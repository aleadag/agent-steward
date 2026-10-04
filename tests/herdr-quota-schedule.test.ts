import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEvent, runVisibleScheduler, type EventDeps } from '../src/herdr-adapter/entry.ts';
import { reconcileDue, runScheduler } from '../src/herdr-adapter/scheduler.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { observeStop, type AgentSnapshot } from '../src/herdr-adapter/observe.ts';
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
  await reconcileDue(
    new Date('2026-09-29T10:05:00Z'),
    f.store,
    f.deps.herdr,
    f.deps.decide,
    ['w1:p1'],
    f.deps.handoff,
    undefined,
    async () => {
      calls++;
      return '2026-09-29T10:08:00Z';
    },
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
  await reconcileDue(
    new Date('2026-09-30T10:00:00Z'),
    f.store,
    f.deps.herdr,
    f.deps.decide,
    ['w1:p1'],
    f.deps.handoff,
    undefined,
    async () => {
      hints++;
      return '2026-10-01T10:00:00Z';
    },
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

test('scheduler threads hints to its due-check path', async () => {
  const f = await fixture();
  await handleEvent(event, f.deps);
  const ctrl = new AbortController();
  let hints = 0;
  const timer = setTimeout(() => ctrl.abort(), 1000);
  const observed = await observeStop(reader, 'w1:p1');
  assert.ok(observed);
  // The visible runner acquires its own lease; release the fixture's first owner.
  await f.store.release(f.deps.leaseToken!);
  await runScheduler({
    store: f.store,
    herdr: f.deps.herdr,
    decide: f.deps.decide,
    targets: ['w1:p1'],
    clock: { now: () => new Date('2026-09-29T10:05:00Z') },
    sessionId: 'server-1',
    signal: ctrl.signal,
    quotaHint: async () => {
      hints++;
      return '2026-09-29T10:08:00Z';
    },
    handoff: async () => {},
    // Stop after publishing the advanced timer, not during hint resolution.
  });
  clearTimeout(timer);
  assert.equal(hints, 1);
  assert.equal((await f.store.retry('w1:p1'))?.next_check_at, '2026-09-29T10:08:00.000Z');
});

test('visible runner supplies a real quota hint using its XDG config and state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-wiring-'));
  const server = createServer((socket) => socket.destroy());
  try {
    const configHome = join(root, 'config');
    const stateHome = join(root, 'state');
    await mkdir(join(configHome, 'agent-steward'), { recursive: true });
    await mkdir(join(stateHome, 'agent-steward', 'quota'), { recursive: true });
    await writeFile(
      join(configHome, 'agent-steward', 'config.json'),
      JSON.stringify({
        tools: ['pi'],
        candidates: [
          {
            id: 'one',
            tool: 'pi',
            provider: 'openai-codex',
            model: 'model-one',
            quota_bucket: 'pi_codex',
            quota_pool: 'primary',
            cost: 1,
            capabilities: 'test',
            thinking_levels: [{ id: 'default', description: 'test' }],
          },
        ],
      }),
    );
    await writeFile(
      join(stateHome, 'agent-steward', 'quota', 'pi_codex.json'),
      JSON.stringify({
        schema_version: 1,
        source: 'pi_codex',
        identity_fingerprint: 'a'.repeat(64),
        windows: [
          {
            scope: { type: 'account' },
            remaining_percent: 0,
            observed_at: '2026-09-29T09:59:00Z',
            valid_until: '2026-09-29T10:02:00Z',
            reset_at: '2026-09-29T10:03:00Z',
          },
        ],
      }),
    );
    const socketPath = join(root, 'herdr.sock');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const observed = await observeStop(reader, 'w1:p1');
    assert.ok(observed);
    let hint: string | null | undefined;
    await runVisibleScheduler(
      {
        HOME: join(root, 'unused-home'),
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        HERDR_SOCKET_PATH: socketPath,
        HERDR_PLUGIN_CONFIG_DIR: join(root, 'plugin-config'),
        HERDR_PLUGIN_STATE_DIR: join(root, 'plugin-state'),
      },
      async (options) => {
        assert.ok(options.quotaHint, 'visible runner must wire the production quota hint');
        hint = await options.quotaHint(observed, initial);
        return 'stopped';
      },
    );
    assert.equal(hint, '2026-09-29T10:04:00.000Z');
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    await rm(root, { recursive: true, force: true });
  }
});
