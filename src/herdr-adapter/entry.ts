import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { CorruptEpisodeError, EpisodeStore, type Episode } from './state.ts';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { StopInputSchema, StopResultSchema } from '../contracts.ts';
import { assertNoCredentials } from '../privacy.ts';
import { observeStop } from './observe.ts';
import { deliverProposal } from './deliver.ts';
import { handleBestEffortApproval } from './best-effort-approval.ts';
import { runScheduler, type SchedulerResult } from './scheduler.ts';
import type { HerdrControl } from './deliver.ts';
import type { HerdrReader, AgentSnapshot, ReadSnapshot } from './observe.ts';
import type { StopInput, StopResult } from '../contracts.ts';

type Retry = StopInput['retry'];
type Event = { type?: string; pane_id?: string; workspace_id?: string; agent?: string | null; agent_status?: string };
type EventTrigger = Event | { event: string; data: Event };
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
  decide: (input: StopInput) => Promise<unknown>;
  store: Store;
  clock: { now: () => Date };
  targets: readonly string[] | 'all';
  handoff: (reason: HandoffReason) => Promise<void>;
  sessionId?: string;
  leaseToken?: string;
  sessionValid?: () => Promise<boolean>;
  admissionOpen?: () => boolean;
};

export async function handleEvent(trigger: EventTrigger, deps: EventDeps, due = false): Promise<void> {
  const admissionOpen = deps.admissionOpen ?? (() => true);
  if (!admissionOpen()) return;
  const event: Event =
    'event' in trigger && trigger.data && typeof trigger.data === 'object'
      ? { ...trigger.data, type: trigger.event }
      : (trigger as Event);
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
    if (exitEvent || (event.agent_status !== 'blocked' && event.agent_status !== 'idle')) {
      if (!exitEvent && !['working', 'done', 'unknown'].includes(event.agent_status ?? '')) return;
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
              last_delivery_state: 'human',
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
        await deps.store.record(event.pane_id!, { ...existing, next_check_at: null, last_delivery_state: 'human' });
        if (!admissionOpen()) return;
      }
      await notify('observation_unavailable');
      return;
    }
    if (await handleBestEffortApproval(observed, deps, stillOwner)) return;
    if (!admissionOpen()) return;
    const history = existing;
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
          last_delivery_state: 'human',
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
    if (history && history.failure_episode_id !== observed.current_episode_id) {
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
    if (history && (history as Episode).last_delivery_state !== 'none') return;
    if (
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
        last_delivery_state: 'human',
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
      Date.parse((history as Episode).next_check_at!) > deps.clock.now().getTime()
    )
      return;
    const now = deps.clock.now();
    if (!Number.isFinite(now.getTime())) return;
    const retry: Retry = history
      ? {
          failure_episode_id: history.failure_episode_id,
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
    if (result.proposed_action.kind === 'manual_review' || result.proposed_action.kind === 'approve_request') {
      await quarantine('human_review_required');
      return;
    }
    // Never store action text. A proposed reset from the CLI is not trusted reset proof;
    // Herdr 0.9.1 exposes no independently bound live agent account/pool identity.
    const action = result.proposed_action;
    if (
      due &&
      history &&
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
    const next =
      quota && Number.isFinite(fallback) && fallback > now.getTime() ? new Date(fallback).toISOString() : null;
    if (quota && !next) {
      await quarantine('human_review_required');
      return;
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

// Herdr 0.9.1 newline-delimited socket protocol for bounded observation.
async function request(
  socketPath: string,
  method: 'agent.get' | 'agent.read' | 'agent.list',
  params: object,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const id = randomUUID();
    let data = '';
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(3000, () => fail(new Error('Herdr read timeout')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data, 'utf8') > 65536) {
        fail(new Error('Herdr response too large'));
        return;
      }
      const end = data.indexOf('\n');
      if (end < 0) return;
      socket.end();
      try {
        const response = JSON.parse(data.slice(0, end));
        if (response.id !== id || response.error || !response.result) throw new Error('Herdr read failed');
        resolve(response.result);
      } catch {
        reject(new Error('Invalid Herdr response'));
      }
    });
    socket.on('end', () => reject(new Error('Incomplete Herdr response')));
  });
}

