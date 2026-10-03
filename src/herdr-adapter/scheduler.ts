import { handleEvent } from './entry.ts';
import { CorruptEpisodeError, EpisodeStore, type Episode } from './state.ts';
import { observeStop } from './observe.ts';
import type { HerdrReader } from './observe.ts';
import type { HerdrControl } from './deliver.ts';
import type { StopInput } from '../contracts.ts';
import type { LeaseAttempt } from './lease.ts';

export type SchedulerResult = 'already_owned' | 'stopped' | 'shutdown_incomplete';

export type SchedulerOptions = {
  store: EpisodeStore;
  herdr: HerdrReader & Partial<Pick<HerdrControl, 'prompt'>>;
  decide: (input: StopInput) => Promise<unknown>;
  targets?: readonly string[];
  sessionId: string;
  signal: AbortSignal;
  onLease?: () => void;
  handoff?: (reason: 'observation_unavailable' | 'decision_failed' | 'human_review_required') => Promise<void>;
  clock?: { now: () => Date };
  sessionValid?: () => Promise<boolean>;
  heartbeatIntervalMs?: number;
  shutdownDeadline?: (milliseconds: number, expire: () => void) => () => void;
};
class OwnershipLostError extends Error {}

type Ownership = {
  sessionId: string;
  leaseToken: string;
  sessionValid?: () => Promise<boolean>;
  admissionOpen: () => boolean;
};
async function owns(store: EpisodeStore, ownership: Ownership): Promise<boolean> {
  if (!ownership.admissionOpen()) return false;
  if (ownership.sessionValid) {
    const valid = await ownership.sessionValid();
    if (!ownership.admissionOpen() || !valid) return false;
  }
  if (!ownership.admissionOpen()) return false;
  const allowed = await store.owned(ownership.leaseToken, ownership.sessionId);
  return ownership.admissionOpen() && allowed;
}

async function reconcileSaved(
  store: EpisodeStore,
  herdr: HerdrReader,
  targets: readonly string[],
  handoff: NonNullable<SchedulerOptions['handoff']>,
  ownership: Ownership,
): Promise<void> {
  for (const pane of targets) {
    if (!ownership.admissionOpen()) return;
    try {
      await store.withEpisodeLock(pane, async () => {
        if (!ownership.admissionOpen()) return;
        // A corrupt record may contain lost cap history: leave it in place and
        // hand off the runner rather than resetting the same session on restart.
        const record = await store.retry(pane);
        if (!ownership.admissionOpen() || !record) return;
        const current = await herdr.get(pane);
        if (!ownership.admissionOpen()) return;
        // A disconnected socket throws; only a successful read of a missing/changed pane
        // establishes that this particular saved episode is no longer current.
        const replaced = current?.agent_session?.value && current.agent_session.value !== record.session_id;
        if (replaced) {
          const allowed = await owns(store, ownership);
          if (!ownership.admissionOpen()) return;
          if (!allowed) throw new OwnershipLostError('lease lost');
          if (!ownership.admissionOpen()) return;
          await store.clear(pane);
          if (!ownership.admissionOpen()) return;
          await handoff('observation_unavailable');
          return;
        }
        const stopped = current?.agent_status === 'blocked' || current?.agent_status === 'idle';
        if (!ownership.admissionOpen()) return;
        const observed = stopped ? await observeStop(herdr, pane) : null;
        if (!ownership.admissionOpen()) return;
        if (!observed || observed.current_episode_id !== record.failure_episode_id) {
          // A missing, moved or unknown same-session pane needs one human handoff,
          // even if an earlier recovery or decision already ended its timer.
          const lifecycle =
            !current || current.agent_status === 'unknown' || current.workspace_id !== pane.split(':')[0];
          const notifyLifecycle = lifecycle && !record.lifecycle_handoff_sent;
          const quarantine =
            record.last_delivery_state === 'none' || (record.last_delivery_state === 'delivered' && !lifecycle);
          if (!notifyLifecycle && !quarantine) return;
          const allowed = await owns(store, ownership);
          if (!ownership.admissionOpen()) return;
          if (!allowed) throw new OwnershipLostError('lease lost');
          if (!ownership.admissionOpen()) return;
          await store.record(pane, {
            ...record,
            ...(quarantine ? { next_check_at: null, last_delivery_state: 'human' as const } : {}),
            ...(notifyLifecycle ? { lifecycle_handoff_sent: true } : {}),
          });
          if (!ownership.admissionOpen()) return;
          await handoff('observation_unavailable');
        }
      });
    } catch (error) {
      if (!ownership.admissionOpen()) return;
      throw error;
    }
    if (!ownership.admissionOpen()) return;
  }
}

