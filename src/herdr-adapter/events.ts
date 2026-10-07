import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import process from 'node:process';
import { StopInputSchema, StopResultSchema } from '../contracts.ts';
import { assertNoCredentials } from '../privacy.ts';
import { observeStop, type ObservedStop } from './observe.ts';
import { deliverProposal } from './deliver.ts';
import { approvalMenu, handleBestEffortApproval } from './best-effort-approval.ts';
import { CorruptEpisodeError, EpisodeStore, type Episode } from './state.ts';
import type { QuotaHint } from './quota-hint.ts';
import type { HerdrControl } from './deliver.ts';
import type { HerdrReader } from './observe.ts';
import type { StopInput, StopResult } from '../contracts.ts';
import type { WorkflowAuthority } from './authority.ts';
import type { WorkflowState } from './workflow-state.ts';

export type Event = {
  type?: string;
  pane_id?: string;
  workspace_id?: string;
  agent?: string | null;
  agent_status?: string;
};
export type EventTrigger = Event | { event: string; data: Event };

const hooks = new Set(['pane.agent_status_changed', 'pane_agent_status_changed', 'pane.exited', 'pane_exited']);
const paneIdentity = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/;

export function normalizeEvent(trigger: unknown): Event | null {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const envelope = trigger as { event?: unknown; data?: unknown };
  const raw: unknown =
    typeof envelope.event === 'string' &&
    envelope.data !== null &&
    typeof envelope.data === 'object' &&
    !Array.isArray(envelope.data)
      ? { ...(envelope.data as object), type: envelope.event }
      : trigger;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw as Event;
  if (typeof event.type !== 'string' || !hooks.has(event.type)) return null;
  if (typeof event.pane_id !== 'string' || event.pane_id.length > 256 || !paneIdentity.test(event.pane_id)) return null;
  return event;
}

type Retry = StopInput['retry'];
type Store = {
  active: (session?: string) => Promise<boolean>;
  leaseMatches?: (token: string, session: string) => Promise<boolean>;
  retry: (paneId: string) => Promise<Episode | null>;
  record: (paneId: string, retry: Episode) => Promise<void>;
  clear?: (paneId: string) => Promise<void>;
  approval?: EpisodeStore['approval'];
  recordApproval?: EpisodeStore['recordApproval'];
  withEpisodeLock?: <T>(paneId: string, action: () => Promise<T>) => Promise<T | null>;
};
type HandoffReason = 'observation_unavailable' | 'decision_failed' | 'human_review_required';
export type EventDeps = {
  herdr: HerdrReader & Partial<Pick<HerdrControl, 'prompt' | 'sendKeys'>>;
  autoApprove?: boolean;
  quotaHint?: QuotaHint;
  decide: (input: StopInput) => Promise<unknown>;
  store: Store;
  clock: { now: () => Date };
  targets: readonly string[] | 'all';
  handoff: (reason: HandoffReason) => Promise<void>;
  sessionId?: string;
  leaseToken?: string;
  sessionValid?: () => Promise<boolean>;
  admissionOpen?: () => boolean;
  recoveryAllowed?: (observed: ObservedStop) => Promise<boolean>;
  completeRecovery?: (observed: ObservedStop) => Promise<void>;
  recoveryHandoff?: () => Promise<void>;
  observationAllowed?: (observed: ObservedStop) => boolean;
  dispatchEffect?: (kind: 'approval' | 'recovery', effect: () => Promise<void>) => Promise<void>;
};

