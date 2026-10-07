import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { reserveJobSlot, type JobSlot, type WorkflowAuthority } from './authority.ts';
import { appendDiagnostic, type DiagnosticEvent } from './diagnostics.ts';
import { handleEvent, workflowEventDeps, type EventDeps } from './events.ts';
import { observeStop } from './observe.ts';
import { workflowEpisodeId, type Episode, type EpisodeStore } from './state.ts';
import type { WorkflowBinding, WorkflowResult, WorkflowState } from './workflow-state.ts';

export type JobOptions = {
  state: WorkflowState;
  authority: WorkflowAuthority;
  episodes: EpisodeStore;
  deps: EventDeps;
  binding: WorkflowBinding;
  signal: AbortSignal;
  wait?: (deadline: Date, signal: AbortSignal) => Promise<void>;
  diagnose?: (event: DiagnosticEvent) => Promise<void>;
};

type HandoffReason = 'observation_unavailable' | 'decision_failed' | 'human_review_required';

function defaultWait(deadline: Date, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const delay = Math.max(0, deadline.getTime() - Date.now());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function recoveryHerdr(herdr: EventDeps['herdr'], valid: () => Promise<boolean>): EventDeps['herdr'] {
  return {
    get: async (paneId) => ((await valid()) ? herdr.get(paneId) : null),
    read: async (paneId) => ((await valid()) ? herdr.read(paneId) : null),
    ...(herdr.prompt
      ? {
          // Validation belongs to the slot's coordinated dispatch, not an
          // asynchronous wrapper between admission and the native invocation.
          prompt: (paneId: string, text: string) => herdr.prompt!(paneId, text),
        }
      : {}),
  };
}

function recoverable(episode: Episode | null): episode is Episode {
  return (
    episode !== null &&
    episode.last_delivery_state === 'none' &&
    episode.next_check_at !== null &&
    episode.lifecycle_handoff_sent !== true
  );
}

export async function runEpisodeJob(options: JobOptions): Promise<WorkflowResult> {
  const controller = new AbortController();
  let slotAttempt: ReturnType<typeof reserveJobSlot> | undefined;
  let slot: JobSlot | undefined;
  let notice: HandoffReason | undefined;
  const forward = () => {
    // Revocation must start at cancellation, not after any foreground await.
    if (!controller.signal.aborted) controller.abort();
    slotAttempt?.close();
  };
  options.signal.addEventListener('abort', forward);
  options.authority.signal.addEventListener('abort', forward);
  if (options.signal.aborted || options.authority.signal.aborted) forward();
  const closed = new Promise<'stopped'>((resolve) => {
    if (controller.signal.aborted) resolve('stopped');
    else controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });
  const open = () => !controller.signal.aborted && options.authority.admissionOpen();
  const valid = async () => open() && (await (slot ? slot.valid() : options.authority.valid())) && open();
  const paneId = options.binding.paneId;
  const scope = options.authority.scope;
  const retryKey = 'retry-session:' + JSON.stringify([scope.agent, scope.sessionId]);
  const wait = options.wait ?? defaultWait;
  const scopeHash = createHash('sha256')
    .update(JSON.stringify([scope.serverId, scope.agent, scope.sessionId]))
    .digest('hex');
  const diagnose = options.diagnose ?? ((event: DiagnosticEvent) => appendDiagnostic(options.state.directory, event));
  const emit = (outcome: DiagnosticEvent['outcome'], reason: DiagnosticEvent['reason']): void => {
    void diagnose({
      at: options.deps.clock.now().toISOString(),
      scopeHash,
      outcome,
      reason,
    }).catch(() => {});
  };

  const markHuman = async (reason: HandoffReason): Promise<WorkflowResult> => {
    try {
      const marked = await options.episodes.withEpisodeLock(paneId, () =>
        options.episodes.withEpisodeLock(retryKey, async () => {
          if (!(await valid())) return false;
          const latest = await options.state.sessionRetry(scope);
          if (!open() || !recoverable(latest) || !(await valid())) return false;
          await slot!.record({ ...latest, next_check_at: null, last_delivery_state: 'human' });
          if (open()) notice = reason;
          return open();
        }),
      );
      return open() ? (marked ? 'finished' : 'shutdown_incomplete') : 'stopped';
    } catch {
      return open() ? 'shutdown_incomplete' : 'stopped';
    }
  };

  const foreground = async (): Promise<WorkflowResult> => {
    if (!open()) return 'stopped';
    if (
      !options.authority.ownsGeneration ||
      options.binding.generation !== options.authority.generation ||
      options.binding.epoch !== options.authority.ticket.epoch
    )
      return 'not_admitted';

    const ready = await options.episodes.withEpisodeLock(paneId, async (): Promise<JobSlot | WorkflowResult> => {
      if (!(await valid())) return 'stopped';
      const episode = await options.state.sessionRetry(scope);
      if (!open()) return 'stopped';
      if (!recoverable(episode) || (await options.state.recoveryQuarantined(scope))) return 'not_admitted';
      if (!open()) return 'stopped';
      const current = await options.state.binding(scope);
      if (
        !open() ||
        !current ||
        current.phase === 'terminal' ||
        current.generation !== options.authority.generation ||
        current.epoch !== options.authority.ticket.epoch ||
        current.paneId !== paneId ||
        episode.pane_id !== paneId ||
        !(await valid())
      )
        return 'not_admitted';
      const pending: WorkflowBinding = {
        ...current,
        phase: 'pending',
        reason: null,
        failureEpisodeId: workflowEpisodeId(episode),
        historyPaneId: episode.pane_id,
      };
      await options.state.recordBinding(pending, options.authority);
      if (!open()) return 'stopped';
      // Keep the pane lock across tentative publication, reservation and refusal
      // cleanup. A second promotion must not slip into the reconciliation gap.
      slotAttempt = reserveJobSlot(options.state, options.authority);
      if (!open()) {
        slotAttempt.close();
        return 'stopped';
      }
      const selected = await slotAttempt.ready;
      if (!open()) return 'stopped';
      if (selected) return selected;
      // A duplicate includes an in-flight reservation, not just a visible
      // selector. Never infer duplication from a best-effort capacity scan.
      if (slotAttempt.duplicate) return 'not_admitted';
      try {
        const ours = async () => {
          if (!(await valid())) return false;
          const current = await options.state.binding(scope);
          return open() && isDeepStrictEqual(current, pending);
        };
        const cleaned = await options.episodes.withEpisodeLock(retryKey, async () => {
          if (!(await ours())) return false;
          const latest = await options.state.sessionRetry(scope);
          if (!open() || !isDeepStrictEqual(latest, episode) || !(await ours())) return false;
          await options.authority.dispatch('recovery', () =>
            options.episodes.recordSessionRetry(scope.agent, scope.sessionId, {
              ...episode,
              next_check_at: null,
              last_delivery_state: 'human',
            }),
          );
          return open();
        });
        // recordBinding acquires the canonical lock itself; keep the pane lock
        // but release retry-session first (no recursive acquisition).
        if (!cleaned || !(await ours())) return open() ? 'shutdown_incomplete' : 'stopped';
        await options.state.recordBinding({ ...pending, phase: 'terminal', reason: 'human' }, options.authority);
        if (open()) notice = 'human_review_required';
        return 'not_admitted';
      } catch {
        // Unavailable cleanup is not a confirmed, clean refusal. Never bypass a
        // shared lock or overwrite history that changed while reserving capacity.
        return open() ? 'shutdown_incomplete' : 'stopped';
      }
    });
    if (!open()) return 'stopped';
    if (!ready) return 'not_admitted';
    if (typeof ready === 'string') return ready;
    slot = ready;
    emit('created', null);
    slot.signal.addEventListener('abort', forward);
    if (slot.signal.aborted) forward();
    const recovery = workflowEventDeps(
      { ...options.deps, herdr: recoveryHerdr(options.deps.herdr, valid), autoApprove: false },
      options.authority,
      options.state,
    );
    const deps: EventDeps = {
      ...recovery,
      autoApprove: false,
      admissionOpen: open,
      sessionValid: valid,
      dispatchEffect: async (kind, effect) => {
        if (kind !== 'recovery' || !open()) throw new Error('lost job authority');
        await slot!.dispatch(effect);
      },
      // Promotion already proved canonical association. A due callback must not
      // adopt missing history or fall back to G-only authority after a suspension.
      recoveryAllowed: async (observed) =>
        observed.pane_id === paneId &&
        observed.agent === scope.agent &&
        observed.session_id === scope.sessionId &&
        observed.session_kind === scope.sessionKind &&
        observed.session_source === scope.sessionSource &&
        (await valid()),
      decide: async (input) => {
        if (!(await valid())) throw new Error('lost job authority');
        return options.deps.decide(input);
      },
      handoff: async (reason) => {
        if (open()) notice = reason;
      },
      store: {
        ...recovery.store,
        active: valid,
        leaseMatches: async (generation, serverId) =>
          generation === options.authority.generation && serverId === scope.serverId && (await valid()),
        record: async (_pane, episode) => {
          if (open()) await slot!.record(episode);
        },
      },
    };
    while (await valid()) {
      const changed = slot!.historyChanged;
      const episode = await options.state.sessionRetry(scope);
      if (!open()) return 'stopped';
      if (!recoverable(episode)) return 'finished';
      const deadline = new Date(episode.next_check_at!);
      const now = options.deps.clock.now().getTime();
      if (!Number.isFinite(deadline.getTime()) || !Number.isFinite(now)) return markHuman('observation_unavailable');
      if (deadline.getTime() > now) {
        const waiting = new AbortController();
        const interrupt = () => waiting.abort();
        changed.addEventListener('abort', interrupt, { once: true });
        controller.signal.addEventListener('abort', interrupt, { once: true });
        if (changed.aborted || controller.signal.aborted) interrupt();
        try {
          const interrupted = new Promise<void>((resolve) => {
            if (waiting.signal.aborted) resolve();
            else waiting.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          await Promise.race([wait(deadline, waiting.signal), interrupted]);
        } finally {
          changed.removeEventListener('abort', interrupt);
          controller.signal.removeEventListener('abort', interrupt);
          waiting.abort();
        }
        if (changed.aborted) continue;
      }
      if (!(await valid())) return 'stopped';
      // The full foreground is raced below. Every continuation still fences the
      // next operation; a race does not cancel the losing promise's continuation.
      try {
        const snapshot = await deps.herdr.get(paneId);
        if (!(await valid())) return 'stopped';
        if (!snapshot || snapshot.agent_session?.value !== scope.sessionId) return markHuman('observation_unavailable');
        const seen = await observeStop(deps.herdr, paneId);
        if (!(await valid())) return 'stopped';
        if (!seen || seen.session_id !== scope.sessionId) return markHuman('observation_unavailable');
        await handleEvent(
          {
            type: 'pane.agent_status_changed',
            pane_id: snapshot.pane_id,
            workspace_id: snapshot.workspace_id,
            agent: snapshot.agent,
            agent_status: snapshot.agent_status,
          },
          deps,
          true,
        );
      } catch {
        if (!open()) return 'stopped';
        return markHuman('observation_unavailable');
      }
      if (!(await valid())) return 'stopped';
      const after = await options.state.sessionRetry(scope);
      if (!open()) return 'stopped';
      if (!recoverable(after)) return 'finished';
      const nextAt = Date.parse(after.next_check_at!);
      if (Number.isFinite(nextAt) && nextAt > options.deps.clock.now().getTime()) continue;
      return markHuman('human_review_required');
    }
    return 'stopped';
  };

  try {
    // Includes permission, binding/history reads, refused-promotion cleanup and
    // all facade work. Promise.race observes late rejection without joining it.
    const work = await Promise.race([
      foreground().catch((): WorkflowResult => (open() ? 'not_admitted' : 'stopped')),
      closed,
    ]);
    slot?.signal.removeEventListener('abort', forward);
    if (work !== 'finished') slotAttempt?.close();
    const finishing = slotAttempt?.finish();
    controller.abort();
    const release = await finishing;
    if (release === 'shutdown_incomplete') {
      emit('shutdown_incomplete', 'release_unconfirmed');
      return release;
    }
    if (options.signal.aborted || options.authority.signal.aborted) {
      if (slot) emit('handoff', 'canceled');
      return 'stopped';
    }
    // Only confirmed terminal completion emits the queued fixed-code notice.
    // Its settlement is observed, never joined, and cannot rewrite the result.
    if (notice && (work === 'finished' || work === 'not_admitted')) {
      try {
        void options.deps.handoff(notice).catch(() => {});
      } catch {
        /* notification is best effort */
      }
    }
    if (work === 'finished') emit(notice ? 'handoff' : 'finished', notice ? 'human' : 'completed');
    else if (work === 'not_admitted' && notice) emit('handoff', slot ? 'human' : 'capacity');
    else if (work === 'shutdown_incomplete') emit('shutdown_incomplete', 'release_unconfirmed');
    else if (work === 'stopped' && slot) emit('handoff', 'lost');
    return work;
  } finally {
    options.signal.removeEventListener('abort', forward);
    options.authority.signal.removeEventListener('abort', forward);
    slot?.signal.removeEventListener('abort', forward);
  }
}
