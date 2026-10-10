import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { observeStop } from '../src/herdr-adapter/observe.ts';
import { deliverProposal, type HerdrControl } from '../src/herdr-adapter/deliver.ts';
import { decideWithCli, handleEvent, runEvent, type EventDeps } from '../src/herdr-adapter/entry.ts';
import type { AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import type { Episode } from '../src/herdr-adapter/state.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

type TestHandoffReason = Parameters<EventDeps['handoff']>[0];
const at = '2026-09-29T10:00:30Z';
const text = 'Current API failure: request timed out';
const pane = (change: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'pi',
  agent_status: 'idle',
  agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 's1' },
  revision: 8,
  state_change_seq: 4,
  ...change,
});
type RecoveryResult = Extract<StopResult, { decision: 'stop_decision' }> & {
  proposed_action: Extract<
    Extract<StopResult, { decision: 'stop_decision' }>['proposed_action'],
    { kind: 'send_recovery_instruction' }
  >;
};
const recovery = (input: Pick<StopInput, 'request_id'>): RecoveryResult => ({
  schema_version: 2,
  request_id: input.request_id,
  decision: 'stop_decision',
  proposed_action: {
    kind: 'send_recovery_instruction',
    not_before: at,
    instruction:
      'Continue the interrupted task from the last unfinished step. Before repeating the preceding operation, check whether it succeeded; do not repeat completed actions. If the same failure is still current, retry the operation once. If the task is already complete, report that.',
  },
  reason_code: 'recoverable_api_error',
  waiting_for: 'recoverable_api_error',
  waiting_confidence: 1,
  risk_probability: 0.1,
  evaluation: {
    model: 'jev-1.13.0',
    usage: {},
    answers: {
      waiting_for: {
        type: 'choice',
        choice: 'recoverable_api_error',
        probabilities: { recoverable_api_error: 1 },
        confidence: 1,
      },
      risky: { type: 'noul', noul: 0.1 },
    },
  },
});
type DeliveryHerdr = HerdrControl & {
  change: (pane: AgentSnapshot) => void;
  excerpt: (text: string) => void;
  writes: () => [string, string][];
};
async function setup(tool: string = 'pi', livePi = false, status = 'idle') {
  let current = pane({
      agent: tool,
      agent_status: status,
      agent_session: livePi
        ? {
            agent: 'pi',
            source: 'herdr:pi',
            kind: 'path',
            value: '/home/example/.pi/agent/sessions/synthetic-delivery.jsonl',
          }
        : { agent: tool, source: `integration:${tool}`, kind: 'id', value: 's1' },
    }),
    excerpt = text;
  const writes: [string, string][] = [];
  const herdr: DeliveryHerdr = {
    get: async () => current,
    read: async () => ({
      pane_id: 'w1:p1',
      source: 'detection',
      revision: livePi ? 0 : current.revision,
      text: excerpt,
      truncated: livePi,
    }),
    prompt: async (target, instruction) => {
      writes.push([target, instruction]);
    },
    change: (p) => {
      current = p;
    },
    excerpt: (t) => {
      excerpt = t;
    },
    writes: () => writes,
  };
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-delivery-')));
  const observation = await observeStop(herdr, 'w1:p1');
  assert.ok(observation);
  await store.record('w1:p1', {
    pane_id: 'w1:p1',
    session_id: observation.session_id,
    failure_episode_id: observation.current_episode_id,
    error_evidence_digest: observation.error_evidence_digest,
    first_observed_at: '2026-09-29T10:00:00Z',
    attempt_count: 0,
    last_attempt_at: null,
    quota_check_count: 0,
    last_quota_check_at: null,
    next_check_at: null,
    last_delivery_state: 'none',
  });
  const clock = { now: () => new Date(at) };
  return { herdr, store, observation, clock, proposal: recovery({ request_id: 'old' }) };
}
type DeliveryFixture = Awaited<ReturnType<typeof setup>>;
async function retryEpisode(f: DeliveryFixture): Promise<Episode> {
  const record = await f.store.retry('w1:p1');
  assert.ok(record);
  return record;
}
const deliver = (
  f: DeliveryFixture,
  decide: (input: StopInput) => Promise<StopResult> = async (input) => recovery(input),
  guard: () => Promise<boolean> = async () => true,
) => deliverProposal(f.herdr, f.observation, f.proposal, f.store, f.clock, decide, guard);

test('local closure during authorization cannot admit a write', async () => {
  const f = await setup();
  let open = true;
  const entered = deferred<void>();
  const resume = deferred<void>();
  const original = await retryEpisode(f);
  const running = deliverProposal(
    f.herdr,
    f.observation,
    f.proposal,
    f.store,
    f.clock,
    async (input) => recovery(input),
    async () => {
      entered.resolve();
      await resume.promise;
      return true;
    },
    false,
    () => open,
  );
  await within(entered.promise);
  open = false;
  resume.resolve();
  assert.equal(await within(running), 'human');
  assert.deepEqual(await retryEpisode(f), original);
  assert.deepEqual(f.herdr.writes(), []);
});

test('pre-admitted prompt remains uncertain across release', async () => {
  const f = await setup();
  const lease = await f.store.acquire('server-1');
  assert.ok(lease);
  const entered = deferred<void>();
  const resume = deferred<void>();
  f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]);
    entered.resolve();
    await resume.promise;
  };
  const running = deliver(
    f,
    async (input) => recovery(input),
    () => f.store.leaseMatches(lease, 'server-1'),
  );
  await within(entered.promise);
  assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
  await f.store.release(lease);
  resume.resolve();
  assert.equal(await within(running), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
  assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
});

test('local closure after uncertain prewrite prevents prompt', async () => {
  const f = await setup();
  let open = true;
  const record = f.store.record.bind(f.store);
  f.store.record = async (paneId, episode) => {
    await record(paneId, episode);
    open = false;
  };
  const result = await deliverProposal(
    f.herdr,
    f.observation,
    f.proposal,
    f.store,
    f.clock,
    async (input) => recovery(input),
    async () => true,
    false,
    () => open,
  );
  assert.equal(result, 'uncertain');
  assert.equal(f.herdr.writes().length, 0);
  assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
});

