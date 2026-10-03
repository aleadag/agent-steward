import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  readFile,
  stat,
  lstat,
  readdir,
  symlink,
  rename,
  open,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { reconcileDue, runScheduler, type SchedulerOptions } from '../src/herdr-adapter/scheduler.ts';
import { handleEvent, runEvent, type EventDeps } from '../src/herdr-adapter/entry.ts';
import type { AgentSnapshot, HerdrReader, ObservedStop, ReadSnapshot } from '../src/herdr-adapter/observe.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';
import { deferred, within } from './herdr-lease-helpers.ts';
import type { LeaseAttempt, LeaseIO } from '../src/herdr-adapter/lease.ts';

type HandoffReason = Parameters<NonNullable<SchedulerOptions['handoff']>>[0];
type EventTrigger = Parameters<typeof handleEvent>[0];
type TestPane = AgentSnapshot & {
  agent: 'pi';
  agent_session: NonNullable<AgentSnapshot['agent_session']>;
};
type PaneOverrides = Partial<Omit<AgentSnapshot, 'agent' | 'agent_session'>> & {
  agent?: TestPane['agent'];
  agent_session?: TestPane['agent_session'];
};
type TestHerdrReader = Omit<HerdrReader, 'read'> & {
  read: (paneId?: string) => Promise<ReadSnapshot>;
};

const base = async () => new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-state-')));
const now = new Date('2026-09-29T10:05:00Z');
const pane = (overrides: PaneOverrides = {}): TestPane => ({
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'pi',
  agent_status: 'blocked',
  agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 's1' },
  revision: 8,
  state_change_seq: 4,
  ...overrides,
});
const herdr = (text = 'Quota exhausted'): TestHerdrReader => ({
  get: async () => pane(),
  read: async (_paneId?: string) => ({ pane_id: 'w1:p1', source: 'detection', revision: 8, text, truncated: false }),
});
const decision = (
  input: StopInput,
  kind: 'wait_for_quota' = 'wait_for_quota',
  not_before = '2026-09-29T10:20:00Z',
): StopResult => ({
  schema_version: 2,
  request_id: input.request_id,
  decision: 'stop_decision',
  proposed_action: { kind, not_before },
  reason_code: 'quota_limit',
  waiting_for: 'quota_limit',
  waiting_confidence: 1,
  risk_probability: null,
  evaluation: {
    model: 'jev-1.13.0',
    usage: {},
    answers: {
      waiting_for: { type: 'choice', choice: 'quota_limit', probabilities: { quota_limit: 1 }, confidence: 1 },
      risky: { type: 'noul', noul: 0.1 },
    },
  },
});
function episode(id: string): Episode {
  return {
    pane_id: 'w1:p1',
    session_id: 's1',
    failure_episode_id: id,
    error_evidence_digest: id,
    first_observed_at: '2026-09-29T10:00:00Z',
    attempt_count: 0,
    last_attempt_at: null,
    quota_check_count: 0,
    last_quota_check_at: null,
    next_check_at: '2026-09-29T10:05:00Z',
    last_delivery_state: 'none',
  };
}

const requireEpisode = async (store: EpisodeStore, paneId = 'w1:p1'): Promise<Episode> => {
  const record = await store.retry(paneId);
  assert.ok(record);
  return record;
};
const requireLease = async (store: EpisodeStore, session = 'server-1'): Promise<string> => {
  const lease = await store.acquire(session);
  assert.ok(lease);
  return lease;
};
const requireObserved = (observed: ObservedStop | null): ObservedStop => {
  assert.ok(observed);
  return observed;
};
const observe = async (reader: HerdrReader, paneId: string): Promise<ObservedStop> => {
  const { observeStop } = await import('../src/herdr-adapter/observe.ts');
  return requireObserved(await observeStop(reader, paneId));
};
const metadataPath = async (directory: string): Promise<string> => {
  const name = (await readdir(directory)).find((entry) => entry.endsWith('.json'));
  assert.ok(name);
  return join(directory, name);
};
const collect =
  <T>(values: T[]) =>
  async (value: T): Promise<void> => {
    values.push(value);
  };

for (const paneId of ['w1:p1', 'wG:p1', 'wR:p55', 'wE:p2W', 'wR:p5A', 'wa9:pz8']) {
  test(`EpisodeStore round-trips opaque Herdr pane ID ${paneId}`, async () => {
    const store = await base();
    const record = { ...episode('e1'), pane_id: paneId };
    await store.record(paneId, record);
    assert.deepEqual(await store.retry(paneId), record);
    assert.deepEqual(await store.targets(), [paneId]);
    assert.deepEqual(await store.due([paneId], now), [paneId]);
  });
}

test('EpisodeStore rejects persisted malformed pane IDs', async () => {
  const store = await base();
  for (const paneId of [
    '',
    '/bin/sh',
    '../wG:p1',
    'G:p1',
    'wG:1',
    'w:p1',
    'wG:p',
    'wG/p1',
    'w-G:p1',
    'wG:p_1',
    'wG:p1\n',
  ]) {
    await store.record(paneId, { ...episode('e1'), pane_id: paneId });
    await assert.rejects(store.retry(paneId), { message: 'invalid episode metadata' });
  }
});

// Catches reusing a failure ID when the same agent/session resumes and later displays identical old text.
test('episode identity changes when the live stop sequence changes with identical excerpt', async () => {
  const before = await observe(herdr(), 'w1:p1');
  const advanced = { get: async () => pane({ state_change_seq: 5 }), read: herdr().read };
  const after = await observe(advanced, 'w1:p1');
  assert.notEqual(before.current_episode_id, after.current_episode_id);
  assert.match(before.error_evidence_digest, /^[0-9a-f]{64}$/);
  assert.equal(before.error_evidence_digest, after.error_evidence_digest);
});

// Catches treating a timer as authorization to call Jev early, and counting checks as recovery sends.
test('due check re-observes and advances quota history, never recovery attempts', async () => {
  const store = await base();
  const observed = await observe(herdr(), 'w1:p1');
  await store.record('w1:p1', episode(observed.current_episode_id));
  const lease = await requireLease(store);
  const calls: StopInput[] = [];
  assert.equal(await store.active('server-1'), true);
  assert.deepEqual(await store.due(['w1:p1'], now), ['w1:p1']);
  await reconcileDue(new Date('2026-09-29T10:04:59Z'), store, herdr(), async (input) => {
    calls.push(input);
    return decision(input);
  });
  assert.equal(calls.length, 0);
  const handoffs: HandoffReason[] = [];
  await reconcileDue(
    now,
    store,
    herdr(),
    async (input) => {
      calls.push(input);
      return decision(input);
    },
    undefined,
    async (reason) => {
      handoffs.push(reason);
    },
  );
  assert.deepEqual(handoffs, []);
  assert.equal(calls.length, 1);
  assert.equal((await requireEpisode(store)).quota_check_count, 1);
  assert.equal((await requireEpisode(store)).attempt_count, 0);
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:20:00.000Z');
  await store.release(lease);
});

// A failed due decision must not trigger another CLI call on each 100ms scheduler wake.
test('failed due CLI quarantines the episode across repeated scheduler wakes', async () => {
  const store = await base();
  await store.record('w1:p1', episode((await observe(herdr(), 'w1:p1')).current_episode_id));
  const ctrl = new AbortController();
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  const deadline = setTimeout(() => ctrl.abort(), 380);
  try {
    assert.equal(
      await runScheduler({
        store,
        herdr: herdr(),
        decide: async () => {
          decisions++;
          throw new Error('sensitive provider error');
        },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: { now: () => now },
        handoff: async (reason) => {
          handoffs.push(reason);
        },
      }),
      'stopped',
    );
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(decisions, 1);
  assert.deepEqual(handoffs, ['decision_failed']);
  assert.equal((await requireEpisode(store)).next_check_at, null);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
});

// A newly credential-looking detection excerpt must remain local and must not
// cause the same overdue episode to spin indefinitely.
test('credential rejection on a due episode hands off once with no decision', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  for (let i = 0; i < 3; i++)
    await reconcileDue(
      now,
      store,
      herdr('Bearer abcdefghijklmnopqrstuvwxyz'),
      async () => {
        decisions++;
      },
      ['w1:p1'],
      async (reason) => {
        handoffs.push(reason);
      },
    );
  assert.equal(decisions, 0);
  assert.deepEqual(handoffs, ['observation_unavailable']);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  assert.equal((await requireEpisode(store)).next_check_at, null);
  await store.release(lease);
});