export async function reconcileDue(
  now: Date,
  store: EpisodeStore,
  herdr: HerdrReader & Partial<Pick<HerdrControl, 'prompt'>>,
  decide: (input: StopInput) => Promise<unknown>,
  targets?: readonly string[],
  handoff: SchedulerOptions['handoff'] = async () => {},
  ownership?: Ownership,
): Promise<void> {
  const admissionOpen = ownership?.admissionOpen ?? (() => true);
  if (!admissionOpen()) return;
  const configured = targets ?? (await store.targets());
  if (!admissionOpen()) return;
  const due: { pane: string; record: Episode }[] = [];
  for (const pane of configured) {
    if (!admissionOpen()) return;
    const record = await store.retry(pane);
    if (!admissionOpen()) return;
    if (record?.next_check_at && Date.parse(record.next_check_at) <= now.getTime()) due.push({ pane, record });
  }
  for (const { pane, record } of due) {
    if (!admissionOpen()) return;
    // The hook may replace the episode between the outer scan and lock acquisition.
    // Recheck *all* metadata and the live pane under the lock before clearing.
    let handoffNeeded = false;
    let current: Awaited<ReturnType<HerdrReader['get']>>;
    try {
      current = await store.withEpisodeLock(pane, async () => {
        if (!admissionOpen()) return null;
        const latest = await store.retry(pane);
        if (!admissionOpen()) return null;
        if (JSON.stringify(latest) !== JSON.stringify(record)) return null;
        if (!admissionOpen()) return null;
        const live = await herdr.get(pane);
        if (!admissionOpen()) return null;
        if (!live || (live.agent_status !== 'blocked' && live.agent_status !== 'idle')) {
          if (ownership) {
            const allowed = await owns(store, ownership);
            if (!admissionOpen()) return null;
            if (!allowed) throw new OwnershipLostError('lease lost');
          }
          if (live?.agent_session?.value && live.agent_session.value !== latest?.session_id) {
            if (!admissionOpen()) return null;
            await store.clear(pane);
            if (!admissionOpen()) return null;
            handoffNeeded = true;
          } else if (latest) {
            const lifecycle = !live || live.agent_status === 'unknown' || live.workspace_id !== pane.split(':')[0];
            const shouldHandoff =
              latest.last_delivery_state === 'none' || (lifecycle && !latest.lifecycle_handoff_sent);
            if (!admissionOpen()) return null;
            await store.record(pane, {
              ...latest,
              next_check_at: null,
              last_delivery_state: latest.last_delivery_state === 'none' ? 'human' : latest.last_delivery_state,
              ...(lifecycle ? { lifecycle_handoff_sent: true } : {}),
            });
            if (!admissionOpen()) return null;
            handoffNeeded = shouldHandoff;
          }
        }
        return live;
      });
    } catch (error) {
      if (!admissionOpen()) return;
      throw error;
    }
    if (!admissionOpen()) return;
    if (handoffNeeded) {
      if (!admissionOpen()) return;
      await handoff('observation_unavailable');
      if (!admissionOpen()) return;
      continue;
    }
    if (!current) continue;
    // The event is a wake-up only. handleEvent rechecks history, occupant, and detection
    // under the same per-pane lock used by the one-shot event hook.
    if (!admissionOpen()) return;
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: pane,
        workspace_id: current.workspace_id,
        agent_status: current.agent_status,
        agent: current.agent,
      },
      {
        herdr,
        decide,
        store,
        clock: { now: () => now },
        targets: [pane],
        handoff,
        sessionId: ownership?.sessionId,
        leaseToken: ownership?.leaseToken,
        sessionValid: ownership?.sessionValid,
        admissionOpen,
      },
      true,
    );
    if (!admissionOpen()) return;
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function defaultShutdownDeadline(milliseconds: number, expire: () => void): () => void {
  const timeout = setTimeout(expire, milliseconds);
  return () => clearTimeout(timeout);
}