export function socketReader(path: string): HerdrReader {
  return {
    list: async () => {
      const result = (await request(path, 'agent.list', {})) as { type?: string; agents?: AgentSnapshot[] };
      if (result.type !== 'agent_list' || !Array.isArray(result.agents)) throw new Error('Invalid Herdr agent list');
      return result.agents;
    },
    get: async (paneId) => {
      const result = (await request(path, 'agent.get', { target: paneId })) as { type?: string; agent?: AgentSnapshot };
      return result.type === 'agent_info' ? (result.agent ?? null) : null;
    },
    read: async (paneId) => {
      const result = (await request(path, 'agent.read', {
        target: paneId,
        source: 'detection',
        lines: 12,
        format: 'text',
      })) as { type?: string; read?: ReadSnapshot };
      // Detection text is untrusted evidence, not a verified current-stop boundary.
      return result.type === 'pane_read' ? (result.read ?? null) : null;
    },
  };
}

// Use Herdr's agent prompt command: it enforces blocked-dialog permission controls.
// An exit, signal, or timeout after invocation is ambiguous; the episode was already
// marked uncertain before spawn and must never be automatically retried.
function socketControl(
  path: string,
  binary: string | undefined,
): HerdrReader & Partial<Pick<HerdrControl, 'prompt' | 'sendKeys'>> {
  const reader = socketReader(path);
  if (!binary || !isAbsolute(binary)) return reader;
  const invoke = async (args: string[]) =>
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: 'ignore', env: { ...process.env, HERDR_SOCKET_PATH: path } });
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Herdr key outcome unknown'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error('Herdr key outcome unknown'));
        else resolve();
      });
    });
  return {
    ...reader,
    sendKeys: async (paneId, keys) => {
      if (keys.length !== 1 || keys[0] !== '1') throw new Error('Invalid approval input');
      await invoke(['agent', 'send-keys', paneId, '1']);
    },
    prompt: async (paneId, instruction) =>
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, ['agent', 'prompt', paneId, instruction], {
          stdio: 'ignore',
          env: { ...process.env, HERDR_SOCKET_PATH: path },
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 8_000);
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Herdr prompt outcome unknown'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (timedOut || code !== 0) reject(new Error('Herdr prompt outcome unknown'));
          else resolve();
        });
      }),
  };
}