export async function handleEvent(trigger: EventTrigger, deps: EventDeps, due = false): Promise<void> {
  const admissionOpen = deps.admissionOpen ?? (() => true);
  if (!admissionOpen()) return;
  const event = normalizeEvent(trigger);
  if (!event) return;
  const statusEvent = event.type === 'pane_agent_status_changed' || event.type === 'pane.agent_status_changed';
  const exitEvent = event.type === 'pane_exited' || event.type === 'pane.exited';
  if (
    (!statusEvent && !exitEvent) ||
    typeof event.pane_id !== 'string' ||
    (deps.targets !== 'all' && !deps.targets.includes(event.pane_id))
  )
    return;
  if (!admissionOpen()) return;
  const active = await deps.store.active(deps.sessionId);
  if (!admissionOpen() || !active) return;
  const stillOwner = async (): Promise<boolean> => {
    if (!admissionOpen()) return false;
    if (deps.sessionValid) {
      const valid = await deps.sessionValid();
      if (!admissionOpen() || !valid) return false;
    }
    if (!admissionOpen()) return false;
    const allowed = deps.sessionId
      ? !!deps.leaseToken && !!(await deps.store.leaseMatches?.(deps.leaseToken, deps.sessionId))
      : await deps.store.active();
    return admissionOpen() && allowed;
  };
  const notify = async (reason: HandoffReason): Promise<void> => {
    if (admissionOpen()) await deps.handoff(reason);
  };
  const assess = async () => {
    if (!admissionOpen()) return;
    if (
      exitEvent ||
      (event.agent_status !== 'blocked' && event.agent_status !== 'idle' && event.agent_status !== 'done')
    ) {
      if (!exitEvent && !['working', 'unknown'].includes(event.agent_status ?? '')) return;
      if (!admissionOpen()) return;
      const owns = await stillOwner();
      if (!admissionOpen() || !owns) return;
      let current;
      try {
        current = await deps.herdr.get(event.pane_id!);
      } catch {
        if (!admissionOpen()) return;
        await notify('observation_unavailable');
        return;
      }
      if (!admissionOpen()) return;
      let old;
      try {
        old = await deps.store.retry(event.pane_id!);
      } catch (error) {
        if (!admissionOpen()) return;
        if (!(error instanceof CorruptEpisodeError)) throw error;
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        // Unreadable history cannot authorize a fresh retry budget.
        await notify('observation_unavailable');
        return;
      }
      if (!admissionOpen()) return;
      if (!old) return;
      const replaced = current?.agent_session?.value && current.agent_session.value !== old.session_id;
      const moved = current && current.workspace_id !== event.pane_id!.split(':')[0];
      const settled =
        !current ||
        (current.workspace_id === event.workspace_id &&
          (exitEvent
            ? ['working', 'done', 'unknown'].includes(current.agent_status)
            : current.agent_status === event.agent_status));
      if (replaced || moved || settled) {
        const lifecycle = !current || moved || current.agent_status === 'unknown';
        const notifyLifecycle = lifecycle && !old.lifecycle_handoff_sent;
        const quarantine = old.last_delivery_state === 'none';
        if (!replaced && !notifyLifecycle && !quarantine) return;
        if (!admissionOpen()) return;
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        if (!admissionOpen()) return;
        if (replaced) await deps.store.clear?.(event.pane_id!);
        else
          await deps.store.record(event.pane_id!, {
            ...old,
            ...(quarantine ? { next_check_at: null, last_delivery_state: 'human' as const } : {}),
            ...(notifyLifecycle ? { lifecycle_handoff_sent: true } : {}),
          });
        if (!admissionOpen()) return;
        await notify('observation_unavailable');
      }
      return;
    }
    if (!statusEvent || !admissionOpen()) return;
    // Recheck the lease *inside* the episode lock; an earlier event never grants authority.
    const owns = await stillOwner();
    if (!admissionOpen() || !owns) return;
    let existing;
    try {
      existing = await deps.store.retry(event.pane_id!);
    } catch (error) {
      if (!admissionOpen()) return;
      if (!(error instanceof CorruptEpisodeError)) throw error;
      const stillOwned = await stillOwner();
      if (!admissionOpen()) return;
      if (!stillOwned) {
        await notify('human_review_required');
        return;
      }
      // Keep corrupt history as a fail-closed quarantine until human repair.
      await notify('observation_unavailable');
      return;
    }
    if (!admissionOpen()) return;
    if (
      due &&
      (!(existing as Episode | null)?.next_check_at ||
        Date.parse((existing as Episode).next_check_at!) > deps.clock.now().getTime())
    )
      return;
    let observed;
    try {
      observed = await observeStop(deps.herdr, event.pane_id!);
    } catch {
      if (!admissionOpen()) return;
      if (due) throw new Error('Herdr observation unavailable');
      await notify('observation_unavailable');
      return;
    }
    if (!admissionOpen()) return;
    if (
      !observed ||
      event.workspace_id !== observed.workspace_id ||
      event.agent_status !== observed.status ||
      (event.agent != null && event.agent !== observed.agent)
    ) {
      if (existing) {
        let live;
        try {
          live = await deps.herdr.get(event.pane_id!);
        } catch {
          if (!admissionOpen()) return;
          if (due) throw new Error('Herdr observation unavailable');
          await notify('observation_unavailable');
          return;
        }
        if (!admissionOpen()) return;
        // A rejected excerpt or stale event workspace alone cannot establish a move.
        const moved =
          !!live &&
          live.pane_id === event.pane_id &&
          !!live.workspace_id &&
          live.workspace_id !== event.pane_id!.split(':')[0] &&
          live.agent_session?.value === existing.session_id;
        if (moved) {
          const notifyLifecycle = !existing.lifecycle_handoff_sent;
          const quarantine = existing.next_check_at !== null || existing.last_delivery_state !== 'human';
          if (notifyLifecycle || quarantine) {
            if (!admissionOpen()) return;
            const stillOwned = await stillOwner();
            if (!admissionOpen()) return;
            if (!stillOwned) {
              await notify('human_review_required');
              return;
            }
            if (!admissionOpen()) return;
            await deps.store.record(event.pane_id!, {
              ...existing,
              next_check_at: null,
              last_delivery_state: existing.last_delivery_state === 'uncertain' ? 'uncertain' : 'human',
              lifecycle_handoff_sent: true,
            });
            if (!admissionOpen()) return;
          }
          if (notifyLifecycle) await notify('observation_unavailable');
          return;
        }
      }
      if (due && existing) {
        if (!admissionOpen()) return;
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        if (!admissionOpen()) return;
        await deps.store.record(event.pane_id!, {
          ...existing,
          next_check_at: null,
          last_delivery_state: existing.last_delivery_state === 'uncertain' ? 'uncertain' : 'human',
        });
        if (!admissionOpen()) return;
      }
      await notify('observation_unavailable');
      return;
    }
    if (deps.observationAllowed && !deps.observationAllowed(observed)) return;
    if (!due && (await handleBestEffortApproval(observed, deps, stillOwner))) return;
    if (!admissionOpen()) return;
    let history = existing;
    let recoveryPermitted = true;
    if (deps.recoveryAllowed) {
      if (!admissionOpen()) return;
      recoveryPermitted = await deps.recoveryAllowed(observed);
      if (!recoveryPermitted && !deps.completeRecovery) return;
      if (!admissionOpen()) return;
      try {
        history = await deps.store.retry(event.pane_id!);
      } catch (error) {
        if (!admissionOpen()) return;
        if (!(error instanceof CorruptEpisodeError)) throw error;
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        await notify('observation_unavailable');
        return;
      }
      if (!admissionOpen()) return;
    }
    const quarantine = async (reason: HandoffReason) => {
      if (!admissionOpen()) return;
      if (due && history) {
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        if (!admissionOpen()) return;
        await deps.store.record(observed.pane_id, {
          ...(history as Episode),
          next_check_at: null,
          last_delivery_state: history.last_delivery_state === 'uncertain' ? 'uncertain' : 'human',
        });
        if (!admissionOpen()) return;
      }
      await notify(reason);
    };
    if (history && (history as Episode).session_id !== observed.session_id) {
      if (!admissionOpen()) return;
      const stillOwned = await stillOwner();
      if (!admissionOpen()) return;
      if (!stillOwned) {
        await notify('human_review_required');
        return;
      }
      if (!admissionOpen()) return;
      await deps.store.clear?.(observed.pane_id);
      if (!admissionOpen()) return;
      await notify('observation_unavailable');
      return;
    }
    if (!deps.completeRecovery && history && history.failure_episode_id !== observed.current_episode_id) {
      // A sequence/revision/status change, even with identical or different historical
      // detection text, cannot prove a fresh failure. Keep the same-session caps.
      const moved = observed.workspace_id !== observed.pane_id.split(':')[0];
      const notifyLifecycle = moved && !history.lifecycle_handoff_sent;
      const quarantine = history.last_delivery_state === 'none' || history.last_delivery_state === 'delivered';
      if (quarantine || notifyLifecycle) {
        if (!admissionOpen()) return;
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        if (!admissionOpen()) return;
        await deps.store.record(observed.pane_id, {
          ...history,
          ...(quarantine ? { next_check_at: null, last_delivery_state: 'human' as const } : {}),
          ...(notifyLifecycle ? { lifecycle_handoff_sent: true } : {}),
        });
        if (!admissionOpen()) return;
        await notify('observation_unavailable');
      }
      return;
    }
    if (!deps.completeRecovery && history && (history as Episode).last_delivery_state !== 'none') return;
    const recognizedMenu = approvalMenu(observed.context);
    const partialMenu = !recognizedMenu && observed.context.includes('Requesting permission for:');
    if ((recognizedMenu && (due || !deps.autoApprove)) || partialMenu) {
      if (history) {
        const stillOwned = await stillOwner();
        if (!admissionOpen()) return;
        if (!stillOwned) {
          await notify('human_review_required');
          return;
        }
        await deps.store.record(observed.pane_id, {
          ...history,
          next_check_at: null,
          last_delivery_state: history.last_delivery_state === 'uncertain' ? 'uncertain' : 'human',
        });
        if (!admissionOpen()) return;
      }
      await notify('human_review_required');
      return;
    }
    if (
      !deps.completeRecovery &&
      history &&
      (history as Episode).next_check_at &&
      deps.clock.now().getTime() >= Date.parse(history.first_observed_at) + 24 * 60 * 60_000
    ) {
      if (!admissionOpen()) return;
      const stillOwned = await stillOwner();
      if (!admissionOpen()) return;
      if (!stillOwned) {
        await notify('human_review_required');
        return;
      }
      if (!admissionOpen()) return;
      await deps.store.record(observed.pane_id, {
        ...(history as Episode),
        next_check_at: null,
        last_delivery_state: history.last_delivery_state === 'uncertain' ? 'uncertain' : 'human',
      });
      if (!admissionOpen()) return;
      await notify('human_review_required');
      return;
    }
    // No new classification for the same pending timer. Due wake-ups advance quota
    // history only when the fresh decision still confirms quota exhaustion.
    if (
      !due &&
      (history as Episode | null)?.next_check_at &&
      (!deps.completeRecovery || history!.failure_episode_id === observed.current_episode_id) &&
      Date.parse((history as Episode).next_check_at!) > deps.clock.now().getTime()
    )
      return;
    const now = deps.clock.now();
    if (!Number.isFinite(now.getTime())) return;
    const retry: Retry = history
      ? {
          failure_episode_id: deps.completeRecovery ? observed.current_episode_id : history.failure_episode_id,
          first_observed_at: history.first_observed_at,
          attempt_count: history.attempt_count,
          last_attempt_at: history.last_attempt_at,
          quota_check_count: history.quota_check_count,
          last_quota_check_at: history.last_quota_check_at,
        }
      : {
          failure_episode_id: observed.current_episode_id,
          first_observed_at: now.toISOString(),
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 0,
          last_quota_check_at: null,
        };
    let current;
    try {
      current = await deps.herdr.get(observed.pane_id);
    } catch {
      if (!admissionOpen()) return;
      // A failed socket read cannot prove a changed occupant. Preserve the due record
      // and let the runner enter its bounded reconnect path rather than waking at 100ms.
      if (due) throw new Error('Herdr read unavailable');
      await notify('observation_unavailable');
      return;
    }
    if (!admissionOpen()) return;
    if (
      !current ||
      current.agent !== observed.agent ||
      current.agent_status !== observed.status ||
      current.agent_session?.agent !== observed.agent ||
      current.agent_session?.kind !== observed.session_kind ||
      current.agent_session?.source !== observed.session_source ||
      current.agent_session?.value !== observed.session_id ||
      current.revision !== observed.revision ||
      current.state_change_seq !== observed.state_change_seq ||
      current.workspace_id !== observed.workspace_id
    ) {
      await quarantine('observation_unavailable');
      return;
    }
    const inputRetry: Retry =
      due && history && (history as Episode).next_check_at
        ? {
            ...retry,
            quota_check_count: retry.quota_check_count + 1,
            last_quota_check_at: now.toISOString(),
          }
        : retry;
    const input = StopInputSchema.safeParse({
      schema_version: 2,
      request_id: randomUUID(),
      agent: {
        id: observed.session_id,
        tool: observed.agent,
        pane_id: observed.pane_id,
        session_id: observed.session_id,
      },
      status: observed.status,
      context: observed.context,
      current_episode_id: observed.current_episode_id,
      automatic_approval_forbidden: true,
      retry: inputRetry,
    });
    if (!input.success) {
      await quarantine('observation_unavailable');
      return;
    }
    try {
      assertNoCredentials(input.data, process.env.TYPESAFE_API_KEY ?? '');
    } catch {
      await quarantine('observation_unavailable');
      return;
    }
    if (!admissionOpen()) return;
    if (deps.completeRecovery && !(await stillOwner())) return;
    if (!admissionOpen()) return;
    let result: StopResult;
    try {
      result = StopResultSchema.parse(await deps.decide(input.data));
    } catch {
      if (!admissionOpen()) return;
      await quarantine('decision_failed');
      return;
    }
    if (!admissionOpen()) return;
    if (result.decision !== 'stop_decision' || result.request_id !== input.data.request_id) {
      await quarantine('decision_failed');
      return;
    }
    if (deps.completeRecovery) {
      if (
        result.proposed_action.kind === 'no_action' &&
        result.reason_code === 'completed' &&
        result.waiting_for === 'completed' &&
        (observed.status === 'idle' || observed.status === 'done')
      ) {
        const fresh = await observeStop(deps.herdr, observed.pane_id);
        if (!admissionOpen()) return;
        if (fresh?.current_episode_id === observed.current_episode_id && (await stillOwner()))
          await deps.completeRecovery(observed);
        return;
      }
      // Classification is never permission to replay an attempted snapshot, erase
      // uncertainty, or bypass cancellation/unsafe association provenance.
      if (!recoveryPermitted) {
        await deps.recoveryHandoff?.();
        return;
      }
      if (
        history &&
        (history.last_delivery_state === 'uncertain' ||
          history.lifecycle_handoff_sent ||
          (history.failure_episode_id === observed.current_episode_id && history.last_delivery_state !== 'none'))
      )
        return;
    }
    if (result.proposed_action.kind === 'manual_review' || result.proposed_action.kind === 'approve_request') {
      await quarantine('human_review_required');
      return;
    }
    // Never store action text. A proposed reset from the CLI is not trusted reset proof;
    // Herdr 0.9.1 exposes no independently bound live agent account/pool identity.
    const action = result.proposed_action;
    // Scoped recovery history is only initialized for a recovery proposal. Keep
    // existing history transitions and the legacy direct pane-metadata contract.
    if (deps.recoveryAllowed && !history && action.kind === 'no_action') return;
    if (
      due &&
      history &&
      history.failure_episode_id === observed.current_episode_id &&
      action.kind === 'send_recovery_instruction' &&
      (history as Episode).next_check_at !== action.not_before
    ) {
      await quarantine('human_review_required');
      return;
    }
    const quota = action.kind === 'wait_for_quota';
    const deadline = Date.parse(retry.first_observed_at) + 24 * 60 * 60_000;
    const checked = due && quota ? inputRetry : retry;
    const delays = [5, 15, 45, 120];
    const delay = (delays[checked.quota_check_count] ?? 360) * 60_000;
    const base = Date.parse(checked.last_quota_check_at ?? checked.first_observed_at);
    const fallback = Math.min(base + delay, deadline);
    // The CLI classifies this as quota; it cannot supply reset proof or dictate this timer.
    let next =
      action.kind === 'send_recovery_instruction' && deps.completeRecovery
        ? Date.parse(action.not_before) > now.getTime()
          ? action.not_before
          : null
        : quota && Number.isFinite(fallback) && fallback > now.getTime()
          ? new Date(fallback).toISOString()
          : null;
    if (quota && !next) {
      await quarantine('human_review_required');
      return;
    }
    if (quota && next && deps.quotaHint) {
      try {
        const hint = await deps.quotaHint(observed, now);
        if (!admissionOpen()) return;
        if (z.iso.datetime({ offset: true }).safeParse(hint).success) {
          const at = Date.parse(hint!);
          if (at > now.getTime() && at < fallback) next = new Date(at).toISOString();
        }
      } catch {
        // A best-effort hint cannot suppress the ordinary quota recheck.
      }
    }
    if (!admissionOpen()) return;
    const stillOwned = await stillOwner();
    if (!admissionOpen()) return;
    if (!stillOwned) {
      await notify('human_review_required');
      return;
    }
    const record: Episode = {
      ...retry,
      ...(history?.workflow_episode_id ? { workflow_episode_id: history.workflow_episode_id } : {}),
      ...(history?.completion_observation_id ? { completion_observation_id: history.completion_observation_id } : {}),
      ...(due && quota ? inputRetry : {}),
      pane_id: observed.pane_id,
      session_id: observed.session_id,
      error_evidence_digest: observed.error_evidence_digest,
      next_check_at: next,
      last_delivery_state: 'none',
    };
    if (!admissionOpen()) return;
    await deps.store.record(observed.pane_id, record);
    if (!admissionOpen()) return;
    if (action.kind === 'send_recovery_instruction') {
      if (!deps.herdr.prompt) {
        if (!admissionOpen()) return;
        const stillOwnedBeforeQuarantine = await stillOwner();
        if (!admissionOpen()) return;
        if (stillOwnedBeforeQuarantine) {
          if (!admissionOpen()) return;
          await deps.store.record(observed.pane_id, {
            ...record,
            next_check_at: null,
            last_delivery_state: 'human',
          });
          if (!admissionOpen()) return;
        }
        await notify('human_review_required');
        return;
      }
      if (!admissionOpen()) return;
      const outcome = await deliverProposal(
        deps.herdr as HerdrControl,
        observed,
        result,
        deps.store as EpisodeStore,
        deps.clock,
        deps.decide as (input: StopInput) => Promise<StopResult>,
        stillOwner,
        true,
        admissionOpen,
        deps.dispatchEffect ? (effect) => deps.dispatchEffect!('recovery', effect) : undefined,
      );
      if (!admissionOpen()) return;
      if (outcome === 'human' || outcome === 'uncertain') {
        const stillOwnedForCleanup = await stillOwner();
        if (!admissionOpen()) return;
        if (stillOwnedForCleanup) {
          const latest = await deps.store.retry(observed.pane_id);
          if (!admissionOpen()) return;
          if (latest) {
            const stillOwnedAfterRead = await stillOwner();
            if (!admissionOpen()) return;
            if (stillOwnedAfterRead) {
              if (!admissionOpen()) return;
              await deps.store.record(observed.pane_id, {
                ...(latest as Episode),
                next_check_at: null,
                last_delivery_state: outcome === 'human' ? 'human' : 'uncertain',
              });
              if (!admissionOpen()) return;
            }
          }
        }
        await notify('human_review_required');
      }
    }
  };
  if (!admissionOpen()) return;
  if (deps.store.withEpisodeLock) {
    await deps.store.withEpisodeLock(event.pane_id!, assess);
    if (!admissionOpen()) return;
  } else await assess();
}