test('local closure during decision leaves the episode unchanged', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  const lease = await f.store.acquire('server-1');
  assert.ok(lease);
  let open = true;
  const entered = deferred<void>();
  const resume = deferred<void>();
  const handoffs: TestHandoffReason[] = [];
  const running = handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' },
    {
      herdr: f.herdr,
      store: f.store,
      clock: f.clock,
      targets: ['w1:p1'],
      sessionId: 'server-1',
      leaseToken: lease,
      sessionValid: async () => true,
      admissionOpen: () => open,
      handoff: async (reason) => {
        handoffs.push(reason);
      },
      decide: async (input) => {
        entered.resolve();
        await resume.promise;
        return recovery(input);
      },
    },
  );
  try {
    await within(entered.promise);
    open = false;
    resume.resolve();
    await within(running);
    assert.equal(await f.store.retry('w1:p1'), null);
    assert.deepEqual(f.herdr.writes(), []);
    assert.deepEqual(handoffs, []);
  } finally {
    resume.resolve();
    await f.store.release(lease);
  }
});

test('session validation finishes before the final token-bound ownership read', async () => {
  const f = await setup();
  const lease = await f.store.acquire('server-1');
  assert.ok(lease);
  let leaseReads = 0;
  const leaseMatches = f.store.leaseMatches.bind(f.store);
  f.store.leaseMatches = async (token, session) => {
    leaseReads++;
    return leaseMatches(token, session);
  };
  const entered = deferred<void>();
  const resume = deferred<void>();
  const original = await retryEpisode(f);
  const running = handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' },
    {
      herdr: f.herdr,
      store: f.store,
      clock: f.clock,
      targets: ['w1:p1'],
      sessionId: 'server-1',
      leaseToken: lease,
      sessionValid: async () => {
        entered.resolve();
        await resume.promise;
        return false;
      },
      handoff: async () => {},
      decide: async (input) => recovery(input),
    },
  );
  await within(entered.promise);
  assert.equal(await f.store.active('server-1'), true);
  assert.equal(leaseReads, 0);
  resume.resolve();
  await within(running);
  assert.equal(leaseReads, 0);
  assert.deepEqual(await retryEpisode(f), original);
  assert.deepEqual(f.herdr.writes(), []);
});

test('a successful ownership snapshot may finish after release without claiming atomic revocation', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  const lease = await f.store.acquire('server-1');
  assert.ok(lease);
  const entered = deferred<void>();
  const resume = deferred<void>();
  const leaseMatches = f.store.leaseMatches.bind(f.store);
  let hold = true;
  f.store.leaseMatches = async (token, session) => {
    const matched = await leaseMatches(token, session);
    if (hold) {
      hold = false;
      entered.resolve();
      await resume.promise;
    }
    return matched;
  };
  let decisions = 0;
  const running = handleEvent(
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' },
    {
      herdr: f.herdr,
      store: f.store,
      clock: f.clock,
      targets: ['w1:p1'],
      sessionId: 'server-1',
      leaseToken: lease,
      sessionValid: async () => true,
      handoff: async () => {},
      decide: async (input) => {
        decisions++;
        return recovery(input);
      },
    },
  );
  await within(entered.promise);
  await f.store.release(lease);
  resume.resolve();
  await within(running);
  assert.equal(decisions, 1, 'the already-admitted check may finish and start work before a fresh check');
  assert.equal(await f.store.retry('w1:p1'), null);
  assert.deepEqual(f.herdr.writes(), []);
});

test('concurrent deliveries for one episode have one prompt submission', async () => {
  const f = await setup();
  const outcomes = await Promise.all([deliver(f), deliver(f)]);
  assert.ok(outcomes.includes('delivered'));
  assert.ok(outcomes.every((outcome) => outcome === 'delivered' || outcome === 'human'));
  assert.equal(f.herdr.writes().length, 1);
});

test('submission timeout persists uncertainty before write and a duplicate event cannot resend', async () => {
  const f = await setup();
  f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]);
    throw new Error('timeout');
  };
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
  assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
});

for (const status of ['idle', 'done']) {
  test(`${status} agent_prompt_stalled after write is uncertain and never resent`, async () => {
    const f = await setup('codex', false, status);
    f.herdr.prompt = async (target, instruction) => {
      f.herdr.writes().push([target, instruction]);
      throw new Error('agent_prompt_stalled');
    };
    assert.equal(await deliver(f), 'uncertain');
    assert.equal(await deliver(f), 'uncertain');
    assert.equal(f.herdr.writes().length, 1);
  });
}

for (const status of ['idle', 'done']) {
  test(`${status} ready Pi and Codex submit fixed instruction once and count only submission`, async () => {
    for (const tool of ['pi', 'codex']) {
      const f = await setup(tool, false, status);
      assert.equal(await deliver(f), 'delivered');
      assert.deepEqual(f.herdr.writes(), [['w1:p1', f.proposal.proposed_action.instruction]]);
      assert.equal((await retryEpisode(f)).attempt_count, 1);
      assert.equal(await deliver(f), 'delivered');
      assert.equal(f.herdr.writes().length, 1);
    }
  });
}

test('best-effort Pi recovery accepts a bounded truncated excerpt but sends only one conditional instruction', async () => {
  const f = await setup('pi', true);
  assert.equal(await deliver(f), 'delivered');
  assert.deepEqual(f.herdr.writes(), [['w1:p1', f.proposal.proposed_action.instruction]]);
  assert.equal((await retryEpisode(f)).attempt_count, 1);
  assert.equal(await deliver(f), 'delivered');
  assert.equal(f.herdr.writes().length, 1);
});

test('future deadline schedules only, and due recheck still needs same deadline', async () => {
  const f = await setup();
  f.clock.now = () => new Date('2026-09-29T10:00:29Z');
  let calls = 0;
  assert.equal(
    await deliver(f, async (input) => {
      calls++;
      return recovery(input);
    }),
    'wait',
  );
  assert.equal(calls, 0);
  assert.equal(f.herdr.writes().length, 0);
  assert.equal((await retryEpisode(f)).next_check_at, at);
  f.clock.now = () => new Date(at);
  assert.equal(
    await deliver(f, async (input) => ({
      ...recovery(input),
      proposed_action: {
        ...recovery(input).proposed_action,
        not_before: '2026-09-29T10:00:31Z',
      },
    })),
    'human',
  );
  assert.equal(f.herdr.writes().length, 0);
});