export async function runScheduler(options: SchedulerOptions): Promise<SchedulerResult> {
  const { store, signal, sessionId, targets, herdr, decide } = options;
  if (signal.aborted) return 'stopped';
  if (!sessionId) return 'already_owned';
  let attempt: LeaseAttempt | undefined;
  let closing = false;
  let releaseStarted = false;
  let finished = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelDeadline: (() => void) | undefined;
  let resolveResult!: (value: SchedulerResult) => void;
  let notifyClosed!: () => void;
  const result = new Promise<SchedulerResult>((resolve) => {
    resolveResult = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  const sleepAbort = new AbortController();
  const cancelBudget = (): void => {
    cancelDeadline?.();
    cancelDeadline = undefined;
  };
  const finish = (value: SchedulerResult): void => {
    if (finished) return;
    finished = true;
    cancelBudget();
    resolveResult(value);
  };
  const beginRelease = (): void => {
    if (!closing || !attempt || releaseStarted) return;
    releaseStarted = true;
    attempt.close();
    try {
      void attempt.release().then(
        () => finish('stopped'),
        () => finish('shutdown_incomplete'),
      );
    } catch {
      finish('shutdown_incomplete');
    }
  };
  const stop = (): void => {
    if (closing || finished) return;
    closing = true;
    attempt?.close();
    notifyClosed();
    if (timer !== undefined) clearInterval(timer);
    sleepAbort.abort();
    // This budget starts at stop entry, never after a pending driver or syscall settles.
    cancelDeadline = (options.shutdownDeadline ?? defaultShutdownDeadline)(5_000, () => finish('shutdown_incomplete'));
    beginRelease();
  };
  const admissionOpen = (): boolean => !closing && !!attempt?.isOpen();
  type OpenValue<T> = { kind: 'value'; value: T } | { kind: 'closed' };
  const waitOpen = <T>(operation: Promise<T>): Promise<OpenValue<T>> =>
    Promise.race([
      operation.then((value): OpenValue<T> => ({ kind: 'value', value })),
      closed.then((): OpenValue<T> => ({ kind: 'closed' })),
    ]);
  const diagnostic = (reason: Parameters<NonNullable<SchedulerOptions['handoff']>>[0]): void => {
    try {
      void options.handoff?.(reason).catch(() => {});
    } catch {
      /* Best-effort fixed diagnostic only. */
    }
  };
  const fatal = (reason: Parameters<NonNullable<SchedulerOptions['handoff']>>[0]): void => {
    if (closing || finished) return;
    stop();
    // Incomplete shutdown has only its release-unconfirmed warning. A confirmed
    // fatal stop may notify, but never joins that notification in the result path.
    void result.then((value) => {
      if (value === 'stopped') diagnostic(reason);
    });
  };

  signal.addEventListener('abort', stop, { once: true });
  try {
    attempt = store.beginAcquire(sessionId);
    if (signal.aborted) stop();
    beginRelease(); // A synchronous abort inside beginAcquire precedes handle assignment.
  } catch {
    fatal('human_review_required');
    finish('shutdown_incomplete');
  }

  const drive = async (): Promise<void> => {
    if (!attempt) return;
    let acquired: OpenValue<string | null>;
    try {
      acquired = await waitOpen(attempt.ready);
    } catch {
      fatal('human_review_required');
      return;
    }
    if (acquired.kind === 'closed' || closing) return;
    const lease = acquired.value;
    if (lease === null) {
      attempt.close();
      diagnostic('human_review_required');
      if (closing) return; // Abort racing refusal retains the revocation result.
      closing = true;
      notifyClosed();
      finish('already_owned');
      return;
    }
    if (!admissionOpen()) return;
    const ownership: Ownership = { sessionId, leaseToken: lease, sessionValid: options.sessionValid, admissionOpen };
    options.onLease?.();
    if (!admissionOpen()) return;
    let heartbeatInFlight = false;
    timer = setInterval(() => {
      if (!admissionOpen() || heartbeatInFlight) return;
      heartbeatInFlight = true;
      const renew = async (): Promise<void> => {
        if (options.sessionValid) {
          const valid = await waitOpen(options.sessionValid());
          if (valid.kind === 'closed' || !admissionOpen()) return;
          if (!valid.value) {
            fatal('observation_unavailable');
            return;
          }
        }
        if (!admissionOpen()) return;
        const renewed = await waitOpen(store.heartbeat(lease, sessionId));
        if (renewed.kind === 'closed' || !admissionOpen()) return;
        if (!renewed.value) fatal('human_review_required');
      };
      void renew().then(
        () => {
          heartbeatInFlight = false;
        },
        () => {
          heartbeatInFlight = false;
          fatal('observation_unavailable');
        },
      );
    }, options.heartbeatIntervalMs ?? 5_000);
    let reconnect = true;
    let outageNotified = false;
    while (admissionOpen()) {
      if (options.sessionValid) {
        const valid = await waitOpen(options.sessionValid());
        if (valid.kind === 'closed' || !admissionOpen()) return;
        if (!valid.value) {
          fatal('observation_unavailable');
          return;
        }
      }
      if (!admissionOpen()) return;
      const renewed = await waitOpen(store.heartbeat(lease, sessionId));
      if (renewed.kind === 'closed' || !admissionOpen()) return;
      if (!renewed.value) {
        fatal('human_review_required');
        return;
      }
      const now = options.clock?.now() ?? new Date();
      const listed = targets ?? (await store.targets());
      if (!admissionOpen()) return;
      try {
        if (reconnect) {
          const saved = await waitOpen(
            reconcileSaved(store, herdr, listed, options.handoff ?? (async () => {}), ownership),
          );
          if (saved.kind === 'closed' || !admissionOpen()) return;
        }
        reconnect = false;
        outageNotified = false;
        if (!admissionOpen()) return;
        const due = await waitOpen(reconcileDue(now, store, herdr, decide, listed, options.handoff, ownership));
        if (due.kind === 'closed' || !admissionOpen()) return;
      } catch (error) {
        if (!admissionOpen()) return;
        if (error instanceof CorruptEpisodeError || error instanceof OwnershipLostError) {
          fatal('observation_unavailable');
          return;
        }
        if (!outageNotified && options.handoff) {
          const notice = await waitOpen(options.handoff('observation_unavailable'));
          if (notice.kind === 'closed' || !admissionOpen()) return;
        }
        reconnect = true;
        outageNotified = true;
      } // Socket failure: reconcile afresh on a bounded next wake.
      if (!admissionOpen()) return;
      let next: number | null = null;
      if (!reconnect) {
        try {
          const scheduled = await waitOpen(store.next(listed));
          if (scheduled.kind === 'closed' || !admissionOpen()) return;
          next = scheduled.value;
        } catch (error) {
          if (!admissionOpen()) return;
          if (error instanceof CorruptEpisodeError) {
            fatal('observation_unavailable');
            return;
          }
          if (!outageNotified && options.handoff) {
            const notice = await waitOpen(options.handoff('observation_unavailable'));
            if (notice.kind === 'closed' || !admissionOpen()) return;
          }
          reconnect = true;
          outageNotified = true;
        }
      }
      if (!admissionOpen()) return;
      const slept = await waitOpen(
        sleep(
          reconnect ? 5_000 : Math.max(100, Math.min(5_000, next === null ? 5_000 : next - now.getTime())),
          sleepAbort.signal,
        ),
      );
      if (slept.kind === 'closed') return;
    }
  };
  // Observe the driver and all abandoned operations; none is a prerequisite for the result.
  void drive().then(stop, () => fatal('observation_unavailable'));
  try {
    return await result;
  } finally {
    signal.removeEventListener('abort', stop);
    cancelBudget();
  }
}