// Socket failures are reconnect conditions, not a reason to poll an overdue pane
// at the 100ms due-timer floor or to erase the pending episode.
test('socket outage uses bounded reconnect delay without repeated handoffs', async () => {
  const store = await base();
  await store.record('w1:p1', episode('e1'));
  const ctrl = new AbortController();
  const handoffs: HandoffReason[] = [];
  let reads = 0;
  const deadline = setTimeout(() => ctrl.abort(), 380);
  try {
    await runScheduler({
      store,
      herdr: {
        get: async () => {
          reads++;
          throw new Error('socket unavailable');
        },
        read: herdr().read,
      },
      decide: async () => {
        throw new Error('no decision during outage');
      },
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      handoff: async (reason) => {
        handoffs.push(reason);
      },
    });
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(reads, 1);
  assert.deepEqual(handoffs, ['observation_unavailable']);
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:05:00Z');
});

// The fourth get (after observeStop's stable read) may fail. A transient socket
// failure must leave the episode intact but use reconnect delay, not a 100ms loop.
test('second live get socket failure uses bounded reconnect on repeated scheduler wakes', async () => {
  const store = await base();
  await store.record('w1:p1', episode((await observe(herdr(), 'w1:p1')).current_episode_id));
  let reads = 0;
  let getsAfterRead = 0;
  let decisions = 0;
  const handoffs: HandoffReason[] = [];
  const reader = {
    read: async () => {
      reads++;
      getsAfterRead = 0;
      return herdr().read();
    },
    get: async () => {
      getsAfterRead++;
      if (reads >= 2 && getsAfterRead === 2) throw new Error('sensitive socket error');
      return pane();
    },
  };
  const ctrl = new AbortController();
  const deadline = setTimeout(() => ctrl.abort(), 380);
  try {
    await runScheduler({
      store,
      herdr: reader,
      decide: async () => {
        decisions++;
      },
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      handoff: async (reason) => {
        handoffs.push(reason);
      },
    });
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(reads, 2);
  assert.equal(decisions, 0);
  assert.deepEqual(handoffs, ['observation_unavailable']);
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:05:00Z');
});

// A failed detection socket read is uncertainty, not proof that the saved failure
// changed; preserve it for bounded reconnect rather than terminally quarantine it.
test('due detection socket failure preserves episode for bounded reconnect', async () => {
  const store = await base();
  await store.record('w1:p1', episode((await observe(herdr(), 'w1:p1')).current_episode_id));
  let reads = 0;
  const handoffs: HandoffReason[] = [];
  const reader = {
    get: herdr().get,
    read: async () => {
      reads++;
      if (reads >= 2) throw new Error('sensitive terminal exception');
      return herdr().read();
    },
  };
  const ctrl = new AbortController();
  const deadline = setTimeout(() => ctrl.abort(), 380);
  try {
    await runScheduler({
      store,
      herdr: reader,
      decide: async () => {
        throw new Error('no decision');
      },
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      handoff: async (reason) => {
        handoffs.push(reason);
      },
    });
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(reads, 2);
  assert.deepEqual(handoffs, ['observation_unavailable']);
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:05:00Z');
});

// A confirmed changed revision on the last read must terminally quarantine the
// old due episode; neither CLI nor the 100ms timer may act on the new occupant.
test('second live get revision change quarantines a due episode once', async () => {
  const store = await base();
  await store.record('w1:p1', episode((await observe(herdr(), 'w1:p1')).current_episode_id));
  let reads = 0;
  let getsAfterRead = 0;
  let decisions = 0;
  const handoffs: HandoffReason[] = [];
  const reader = {
    read: async () => {
      reads++;
      getsAfterRead = 0;
      return herdr().read();
    },
    get: async () => {
      getsAfterRead++;
      return reads >= 2 && getsAfterRead === 2 ? pane({ revision: 9 }) : pane();
    },
  };
  const ctrl = new AbortController();
  const deadline = setTimeout(() => ctrl.abort(), 380);
  try {
    await runScheduler({
      store,
      herdr: reader,
      decide: async () => {
        decisions++;
      },
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      handoff: async (reason) => {
        handoffs.push(reason);
      },
    });
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(reads, 2);
  assert.equal(decisions, 0);
  assert.deepEqual(handoffs, ['observation_unavailable']);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  assert.equal((await requireEpisode(store)).next_check_at, null);
});

// A due manual review must be terminal, not a repeatedly reevaluated overdue timer.
test('manual decision at a due check is quarantined across later wakes', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  let decisions = 0;
  for (let i = 0; i < 3; i++)
    await reconcileDue(now, store, herdr(), async (input) => {
      decisions++;
      return { ...decision(input), proposed_action: { kind: 'manual_review' }, reason_code: 'retry_exhausted' };
    });
  assert.equal(decisions, 1);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  await store.release(lease);
});

// Catches a default due check silently ignoring persisted panes other than w1:p1.
test('reconcileDue discovers all persisted configured pane episodes', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const other = {
    get: async () => pane({ pane_id: 'w1:p2' }),
    read: async () => ({
      pane_id: 'w1:p2',
      source: 'detection',
      revision: 8,
      text: 'Quota exhausted',
      truncated: false,
    }),
  };
  const id = (await observe(other, 'w1:p2')).current_episode_id;
  await store.record('w1:p2', { ...episode(id), pane_id: 'w1:p2' });
  let calls = 0;
  await reconcileDue(now, store, other, async (input) => {
    calls++;
    return decision(input);
  });
  assert.equal(calls, 1);
  await store.release(lease);
});

// A missing/non-stopped pre-lock pane read cannot clear another hook's fresh
// episode, even when its replacement has the same due instant.
test('missing-pane cleanup preserves a new due episode written before the lock', async () => {
  const store = await base();
  const lease = await requireLease(store);
  await store.record('w1:p1', episode('old-id'));
  const replacement = { ...episode('new-id'), first_observed_at: '2026-09-29T10:01:00Z' };
  const lock = store.withEpisodeLock.bind(store);
  let interleaved = false;
  store.withEpisodeLock = async (paneId, action) => {
    if (!interleaved) {
      interleaved = true;
      await lock(paneId, async () => {
        await store.clear(paneId);
        await store.record(paneId, replacement);
      });
    }
    return lock(paneId, action);
  };
  let decisions = 0;
  const handoffs: HandoffReason[] = [];
  await reconcileDue(
    now,
    store,
    { get: async () => null, read: herdr().read },
    async () => {
      decisions++;
    },
    ['w1:p1'],
    async (reason) => {
      handoffs.push(reason);
    },
  );
  assert.equal(interleaved, true);
  assert.equal(decisions, 0);
  assert.deepEqual(handoffs, []);
  assert.equal((await requireEpisode(store)).failure_episode_id, 'new-id');
  await store.release(lease);
});

// A different excerpt can be older history, not a fresh failure with a new retry budget.
test('different observed evidence quarantines same-session history without invoking decision or resetting caps', async () => {
  const store = await base();
  await store.record('w1:p1', { ...episode('old-episode'), attempt_count: 3, last_attempt_at: '2026-09-29T10:01:00Z' });
  const lease = await requireLease(store);
  let calls = 0;
  await reconcileDue(now, store, herdr('Different failure'), async () => {
    calls++;
  });
  assert.equal(calls, 0);
  assert.equal((await requireEpisode(store)).attempt_count, 3);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  assert.equal((await requireEpisode(store)).next_check_at, null);
  await store.release(lease);
});

// Only a verified different session frees the old session's history.
test('verified replacement session clears unrelated human-handed-off history', async () => {
  const store = await base();
  const lease = await requireLease(store);
  await store.record('w1:p1', { ...episode('old-id'), last_delivery_state: 'human' });
  const replacement = {
    get: async () => pane({ agent_session: { ...pane().agent_session, value: 's2' } }),
    read: herdr().read,
  };
  await reconcileDue(now, store, replacement, async (input) => decision(input));
  assert.equal(await store.retry('w1:p1'), null);
  await store.release(lease);
});

// Catches advancing a past deadline into a busy loop, or trusting asserted reset evidence.
test('same-session quota churn near 24h preserves first observation and hands off without another check', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  const record = {
    ...episode(id),
    first_observed_at: '2026-09-28T10:00:00Z',
    quota_check_count: 2,
    last_quota_check_at: '2026-09-29T09:55:00Z',
    next_check_at: '2026-09-29T10:00:00Z',
  };
  await store.record('w1:p1', record);
  let live = pane({ agent_status: 'working', revision: 9, state_change_seq: 5 });
  const reader = {
    get: async () => live,
    read: async () => ({
      pane_id: 'w1:p1',
      source: 'detection',
      revision: live.revision,
      text: 'Quota exhausted',
      truncated: false,
    }),
  };
  const handoffs: HandoffReason[] = [];
  let checks = 0;
  const deps: EventDeps = {
    store,
    herdr: reader,
    clock: { now: () => now },
    targets: ['w1:p1'],
    handoff: collect(handoffs),
    decide: async (input) => {
      checks++;
      return decision(input);
    },
  };
  try {
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
      deps,
    );
    live = pane({ agent_status: 'blocked', revision: 10, state_change_seq: 6 });
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked' },
      deps,
    );
    await reconcileDue(new Date('2026-09-29T10:05:00Z'), store, reader, deps.decide, ['w1:p1'], deps.handoff);
    assert.equal(checks, 0);
    assert.equal((await requireEpisode(store)).first_observed_at, record.first_observed_at);
    assert.equal((await requireEpisode(store)).quota_check_count, 2);
    assert.equal((await requireEpisode(store)).next_check_at, null);
    assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
    assert.ok(handoffs.length > 0);
  } finally {
    await store.release(lease);
  }
});