for (const status of ['idle', 'done']) {
  test(`${status} changed evidence, revision, session, blocked UI and permission UI never prompt`, async () => {
    for (const change of [
      (f: DeliveryFixture) => f.herdr.excerpt('Another API failure'),
      (f: DeliveryFixture) => f.herdr.change(pane({ agent_status: status, revision: 9 })),
      (f: DeliveryFixture) =>
        f.herdr.change(pane({ agent_status: status, agent_session: { ...pane().agent_session!, value: 's2' } })),
      (f: DeliveryFixture) => f.herdr.change(pane({ agent_status: 'blocked' })),
      (f: DeliveryFixture) => f.herdr.change(pane({ agent_status: 'unknown' })),
      (f: DeliveryFixture) => f.herdr.change(pane({ agent_status: 'working' })),
      (f: DeliveryFixture) => f.herdr.change(pane({ agent_status: status === 'idle' ? 'done' : 'idle' })),
    ]) {
      const f = await setup('pi', false, status);
      change(f);
      assert.equal(await deliver(f), 'human');
      assert.equal(f.herdr.writes().length, 0);
    }
    for (const tool of ['pi', 'codex']) {
      const f = await setup();
      f.herdr.change(
        pane({
          agent: tool,
          agent_status: 'blocked',
          agent_session: { agent: tool, source: `integration:${tool}`, kind: 'id', value: 's1' },
        }),
      );
      assert.equal(await deliver(f), 'human');
      assert.equal(f.herdr.writes().length, 0);
    }
    const f = await setup('pi', false, status);
    assert.equal(
      await deliver(f, async (input) => ({
        ...recovery(input),
        proposed_action: { kind: 'approve_request' },
        reason_code: 'low_risk',
        waiting_for: 'approve_command',
      })),
      'human',
    );
    assert.equal(f.herdr.writes().length, 0);
  });
}

for (const [field, value] of [
  ['kind', 'opaque'],
  ['source', 'other'],
] as const) {
  test(`session ${field}-only change before delivery's fresh decision prevents prompt`, async () => {
    const f = await setup('agy');
    const base = await f.herdr.get('w1:p1');
    assert.ok(base?.agent_session);
    f.herdr.change({ ...base, agent_session: { ...base.agent_session, [field]: value } });
    let decisions = 0;
    assert.equal(
      await deliver(f, async (input) => {
        decisions++;
        return recovery(input);
      }),
      'human',
    );
    assert.equal(decisions, 0);
    assert.deepEqual(f.herdr.writes(), []);
    assert.equal((await retryEpisode(f)).attempt_count, 0);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'none');
  });

  test(`session ${field}-only change after delivery's fresh decision prevents prompt`, async () => {
    const f = await setup('agy');
    const base = await f.herdr.get('w1:p1');
    assert.ok(base?.agent_session);
    const next = { ...base, agent_session: { ...base.agent_session, [field]: value } };
    let decisions = 0;
    assert.equal(
      await deliver(f, async (input) => {
        decisions++;
        f.herdr.change(next);
        return recovery(input);
      }),
      'human',
    );
    assert.equal(decisions, 1);
    assert.deepEqual(f.herdr.writes(), []);
    assert.equal((await retryEpisode(f)).attempt_count, 0);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'none');
  });
}

test('error changing after the fresh CLI decision cannot reach prompt', async () => {
  const f = await setup();
  let decided = false;
  f.herdr.read = async () => ({
    pane_id: 'w1:p1',
    source: 'detection',
    revision: 8,
    text: decided ? 'Different operation failed' : text,
    truncated: false,
  });
  assert.equal(
    await deliver(f, async (input) => {
      decided = true;
      return recovery(input);
    }),
    'human',
  );
  assert.equal(f.herdr.writes().length, 0);
});

test('loss of lease/socket proxy just before mutation blocks submission', async () => {
  const f = await setup();
  let checks = 0;
  assert.equal(
    await deliver(
      f,
      async (input) => recovery(input),
      async () => ++checks < 2,
    ),
    'human',
  );
  assert.equal(f.herdr.writes().length, 0);
});

test('lease loss after prewrite but before prompt never submits', async () => {
  const f = await setup();
  let checks = 0;
  assert.equal(
    await deliver(
      f,
      async (input) => recovery(input),
      async () => ++checks < 3,
    ),
    'uncertain',
  );
  assert.equal(f.herdr.writes().length, 0);
  assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
});

test('lease replacement during prompt cannot overwrite the uncertain episode afterward', async () => {
  const f = await setup();
  const oldToken = await f.store.acquire('server-1');
  assert.ok(oldToken);
  let replacement: string | null = null;
  f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]);
    await f.store.release(oldToken);
    replacement = await f.store.acquire('server-1');
  };
  try {
    assert.equal(
      await deliver(
        f,
        async (input) => recovery(input),
        () => f.store.leaseMatches(oldToken, 'server-1'),
      ),
      'uncertain',
    );
    assert.ok(replacement && replacement !== oldToken);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
    assert.equal(f.herdr.writes().length, 1);
  } finally {
    if (replacement) await f.store.release(replacement);
  }
});

test('old hook does not quarantine a successor episode when lease changes during final retry read', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  const oldToken = await f.store.acquire('server-1');
  assert.ok(oldToken);
  const retry = f.store.retry.bind(f.store);
  let reads = 0,
    decisions = 0,
    replacement;
  f.store.retry = async (paneId) => {
    const record = await retry(paneId);
    if (++reads === 3) {
      await f.store.release(oldToken);
      replacement = await f.store.acquire('server-1');
    }
    return record;
  };
  const deps: EventDeps = {
    herdr: f.herdr,
    store: f.store,
    clock: f.clock,
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: oldToken,
    sessionValid: async () => true,
    handoff: async () => {},
    decide: async (input) => {
      decisions++;
      return decisions === 1
        ? recovery(input)
        : { ...recovery(input), proposed_action: { kind: 'manual_review' }, reason_code: 'retry_exhausted' };
    },
  };
  try {
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' },
      deps,
    );
    assert.equal(reads, 3);
    assert.ok(replacement && replacement !== oldToken);
    const successor = await retry('w1:p1');
    assert.ok(successor);
    assert.equal(successor.last_delivery_state, 'none');
    assert.equal(f.herdr.writes().length, 0);
  } finally {
    if (replacement) await f.store.release(replacement);
  }
});