export async function decideWithCli(
  input: StopInput,
  main = fileURLToPath(new URL('../main.js', import.meta.url)),
  deadlineMs = 35_000,
): Promise<StopResult> {
  const child = spawn(process.execPath, [main, 'stop', 'check'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let data = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    data += chunk;
    if (data.length > 65536) child.kill();
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    let expired = false;
    let exited = false;
    const deadlineError = () => new Error('stop check deadline exceeded');
    const timer = setTimeout(() => {
      expired = true;
      if (exited) reject(deadlineError());
      else child.kill('SIGKILL');
    }, deadlineMs);
    child.on('exit', () => {
      exited = true;
      if (expired) reject(deadlineError());
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(deadlineError());
      else resolve(code);
    });
    child.stdin.on('error', (error) => {
      child.kill('SIGKILL');
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(JSON.stringify(input));
  });
  if (exit !== 0 && exit !== 2 && exit !== 3) throw new Error('stop check failed');
  let result: StopResult;
  try {
    result = StopResultSchema.parse(JSON.parse(data));
  } catch {
    throw new Error('invalid stop check response');
  }
  if (result.decision === 'error' || result.request_id !== input.request_id)
    throw new Error('invalid stop check decision');
  return result;
}

// Socket inode binds this process's lease to a particular Herdr server instance;
// a replaced socket cannot use the old runner's lease.
async function socketSession(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isSocket() ? `${info.dev}:${info.ino}` : null;
  } catch {
    return null;
  }
}
function handoff(reason: HandoffReason): Promise<void> {
  process.stderr.write(`agent-steward: human_review_required (${reason})\n`);
  return Promise.resolve();
}
async function visibleHandoff(env: NodeJS.ProcessEnv, reason: HandoffReason): Promise<void> {
  await handoff(reason);
  if (!env.HERDR_BIN_PATH || !isAbsolute(env.HERDR_BIN_PATH) || !env.HERDR_SOCKET_PATH) return;
  // Herdr 0.9.1 notification.show is a best-effort visible toast, not a
  // guaranteed human acknowledgment; never include context, IDs, or errors.
  await new Promise<void>((resolve) => {
    const child = spawn(
      env.HERDR_BIN_PATH!,
      ['notification', 'show', 'Agent Steward: human review required', '--body', 'Review the stopped agent manually.'],
      { stdio: 'ignore', env: { ...process.env, HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH } },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function adapterConfigFrom(
  env: NodeJS.ProcessEnv,
): Promise<{ targets: readonly string[] | 'all'; autoApprove: boolean }> {
  const config = JSON.parse(await readFile(`${env.HERDR_PLUGIN_CONFIG_DIR}/targets.json`, 'utf8'));
  const targets =
    !Object.hasOwn(config, 'pane_ids') || (Array.isArray(config.pane_ids) && config.pane_ids.length === 0)
      ? 'all'
      : Array.isArray(config.pane_ids) && config.pane_ids.every((id: unknown) => typeof id === 'string')
        ? config.pane_ids
        : [];
  return { targets, autoApprove: config.auto_approve === true };
}
export async function runEvent(env: NodeJS.ProcessEnv, decide: EventDeps['decide'] = decideWithCli): Promise<void> {
  if (
    !env.HERDR_PLUGIN_EVENT_JSON ||
    !env.HERDR_SOCKET_PATH ||
    !env.HERDR_PLUGIN_CONFIG_DIR ||
    !env.HERDR_PLUGIN_STATE_DIR
  )
    return;
  let event: EventTrigger;
  let targets: readonly string[] | 'all';
  let autoApprove = false;
  try {
    event = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON);
  } catch {
    return;
  }
  try {
    ({ targets, autoApprove } = await adapterConfigFrom(env));
  } catch {
    targets = 'all';
  }
  if (!event || typeof event !== 'object') return;
  const paneId = 'data' in event ? event.data?.pane_id : event.pane_id;
  if (targets !== 'all' && !targets.includes(paneId ?? '')) return;
  const sessionId = await socketSession(env.HERDR_SOCKET_PATH);
  if (!sessionId) return;
  const store = new EpisodeStore(env.HERDR_PLUGIN_STATE_DIR);
  const leaseToken = await store.activeToken(sessionId);
  if (!leaseToken) return;
  await handleEvent(event, {
    herdr: socketControl(env.HERDR_SOCKET_PATH, env.HERDR_BIN_PATH),
    decide,
    store,
    sessionId,
    leaseToken,
    clock: { now: () => new Date() },
    targets,
    autoApprove,
    handoff: (reason) => visibleHandoff(env, reason),
    sessionValid: async () => (await socketSession(env.HERDR_SOCKET_PATH!)) === sessionId,
  });
}

export function reportSchedulerResult(
  result: SchedulerResult,
  output: { write: (text: string) => void; fail: () => void },
): void {
  if (result === 'shutdown_incomplete') {
    output.write(
      'agent-steward: release unconfirmed; shutdown incomplete; event hooks may still act. Human review required.\n',
    );
    output.fail();
  }
  if (result === 'already_owned') {
    output.write(
      'agent-steward: scheduler lease unavailable. If recovery is needed, disable the plugin, stop all adapters and verify they are dead before offline cleanup of a stranded guard or legacy lease. Preserve episode records and generation tombstones.\n',
    );
  }
}

export async function runVisibleScheduler(
  env: NodeJS.ProcessEnv,
  schedule: typeof runScheduler = runScheduler,
): Promise<void> {
  if (!env.HERDR_SOCKET_PATH || !env.HERDR_PLUGIN_CONFIG_DIR || !env.HERDR_PLUGIN_STATE_DIR) return;
  const sessionId = await socketSession(env.HERDR_SOCKET_PATH);
  if (!sessionId) {
    await visibleHandoff(env, 'observation_unavailable');
    return;
  }
  let listed: readonly string[] | 'all';
  let autoApprove = false;
  try {
    const config = await adapterConfigFrom(env);
    listed = config.targets;
    autoApprove = config.autoApprove;
  } catch {
    listed = 'all';
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await schedule({
      store: new EpisodeStore(env.HERDR_PLUGIN_STATE_DIR),
      herdr: socketControl(env.HERDR_SOCKET_PATH, env.HERDR_BIN_PATH),
      decide: decideWithCli,
      targets: listed === 'all' ? undefined : listed,
      autoApprove,
      sessionId,
      signal: abort.signal,
      handoff: (reason) => visibleHandoff(env, reason),
      sessionValid: async () => (await socketSession(env.HERDR_SOCKET_PATH!)) === sessionId,
    });
    reportSchedulerResult(result, {
      write: (text) => {
        process.stderr.write(text);
      },
      fail: () => {
        process.exitCode = 1;
      },
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === 'event') await runEvent(process.env);
  if (process.argv[2] === 'scheduler') await runVisibleScheduler(process.env);
}