test('past asserted deadline cannot create an immediate check loop', async () => {
  const store = await base();
  const observed = await observe(herdr(), 'w1:p1');
  await store.record('w1:p1', episode(observed.current_episode_id));
  const lease = await requireLease(store);
  await reconcileDue(now, store, herdr(), async (input) => decision(input, 'wait_for_quota', '2026-09-29T09:00:00Z'));
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:20:00.000Z');
  await store.release(lease);
});

// Catches treating an asserted/fabricated decision deadline as verified quota reset.
test('unbound reset proposal cannot replace adapter-owned fallback schedule', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  await reconcileDue(now, store, herdr(), async (input) => decision(input, 'wait_for_quota', '2030-09-29T10:20:00Z'));
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:20:00.000Z');
  await store.release(lease);
});

// Persisted identity must not be silently normalized into another live session.
test('persisted session identity with surrounding whitespace is corrupt, not a match', async () => {
  const store = await base();
  await store.record('w1:p1', episode('e1'));
  const path = await metadataPath(store.directory);
  await writeFile(path, JSON.stringify({ ...episode('e1'), session_id: ' s1 ' }));
  await assert.rejects(store.retry('w1:p1'), { message: 'invalid episode metadata' });
});

// A non-boolean or scheduled notification marker cannot bypass the one-shot gate.
test('persisted malformed lifecycle handoff marker is rejected on read', async () => {
  const store = await base();
  await store.record('w1:p1', episode('e1'));
  const path = await metadataPath(store.directory);
  for (const corrupted of [
    { ...episode('e1'), lifecycle_handoff_sent: 'yes' },
    { ...episode('e1'), lifecycle_handoff_sent: true },
  ]) {
    await writeFile(path, JSON.stringify(corrupted));
    await assert.rejects(store.retry('w1:p1'), { message: 'invalid episode metadata' });
  }
});

// A scheduled check cannot precede its persisted most recent quota observation.
test('persisted next check earlier than quota history is rejected on read', async () => {
  const store = await base();
  await store.record('w1:p1', episode('e1'));
  const path = await metadataPath(store.directory);
  await writeFile(
    path,
    JSON.stringify({ ...episode('e1'), quota_check_count: 1, last_quota_check_at: '2026-09-29T10:20:00Z' }),
  );
  await assert.rejects(store.retry('w1:p1'), { message: 'invalid episode metadata' });
});

test('delivered history emits one fixed handoff for a newly observed exit, unknown or moved pane', async () => {
  const cases: Array<[EventTrigger, AgentSnapshot | null]> = [
    [{ type: 'pane_exited', pane_id: 'w1:p1', workspace_id: 'w1' }, null],
    [
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'unknown' },
      pane({ agent_status: 'unknown' }),
    ],
    [
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
      pane({ workspace_id: 'w2', agent_status: 'working' }),
    ],
  ];
  for (const [trigger, live] of cases) {
    const store = await base();
    const lease = await requireLease(store);
    const original: Episode = {
      ...episode('old-id'),
      next_check_at: null,
      attempt_count: 1,
      last_attempt_at: '2026-09-29T10:01:00Z',
      last_delivery_state: 'delivered',
    };
    await store.record('w1:p1', original);
    const handoffs: HandoffReason[] = [];
    let decisions = 0;
    const deps: EventDeps = {
      store,
      targets: ['w1:p1'],
      clock: { now: () => now },
      herdr: { get: async () => live, read: herdr().read },
      decide: async () => {
        decisions++;
      },
      handoff: collect(handoffs),
    };
    try {
      await handleEvent(trigger, deps);
      await handleEvent(trigger, deps);
      assert.deepEqual(handoffs, ['observation_unavailable']);
      const saved = await requireEpisode(store);
      assert.equal(saved.attempt_count, 1);
      assert.equal(saved.first_observed_at, original.first_observed_at);
      assert.equal(saved.last_delivery_state, 'delivered');
      assert.equal(decisions, 0);
    } finally {
      await store.release(lease);
    }
  }
});

test('missed lifecycle event notifies once on restart even for uncertain or human history', async () => {
  const states: Array<[Episode['last_delivery_state'], AgentSnapshot | null]> = [
    ['uncertain', null],
    ['human', pane({ agent_status: 'unknown' })],
    ['delivered', pane({ workspace_id: 'w2', agent_status: 'working' })],
  ];
  for (const [state, live] of states) {
    const store = await base();
    const original = {
      ...episode('old-id'),
      next_check_at: null,
      attempt_count: 1,
      last_attempt_at: '2026-09-29T10:01:00Z',
      last_delivery_state: state,
    };
    await store.record('w1:p1', original);
    const handoffs: HandoffReason[] = [];
    let decisions = 0;
    const reconciled = deferred<void>();
    const next = store.next.bind(store);
    let nextCalls = 0;
    for (let restart = 0; restart < 2; restart++) {
      if (restart === 1) {
        store.next = async (...args) => {
          const scheduled = await next(...args);
          nextCalls++;
          reconciled.resolve();
          return scheduled;
        };
      }
      const ctrl = new AbortController();
      const running = runScheduler({
        store,
        herdr: { get: async () => live, read: herdr().read },
        decide: async () => {
          decisions++;
        },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: { now: () => now },
        handoff: async (reason) => {
          handoffs.push(reason);
          if (restart === 0 && reason === 'observation_unavailable') ctrl.abort();
        },
      });
      try {
        if (restart === 0) {
          await within(running);
        } else {
          await within(reconciled.promise);
          ctrl.abort();
          await within(running);
        }
      } finally {
        ctrl.abort();
        await within(running);
        if (restart === 1) store.next = next;
      }
      if (restart === 1) assert.equal(nextCalls, 1);
    }
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
    const saved = await requireEpisode(store);
    assert.equal(saved.attempt_count, 1);
    assert.equal(saved.first_observed_at, original.first_observed_at);
    assert.equal(saved.last_delivery_state, state);
    assert.equal(saved.lifecycle_handoff_sent, true);
  }
});