test('no Herdr prompt binary quarantines a new episode after one human handoff', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  delete (f.herdr as Partial<HerdrControl>).prompt;
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const handoffs: TestHandoffReason[] = [];
  const deps: EventDeps = {
    herdr: f.herdr,
    store: f.store,
    clock: f.clock,
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    handoff: async (reason) => {
      handoffs.push(reason);
    },
    decide: async (input) => recovery(input),
  };
  const event = { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' };
  try {
    await handleEvent(event, deps);
    await handleEvent(event, deps);
    assert.deepEqual(handoffs, ['human_review_required']);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'human');
  } finally {
    await f.store.release(token);
  }
});

test('stable moved idle snapshot is not an observation for its configured pane', async () => {
  const f = await setup();
  f.herdr.change(pane({ workspace_id: 'w2' }));
  assert.equal(await observeStop(f.herdr, 'w1:p1'), null);
});

test('moved idle pane without an episode cannot classify, record or receive recovery input', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  f.herdr.change(pane({ workspace_id: 'w2' }));
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const handoffs: TestHandoffReason[] = [];
  let decisions = 0;
  const deps: EventDeps = {
    herdr: f.herdr,
    store: f.store,
    clock: f.clock,
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    handoff: async (reason) => {
      handoffs.push(reason);
    },
    decide: async (input) => {
      decisions++;
      return recovery(input);
    },
  };
  try {
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w2', agent: 'pi', agent_status: 'idle' },
      deps,
    );
    assert.equal(decisions, 0);
    assert.equal(await f.store.retry('w1:p1'), null);
    assert.deepEqual(f.herdr.writes(), []);
    assert.deepEqual(handoffs, ['observation_unavailable']);
  } finally {
    await f.store.release(token);
  }
});

test('final delivery rejects a moved workspace even when the pane snapshot stays stable', async () => {
  const f = await setup();
  let decisions = 0;
  f.herdr.change(pane({ workspace_id: 'w2' }));
  assert.equal(
    await deliver(f, async (input) => {
      decisions++;
      return recovery(input);
    }),
    'human',
  );
  assert.equal(decisions, 0);
  assert.deepEqual(f.herdr.writes(), []);
  assert.equal((await retryEpisode(f)).last_delivery_state, 'none');
});

test('event path passes recovery through a second fresh decision and never resends', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const handoffs: TestHandoffReason[] = [];
  let decisions = 0;
  const deps: EventDeps = {
    herdr: f.herdr,
    store: f.store,
    clock: f.clock,
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    handoff: async (reason) => {
      handoffs.push(reason);
    },
    decide: async (input) => {
      decisions++;
      return recovery(input);
    },
  };
  const event = {
    type: 'pane.agent_status_changed',
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'pi',
    agent_status: 'idle',
  };
  try {
    await handleEvent(event, deps);
    await handleEvent(event, deps);
    assert.equal(decisions, 2);
    assert.equal(f.herdr.writes().length, 1);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'delivered');
    assert.deepEqual(handoffs, []);
  } finally {
    await f.store.release(token);
  }
});

test('delivered recovery survives working then idle with the same old detection text without a second prompt', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const handoffs: TestHandoffReason[] = [];
  let decisions = 0;
  const deps: EventDeps = {
    herdr: f.herdr,
    store: f.store,
    clock: f.clock,
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    handoff: async (reason) => {
      handoffs.push(reason);
    },
    decide: async (input) => {
      decisions++;
      return recovery(input);
    },
  };
  const status = (agent_status: string) => ({
    type: 'pane.agent_status_changed',
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'pi',
    agent_status,
  });
  try {
    await handleEvent(status('idle'), deps);
    assert.equal(f.herdr.writes().length, 1);
    for (let i = 0; i < 4; i++) {
      f.herdr.change(pane({ agent_status: 'working', revision: 9 + i * 2, state_change_seq: 5 + i * 2 }));
      await handleEvent(status('working'), deps);
      f.herdr.change(pane({ revision: 10 + i * 2, state_change_seq: 6 + i * 2 }));
      await handleEvent(status('idle'), deps);
    }
    assert.equal(f.herdr.writes().length, 1, 'status churn must not authorize a fourth or any duplicate prompt');
    assert.equal(decisions, 2);
    assert.equal((await retryEpisode(f)).attempt_count, 1);
    assert.equal((await retryEpisode(f)).first_observed_at, '2026-09-29T10:00:30.000Z');
    assert.ok(handoffs.includes('observation_unavailable'));
  } finally {
    await f.store.release(token);
  }
});

test('unknown prompt delivery remains uncertain after same-session status changes', async () => {
  const f = await setup();
  await f.store.clear('w1:p1');
  f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]);
    throw new Error('unknown outcome');
  };
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const deps: EventDeps = {
    herdr: f.herdr,
    store: f.store,
    clock: f.clock,
    targets: ['w1:p1'],
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    handoff: async () => {},
    decide: async (input) => recovery(input),
  };
  const status = (agent_status: string) => ({
    type: 'pane.agent_status_changed',
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'pi',
    agent_status,
  });
  try {
    await handleEvent(status('idle'), deps);
    f.herdr.change(pane({ agent_status: 'working', revision: 9, state_change_seq: 5 }));
    await handleEvent(status('working'), deps);
    f.herdr.change(pane({ revision: 10, state_change_seq: 6 }));
    await handleEvent(status('idle'), deps);
    assert.equal(f.herdr.writes().length, 1);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'uncertain');
  } finally {
    await f.store.release(token);
  }
});

