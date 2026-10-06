import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEvent, type EventDeps } from '../src/herdr-adapter/entry.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import type { AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';

const initial = new Date('2026-09-29T10:00:00Z');
const pane: AgentSnapshot = {
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'pi',
  agent_status: 'idle',
  agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 's1' },
  revision: 8,
  state_change_seq: 4,
};
const reader = {
  get: async () => pane,
  read: async () => ({
    pane_id: 'w1:p1',
    source: 'detection',
    revision: 8,
    text: 'model-one quota exhausted',
    truncated: false,
  }),
};
function decision(input: StopInput): StopResult {
  return {
    schema_version: 2,
    request_id: input.request_id,
    decision: 'stop_decision',
    proposed_action: { kind: 'wait_for_quota', not_before: '2030-09-29T10:20:00Z' },
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
  };
}
async function fixture() {
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-quota-hint-')));
  const lease = await store.acquire('server-1');
  assert.ok(lease);
  let decisions = 0;
  let deliveries = 0;
  const deps: EventDeps = {
    store,
    herdr: {
      ...reader,
      prompt: async () => {
        deliveries++;
      },
      sendKeys: async () => {
        deliveries++;
      },
    },
    clock: { now: () => initial },
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: lease,
    handoff: async () => {},
    decide: async (input) => {
      decisions++;
      return decision(input);
    },
  };
  return { store, deps, counts: () => ({ decisions, deliveries }) };
}
const event = { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' };

for (const [hint, expected] of [
  ['2026-09-29T10:03:00Z', '2026-09-29T10:03:00.000Z'],
  ['2026-09-29T10:06:00Z', '2026-09-29T10:05:00.000Z'],
  ['2026-09-29T10:00:00Z', '2026-09-29T10:05:00.000Z'],
  ['2026-09-29T09:59:00Z', '2026-09-29T10:05:00.000Z'],
  ['tomorrow', '2026-09-29T10:05:00.000Z'],
  ['2026-09-29 10:03:00', '2026-09-29T10:05:00.000Z'],
  [null, '2026-09-29T10:05:00.000Z'],
] as const) {
  test(`quota hint only advances initial polling: ${hint}`, async () => {
    const f = await fixture();
    let hints = 0;
    await handleEvent(event, {
      ...f.deps,
      quotaHint: async (observed, now) => {
        hints++;
        assert.equal(observed.session_id, 's1');
        assert.equal(now.toISOString(), '2026-09-29T10:00:00.000Z');
        return hint;
      },
    });
    const saved = await f.store.retry('w1:p1');
    assert.equal(saved?.next_check_at, expected);
    assert.equal(saved?.quota_check_count, 0);
    assert.equal(saved?.attempt_count, 0);
    assert.deepEqual(f.counts(), { decisions: 1, deliveries: 0 });
    assert.equal(hints, 1);
  });
}

test('due quota check passes the optional hint without extra assessment or delivery', async () => {
  const f = await fixture();
  await handleEvent(event, f.deps);
  let calls = 0;
  await handleEvent(
    event,
    {
      ...f.deps,
      clock: { now: () => new Date('2026-09-29T10:05:00Z') },
      quotaHint: async () => {
        calls++;
        return '2026-09-29T10:08:00Z';
      },
    },
    true,
  );
  const saved = await f.store.retry('w1:p1');
  assert.equal(saved?.next_check_at, '2026-09-29T10:08:00.000Z');
  assert.equal(saved?.quota_check_count, 1);
  assert.equal(saved?.attempt_count, 0);
  assert.deepEqual(f.counts(), { decisions: 2, deliveries: 0 });
  assert.equal(calls, 1);
});

test('optional quota hint failure keeps normal polling', async () => {
  const f = await fixture();
  let calls = 0;
  await handleEvent(event, {
    ...f.deps,
    quotaHint: async () => {
      calls++;
      throw new Error('private lookup failure');
    },
  });
  assert.equal((await f.store.retry('w1:p1'))?.next_check_at, '2026-09-29T10:05:00.000Z');
  assert.equal(calls, 1);
  assert.deepEqual(f.counts(), { decisions: 1, deliveries: 0 });
});

test('ownership or admission lost during awaited hint prevents timer publication', async () => {
  for (const boundary of ['ownership', 'admission']) {
    const f = await fixture();
    let open = true;
    let valid = true;
    let reached!: () => void;
    let resolve!: (hint: string) => void;
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    const run = handleEvent(event, {
      ...f.deps,
      admissionOpen: () => open,
      sessionValid: async () => valid,
      quotaHint: async () => {
        reached();
        return pending;
      },
    });
    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hint not called')), 1000)),
    ]);
    if (boundary === 'ownership') valid = false;
    else open = false;
    resolve('2026-09-29T10:03:00Z');
    await run;
    assert.equal(await f.store.retry('w1:p1'), null);
    assert.equal(f.counts().deliveries, 0);
  }
});

test('24-hour handoff cannot be extended by a reset hint', async () => {
  const f = await fixture();
  await handleEvent(event, f.deps);
  const record = await f.store.retry('w1:p1');
  assert.ok(record);
  await f.store.record('w1:p1', { ...record, next_check_at: '2026-09-30T10:00:00Z' });
  let hints = 0;
  await handleEvent(
    event,
    {
      ...f.deps,
      clock: { now: () => new Date('2026-09-30T10:00:00Z') },
      quotaHint: async () => {
        hints++;
        return '2026-10-01T10:00:00Z';
      },
    },
    true,
  );
  assert.equal((await f.store.retry('w1:p1'))?.next_check_at, null);
  assert.equal(hints, 0);
  assert.equal(f.counts().deliveries, 0);
});

test('non-quota stop decisions never look up hints', async () => {
  const f = await fixture();
  let hints = 0;
  await handleEvent(event, {
    ...f.deps,
    decide: async (input) => ({
      ...decision(input),
      proposed_action: { kind: 'manual_review' },
    }),
    quotaHint: async () => {
      hints++;
      return '2026-09-29T10:03:00Z';
    },
  });
  assert.equal(hints, 0);
  assert.equal(f.counts().deliveries, 0);
});