test('non-due moved idle events quarantine one same-session episode and hand off once across restart', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const original = {
    ...episode('old-id'),
    next_check_at: '2026-09-29T10:20:00Z',
    quota_check_count: 1,
    last_quota_check_at: '2026-09-29T10:01:00Z',
  };
  await store.record('w1:p1', original);
  const reader = {
    get: async () => pane({ workspace_id: 'w2', agent_status: 'idle' }),
    read: herdr().read,
    prompt: async () => {
      throw new Error('unexpected prompt');
    },
  };
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  const deps: EventDeps = {
    herdr: reader,
    store,
    clock: { now: () => now },
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: lease,
    sessionValid: async () => true,
    handoff: collect(handoffs),
    decide: async () => {
      decisions++;
      throw new Error('unexpected decision');
    },
  };
  const staleEvent = {
    type: 'pane.agent_status_changed',
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'pi',
    agent_status: 'idle',
  };
  try {
    for (let repeat = 0; repeat < 3; repeat++) await handleEvent(staleEvent, deps);
    const saved = await requireEpisode(store);
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
    assert.equal(saved.lifecycle_handoff_sent, true);
    assert.equal(saved.next_check_at, null);
    assert.equal(saved.last_delivery_state, 'human');
    assert.equal(saved.quota_check_count, original.quota_check_count);
    assert.equal(saved.attempt_count, original.attempt_count);
    await store.release(lease);
    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(), 70);
    try {
      await runScheduler({
        store,
        herdr: reader,
        decide: deps.decide,
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: deps.clock,
        handoff: collect(handoffs),
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
  } finally {
    await store.release(lease);
  }
});

test('a stale workspace event and rejected excerpt do not claim an in-place moved lifecycle', async () => {
  const store = await base();
  const lease = await requireLease(store);
  await store.record('w1:p1', episode('old-id'));
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  const reader = {
    get: async () => pane({ agent_status: 'idle' }),
    read: herdr('Bearer abcdefghijklmnopqrstuvwxyz').read,
  };
  const deps: EventDeps = {
    herdr: reader,
    store,
    clock: { now: () => now },
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: lease,
    sessionValid: async () => true,
    handoff: collect(handoffs),
    decide: async () => {
      decisions++;
    },
  };
  try {
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w2', agent: 'pi', agent_status: 'idle' },
      deps,
      true,
    );
    const saved = await requireEpisode(store);
    assert.equal(saved.lifecycle_handoff_sent, undefined);
    assert.equal(saved.next_check_at, null);
    assert.equal(saved.last_delivery_state, 'human');
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
  } finally {
    await store.release(lease);
  }
});

test('a different session in the moved pane cannot mark the old episode lifecycle', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const original = { ...episode('old-id'), next_check_at: '2026-09-29T10:20:00Z' };
  await store.record('w1:p1', original);
  const reader = {
    get: async () =>
      pane({
        workspace_id: 'w2',
        agent_status: 'idle',
        agent_session: { ...pane().agent_session, value: 'other-session' },
      }),
    read: herdr().read,
  };
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  try {
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w2', agent: 'pi', agent_status: 'idle' },
      {
        herdr: reader,
        store,
        clock: { now: () => now },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        leaseToken: lease,
        sessionValid: async () => true,
        handoff: collect(handoffs),
        decide: async () => {
          decisions++;
        },
      },
    );
    assert.deepEqual(await store.retry('w1:p1'), original);
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
  } finally {
    await store.release(lease);
  }
});

test('overdue timer observing a moved idle pane does not hand off again after restart', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const original = { ...episode('old-id'), quota_check_count: 1, last_quota_check_at: '2026-09-29T10:01:00Z' };
  await store.record('w1:p1', original);
  const reader = {
    get: async () => pane({ workspace_id: 'w2', agent_status: 'idle' }),
    read: async () => ({
      pane_id: 'w1:p1',
      source: 'detection',
      revision: 8,
      text: 'Quota exhausted',
      truncated: false,
    }),
  };
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  try {
    await reconcileDue(
      now,
      store,
      reader,
      async () => {
        decisions++;
      },
      ['w1:p1'],
      collect(handoffs),
    );
    assert.equal((await requireEpisode(store)).lifecycle_handoff_sent, true);
    await store.release(lease);
    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(), 70);
    try {
      await runScheduler({
        store,
        herdr: reader,
        decide: async () => {
          decisions++;
        },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: { now: () => now },
        handoff: collect(handoffs),
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
    assert.equal((await requireEpisode(store)).quota_check_count, 1);
    assert.equal((await requireEpisode(store)).first_observed_at, original.first_observed_at);
  } finally {
    await store.release(lease);
  }
});

test('overdue timer observing unknown status hands off once across later wakes and restart', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const original = { ...episode('old-id'), quota_check_count: 2, last_quota_check_at: '2026-09-29T10:01:00Z' };
  await store.record('w1:p1', original);
  const reader = { get: async () => pane({ agent_status: 'unknown' }), read: herdr().read };
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  try {
    for (let wake = 0; wake < 3; wake++) {
      await reconcileDue(
        now,
        store,
        reader,
        async () => {
          decisions++;
        },
        ['w1:p1'],
        collect(handoffs),
      );
    }
    assert.equal((await requireEpisode(store)).quota_check_count, 2);
    assert.equal((await requireEpisode(store)).first_observed_at, original.first_observed_at);
    assert.equal((await requireEpisode(store)).next_check_at, null);
    assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
    await store.release(lease);
    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(), 70);
    try {
      await runScheduler({
        store,
        herdr: reader,
        decide: async () => {
          decisions++;
        },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: { now: () => now },
        handoff: collect(handoffs),
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
  } finally {
    await store.release(lease);
  }
});

// Restart retains already-quarantined history when resolution is uncertain; only a
// distinct session can establish that the old record is unrelated.
test('runner startup preserves non-due closed moved unknown same-session records and clears replacement', async () => {
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  const states: Array<[AgentSnapshot | null, boolean]> = [
    [null, false],
    [pane({ workspace_id: 'w2' }), false],
    [pane({ agent_status: 'unknown' }), false],
    [pane({ agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 'new-session' } }), true],
  ];
  for (const [current, replaced] of states) {
    const store = await base();
    await store.record('w1:p1', { ...episode(id), next_check_at: null, last_delivery_state: 'human' });
    const ctrl = new AbortController();
    const handoffs: HandoffReason[] = [];
    let decisions = 0;
    const deadline = setTimeout(() => ctrl.abort(), 50);
    try {
      await runScheduler({
        store,
        herdr: { get: async () => current, read: herdr().read },
        decide: async () => {
          decisions++;
        },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: { now: () => now },
        handoff: async (reason) => {
          handoffs.push(reason);
          ctrl.abort();
        },
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
    assert.equal((await store.retry('w1:p1'))?.session_id ?? null, replaced ? null : 's1');
    if (!replaced) assert.equal((await requireEpisode(store)).lifecycle_handoff_sent, true);
  }
});

// Lifecycle events cannot erase same-session caps or trust stale status events;
// verified replacement sessions may clear unrelated records.
test('lifecycle events preserve same-session history and reject stale status events', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  const record = { ...episode(id), next_check_at: '2026-09-29T12:00:00Z' };
  let live: AgentSnapshot | null = pane({ agent_status: 'working' });
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  const deps: EventDeps = {
    store,
    targets: ['w1:p1'],
    clock: { now: () => now },
    herdr: { get: async () => live, read: herdr().read },
    decide: async () => {
      decisions++;
    },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  };
  await store.record('w1:p1', record);
  await handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
    deps,
  );
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  await store.record('w1:p1', record);
  live = null;
  await handleEvent({ type: 'pane_exited', pane_id: 'w1:p1', workspace_id: 'w1' }, deps);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  await store.record('w1:p1', record);
  live = pane();
  await handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
    deps,
  );
  assert.equal((await requireEpisode(store)).failure_episode_id, id);
  live = pane({ workspace_id: 'w2' });
  await handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
    deps,
  );
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  assert.equal((await requireEpisode(store)).lifecycle_handoff_sent, true);
  await store.record('w1:p1', record);
  live = pane({ agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 's2' } });
  await handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' },
    deps,
  );
  assert.equal(await store.retry('w1:p1'), null);
  assert.equal(decisions, 0);
  assert.deepEqual(handoffs, [
    'observation_unavailable',
    'observation_unavailable',
    'observation_unavailable',
    'observation_unavailable',
  ]);
  await store.release(lease);
});

// A malformed persisted field must fail closed once on restart, not strand the timer
// or throw on every wake. These are real on-disk records, not mocked store reads.
test('corrupt episode cannot reset caps on a later same-session hook', async () => {
  const store = await base();
  const lease = await requireLease(store);
  await store.record('w1:p1', { ...episode('previous'), attempt_count: 3, last_attempt_at: '2026-09-29T10:01:00Z' });
  const path = await metadataPath(store.directory);
  await writeFile(path, '{broken retry record');
  let decisions = 0;
  const handoffs: HandoffReason[] = [];
  const deps: EventDeps = {
    store,
    herdr: herdr(),
    clock: { now: () => now },
    targets: ['w1:p1'],
    handoff: collect(handoffs),
    decide: async () => {
      decisions++;
    },
  };
  try {
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked' },
      deps,
    );
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked' },
      deps,
    );
    assert.equal(decisions, 0);
    assert.equal(await readFile(path, 'utf8'), '{broken retry record');
    assert.deepEqual(handoffs, ['observation_unavailable', 'observation_unavailable']);
  } finally {
    await store.release(lease);
  }
});