for (const status of ['idle', 'done']) {
  test(`${status} future recovery event schedules a due re-observation, not a cached prompt`, async () => {
    const f = await setup('codex', false, status);
    await f.store.clear('w1:p1');
    f.clock.now = () => new Date('2026-09-29T10:00:00Z');
    const token = await f.store.acquire('server-1');
    assert.ok(token);
    let decisions = 0;
    const decide: EventDeps['decide'] = async (input) => {
      decisions++;
      return recovery(input);
    };
    const ownership = {
      sessionId: 'server-1',
      leaseToken: token,
      sessionValid: async () => true,
      admissionOpen: () => true,
    };
    try {
      await handleEvent(
        {
          type: 'pane.agent_status_changed',
          pane_id: 'w1:p1',
          workspace_id: 'w1',
          agent: 'codex',
          agent_status: status,
        },
        {
          herdr: f.herdr,
          store: f.store,
          clock: f.clock,
          targets: ['w1:p1'],
          handoff: async () => {},
          decide,
          ...ownership,
        },
      );
      assert.equal(decisions, 1);
      assert.equal(f.herdr.writes().length, 0);
      assert.equal((await retryEpisode(f)).next_check_at, at);
      await handleEvent(
        {
          type: 'pane.agent_status_changed',
          pane_id: 'w1:p1',
          workspace_id: 'w1',
          agent: 'codex',
          agent_status: status,
        },
        {
          herdr: f.herdr,
          store: f.store,
          clock: { now: () => new Date(at) },
          targets: ['w1:p1'],
          handoff: async () => {},
          decide,
          ...ownership,
        },
        true,
      );
      assert.equal(decisions, 3);
      assert.equal(f.herdr.writes().length, 1);
    } finally {
      await f.store.release(token);
    }
  });
}

for (const matchingEvidence of [false, true]) {
  test(`done permission handoff cancels a pending timer once with matching evidence ${matchingEvidence}`, async () => {
    const f = await setup('codex', false, 'done');
    f.herdr.excerpt(
      'Requesting permission for:\n  printf probe\nRun this command?\n> 1. Yes, run command\n  2. No, cancel',
    );
    const menu = await observeStop(f.herdr, 'w1:p1');
    assert.ok(menu);
    const original = {
      ...(await retryEpisode(f)),
      ...(matchingEvidence
        ? { failure_episode_id: menu.current_episode_id, error_evidence_digest: menu.error_evidence_digest }
        : {}),
      attempt_count: 1,
      last_attempt_at: '2026-09-29T10:00:00Z',
      next_check_at: at,
    };
    await f.store.record('w1:p1', original);
    const token = await f.store.acquire('server-1');
    assert.ok(token);
    const handoffs: TestHandoffReason[] = [];
    let decisions = 0;
    const ownership = {
      sessionId: 'server-1',
      leaseToken: token,
      sessionValid: async () => true,
      admissionOpen: () => true,
    };
    const deps: EventDeps = {
      ...ownership,
      herdr: f.herdr,
      store: f.store,
      clock: f.clock,
      targets: ['w1:p1'],
      autoApprove: false,
      handoff: async (reason) => {
        handoffs.push(reason);
      },
      decide: async (input) => {
        decisions++;
        return recovery(input);
      },
    };
    const event = {
      type: 'pane.agent_status_changed',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent: 'codex',
      agent_status: 'done',
    };
    try {
      await handleEvent(event, deps);
      await handleEvent(event, deps);
      await handleEvent(event, deps, true);
      assert.equal(handoffs.length, 1);
      assert.equal(decisions, 0);
      assert.deepEqual(f.herdr.writes(), []);
      assert.deepEqual(await retryEpisode(f), { ...original, next_check_at: null, last_delivery_state: 'human' });
    } finally {
      await f.store.release(token);
    }
  });
}

test('due scheduler keeps its original lease token across a held decision', async () => {
  const f = await setup();
  const record = await f.store.retry('w1:p1');
  assert.ok(record);
  const original: Episode = { ...record, next_check_at: at };
  await f.store.record('w1:p1', original);
  const oldToken = await f.store.acquire('server-1');
  assert.ok(oldToken);
  let entered!: () => void;
  let releaseDecision!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  const handoffs: TestHandoffReason[] = [];
  let replacement: string | null = null;
  try {
    const oldDue = handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent: 'pi',
        agent_status: 'idle',
      },
      {
        herdr: f.herdr,
        store: f.store,
        clock: { now: () => new Date(at) },
        targets: ['w1:p1'],
        decide: async (input) => {
          entered();
          await held;
          return recovery(input);
        },
        handoff: async (reason) => {
          handoffs.push(reason);
        },
        sessionId: 'server-1',
        leaseToken: oldToken,
        sessionValid: async () => true,
        admissionOpen: () => true,
      },
      true,
    );
    await pending;
    await f.store.release(oldToken);
    replacement = await f.store.acquire('server-1');
    assert.ok(replacement && replacement !== oldToken);
    releaseDecision();
    await oldDue;
    assert.deepEqual(await f.store.retry('w1:p1'), original);
    assert.equal(f.herdr.writes().length, 0);
    assert.deepEqual(handoffs, ['human_review_required']);
  } finally {
    releaseDecision?.();
    if (replacement) await f.store.release(replacement);
  }
});