function boundStore(store: EventDeps['store']): EventDeps['store'] {
  return {
    active: (session) => store.active(session),
    leaseMatches: store.leaseMatches ? (token, session) => store.leaseMatches!(token, session) : undefined,
    retry: (paneId) => store.retry(paneId),
    record: (paneId, retry) => store.record(paneId, retry),
    clear: store.clear ? (paneId) => store.clear!(paneId) : undefined,
    approval: store.approval ? (agent, session) => store.approval!(agent, session) : undefined,
    recordApproval: store.recordApproval ? (pane, attempt) => store.recordApproval!(pane, attempt) : undefined,
    withEpisodeLock: store.withEpisodeLock ? (paneId, action) => store.withEpisodeLock!(paneId, action) : undefined,
  };
}

export function workflowEventDeps(base: EventDeps, authority: WorkflowAuthority, state: WorkflowState): EventDeps {
  const episodes = new EpisodeStore(state.directory);
  const bound = boundStore(base.store);
  const retryKey = 'retry-session:' + JSON.stringify([authority.scope.agent, authority.scope.sessionId]);
  let retryDepth = 0;
  const withRetrySession = async <T>(action: () => Promise<T>): Promise<T | null> => {
    if (retryDepth > 0) return action();
    retryDepth++;
    try {
      return await episodes.withEpisodeLock(retryKey, action);
    } finally {
      retryDepth--;
    }
  };
  let associationDenied = false;
  const legacy = {
    directory: episodes.directory,
    withEpisodeLock: async <T>(key: string, action: () => Promise<T>): Promise<T | null> =>
      key === retryKey && retryDepth > 0 ? action() : episodes.withEpisodeLock(key, action),
    sessionRetry: (agent: string, sessionId: string) => episodes.sessionRetry(agent, sessionId),
    hasRetryHead: (agent: string, sessionId: string) => episodes.hasRetryHead(agent, sessionId),
    recordSessionRetry: (agent: string, sessionId: string, episode: Episode) =>
      episodes.recordSessionRetry(agent, sessionId, episode),
  } as EpisodeStore;
  return {
    ...base,
    autoApprove: base.autoApprove === true && authority.permission.autoApprove,
    targets: authority.permission.targets,
    observationAllowed: (observed) =>
      observed.pane_id === authority.paneId &&
      observed.workspace_id === authority.workspaceId &&
      observed.agent === authority.scope.agent &&
      observed.session_id === authority.scope.sessionId &&
      observed.session_kind === authority.scope.sessionKind &&
      observed.session_source === authority.scope.sessionSource,
    dispatchEffect: (kind, effect) => authority.dispatch(kind, effect),
    sessionId: authority.scope.serverId,
    leaseToken: authority.generation,
    sessionValid: () => authority.valid(),
    admissionOpen: () => authority.admissionOpen(),
    store: {
      ...bound,
      active: async () => authority.valid(),
      leaseMatches: async (token, serverId) =>
        token === authority.generation && serverId === authority.scope.serverId && (await authority.valid()),
      retry: async () => state.sessionRetry(authority.scope),
      record: async (pane, retry) => {
        if (pane !== authority.paneId || retry.pane_id !== pane || retry.session_id !== authority.scope.sessionId)
          throw new Error('workflow subject mismatch');
        await authority.dispatch('recovery', async () => {
          const previous = await state.sessionRetry(authority.scope);
          if (!previous || previous.failure_episode_id !== retry.failure_episode_id)
            await episodes.advanceSessionRetry(authority.scope.agent, authority.scope.sessionId, retry, previous);
          else await episodes.recordSessionRetry(authority.scope.agent, authority.scope.sessionId, retry);
          const selected = await state.sessionRetry(authority.scope);
          if (!selected || selected.failure_episode_id !== retry.failure_episode_id) throw new CorruptEpisodeError();
          await state.publishPendingRecoveryProvenance(
            authority.scope,
            authority.ticket,
            authority.generation,
            authority.paneId,
            authority.workspaceId,
            selected,
          );
        });
      },
      clear: async () => {},
      approval: (agent, session) => episodes.approval(agent, session),
      recordApproval: async (pane, attempt) => {
        if (
          pane !== authority.paneId ||
          attempt.pane_id !== pane ||
          attempt.agent !== authority.scope.agent ||
          attempt.session_id !== authority.scope.sessionId
        )
          throw new Error('workflow subject mismatch');
        await authority.dispatch('approval', () => episodes.recordApproval(pane, attempt));
      },
      withEpisodeLock: async (key, action) => {
        if (key.startsWith('approval:')) return episodes.withEpisodeLock(key, action);
        if (key.startsWith('retry-session:')) return withRetrySession(action);
        return episodes.withEpisodeLock(key, async () => {
          // Pane -> retry-session before any nested approval lock. Nested approval
          // keys must not reacquire this retry-session lock (retryDepth).
          const result = await withRetrySession(action);
          return result as Awaited<ReturnType<typeof action>>;
        });
      },
    },
    completeRecovery: async (observed) => {
      if (
        !authority.admissionOpen() ||
        !(await authority.valid()) ||
        (await state.recoveryQuarantined(authority.scope, true))
      )
        return;
      const adopted = await state.adoptLegacyRetry(legacy, authority.scope, observed, authority, true);
      if (adopted !== 'adopted' || !authority.admissionOpen()) return;
      const previous = await state.sessionRetry(authority.scope);
      if (!previous || previous.pane_id !== observed.pane_id) return;
      const fresh = await observeStop(base.herdr, observed.pane_id);
      if (!authority.admissionOpen() || fresh?.current_episode_id !== observed.current_episode_id) return;
      if (previous.failure_episode_id === observed.current_episode_id) {
        await authority.dispatch('recovery', () =>
          episodes.recordSessionRetry(authority.scope.agent, authority.scope.sessionId, {
            ...previous,
            next_check_at: null,
          }),
        );
        return;
      }
      await authority.dispatch('completion', () =>
        episodes.completeSessionRetry(
          authority.scope.agent,
          authority.scope.sessionId,
          observed.current_episode_id,
          previous,
        ),
      );
    },
    recoveryHandoff: async () => {
      if (associationDenied && authority.admissionOpen() && (await authority.valid()) && authority.admissionOpen())
        await base.handoff('human_review_required');
    },
    recoveryAllowed: async (observed) => {
      associationDenied = false;
      if (!(await authority.valid())) return false;
      if (
        observed.pane_id !== authority.paneId ||
        observed.workspace_id !== authority.workspaceId ||
        observed.agent !== authority.scope.agent ||
        observed.session_id !== authority.scope.sessionId ||
        observed.session_kind !== authority.scope.sessionKind ||
        observed.session_source !== authority.scope.sessionSource
      )
        return false;
      const binding = await state.binding(authority.scope);
      if (binding && binding.historyPaneId !== observed.pane_id) return false;
      const history = await state.sessionRetry(authority.scope);
      if (
        history?.last_delivery_state === 'human' &&
        history.attempt_count !== 0 &&
        !(await episodes.hasRetryHead(authority.scope.agent, authority.scope.sessionId))
      )
        return false;
      if (await state.recoveryQuarantined(authority.scope)) {
        if (history) return false;
      } else if (history) return true;
      const adopted = await state.adoptLegacyRetry(legacy, authority.scope, observed, authority);
      if (adopted === 'quarantined') {
        associationDenied = true;
        return false;
      }
      return authority.valid();
    },
  };
}