test('restart quarantines corrupt retry metadata with one bounded handoff', async () => {
  const invalid: Array<(record: Episode) => object> = [
    (record) => ({ ...record, attempt_count: -1 }),
    (record) => ({ ...record, quota_check_count: 'two' }),
    (record) => ({ ...record, last_attempt_at: 'yesterday' }),
    (record) => ({ ...record, last_quota_check_at: 'yesterday' }),
    (record) => ({ ...record, first_observed_at: 'bad-date' }),
    (record) => ({ ...record, next_check_at: 'not-an-instant' }),
    (record) => ({ ...record, last_delivery_state: 'prompt_sent' }),
    (record) => ({ ...record, error_evidence_digest: null }),
    (record) => ({ ...record, session_id: '' }),
    (record) => ({ ...record, quota_check_count: 1, last_quota_check_at: null }),
    (record) => ({ ...record, quota_check_count: 1, last_quota_check_at: '2026-09-29T09:00:00Z' }),
    (record) => ({ ...record, first_observed_at: '2026-09-29T10:10:00Z' }),
  ];
  for (const corrupt of invalid) {
    const store = await base();
    await store.record('w1:p1', episode('e1'));
    const path = await metadataPath(store.directory);
    await writeFile(path, JSON.stringify(corrupt(episode('e1'))));
    const ctrl = new AbortController();
    const handoffs: HandoffReason[] = [];
    let decisions = 0;
    const deadline = setTimeout(() => ctrl.abort(), 400);
    try {
      assert.equal(
        await runScheduler({
          store,
          herdr: herdr(),
          decide: async () => {
            decisions++;
          },
          targets: ['w1:p1'],
          sessionId: 'server-1',
          signal: ctrl.signal,
          clock: { now: () => now },
          handoff: async (reason) => {
            handoffs.push(reason);
            ctrl.abort();
          },
        }),
        'stopped',
      );
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(decisions, 0);
    await assert.rejects(store.retry('w1:p1'), { message: 'invalid episode metadata' });
  }
});

// Catches unprotected metadata files or persisting raw action/terminal text.
// Catches two checks of the same still-limited episode treating one check as a recovery send.
test('successive quota checks advance separately and the 24h boundary hands off', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  await reconcileDue(now, store, herdr(), async (input) => decision(input, 'wait_for_quota', '2026-09-29T10:20:00Z'));
  await reconcileDue(new Date('2026-09-29T10:20:00Z'), store, herdr(), async (input) =>
    decision(input, 'wait_for_quota', '2026-09-29T10:35:00Z'),
  );
  assert.equal((await requireEpisode(store)).quota_check_count, 2);
  assert.equal((await requireEpisode(store)).last_quota_check_at, '2026-09-29T10:20:00.000Z');
  assert.equal((await requireEpisode(store)).attempt_count, 0);
  let boundaryCalls = 0;
  for (let i = 0; i < 3; i++)
    await reconcileDue(new Date('2026-09-30T10:35:00Z'), store, herdr(), async (input) => {
      boundaryCalls++;
      return decision(input, 'wait_for_quota', '2026-09-30T11:00:00Z');
    });
  assert.equal(boundaryCalls, 0);
  assert.equal((await requireEpisode(store)).quota_check_count, 2);
  assert.equal((await requireEpisode(store)).next_check_at, null);
  await store.release(lease);
});

// Catches the installed event path remaining an always-inactive stub or using an old
// agent-less event to schedule a replacement occupant with the same status.
test('installed event path honors lease and rejects delayed event for replaced occupant', async () => {
  const store = await base();
  const config = join(store.directory, 'config');
  await mkdir(config);
  await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: ['w1:p1'] }));
  const socket = join(store.directory, 'herdr.sock');
  let current = pane();
  const server = createServer((connection) => {
    let data = '';
    connection.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      const { id, method } = JSON.parse(data.slice(0, data.indexOf('\n')));
      connection.end(
        JSON.stringify({
          id,
          result:
            method === 'agent.get'
              ? { type: 'agent_info', agent: current }
              : {
                  type: 'pane_read',
                  read: {
                    pane_id: 'w1:p1',
                    source: 'detection',
                    revision: 8,
                    text: 'Quota exhausted',
                    truncated: false,
                  },
                },
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  const info = await stat(socket);
  const session = `${info.dev}:${info.ino}`;
  const lease = await requireLease(store, session);
  let calls = 0;
  const env = {
    HERDR_SOCKET_PATH: socket,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: store.directory,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      type: 'pane.agent_status_changed',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent_status: 'blocked',
    }),
  };
  try {
    await runEvent(env, async (input) => {
      calls++;
      return decision(input, 'wait_for_quota', '2030-09-29T10:20:00Z');
    });
    assert.equal(calls, 1);
    current = pane();
    current.agent_session.value = 's2';
    await runEvent(env, async (input) => {
      calls++;
      return decision(input, 'wait_for_quota', '2030-09-29T10:20:00Z');
    });
    assert.equal(calls, 1);
    assert.equal(await store.retry('w1:p1'), null);
  } finally {
    await store.release(lease);
    await new Promise((resolve) => server.close(resolve));
  }
});

// A decision arriving after lease expiry cannot mutate the episode merely because
// its earlier observation/decision was valid.
test('slow CLI result cannot mutate state after lease expires under a fake clock', async () => {
  let milliseconds = Date.now();
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-slow-')), () => milliseconds);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  const lease = await requireLease(store);
  const handoffs: HandoffReason[] = [];
  await reconcileDue(
    now,
    store,
    herdr(),
    async (input) => {
      milliseconds += 35_000;
      return decision(input);
    },
    ['w1:p1'],
    async (reason) => {
      handoffs.push(reason);
    },
  );
  assert.equal((await requireEpisode(store)).quota_check_count, 0);
  assert.deepEqual(handoffs, ['human_review_required']);
  await store.release(lease);
});

// Heartbeats must continue while a slow CLI decision is pending; advancing more
// than 15s in fake wall time must not disable the visible runner's lease.
test('visible runner renews its lease during a slow CLI evaluation', async () => {
  let milliseconds = Date.now();
  const heldRenames = [deferred<void>(), deferred<void>()] as const;
  const releaseRenames = [deferred<void>(), deferred<void>()] as const;
  let holdTimerRenames = false;
  let heldRenameCount = 0;
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-heartbeat-')), () => milliseconds, {
    io: {
      rename: async (from, to) => {
        if (holdTimerRenames && heldRenameCount < heldRenames.length && to.endsWith('/heartbeat.json')) {
          const index = heldRenameCount++;
          if (index === 0) {
            heldRenames[0].resolve();
            await releaseRenames[0].promise;
          } else {
            holdTimerRenames = false;
            heldRenames[1].resolve();
            await releaseRenames[1].promise;
          }
        }
        await rename(from, to);
      },
    },
  });
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  const ctrl = new AbortController();
  let entered!: () => void;
  let finish!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handoffs: HandoffReason[] = [];
  let heartbeatPath: string | undefined;
  let persistedHeartbeat: number | undefined;
  let checkpoint:
    | {
        epoch: number;
        completed: boolean;
        completion: ReturnType<typeof deferred<number>>;
        stale: ReturnType<typeof deferred<number>>;
      }
    | undefined;
  const originalHeartbeat = store.heartbeat.bind(store);
  store.heartbeat = async (...args) => {
    const renewed = await originalHeartbeat(...args);
    if (renewed && heartbeatPath) {
      const value = JSON.parse(await readFile(heartbeatPath, 'utf8')) as { heartbeat: number };
      persistedHeartbeat = value.heartbeat;
      if (checkpoint && value.heartbeat === checkpoint.epoch) {
        checkpoint.completed = true;
        checkpoint.completion.resolve(value.heartbeat);
      } else if (checkpoint && value.heartbeat < checkpoint.epoch) {
        checkpoint.stale.resolve(value.heartbeat);
      }
    }
    return renewed;
  };
  const originalRecord = store.record.bind(store);
  store.record = async (paneId, value) => {
    await originalRecord(paneId, value);
    if (value.quota_check_count === 1) ctrl.abort();
  };
  const runner = runScheduler({
    store,
    herdr: herdr(),
    decide: async (input) => {
      holdTimerRenames = true;
      entered();
      await held;
      return decision(input);
    },
    targets: ['w1:p1'],
    sessionId: 'server-1',
    signal: ctrl.signal,
    clock: { now: () => now },
    heartbeatIntervalMs: 5,
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  });
  try {
    await within(began);
    await within(heldRenames[0].promise);
    const token = await store.activeToken('server-1');
    assert.ok(token);
    heartbeatPath = join(store.directory, 'scheduler-lease', 'generations', token, 'heartbeat.json');

    const firstEpoch = milliseconds + 10_000;
    const firstCheckpoint = {
      epoch: firstEpoch,
      completed: false,
      completion: deferred<number>(),
      stale: deferred<number>(),
    };
    checkpoint = firstCheckpoint;
    milliseconds = firstEpoch;
    releaseRenames[0].resolve();
    await within(heldRenames[1].promise);
    assert.equal(await within(firstCheckpoint.stale.promise), firstEpoch - 10_000);
    assert.equal(firstCheckpoint.completed, false);
    assert.equal(persistedHeartbeat, firstEpoch - 10_000);
    releaseRenames[1].resolve();
    assert.equal(await within(firstCheckpoint.completion.promise), firstEpoch);
    assert.equal(firstCheckpoint.completed, true);
    assert.equal(persistedHeartbeat, firstEpoch);
    assert.equal(await store.active('server-1'), true);

    for (let i = 0; i < 2; i++) {
      const epoch = milliseconds + 10_000;
      const nextCheckpoint = {
        epoch,
        completed: false,
        completion: deferred<number>(),
        stale: deferred<number>(),
      };
      checkpoint = nextCheckpoint;
      milliseconds = epoch;
      assert.equal(await within(nextCheckpoint.completion.promise), epoch);
      assert.equal(nextCheckpoint.completed, true);
      assert.equal(persistedHeartbeat, epoch);
      assert.equal(await store.active('server-1'), true);
    }
    finish();
    assert.equal(await within(runner), 'stopped');
  } finally {
    holdTimerRenames = false;
    releaseRenames[0].resolve();
    releaseRenames[1].resolve();
    finish();
    ctrl.abort();
    await within(runner).catch(() => {});
  }
  assert.equal((await requireEpisode(store)).quota_check_count, 1);
  assert.deepEqual(handoffs, []);
});