test('installed event uses the supplied Herdr 0.9.1 agent prompt CLI, not raw pane input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-delivery-wire-'));
  const socket = join(directory, 'herdr.sock'),
    executable = join(directory, 'fake-herdr');
  const config = join(directory, 'config'),
    plugin = join(directory, 'plugin'),
    state = join(directory, 'state'),
    calls = join(directory, 'calls.json');
  await mkdir(config);
  await mkdir(plugin);
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n');
  await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: ['w1:p1'] }));
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
  );
  await chmod(executable, 0o755);
  const live = pane({
    agent_session: { agent: 'pi', source: 'herdr:pi', kind: 'id', value: 's1' },
  });
  const server = createServer((connection) => {
    let bytes = '';
    connection.on('data', (chunk) => {
      bytes += chunk;
      if (!bytes.includes('\n')) return;
      const { id, method } = JSON.parse(bytes.slice(0, bytes.indexOf('\n')));
      connection.end(
        JSON.stringify({
          id,
          result:
            method === 'plugin.list'
              ? {
                  type: 'plugin_list',
                  plugins: [
                    {
                      plugin_id: 'agent-steward-recover',
                      name: 'Agent Steward recover',
                      version: '0.1.0',
                      plugin_root: plugin,
                      manifest_path: join(plugin, 'herdr-plugin.toml'),
                      enabled: true,
                    },
                  ],
                }
              : method === 'agent.get'
                ? { type: 'agent_info', agent: live }
                : {
                    type: 'pane_read',
                    read: { pane_id: 'w1:p1', source: 'detection', revision: 8, text, truncated: false },
                  },
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  const env = {
    HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: executable,
    HERDR_PLUGIN_ID: 'agent-steward-recover',
    HERDR_PLUGIN_ROOT: plugin,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      type: 'pane.agent_status_changed',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent: 'pi',
      agent_status: 'idle',
    }),
  };
  try {
    await runEvent(env, async (input) => recovery(input));
    assert.deepEqual(
      (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [['agent', 'prompt', 'w1:p1', recovery({ request_id: 'unused' }).proposed_action.instruction]],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('fresh stop check subprocess is required before prompt; malformed outcome cannot send', async () => {
  const f = await setup();
  const dir = await mkdtemp(join(tmpdir(), 'steward-delivery-cli-'));
  const script = join(dir, 'fake.mjs');
  await writeFile(
    script,
    `let data = ''; for await (const part of process.stdin) data += part;
const input = JSON.parse(data);
if (process.argv.slice(2).join(' ') !== 'stop check' || input.context !== ${JSON.stringify(text)}) process.exit(41);
const response = ${JSON.stringify(recovery({ request_id: 'template' }))};
response.request_id = input.request_id;
process.stdout.write(JSON.stringify(response));`,
  );
  assert.equal(await deliver(f, (input) => decideWithCli(input, script)), 'delivered');
  assert.equal(f.herdr.writes().length, 1);
  const bad = await setup();
  await writeFile(script, `process.stdout.write('{}');`);
  assert.equal(await deliver(bad, (input) => decideWithCli(input, script)), 'human');
  assert.equal(bad.herdr.writes().length, 0);
});

const permissionDialog =
  'Requesting permission for:\n  printf probe\nRun this command?\n> 1. Yes, run command\n  2. No, cancel';
const partialPermission = 'Requesting permission for:\n  printf probe\nRun this command?\n> 1. Yes, run command';

test('due recovery cannot send approval keys for a recognized permission menu', async () => {
  const f = await setup('codex', false, 'idle');
  f.herdr.excerpt(permissionDialog);
  const menu = await observeStop(f.herdr, 'w1:p1');
  assert.ok(menu);
  const original: Episode = {
    ...(await retryEpisode(f)),
    failure_episode_id: menu.current_episode_id,
    error_evidence_digest: menu.error_evidence_digest,
    attempt_count: 1,
    last_attempt_at: '2026-09-29T10:00:00Z',
    next_check_at: at,
  };
  await f.store.record('w1:p1', original);
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const keys: string[][] = [];
  const handoffs: TestHandoffReason[] = [];
  let decisions = 0;
  try {
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent: 'codex',
        agent_status: 'idle',
      },
      {
        herdr: {
          ...f.herdr,
          sendKeys: async (_pane, input) => {
            keys.push(input);
          },
        },
        store: f.store,
        clock: f.clock,
        targets: ['w1:p1'],
        autoApprove: true,
        sessionId: 'server-1',
        leaseToken: token,
        sessionValid: async () => true,
        handoff: async (reason) => {
          handoffs.push(reason);
        },
        decide: async (input) => {
          decisions++;
          return recovery(input);
        },
      },
      true,
    );
    assert.deepEqual(keys, []);
    assert.equal(decisions, 0);
    assert.equal((await retryEpisode(f)).next_check_at, null);
    assert.equal((await retryEpisode(f)).attempt_count, 1);
    assert.equal((await retryEpisode(f)).last_delivery_state, 'human');
    assert.equal(handoffs.length, 1);
  } finally {
    await f.store.release(token);
  }
});

test('due recovery does not treat a partial permission menu as a reason to poll', async () => {
  const f = await setup('codex', false, 'idle');
  f.herdr.excerpt(partialPermission);
  const menu = await observeStop(f.herdr, 'w1:p1');
  assert.ok(menu);
  await f.store.record('w1:p1', {
    ...(await retryEpisode(f)),
    failure_episode_id: menu.current_episode_id,
    error_evidence_digest: menu.error_evidence_digest,
    attempt_count: 1,
    last_attempt_at: '2026-09-29T10:00:00Z',
    next_check_at: at,
  });
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const handoffs: TestHandoffReason[] = [];
  let decisions = 0;
  let reads = 0;
  const read = f.herdr.read.bind(f.herdr);
  f.herdr.read = async (pane) => {
    reads++;
    return read(pane);
  };
  try {
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent: 'codex',
        agent_status: 'idle',
      },
      {
        herdr: f.herdr,
        store: f.store,
        clock: f.clock,
        targets: ['w1:p1'],
        autoApprove: true,
        sessionId: 'server-1',
        leaseToken: token,
        sessionValid: async () => true,
        handoff: async (reason) => {
          handoffs.push(reason);
        },
        decide: async (input) => {
          decisions++;
          return recovery(input);
        },
      },
      true,
    );
    assert.equal(decisions, 1);
    assert.equal(reads, 2);
    assert.equal((await retryEpisode(f)).next_check_at, null);
    assert.equal((await retryEpisode(f)).attempt_count, 1);
    assert.ok(handoffs.length >= 1);
    assert.deepEqual(f.herdr.writes(), []);
  } finally {
    await f.store.release(token);
  }
});

async function scopedDelivery(status: 'idle' | 'done' = 'idle') {
  const { beginWorkflow } = await import('../src/herdr-adapter/authority.ts');
  const { WorkflowState } = await import('../src/herdr-adapter/workflow-state.ts');
  const { workflowEventDeps } = await import('../src/herdr-adapter/events.ts');
  const root = await mkdtemp(join(tmpdir(), 'steward-scoped-delivery-'));
  const state = new WorkflowState(root);
  const store = new EpisodeStore(root);
  const attempt = beginWorkflow({
    state,
    scope: {
      serverId: '47:1',
      agent: 'agy',
      sessionId: 's1',
      sessionKind: 'id',
      sessionSource: 'herdr:antigravity_cli',
    },
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all' as const, autoApprove: false }),
    signal: new AbortController().signal,
  });
  const authority = await attempt.ready;
  assert.ok(authority);
  let current = pane({
    agent: 'agy',
    agent_status: status,
    agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 's1' },
  });
  let excerpt = text;
  const writes: [string, string][] = [];
  const herdr: DeliveryHerdr = {
    get: async (id = current.pane_id) =>
      id === current.pane_id ? current : { ...current, pane_id: id, workspace_id: id.split(':')[0]! },
    read: async (id = current.pane_id) => ({
      pane_id: id,
      source: 'detection',
      revision: current.revision,
      text: excerpt,
      truncated: false,
    }),
    prompt: async (target, instruction) => {
      writes.push([target, instruction]);
    },
    change: (next) => {
      current = next;
    },
    excerpt: (next) => {
      excerpt = next;
    },
    writes: () => writes,
  };
  const clock = { now: () => new Date(at) };
  return {
    state,
    store,
    attempt,
    authority,
    herdr,
    clock,
    workflowEventDeps,
    cleanup: async () => {
      attempt.close();
      await attempt.finish();
    },
  };
}

for (const association of ['ambiguous', 'corrupt', 'closed_after_association', 'paused_after_association'] as const) {
  test(`scoped ${association} legacy association has no budget or input and hands off only while authorized`, async () => {
    const f = await scopedDelivery();
    const held = association === 'closed_after_association' || association === 'paused_after_association';
    const entered = deferred<void>();
    const resume = deferred<void>();
    let running: Promise<void> | undefined;
    try {
      const observed = await observeStop(f.herdr, 'w1:p1');
      assert.ok(observed);
      const legacy: Episode = {
        pane_id: 'w1:p1',
        session_id: 's1',
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: '2026-09-29T10:00:00Z',
        attempt_count: 2,
        last_attempt_at: '2026-09-29T10:00:20Z',
        quota_check_count: 1,
        last_quota_check_at: '2026-09-29T10:00:10Z',
        next_check_at: '2026-09-29T10:05:00Z',
        last_delivery_state: 'none',
      };
      await f.store.record('w1:p1', legacy);
      if (association === 'corrupt') {
        const path = join(f.store.directory, createHash('sha256').update('w1:p1').digest('hex') + '.json');
        await writeFile(path, '{', { mode: 0o600 });
      } else {
        await f.store.record('w1:p2', { ...legacy, pane_id: 'w1:p2' });
      }
      if (held) {
        const adopt = f.state.adoptLegacyRetry.bind(f.state);
        f.state.adoptLegacyRetry = async (...args) => {
          const result = await adopt(...args);
          assert.equal(result, 'quarantined');
          entered.resolve();
          await resume.promise;
          return result;
        };
      }
      const handoffs: TestHandoffReason[] = [];
      let decisions = 0;
      const deps = f.workflowEventDeps(
        {
          herdr: f.herdr,
          store: f.store,
          clock: f.clock,
          targets: 'all',
          handoff: async (reason) => {
            handoffs.push(reason);
          },
          decide: async (input) => {
            decisions++;
            return recovery(input);
          },
        },
        f.authority,
        f.state,
      );
      running = handleEvent(
        { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'agy', agent_status: 'idle' },
        deps,
      );
      if (held) {
        await within(entered.promise);
        assert.deepEqual(handoffs, []);
        assert.equal(await f.store.sessionRetry('agy', 's1'), null);
        if (association === 'closed_after_association') f.attempt.close();
        else assert.equal(await f.state.pause(f.authority.scope.serverId), 'paused');
        resume.resolve();
      }
      await within(running);
      assert.equal(await f.store.sessionRetry('agy', 's1'), null);
      assert.equal(await f.state.recoveryQuarantined(f.authority.scope), true);
      assert.equal(decisions, ['ambiguous', 'corrupt'].includes(association) ? 1 : 0);
      assert.deepEqual(f.herdr.writes(), []);
      assert.deepEqual(handoffs, held ? [] : ['human_review_required']);
      if (association !== 'corrupt') assert.deepEqual(await f.store.retry('w1:p1'), legacy);
    } finally {
      resume.resolve();
      if (running) await within(running);
      await f.cleanup();
    }
  });
}

test('first upgraded event preserves nonzero legacy attempt and quota counters', async () => {
  const f = await scopedDelivery();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    await f.store.record('w1:p1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 2,
      last_attempt_at: '2026-09-29T10:00:20Z',
      quota_check_count: 1,
      last_quota_check_at: '2026-09-29T10:00:10Z',
      next_check_at: '2026-09-29T10:05:00Z',
      last_delivery_state: 'none',
    });
    assert.equal(await f.store.sessionRetry('agy', 's1'), null);
    const retries: StopInput['retry'][] = [];
    const deps = f.workflowEventDeps(
      {
        herdr: f.herdr,
        store: f.store,
        clock: f.clock,
        targets: 'all',
        handoff: async () => {},
        decide: async (input) => {
          retries.push(input.retry);
          return {
            ...recovery(input),
            proposed_action: { kind: 'manual_review' },
            reason_code: 'insufficient_context',
            waiting_for: 'other',
          };
        },
      },
      f.authority,
      f.state,
    );
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'agy', agent_status: 'idle' },
      deps,
    );
    const canonical = await f.store.sessionRetry('agy', 's1');
    assert.equal(canonical?.attempt_count, 2);
    assert.equal(canonical?.quota_check_count, 1);
    assert.equal(canonical?.next_check_at, '2026-09-29T10:05:00Z');
    assert.equal(canonical?.last_delivery_state, 'none');
    if (retries[0]) {
      assert.equal(retries[0].attempt_count, 2);
      assert.equal(retries[0].quota_check_count, 1);
    }
  } finally {
    await f.cleanup();
  }
});

