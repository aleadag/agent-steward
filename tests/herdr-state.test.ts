import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, mkdir, chmod, writeFile, readFile, stat, lstat, readdir, symlink, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { handleEvent, type EventDeps } from '../src/herdr-adapter/entry.ts';
import type { AgentSnapshot, HerdrReader, ObservedStop, ReadSnapshot } from '../src/herdr-adapter/observe.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';

type HandoffReason = 'observation_unavailable' | 'decision_failed' | 'human_review_required';
async function dueCheck(
  at: Date,
  store: EpisodeStore,
  reader: HerdrReader,
  decide: EventDeps['decide'],
  targets?: readonly string[],
  handoff: EventDeps['handoff'] = async () => {},
  ownership?: {
    sessionId?: string;
    leaseToken?: string;
    sessionValid?: () => Promise<boolean>;
    admissionOpen?: () => boolean;
  },
  quotaHint?: EventDeps['quotaHint'],
): Promise<void> {
  const panes = targets ?? (await store.targets());
  for (const paneId of panes) {
    const record = await store.retry(paneId);
    if (!record?.next_check_at || Date.parse(record.next_check_at) > at.getTime()) continue;
    const current = await reader.get(paneId);
    if (!current) continue;
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: paneId,
        workspace_id: current.workspace_id,
        agent_status: current.agent_status,
        agent: current.agent,
      },
      {
        herdr: reader,
        decide,
        store,
        clock: { now: () => at },
        targets: [paneId],
        handoff,
        quotaHint,
        sessionId: ownership?.sessionId,
        leaseToken: ownership?.leaseToken,
        sessionValid: ownership?.sessionValid,
        admissionOpen: ownership?.admissionOpen,
      },
      true,
    );
  }
}
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