test('abort before a due decision returns leaves the episode unchanged', async () => {
  const store = await base();
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  const original = episode(id);
  await store.record('w1:p1', original);
  const ctrl = new AbortController();
  const entered = deferred<void>();
  const resume = deferred<void>();
  const handoffs: HandoffReason[] = [];
  const runner = runScheduler({
    store,
    herdr: herdr(),
    decide: async (input) => {
      entered.resolve();
      await resume.promise;
      return decision(input);
    },
    targets: ['w1:p1'],
    sessionId: 'server-1',
    signal: ctrl.signal,
    clock: { now: () => now },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  });
  try {
    await within(entered.promise);
    ctrl.abort();
    resume.resolve();
    assert.equal(await within(runner), 'stopped');
    assert.deepEqual(await requireEpisode(store), original);
    assert.deepEqual(handoffs, []);
  } finally {
    resume.resolve();
  }
});

// A submitted generation-local rename is not a prerequisite for revocation.
for (const boundary of ['heartbeat rename', 'timer validation'] as const) {
  test(`abort bypasses in-flight ${boundary} and a pending decision`, async () => {
    const entered = deferred<void>(),
      resume = deferred<void>();
    const deciding = deferred<void>(),
      decisionResume = deferred<void>();
    const settled = deferred<void>(),
      assessment = deferred<void>();
    const timerStarted = deferred<void>();
    let holdTimer = false;
    let renewals = 0;
    let lateRenewal: boolean | undefined;
    const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-heartbeat-race-')), undefined, {
      io: {
        rename: async (from, to) => {
          if (renewals >= 2 && boundary === 'heartbeat rename' && to.endsWith('/heartbeat.json')) {
            await deciding.promise;
            entered.resolve();
            await resume.promise;
          }
          await rename(from, to);
        },
      },
    });
    const original = episode((await observe(herdr(), 'w1:p1')).current_episode_id);
    await store.record('w1:p1', original);
    const heartbeat = store.heartbeat.bind(store);
    store.heartbeat = async (...args) => {
      renewals++;
      if (renewals === 2) timerStarted.resolve();
      const value = await heartbeat(...args);
      if (holdTimer) {
        lateRenewal = value;
        settled.resolve();
      }
      return value;
    };
    const lock = store.withEpisodeLock.bind(store);
    store.withEpisodeLock = async (paneId, action) => {
      const value = await lock(paneId, action);
      if (holdTimer) assessment.resolve();
      return value;
    };
    const ctrl = new AbortController();
    const runner = runScheduler({
      store,
      herdr: herdr(),
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      heartbeatIntervalMs: 5,
      sessionValid: async () => {
        if (holdTimer && boundary === 'timer validation') {
          entered.resolve();
          await resume.promise;
          settled.resolve();
        }
        return true;
      },
      decide: async (input) => {
        if (boundary === 'heartbeat rename') await timerStarted.promise;
        holdTimer = true;
        deciding.resolve();
        await decisionResume.promise;
        return decision(input);
      },
    });
    try {
      await within(deciding.promise);
      await within(entered.promise);
      const token = await store.activeToken('server-1');
      assert.ok(token);
      ctrl.abort();
      assert.equal(await within(runner).catch(() => 'pending'), 'stopped');
      assert.equal(
        (await lstat(join(store.directory, 'scheduler-lease', 'generations', token, 'released'))).isDirectory(),
        true,
      );
      assert.equal(await store.owned(token, 'server-1'), false);
      const calls = renewals;
      resume.resolve();
      decisionResume.resolve();
      await within(settled.promise).catch(() => assert.fail('late timer operation settlement was not observed'));
      await within(assessment.promise);
      assert.equal(renewals, calls);
      if (boundary === 'heartbeat rename') assert.equal(lateRenewal, false);
      assert.deepEqual(await requireEpisode(store), original);
    } finally {
      ctrl.abort();
      resume.resolve();
      decisionResume.resolve();
      await within(runner).catch(() => {});
    }
  });
}

for (const mode of ['confirmed', 'held marker', 'initial owner'] as const) {
  test(`abort independently revokes a pending acquisition: ${mode}`, async () => {
    const entered = deferred<void>(),
      resume = deferred<void>();
    const markerEntered = deferred<void>(),
      markerResume = deferred<void>();
    let expire!: () => void;
    let leases = 0,
      callbacks = 0;
    const io: Partial<LeaseIO> = {
      open: async (path, flags, permissions) => {
        const handle = await open(path, flags, permissions);
        if (mode === 'initial owner' && path.endsWith('/owner.json')) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...args) => {
            entered.resolve();
            await resume.promise;
            return write(...args);
          };
        }
        return handle;
      },
      rename: async (from, to) => {
        if (mode !== 'initial owner' && to.endsWith('/active.json')) {
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
      },
      mkdir: async (path, options) => {
        if (path.endsWith('/released')) {
          markerEntered.resolve();
          if (mode === 'held marker') await markerResume.promise;
        }
        await mkdir(path, options);
      },
    };
    const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-acquire-abort-')), undefined, { io });
    let attempt!: LeaseAttempt;
    const begin = store.beginAcquire.bind(store);
    store.beginAcquire = (session) => (attempt = begin(session));
    const ctrl = new AbortController();
    const running = runScheduler({
      store,
      herdr: herdr(),
      decide: async () => {
        callbacks++;
      },
      targets: [],
      sessionId: 'server-1',
      signal: ctrl.signal,
      onLease: () => {
        leases++;
      },
      sessionValid: async () => {
        callbacks++;
        return true;
      },
      shutdownDeadline: (ms, callback) => {
        assert.equal(ms, 5_000);
        expire = callback;
        return () => {};
      },
    });
    try {
      await within(entered.promise);
      ctrl.abort();
      if (mode !== 'initial owner') {
        assert.equal(await within(markerEntered.promise.then(() => true)).catch(() => false), true);
      }
      if (mode !== 'confirmed') {
        assert.equal(typeof expire, 'function');
        expire();
      }
      assert.equal(
        await within(running).catch(() => 'pending'),
        mode === 'confirmed' ? 'stopped' : 'shutdown_incomplete',
      );
      assert.equal(attempt.isOpen(), false);
      assert.equal((await lstat(join(store.directory, 'takeover-guard'))).isFile(), true);
      assert.equal(await new EpisodeStore(store.directory).acquire('server-1'), null);
      if (mode === 'confirmed') {
        assert.equal(
          (
            await lstat(join(store.directory, 'scheduler-lease', 'generations', attempt.token, 'released'))
          ).isDirectory(),
          true,
        );
      }
      resume.resolve();
      markerResume.resolve();
      assert.equal(await within(attempt.ready), null);
      await within(attempt.release());
      assert.equal(await store.activeToken('server-1'), null);
      assert.equal(leases, 0);
      assert.equal(callbacks, 0);
      await assert.rejects(lstat(join(store.directory, 'takeover-guard')), { code: 'ENOENT' });
    } finally {
      ctrl.abort();
      resume.resolve();
      markerResume.resolve();
      await within(running).catch(() => {});
    }
  });
}