test('another pane cannot initialize a fresh budget for an unresolved session binding', async () => {
  const f = await scopedDelivery();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    await f.store.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 2,
      last_attempt_at: '2026-09-29T10:00:20Z',
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:05:00Z',
      last_delivery_state: 'none',
    });
    const before = await f.store.sessionRetry('agy', 's1');
    const handoffs: TestHandoffReason[] = [];
    const deps = f.workflowEventDeps(
      {
        herdr: f.herdr,
        store: f.store,
        clock: f.clock,
        targets: 'all',
        handoff: async (reason) => {
          handoffs.push(reason);
        },
        decide: async (input) => recovery(input),
      },
      f.authority,
      f.state,
    );
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p2', workspace_id: 'w1', agent: 'agy', agent_status: 'idle' },
      deps,
    );
    assert.deepEqual(await f.store.sessionRetry('agy', 's1'), before);
    assert.equal(await f.store.retry('w1:p2'), null);
    assert.deepEqual(f.herdr.writes(), []);
    assert.deepEqual(handoffs, []);
  } finally {
    await f.cleanup();
  }
});

test('scoped due no-action preserves canonical history and counters while clearing its timer', async () => {
  const f = await scopedDelivery();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    const pending: Episode = {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 2,
      last_attempt_at: '2026-09-29T10:00:20Z',
      quota_check_count: 1,
      last_quota_check_at: '2026-09-29T10:00:10Z',
      next_check_at: at,
      last_delivery_state: 'none',
    };
    await f.store.recordSessionRetry('agy', 's1', pending);
    const inputs: StopInput[] = [];
    const handoffs: TestHandoffReason[] = [];
    const deps = f.workflowEventDeps(
      {
        herdr: f.herdr,
        store: f.store,
        clock: f.clock,
        targets: 'all',
        handoff: async (reason) => {
          handoffs.push(reason);
        },
        decide: async (input) => {
          inputs.push(input);
          return {
            ...recovery(input),
            proposed_action: { kind: 'no_action' },
            reason_code: 'completed',
            waiting_for: 'completed',
            waiting_confidence: null,
            risk_probability: null,
            evaluation: null,
          };
        },
      },
      f.authority,
      f.state,
    );
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'agy', agent_status: 'idle' },
      deps,
      true,
    );
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.retry.attempt_count, 2);
    assert.equal(inputs[0]!.retry.quota_check_count, 2);
    assert.deepEqual(await f.store.sessionRetry('agy', 's1'), { ...pending, next_check_at: null });
    assert.deepEqual(f.herdr.writes(), []);
    assert.deepEqual(handoffs, []);
  } finally {
    await f.cleanup();
  }
});

