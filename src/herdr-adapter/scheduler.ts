import { handleEvent } from './entry.js';
import { CorruptEpisodeError, EpisodeStore, type Episode } from './state.js';
import { observeStop } from './observe.js';
import type { HerdrReader } from './observe.js';
import type { HerdrControl } from './deliver.js';
import type { StopInput } from '../contracts.js';

export type SchedulerOptions = {
  store: EpisodeStore;
  herdr: HerdrReader & Partial<Pick<HerdrControl, 'prompt'>>;
  decide: (input: StopInput) => Promise<unknown>;
  targets: readonly string[];
  sessionId: string;
  signal: AbortSignal;
  onLease?: () => void;
  handoff?: (reason: 'observation_unavailable' | 'decision_failed' | 'human_review_required') => Promise<void>;
  clock?: { now: () => Date };
  sessionValid?: () => Promise<boolean>;
  heartbeatIntervalMs?: number;
};
type Ownership = { sessionId: string; leaseToken: string; sessionValid?: () => Promise<boolean> };
async function owns(store: EpisodeStore, ownership: Ownership): Promise<boolean> {
  return (
    (await store.owned(ownership.leaseToken, ownership.sessionId)) &&
    (!ownership.sessionValid || (await ownership.sessionValid()))
  );
}

async function reconcileSaved(
  store: EpisodeStore,
  herdr: HerdrReader,
  targets: readonly string[],
  handoff: NonNullable<SchedulerOptions['handoff']>,
  ownership: Ownership,
): Promise<void> {
  for (const pane of targets) {
    await store.withEpisodeLock(pane, async () => {
      // A corrupt record may contain lost cap history: leave it in place and
      // hand off the runner rather than resetting the same session on restart.
      const record = await store.retry(pane);
      if (!record) return;
      const current = await herdr.get(pane);
      // A disconnected socket throws; only a successful read of a missing/changed pane
      // establishes that this particular saved episode is no longer current.
      const replaced = current?.agent_session?.value && current.agent_session.value !== record.session_id;
      if (replaced) {
        if (!(await owns(store, ownership))) throw new Error('lease lost');
        await store.clear(pane);
        await handoff('observation_unavailable');
        return;
      }
      const stopped = current?.agent_status === 'blocked' || current?.agent_status === 'idle';
      const observed = stopped ? await observeStop(herdr, pane) : null;
      if (!observed || observed.current_episode_id !== record.failure_episode_id) {
        // A missing, moved or unknown same-session pane needs one human handoff,
        // even if an earlier recovery or decision already ended its timer.
        const lifecycle = !current || current.agent_status === 'unknown' || current.workspace_id !== pane.split(':')[0];
        const notifyLifecycle = lifecycle && !record.lifecycle_handoff_sent;
        const quarantine =
          record.last_delivery_state === 'none' || (record.last_delivery_state === 'delivered' && !lifecycle);
        if (!notifyLifecycle && !quarantine) return;
        if (!(await owns(store, ownership))) throw new Error('lease lost');
        await store.record(pane, {
          ...record,
          ...(quarantine ? { next_check_at: null, last_delivery_state: 'human' as const } : {}),
          ...(notifyLifecycle ? { lifecycle_handoff_sent: true } : {}),
        });
        await handoff('observation_unavailable');
      }
    });
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
  const configured = targets ?? (await store.targets());
  const due: { pane: string; record: Episode }[] = [];
  for (const pane of configured) {
    const record = await store.retry(pane);
    if (record?.next_check_at && Date.parse(record.next_check_at) <= now.getTime()) due.push({ pane, record });
  }
  for (const { pane, record } of due) {
    // The hook may replace the episode between the outer scan and lock acquisition.
    // Recheck *all* metadata and the live pane under the lock before clearing.
    let handoffNeeded = false;
    const current = await store.withEpisodeLock(pane, async () => {
      const latest = await store.retry(pane);
      if (JSON.stringify(latest) !== JSON.stringify(record)) return null;
      const live = await herdr.get(pane);
      if (!live || (live.agent_status !== 'blocked' && live.agent_status !== 'idle')) {
        if (ownership && !(await owns(store, ownership))) throw new Error('lease lost');
        if (live?.agent_session?.value && live.agent_session.value !== latest?.session_id) {
          await store.clear(pane);
          handoffNeeded = true;
        } else if (latest) {
          const lifecycle = !live || live.agent_status === 'unknown' || live.workspace_id !== pane.split(':')[0];
          handoffNeeded = latest.last_delivery_state === 'none' || (lifecycle && !latest.lifecycle_handoff_sent);
          await store.record(pane, {
            ...latest,
            next_check_at: null,
            last_delivery_state: latest.last_delivery_state === 'none' ? 'human' : latest.last_delivery_state,
            ...(lifecycle ? { lifecycle_handoff_sent: true } : {}),
          });
        }
      }
      return live;
    });
    if (handoffNeeded) {
      await handoff('observation_unavailable');
      continue;
    }
    if (!current) continue;
    // The event is a wake-up only. handleEvent rechecks history, occupant, and detection
    // under the same per-pane lock used by the one-shot event hook.
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
      },
      true,
    );
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

export async function runScheduler(options: SchedulerOptions): Promise<'already_owned' | 'stopped'> {
  const { store, signal, sessionId, targets, herdr, decide } = options;
  if (!sessionId) return 'already_owned';
  const lease = await store.acquire(sessionId);
  if (!lease) {
    await options.handoff?.('human_review_required');
    return 'already_owned';
  }
  const ownership: Ownership = { sessionId, leaseToken: lease, sessionValid: options.sessionValid };
  let heartbeatInFlight = false;
  let invalid = false;
  const timer = setInterval(() => {
    if (heartbeatInFlight || invalid) return;
    heartbeatInFlight = true;
    void (async () => {
      try {
        if ((options.sessionValid && !(await options.sessionValid())) || !(await store.heartbeat(lease, sessionId)))
          invalid = true;
      } catch {
        invalid = true;
      } finally {
        heartbeatInFlight = false;
      }
    })();
  }, options.heartbeatIntervalMs ?? 5_000);
  try {
    options.onLease?.();
    let reconnect = true;
    let outageNotified = false;
    while (!signal.aborted) {
      if (invalid || (options.sessionValid && !(await options.sessionValid()))) {
        await options.handoff?.('observation_unavailable');
        break;
      }
      if (!(await store.heartbeat(lease, sessionId))) {
        await options.handoff?.('human_review_required');
        break;
      }
      const now = options.clock?.now() ?? new Date();
      try {
        if (reconnect) await reconcileSaved(store, herdr, targets, options.handoff ?? (async () => {}), ownership);
        reconnect = false;
        outageNotified = false;
        await reconcileDue(now, store, herdr, decide, targets, options.handoff, ownership);
      } catch (error) {
        if (!outageNotified) await options.handoff?.('observation_unavailable');
        if (error instanceof CorruptEpisodeError) break;
        reconnect = true;
        outageNotified = true;
      } // Socket failure: reconcile afresh on a bounded next wake.
      if (signal.aborted || invalid) break;
      let next: number | null = null;
      if (!reconnect) {
        try {
          next = await store.next(targets);
        } catch (error) {
          if (!outageNotified) await options.handoff?.('observation_unavailable');
          if (error instanceof CorruptEpisodeError) break;
          reconnect = true;
          outageNotified = true;
        }
      }
      await sleep(
        reconnect ? 5_000 : Math.max(100, Math.min(5_000, next === null ? 5_000 : next - now.getTime())),
        signal,
      );
    }
  } finally {
    clearInterval(timer);
    await store.release(lease);
  }
  return 'stopped';
}