for (const boundary of [
  'sessionValid',
  'main heartbeat',
  'get',
  'read',
  'decide',
  'lock',
  'record',
  'next',
  'handoff',
] as const) {
  test(`abort bypasses every suspended foreground boundary: ${boundary}`, async () => {
    const entered = deferred<void>(),
      resume = deferred<void>(),
      completed = deferred<void>();
    const assessment = deferred<void>();
    let held = false;
    const pause = async () => {
      held = true;
      entered.resolve();
      await resume.promise;
      completed.resolve();
    };
    let heartbeatWrites = 0;
    const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-foreground-abort-')), undefined, {
      io: {
        rename: async (from, to) => {
          if (to.endsWith('/heartbeat.json') && ++heartbeatWrites === 2 && boundary === 'main heartbeat') await pause();
          await rename(from, to);
        },
      },
    });
    const original = episode((await observe(herdr(), 'w1:p1')).current_episode_id);
    await store.record('w1:p1', original);
    const effects: string[] = [];
    const lock = store.withEpisodeLock.bind(store);
    store.withEpisodeLock = async (paneId, action) => {
      if (boundary === 'lock') await pause();
      const result = await lock(paneId, action);
      if (held) assessment.resolve();
      return result;
    };
    const record = store.record.bind(store);
    store.record = async (...args) => {
      effects.push('record');
      if (boundary === 'record') await pause();
      await record(...args);
    };
    const next = store.next.bind(store);
    store.next = async (...args) => {
      if (boundary === 'next') await pause();
      return next(...args);
    };
    const reader = herdr();
    const get = reader.get,
      read = reader.read;
    reader.get = async (...args) => {
      if (boundary === 'get') await pause();
      return get(...args);
    };
    reader.read = async (...args) => {
      if (boundary === 'read') await pause();
      return read(...args);
    };
    if (boundary === 'handoff') reader.get = async () => pane({ agent_status: 'running' });
    const ctrl = new AbortController();
    const running = runScheduler({
      store,
      herdr: {
        ...reader,
        prompt: async () => {
          effects.push('prompt');
        },
      },
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      sessionValid: async () => {
        if (boundary === 'sessionValid') await pause();
        return true;
      },
      decide: async (input) => {
        effects.push('decide');
        if (boundary === 'decide') await pause();
        return decision(input);
      },
      handoff: async () => {
        effects.push('handoff');
        if (boundary === 'handoff') await pause();
      },
    });
    try {
      await within(entered.promise);
      const token = await store.activeToken('server-1');
      assert.ok(token);
      ctrl.abort();
      assert.equal(await within(running).catch(() => 'pending'), 'stopped');
      assert.equal(
        (await lstat(join(store.directory, 'scheduler-lease', 'generations', token, 'released'))).isDirectory(),
        true,
      );
      const before = [...effects];
      resume.resolve();
      await within(completed.promise);
      if (['get', 'read', 'decide', 'lock', 'record', 'handoff'].includes(boundary)) await within(assessment.promise);
      assert.deepEqual(effects, before, 'no new decision, write, prompt or handoff after closure');
      const saved = await requireEpisode(store);
      if (boundary === 'record' || boundary === 'next') assert.equal(saved.quota_check_count, 1);
      else if (boundary !== 'handoff') assert.deepEqual(saved, original);
    } finally {
      ctrl.abort();
      resume.resolve();
      await within(running).catch(() => {});
    }
  });
}

// Ownership loss in reconciliation must not masquerade as a reconnectable socket failure.
for (const loss of ['session', 'ownership'] as const) {
  test(`internal shutdown on reconciliation ${loss} loss precedes a pending handoff`, async () => {
    const store = await base();
    await store.record('w1:p1', episode('old-stop'));
    const noticed = deferred<void>(),
      resume = deferred<void>();
    const ctrl = new AbortController();
    let checks = 0;
    const owned = store.owned.bind(store);
    store.owned = async (...args) => (loss === 'ownership' ? false : owned(...args));
    const reader = herdr();
    reader.get = async () => pane({ agent_status: 'running' });
    const running = runScheduler({
      store,
      herdr: reader,
      decide: async (input) => decision(input),
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      sessionValid: async () => loss !== 'session' || ++checks === 1,
      handoff: async () => {
        noticed.resolve();
        await resume.promise;
      },
    });
    try {
      await within(noticed.promise);
      assert.equal(await within(running).catch(() => 'pending'), 'stopped');
      assert.equal(await store.active('server-1'), false);
    } finally {
      ctrl.abort();
      resume.resolve();
      await within(running).catch(() => {});
    }
  });
}

for (const failure of ['invalid session', 'rejected validation', 'denied heartbeat', 'rejected heartbeat'] as const) {
  test(`timer shutdown ${failure} bypasses pending foreground work`, async () => {
    const store = await base();
    const original = episode((await observe(herdr(), 'w1:p1')).current_episode_id);
    await store.record('w1:p1', original);
    const deciding = deferred<void>(),
      resume = deferred<void>(),
      failed = deferred<void>();
    const assessment = deferred<void>();
    const ctrl = new AbortController();
    let pending = false;
    const heartbeat = store.heartbeat.bind(store);
    store.heartbeat = async (...args) => {
      if (pending && failure.endsWith('heartbeat')) {
        failed.resolve();
        if (failure === 'rejected heartbeat') throw new Error('synthetic-private-error');
        return false;
      }
      return heartbeat(...args);
    };
    const lock = store.withEpisodeLock.bind(store);
    store.withEpisodeLock = async (paneId, action) => {
      const value = await lock(paneId, action);
      if (pending) assessment.resolve();
      return value;
    };
    const running = runScheduler({
      store,
      herdr: herdr(),
      targets: ['w1:p1'],
      sessionId: 'server-1',
      signal: ctrl.signal,
      clock: { now: () => now },
      heartbeatIntervalMs: 5,
      decide: async (input) => {
        pending = true;
        deciding.resolve();
        await resume.promise;
        return decision(input);
      },
      sessionValid: async () => {
        if (pending && !failure.endsWith('heartbeat')) {
          failed.resolve();
          if (failure === 'rejected validation') throw new Error('synthetic-private-error');
          return false;
        }
        return true;
      },
    });
    try {
      await within(deciding.promise);
      await within(failed.promise);
      assert.equal(await within(running).catch(() => 'pending'), 'stopped');
      assert.equal(ctrl.signal.aborted, false);
      resume.resolve();
      await within(assessment.promise);
      assert.deepEqual(await requireEpisode(store), original);
    } finally {
      ctrl.abort();
      resume.resolve();
      await within(running).catch(() => {});
    }
  });
}

// Catches accepting an expired lease as sufficient evidence that a living runner is gone.
test('guarded takeover rejects a living owner even after heartbeat expiry', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const selector = join(store.directory, 'scheduler-lease', 'active.json');
  const original = JSON.parse(await readFile(selector, 'utf8'));
  const heartbeatPath = join(store.directory, 'scheduler-lease', 'generations', original.token, 'heartbeat.json');
  const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8'));
  await writeFile(heartbeatPath, JSON.stringify({ ...heartbeat, heartbeat: 1 }));
  assert.equal(await store.acquire('server-1'), null);
  await store.release(lease);
});