test('replacement clear does not delete another session canonical retry history', async () => {
  const f = await scopedDelivery();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    await f.store.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 2,
      last_attempt_at: '2026-09-29T10:00:20Z',
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: null,
      last_delivery_state: 'uncertain',
    });
    f.herdr.change(
      pane({
        agent: 'agy',
        agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 's2' },
      }),
    );
    const handoffs: TestHandoffReason[] = [];
    const deps = f.workflowEventDeps(
      {
        herdr: f.herdr,
        store: f.store,
        clock: f.clock,
        targets: 'all',
        handoff: async (reason) => {
          handoffs.push(reason);
        },
        decide: async (input) => recovery(input),
      },
      f.authority,
      f.state,
    );
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'agy', agent_status: 'idle' },
      deps,
    );
    const canonical = await f.store.sessionRetry('agy', 's1');
    assert.equal(canonical?.attempt_count, 2);
    assert.equal(canonical?.last_delivery_state, 'uncertain');
    assert.equal(await f.store.sessionRetry('agy', 's2'), null);
    assert.deepEqual(handoffs, []);
    assert.deepEqual(f.herdr.writes(), []);
  } finally {
    await f.cleanup();
  }
});

for (const stage of ['observation', 'decision', 'quota_hint', 'uncertain', 'acknowledgment'] as const) {
  test(`captured authority closure after ${stage} prevents later writes and input`, async () => {
    const f = await scopedDelivery();
    try {
      const observed = await observeStop(f.herdr, 'w1:p1');
      assert.ok(observed);
      let gets = 0;
      const get = f.herdr.get.bind(f.herdr);
      f.herdr.get = async (paneId) => {
        const snapshot = await get(paneId);
        gets++;
        if (stage === 'observation' && gets === 3) f.attempt.close();
        return snapshot;
      };
      const baseRecord = f.store.recordSessionRetry.bind(f.store);
      if (stage === 'uncertain' || stage === 'acknowledgment') {
        f.store.recordSessionRetry = async (agent, session, episode) => {
          await baseRecord(agent, session, episode);
          if (episode.last_delivery_state === 'uncertain') f.attempt.close();
        };
      }
      const prompt = f.herdr.prompt.bind(f.herdr);
      f.herdr.prompt = async (paneId, instruction) => {
        await prompt(paneId, instruction);
        if (stage === 'acknowledgment') f.attempt.close();
      };
      const deps = f.workflowEventDeps(
        {
          herdr: f.herdr,
          store: f.store,
          clock: f.clock,
          targets: 'all',
          quotaHint:
            stage === 'quota_hint'
              ? async () => {
                  f.attempt.close();
                  return '2026-09-29T10:01:00Z';
                }
              : undefined,
          handoff: async () => {},
          decide: async (input) => {
            if (stage === 'decision') f.attempt.close();
            if (stage === 'quota_hint') {
              return {
                schema_version: 2,
                request_id: input.request_id,
                decision: 'stop_decision',
                proposed_action: { kind: 'wait_for_quota', not_before: '2026-09-29T10:20:00Z' },
                reason_code: 'quota_limit',
                waiting_for: 'quota_limit',
                waiting_confidence: 1,
                risk_probability: null,
                evaluation: recovery(input).evaluation,
              };
            }
            return recovery(input);
          },
        },
        f.authority,
        f.state,
      );
      if (stage === 'uncertain' || stage === 'acknowledgment') {
        const originalRecord = deps.store.record.bind(deps.store);
        deps.store.record = async (pane, episode) => {
          await originalRecord(pane, episode);
          if (episode.last_delivery_state === 'uncertain' && stage === 'uncertain') f.attempt.close();
        };
      }
      await handleEvent(
        { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'agy', agent_status: 'idle' },
        deps,
      );
      const canonical = await f.store.sessionRetry('agy', 's1');
      if (stage === 'observation' || stage === 'decision' || stage === 'quota_hint') {
        assert.equal(canonical, null);
        assert.deepEqual(f.herdr.writes(), []);
      }
      if (stage === 'uncertain') {
        assert.equal(canonical?.last_delivery_state, 'uncertain');
        assert.deepEqual(f.herdr.writes(), []);
      }
      if (stage === 'acknowledgment') {
        assert.equal(canonical?.last_delivery_state, 'uncertain');
        assert.equal(f.herdr.writes().length, 1);
      }
    } finally {
      await f.cleanup();
    }
  });
}