test('canonical session metadata must fit bounded reads and reject control-bearing identifiers', async () => {
  const store = await base();
  try {
    for (const changed of [
      { ...episode('e1'), pane_id: 'w1:p' + 'a'.repeat(9000) },
      { ...episode('e1'), failure_episode_id: 'e\u0000x' },
      { ...episode('e1'), error_evidence_digest: 'e\nother' },
    ])
      await assert.rejects(store.recordSessionRetry('agy', 's1', changed));
    assert.deepEqual(await readdir(store.directory), []);
  } finally {
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('canonical session writes cannot reset anchors, counters or uncertainty across panes', async () => {
  const store = await base();
  const original = {
    ...episode('e1'),
    attempt_count: 1,
    last_attempt_at: '2026-09-29T10:01:00Z',
    last_delivery_state: 'uncertain' as const,
  };
  try {
    await store.recordSessionRetry('agy', 's1', original);
    for (const changed of [
      { ...original, pane_id: 'w2:p2', attempt_count: 0, last_attempt_at: null },
      { ...original, failure_episode_id: 'e2' },
      { ...original, first_observed_at: '2026-09-29T09:00:00Z' },
      { ...original, last_delivery_state: 'none' as const },
    ])
      await assert.rejects(store.recordSessionRetry('agy', 's1', changed));
    assert.deepEqual(await store.sessionRetry('agy', 's1'), original);
    await store.recordSessionRetry('agy', 's1', { ...original, last_delivery_state: 'human', next_check_at: null });
    assert.equal((await store.sessionRetry('agy', 's1'))?.last_delivery_state, 'human');
  } finally {
    await rm(store.directory, { recursive: true, force: true });
  }
});

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

test('episode identity changes when the live stop sequence changes with identical excerpt', async () => {
  const before = await observe(herdr(), 'w1:p1');
  const advanced = { get: async () => pane({ state_change_seq: 5 }), read: herdr().read };
  const after = await observe(advanced, 'w1:p1');
  assert.notEqual(before.current_episode_id, after.current_episode_id);
  assert.match(before.error_evidence_digest, /^[0-9a-f]{64}$/);
  assert.equal(before.error_evidence_digest, after.error_evidence_digest);
});

test('due check re-observes and advances quota history, never recovery attempts', async () => {
  const store = await base();
  const observed = await observe(herdr(), 'w1:p1');
  await store.record('w1:p1', episode(observed.current_episode_id));
  const lease = await requireLease(store);
  const calls: StopInput[] = [];
  assert.equal(await store.active('server-1'), true);
  assert.deepEqual(await store.due(['w1:p1'], now), ['w1:p1']);
  await dueCheck(new Date('2026-09-29T10:04:59Z'), store, herdr(), async (input) => {
    calls.push(input);
    return decision(input);
  });
  assert.equal(calls.length, 0);
  const handoffs: HandoffReason[] = [];
  await dueCheck(
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

test('credential rejection on a due episode hands off once with no decision', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  const handoffs: HandoffReason[] = [];
  let decisions = 0;
  for (let i = 0; i < 3; i++)
    await dueCheck(
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

test('manual decision at a due check is quarantined across later wakes', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  let decisions = 0;
  for (let i = 0; i < 3; i++)
    await dueCheck(now, store, herdr(), async (input) => {
      decisions++;
      return { ...decision(input), proposed_action: { kind: 'manual_review' }, reason_code: 'retry_exhausted' };
    });
  assert.equal(decisions, 1);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  await store.release(lease);
});

test('due handleEvent discovers all persisted configured pane episodes', async () => {
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
  await dueCheck(now, store, other, async (input) => {
    calls++;
    return decision(input);
  });
  assert.equal(calls, 1);
  await store.release(lease);
});

test('different observed evidence quarantines same-session history without invoking decision or resetting caps', async () => {
  const store = await base();
  await store.record('w1:p1', { ...episode('old-episode'), attempt_count: 3, last_attempt_at: '2026-09-29T10:01:00Z' });
  const lease = await requireLease(store);
  let calls = 0;
  await dueCheck(now, store, herdr('Different failure'), async () => {
    calls++;
  });
  assert.equal(calls, 0);
  assert.equal((await requireEpisode(store)).attempt_count, 3);
  assert.equal((await requireEpisode(store)).last_delivery_state, 'human');
  assert.equal((await requireEpisode(store)).next_check_at, null);
  await store.release(lease);
});

test('verified replacement session clears unrelated human-handed-off history', async () => {
  const store = await base();
  const lease = await requireLease(store);
  await store.record('w1:p1', { ...episode('old-id'), last_delivery_state: 'human' });
  const replacement = {
    get: async () => pane({ agent_session: { ...pane().agent_session, value: 's2' } }),
    read: herdr().read,
  };
  await dueCheck(now, store, replacement, async (input) => decision(input));
  assert.equal(await store.retry('w1:p1'), null);
  await store.release(lease);
});

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
    await dueCheck(new Date('2026-09-29T10:05:00Z'), store, reader, deps.decide, ['w1:p1'], deps.handoff);
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
  await dueCheck(now, store, herdr(), async (input) => decision(input, 'wait_for_quota', '2026-09-29T09:00:00Z'));
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:20:00.000Z');
  await store.release(lease);
});

test('unbound reset proposal cannot replace adapter-owned fallback schedule', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  await dueCheck(now, store, herdr(), async (input) => decision(input, 'wait_for_quota', '2030-09-29T10:20:00Z'));
  assert.equal((await requireEpisode(store)).next_check_at, '2026-09-29T10:20:00.000Z');
  await store.release(lease);
});

test('persisted session identity with surrounding whitespace is corrupt, not a match', async () => {
  const store = await base();
  await store.record('w1:p1', episode('e1'));
  const path = await metadataPath(store.directory);
  await writeFile(path, JSON.stringify({ ...episode('e1'), session_id: ' s1 ' }));
  await assert.rejects(store.retry('w1:p1'), { message: 'invalid episode metadata' });
});

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

test('successive quota checks advance separately and the 24h boundary hands off', async () => {
  const store = await base();
  const lease = await requireLease(store);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  await dueCheck(now, store, herdr(), async (input) => decision(input, 'wait_for_quota', '2026-09-29T10:20:00Z'));
  await dueCheck(new Date('2026-09-29T10:20:00Z'), store, herdr(), async (input) =>
    decision(input, 'wait_for_quota', '2026-09-29T10:35:00Z'),
  );
  assert.equal((await requireEpisode(store)).quota_check_count, 2);
  assert.equal((await requireEpisode(store)).last_quota_check_at, '2026-09-29T10:20:00.000Z');
  assert.equal((await requireEpisode(store)).attempt_count, 0);
  let boundaryCalls = 0;
  for (let i = 0; i < 3; i++)
    await dueCheck(new Date('2026-09-30T10:35:00Z'), store, herdr(), async (input) => {
      boundaryCalls++;
      return decision(input, 'wait_for_quota', '2026-09-30T11:00:00Z');
    });
  assert.equal(boundaryCalls, 0);
  assert.equal((await requireEpisode(store)).quota_check_count, 2);
  assert.equal((await requireEpisode(store)).next_check_at, null);
  await store.release(lease);
});

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
  const { socketReader } = await import('../src/herdr-adapter/entry.ts');
  const deps = {
    herdr: socketReader(socket),
    store,
    clock: { now: () => now },
    targets: ['w1:p1'],
    sessionId: session,
    leaseToken: lease,
    sessionValid: async () => true,
    handoff: async () => {},
    decide: async (input: StopInput) => {
      calls++;
      return decision(input, 'wait_for_quota', '2030-09-29T10:20:00Z');
    },
  };
  const event = {
    type: 'pane.agent_status_changed' as const,
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent_status: 'blocked',
  };
  try {
    await handleEvent(event, deps);
    assert.equal(calls, 1);
    current = pane();
    current.agent_session.value = 's2';
    await handleEvent(event, deps);
    assert.equal(calls, 1);
    assert.equal(await store.retry('w1:p1'), null);
  } finally {
    await store.release(lease);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('slow CLI result cannot mutate state after lease expires under a fake clock', async () => {
  let milliseconds = Date.now();
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-slow-')), () => milliseconds);
  const id = (await observe(herdr(), 'w1:p1')).current_episode_id;
  await store.record('w1:p1', episode(id));
  const lease = await requireLease(store);
  const handoffs: HandoffReason[] = [];
  await dueCheck(
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