// Catches never reclaiming a verified dead runner after the heartbeat expires.
test('dead expired runner lease is reclaimed and due state is re-observed only', async () => {
  const initial = await base();
  const store = new EpisodeStore(initial.directory, undefined, { alive: (pid) => (pid === 4242 ? false : true) });
  const token = await requireLease(store);
  const root = join(store.directory, 'scheduler-lease');
  const selectorPath = join(root, 'active.json');
  const selected = JSON.parse(await readFile(selectorPath, 'utf8'));
  const ownerPath = join(root, 'generations', token, 'owner.json');
  const heartbeatPath = join(root, 'generations', token, 'heartbeat.json');
  await writeFile(selectorPath, JSON.stringify({ ...selected, pid: 4242 }));
  await writeFile(ownerPath, JSON.stringify({ ...selected, pid: 4242 }));
  const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8'));
  await writeFile(heartbeatPath, JSON.stringify({ ...heartbeat, heartbeat: 1 }));
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  const ctrl = new AbortController();
  const originalRecord = store.record.bind(store);
  store.record = async (paneId, value) => {
    await originalRecord(paneId, value);
    if (value.quota_check_count === 1) ctrl.abort();
  };
  let calls = 0;
  const fallback = setTimeout(() => ctrl.abort(), 1000);
  const result = runScheduler({
    store,
    herdr: herdr(),
    decide: async (input) => {
      calls++;
      return decision(input);
    },
    targets: ['w1:p1'],
    sessionId: 'server-1',
    signal: ctrl.signal,
    clock: { now: () => now },
  });
  assert.equal(await result, 'stopped');
  clearTimeout(fallback);
  assert.equal(calls, 1);
  assert.equal((await requireEpisode(store)).quota_check_count, 1);
  assert.equal(await store.active('server-1'), false);
});

// Catches a crashed one-shot hook permanently blocking all later episode checks.
test('episode lock can be recovered only after expiry and proven owner death', async () => {
  const store = await base();
  await store.prepare();
  const { createHash } = await import('node:crypto');
  const name = createHash('sha256').update('w1:p1').digest('hex') + '.json.lock';
  const lock = join(store.directory, name);
  await mkdir(lock);
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: 99999999, token: 'old', session: 'server-1', heartbeat: 1 }),
  );
  assert.equal(await store.withEpisodeLock('w1:p1', async () => 'reobserved_only'), 'reobserved_only');
});

// Catches rejecting Herdr's precreated private, owned 0755 directory instead of tightening it before writes.
test('precreated owned 0755 state directory is tightened before episode and lease writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-precreated-'));
  const directory = join(root, 'state');
  await mkdir(directory);
  await chmod(directory, 0o755);
  const store = new EpisodeStore(directory);
  const sensitiveEpisode = { ...episode('e1'), context: 'Bearer abcdefghijklmnopqrstuvwxyz' };
  await store.record('w1:p1', sensitiveEpisode);
  const token = await requireLease(store);
  try {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const file = await metadataPath(directory);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).includes('Bearer'), false);
    assert.equal((await requireEpisode(store)).failure_episode_id, 'e1');
    const lease = join(directory, 'scheduler-lease');
    const generation = join(lease, 'generations', token);
    assert.equal((await stat(lease)).mode & 0o777, 0o700);
    assert.equal((await stat(join(lease, 'generations'))).mode & 0o777, 0o700);
    assert.equal((await stat(generation)).mode & 0o777, 0o700);
    assert.equal((await stat(join(lease, 'active.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(generation, 'owner.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(generation, 'heartbeat.json'))).mode & 0o777, 0o600);
  } finally {
    await store.release(token);
  }
});

// Catches relaxing directory safety to accept group/world-writeable state before creating metadata.
test('precreated 0777 state directory is rejected without chmod or state writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-writable-'));
  const directory = join(root, 'state');
  await mkdir(directory);
  await chmod(directory, 0o777);
  const store = new EpisodeStore(directory);
  await assert.rejects(store.record('w1:p1', episode('e1')), /unsafe plugin state directory/);
  await assert.rejects(store.acquire('server-1'), /unsafe plugin state directory/);
  assert.equal((await stat(directory)).mode & 0o777, 0o777);
  assert.deepEqual(await readdir(directory), []);
});

// Catches following a symlink to an otherwise private directory during prepare.
test('symlink state directory is rejected without following or changing its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-linked-'));
  for (const mode of [0o700, 0o755]) {
    const target = join(root, `target-${mode}`);
    await mkdir(target, { mode });
    await chmod(target, mode);
    const directory = join(root, `state-${mode}`);
    await symlink(target, directory);
    const store = new EpisodeStore(directory);
    await assert.rejects(store.record('w1:p1', episode('e1')), /unsafe plugin state directory/);
    await assert.rejects(store.acquire('server-1'), /unsafe plugin state directory/);
    assert.equal((await lstat(directory)).isSymbolicLink(), true);
    assert.equal((await stat(target)).mode & 0o777, mode);
    assert.deepEqual(await readdir(target), []);
  }
});

test('metadata is private, atomic, and excludes unapproved fields', async () => {
  const store = await base();
  const sensitiveEpisode = {
    ...episode('e1'),
    context: 'Bearer abcdefghijklmnopqrstuvwxyz',
    proposal: 'send this',
  };
  await store.record('w1:p1', sensitiveEpisode);
  const file = await metadataPath(store.directory);
  const raw = await readFile(file, 'utf8');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal(raw.includes('Bearer'), false);
  assert.equal(raw.includes('send this'), false);
});

// Catches duplicate visible runners, takeover while old owner lives, and timers continuing after pane close.
// Catches a reconnected socket silently carrying an old server's lease into a new instance.
test('server identity change stops supervision instead of acting on a replacement socket', async () => {
  const store = await base();
  let checks = 0;
  let began;
  const ready = new Promise((resolve) => {
    began = resolve;
  });
  const ctrl = new AbortController();
  const result = runScheduler({
    store,
    herdr: herdr(),
    decide: async (input) => decision(input),
    targets: [],
    sessionId: 'server-1',
    signal: ctrl.signal,
    sessionValid: async () => ++checks === 1,
    onLease: began,
  });
  await ready;
  let abortFallbackTriggered = false;
  const timeout = setTimeout(() => {
    abortFallbackTriggered = true;
    ctrl.abort();
  }, 5200);
  try {
    assert.equal(await result, 'stopped');
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(abortFallbackTriggered, false, 'server identity change must stop supervision before the abort fallback');
  assert.equal(checks, 2);
  assert.equal(await store.active('server-1'), false);
}, 10000);

test('timer record corrupted after reconciliation causes bounded credential-free handoff rather than silent exit', async () => {
  const store = await base();
  const ctrl = new AbortController();
  const handoffs: HandoffReason[] = [];
  const next = store.next.bind(store);
  let interleaved = false;
  store.next = async (targets) => {
    if (!interleaved) {
      interleaved = true;
      await store.record('w1:p1', episode('timer'));
      const path = await metadataPath(store.directory);
      await writeFile(path, JSON.stringify({ ...episode('timer'), next_check_at: 'invalid-timer' }));
    }
    return next(targets);
  };
  const fallback = setTimeout(() => ctrl.abort(), 500);
  try {
    assert.equal(
      await runScheduler({
        store,
        herdr: herdr(),
        decide: async () => {
          throw new Error('unexpected decision');
        },
        targets: ['w1:p1'],
        sessionId: 'server-1',
        signal: ctrl.signal,
        clock: { now: () => now },
        handoff: async (reason) => {
          handoffs.push(reason);
          ctrl.abort();
        },
      }),
      'stopped',
    );
  } finally {
    clearTimeout(fallback);
  }
  assert.equal(interleaved, true);
  assert.deepEqual(handoffs, ['observation_unavailable']);
  assert.equal(await store.active('server-1'), false);
});

test('visible scheduler owns one lease and stops checking when closed', async () => {
  const store = await base();
  const ctrl = new AbortController();
  let began;
  const ready = new Promise((resolve) => {
    began = resolve;
  });
  const runner = runScheduler({
    store,
    herdr: herdr(),
    decide: async (input) => decision(input),
    targets: [],
    sessionId: 'server-1',
    signal: ctrl.signal,
    onLease: began,
  });
  await ready;
  assert.equal(
    await runScheduler({
      store,
      herdr: herdr(),
      decide: async (input) => decision(input),
      targets: [],
      sessionId: 'server-1',
      signal: new AbortController().signal,
    }),
    'already_owned',
  );
  ctrl.abort();
  assert.equal(await runner, 'stopped');
  assert.equal(await store.active('server-1'), false);
});
