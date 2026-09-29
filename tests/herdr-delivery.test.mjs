import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, chmod, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeStore } from '../dist/src/herdr-adapter/state.js';
import { observeStop } from '../dist/src/herdr-adapter/observe.js';
import { reconcileDue } from '../dist/src/herdr-adapter/scheduler.js';
import { deliverProposal } from '../dist/src/herdr-adapter/deliver.js';
import { decideWithCli, handleEvent, runEvent } from '../dist/src/herdr-adapter/entry.js';

const at = '2026-09-29T10:00:30Z';
const text = 'Current API failure: request timed out';
const pane = (change = {}) => ({ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle',
  agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 's1' }, revision: 8, state_change_seq: 4, ...change });
const recovery = input => ({ schema_version: 2, request_id: input.request_id, decision: 'stop_decision',
  proposed_action: { kind: 'send_recovery_instruction', not_before: at,
    instruction: 'Check whether the preceding operation succeeded. If it did, do nothing. If the same failure is still current, retry the operation once.' },
  reason_code: 'recoverable_api_error', waiting_for: 'recoverable_api_error', waiting_confidence: 1, risk_probability: 0.1,
  evaluation: { model: 'jev-1.13.0', usage: {}, answers: {
    waiting_for: { type: 'choice', choice: 'recoverable_api_error', probabilities: { recoverable_api_error: 1 }, confidence: 1 },
    risky: { type: 'noul', noul: 0.1 } } } });
async function setup(tool = 'pi', livePi = false) {
  let current = pane({ agent: tool,
    agent_session: livePi
      ? { agent: 'pi', source: 'herdr:pi', kind: 'path', value: '/home/example/.pi/agent/sessions/synthetic-delivery.jsonl' }
      : { agent: tool, source: `integration:${tool}`, kind: 'id', value: 's1' } }), excerpt = text, writes = [];
  const herdr = { get: async () => current, read: async () => ({ pane_id: 'w1:p1', source: 'detection', revision: livePi ? 0 : current.revision,
    text: excerpt, truncated: livePi }), prompt: async (target, instruction) => { writes.push([target, instruction]); },
    change: p => { current = p; }, excerpt: t => { excerpt = t; }, writes: () => writes };
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-delivery-')));
  const observation = await observeStop(herdr, 'w1:p1');
  await store.record('w1:p1', { pane_id: 'w1:p1', session_id: observation.session_id, failure_episode_id: observation.current_episode_id,
    error_evidence_digest: observation.error_evidence_digest, first_observed_at: '2026-09-29T10:00:00Z',
    attempt_count: 0, last_attempt_at: null, quota_check_count: 0, last_quota_check_at: null,
    next_check_at: null, last_delivery_state: 'none' });
  const clock = { now: () => new Date(at) };
  return { herdr, store, observation, clock, proposal: recovery({ request_id: 'old' }) };
}
const deliver = (f, decide = async input => recovery(input), guard = async () => true) =>
  deliverProposal(f.herdr, f.observation, f.proposal, f.store, f.clock, decide, guard);

test('concurrent deliveries for one episode have one prompt submission', async () => {
  const f = await setup();
  const outcomes = await Promise.all([deliver(f), deliver(f)]);
  assert.ok(outcomes.includes('delivered'));
  assert.ok(outcomes.every(outcome => outcome === 'delivered' || outcome === 'human'));
  assert.equal(f.herdr.writes().length, 1);
});

test('submission timeout persists uncertainty before write and a duplicate event cannot resend', async () => {
  const f = await setup(); f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]); throw new Error('timeout'); };
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
  assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'uncertain');
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
});

test('agent_prompt_stalled after write is uncertain and never resent', async () => {
  const f = await setup(); f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]); throw new Error('agent_prompt_stalled'); };
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(await deliver(f), 'uncertain');
  assert.equal(f.herdr.writes().length, 1);
});

test('idle ready Pi and Codex submit fixed instruction once and count only submission', async () => {
  for (const tool of ['pi', 'codex']) {
    const f = await setup(tool);
    assert.equal(await deliver(f), 'delivered');
    assert.deepEqual(f.herdr.writes(), [['w1:p1', f.proposal.proposed_action.instruction]]);
    assert.equal((await f.store.retry('w1:p1')).attempt_count, 1);
    assert.equal(await deliver(f), 'delivered');
    assert.equal(f.herdr.writes().length, 1);
  }
});

test('best-effort Pi recovery accepts a bounded truncated excerpt but sends only one conditional instruction', async () => {
  const f = await setup('pi', true);
  assert.equal(await deliver(f), 'delivered');
  assert.deepEqual(f.herdr.writes(), [['w1:p1', f.proposal.proposed_action.instruction]]);
  assert.equal((await f.store.retry('w1:p1')).attempt_count, 1);
  assert.equal(await deliver(f), 'delivered');
  assert.equal(f.herdr.writes().length, 1);
});

test('future deadline schedules only, and due recheck still needs same deadline', async () => {
  const f = await setup(); f.clock.now = () => new Date('2026-09-29T10:00:29Z'); let calls = 0;
  assert.equal(await deliver(f, async () => { calls++; }), 'wait');
  assert.equal(calls, 0); assert.equal(f.herdr.writes().length, 0);
  assert.equal((await f.store.retry('w1:p1')).next_check_at, at);
  f.clock.now = () => new Date(at);
  assert.equal(await deliver(f, async input => ({ ...recovery(input), proposed_action: {
    ...recovery(input).proposed_action, not_before: '2026-09-29T10:00:31Z' } })), 'human');
  assert.equal(f.herdr.writes().length, 0);
});

test('changed evidence, revision, session, blocked UI and permission UI never prompt', async () => {
  for (const change of [f => f.herdr.excerpt('Another API failure'), f => f.herdr.change(pane({ revision: 9 })),
    f => f.herdr.change(pane({ agent_session: { ...pane().agent_session, value: 's2' } })),
    f => f.herdr.change(pane({ agent_status: 'blocked' })), f => f.herdr.change(pane({ agent_status: 'unknown' })),
    f => f.herdr.change(pane({ agent_status: 'working' })), f => f.herdr.change(pane({ agent_status: 'done' }))]) {
    const f = await setup(); change(f);
    assert.equal(await deliver(f), 'human'); assert.equal(f.herdr.writes().length, 0);
  }
  for (const tool of ['pi', 'codex']) {
    const f = await setup();
    f.herdr.change(pane({ agent: tool, agent_status: 'blocked',
      agent_session: { agent: tool, source: `integration:${tool}`, kind: 'id', value: 's1' } }));
    assert.equal(await deliver(f), 'human');
    assert.equal(f.herdr.writes().length, 0);
  }
  const f = await setup();
  assert.equal(await deliver(f, async input => ({ ...recovery(input), proposed_action: { kind: 'approve_request' },
    reason_code: 'low_risk', waiting_for: 'approve_command' })), 'human');
  assert.equal(f.herdr.writes().length, 0);
});

test('error changing after the fresh CLI decision cannot reach prompt', async () => {
  const f = await setup(); let decided = false;
  f.herdr.read = async () => ({ pane_id: 'w1:p1', source: 'detection', revision: 8,
    text: decided ? 'Different operation failed' : text, truncated: false });
  assert.equal(await deliver(f, async input => { decided = true; return recovery(input); }), 'human');
  assert.equal(f.herdr.writes().length, 0);
});

test('loss of lease/socket proxy just before mutation blocks submission', async () => {
  const f = await setup(); let checks = 0;
  assert.equal(await deliver(f, async input => recovery(input), async () => ++checks < 2), 'human');
  assert.equal(f.herdr.writes().length, 0);
});

test('lease loss after prewrite but before prompt never submits', async () => {
  const f = await setup(); let checks = 0;
  assert.equal(await deliver(f, async input => recovery(input), async () => ++checks < 3), 'uncertain');
  assert.equal(f.herdr.writes().length, 0);
  assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'uncertain');
});

test('lease replacement during prompt cannot overwrite the uncertain episode afterward', async () => {
  const f = await setup();
  const oldToken = await f.store.acquire('server-1');
  let replacement;
  f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]);
    await f.store.release(oldToken);
    replacement = await f.store.acquire('server-1');
  };
  try {
    assert.equal(await deliver(f, async input => recovery(input),
      () => f.store.leaseMatches(oldToken, 'server-1')), 'uncertain');
    assert.ok(replacement && replacement !== oldToken);
    assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'uncertain');
    assert.equal(f.herdr.writes().length, 1);
  } finally { if (replacement) await f.store.release(replacement); }
});

test('old hook does not quarantine a successor episode when lease changes during final retry read', async () => {
  const f = await setup(); await f.store.clear('w1:p1');
  const oldToken = await f.store.acquire('server-1');
  const retry = f.store.retry.bind(f.store);
  let reads = 0, decisions = 0, replacement;
  f.store.retry = async paneId => {
    const record = await retry(paneId);
    if (++reads === 3) {
      await f.store.release(oldToken);
      replacement = await f.store.acquire('server-1');
    }
    return record;
  };
  const deps = { herdr: f.herdr, store: f.store, clock: f.clock, targets: ['w1:p1'],
    sessionId: 'server-1', leaseToken: oldToken, sessionValid: async () => true,
    handoff: async () => {}, decide: async input => {
      decisions++;
      return decisions === 1 ? recovery(input) : { ...recovery(input),
        proposed_action: { kind: 'manual_review' }, reason_code: 'retry_exhausted' };
    } };
  try {
    await handleEvent({ type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1',
      agent: 'pi', agent_status: 'idle' }, deps);
    assert.equal(reads, 3);
    assert.ok(replacement && replacement !== oldToken);
    assert.equal((await retry('w1:p1')).last_delivery_state, 'none');
    assert.equal(f.herdr.writes().length, 0);
  } finally { if (replacement) await f.store.release(replacement); }
});

test('no Herdr prompt binary quarantines a new episode after one human handoff', async () => {
  const f = await setup(); await f.store.clear('w1:p1'); delete f.herdr.prompt;
  const token = await f.store.acquire('server-1'); const handoffs = [];
  const deps = { herdr: f.herdr, store: f.store, clock: f.clock, targets: ['w1:p1'], sessionId: 'server-1',
    leaseToken: token, sessionValid: async () => true,
    handoff: async reason => handoffs.push(reason), decide: async input => recovery(input) };
  const event = { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' };
  try {
    await handleEvent(event, deps); await handleEvent(event, deps);
    assert.deepEqual(handoffs, ['human_review_required']);
    assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'human');
  } finally { await f.store.release(token); }
});

test('stable moved idle snapshot is not an observation for its configured pane', async () => {
  const f = await setup();
  f.herdr.change(pane({ workspace_id: 'w2' }));
  assert.equal(await observeStop(f.herdr, 'w1:p1'), null);
});

test('moved idle pane without an episode cannot classify, record or receive recovery input', async () => {
  const f = await setup(); await f.store.clear('w1:p1');
  f.herdr.change(pane({ workspace_id: 'w2' }));
  const token = await f.store.acquire('server-1'); const handoffs = []; let decisions = 0;
  const deps = { herdr: f.herdr, store: f.store, clock: f.clock, targets: ['w1:p1'],
    sessionId: 'server-1', leaseToken: token, sessionValid: async () => true,
    handoff: async reason => handoffs.push(reason), decide: async input => { decisions++; return recovery(input); } };
  try {
    await handleEvent({ type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w2',
      agent: 'pi', agent_status: 'idle' }, deps);
    assert.equal(decisions, 0);
    assert.equal(await f.store.retry('w1:p1'), null);
    assert.deepEqual(f.herdr.writes(), []);
    assert.deepEqual(handoffs, ['observation_unavailable']);
  } finally { await f.store.release(token); }
});

test('final delivery rejects a moved workspace even when the pane snapshot stays stable', async () => {
  const f = await setup(); let decisions = 0;
  f.herdr.change(pane({ workspace_id: 'w2' }));
  assert.equal(await deliver(f, async input => { decisions++; return recovery(input); }), 'human');
  assert.equal(decisions, 0);
  assert.deepEqual(f.herdr.writes(), []);
  assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'none');
});

test('event path passes recovery through a second fresh decision and never resends', async () => {
  const f = await setup(); await f.store.clear('w1:p1');
  const token = await f.store.acquire('server-1');
  const handoffs = []; let decisions = 0;
  const deps = { herdr: f.herdr, store: f.store, clock: f.clock, targets: ['w1:p1'],
    sessionId: 'server-1', leaseToken: token, sessionValid: async () => true,
    handoff: async reason => handoffs.push(reason), decide: async input => { decisions++; return recovery(input); } };
  const event = { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' };
  try {
    await handleEvent(event, deps); await handleEvent(event, deps);
    assert.equal(decisions, 2);
    assert.equal(f.herdr.writes().length, 1);
    assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'delivered');
    assert.deepEqual(handoffs, []);
  } finally { await f.store.release(token); }
});

test('delivered recovery survives working then idle with the same old detection text without a second prompt', async () => {
  const f = await setup(); await f.store.clear('w1:p1');
  const token = await f.store.acquire('server-1'); const handoffs = []; let decisions = 0;
  const deps = { herdr: f.herdr, store: f.store, clock: f.clock, targets: ['w1:p1'],
    sessionId: 'server-1', leaseToken: token, sessionValid: async () => true,
    handoff: async reason => handoffs.push(reason), decide: async input => { decisions++; return recovery(input); } };
  const status = agent_status => ({ type: 'pane.agent_status_changed', pane_id: 'w1:p1',
    workspace_id: 'w1', agent: 'pi', agent_status });
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
    assert.equal((await f.store.retry('w1:p1')).attempt_count, 1);
    assert.equal((await f.store.retry('w1:p1')).first_observed_at, '2026-09-29T10:00:30.000Z');
    assert.ok(handoffs.includes('observation_unavailable'));
  } finally { await f.store.release(token); }
});

test('unknown prompt delivery remains uncertain after same-session status changes', async () => {
  const f = await setup(); await f.store.clear('w1:p1');
  f.herdr.prompt = async (target, instruction) => {
    f.herdr.writes().push([target, instruction]); throw new Error('unknown outcome'); };
  const token = await f.store.acquire('server-1');
  const deps = { herdr: f.herdr, store: f.store, clock: f.clock, targets: ['w1:p1'],
    sessionId: 'server-1', leaseToken: token, sessionValid: async () => true,
    handoff: async () => {}, decide: async input => recovery(input) };
  const status = agent_status => ({ type: 'pane.agent_status_changed', pane_id: 'w1:p1',
    workspace_id: 'w1', agent: 'pi', agent_status });
  try {
    await handleEvent(status('idle'), deps);
    f.herdr.change(pane({ agent_status: 'working', revision: 9, state_change_seq: 5 }));
    await handleEvent(status('working'), deps);
    f.herdr.change(pane({ revision: 10, state_change_seq: 6 }));
    await handleEvent(status('idle'), deps);
    assert.equal(f.herdr.writes().length, 1);
    assert.equal((await f.store.retry('w1:p1')).last_delivery_state, 'uncertain');
  } finally { await f.store.release(token); }
});

test('future recovery event schedules a due re-observation, not a cached prompt', async () => {
  const f = await setup(); await f.store.clear('w1:p1');
  f.clock.now = () => new Date('2026-09-29T10:00:00Z');
  const token = await f.store.acquire('server-1'); let decisions = 0;
  const decide = async input => { decisions++; return recovery(input); };
  const ownership = { sessionId: 'server-1', leaseToken: token, sessionValid: async () => true };
  try {
    await handleEvent({ type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1',
      agent: 'pi', agent_status: 'idle' }, { herdr: f.herdr, store: f.store, clock: f.clock,
      targets: ['w1:p1'], handoff: async () => {}, decide, ...ownership });
    assert.equal(decisions, 1);
    assert.equal(f.herdr.writes().length, 0);
    assert.equal((await f.store.retry('w1:p1')).next_check_at, at);
    await reconcileDue(new Date(at), f.store, f.herdr, decide, ['w1:p1'], async () => {}, ownership);
    assert.equal(decisions, 3);
    assert.equal(f.herdr.writes().length, 1);
  } finally { await f.store.release(token); }
});

test('due scheduler keeps its original lease token across a held decision', async () => {
  const f = await setup();
  const original = { ...(await f.store.retry('w1:p1')), next_check_at: at };
  await f.store.record('w1:p1', original);
  const oldToken = await f.store.acquire('server-1');
  let entered, releaseDecision;
  const pending = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { releaseDecision = resolve; });
  const handoffs = [];
  let replacement;
  try {
    const oldDue = reconcileDue(new Date(at), f.store, f.herdr, async input => {
      entered(); await held; return recovery(input);
    }, ['w1:p1'], async reason => { handoffs.push(reason); },
    { sessionId: 'server-1', leaseToken: oldToken, sessionValid: async () => true });
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

test('old event hook cannot submit under a replacement lease on the same socket', async () => {
  let milliseconds = Date.now();
  const directory = await mkdtemp(join(tmpdir(), 'steward-lease-swap-'));
  const socket = join(directory, 'herdr.sock'), executable = join(directory, 'fake-herdr');
  const config = join(directory, 'config'), calls = join(directory, 'calls.json');
  await mkdir(config); await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: ['w1:p1'] }));
  await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  await chmod(executable, 0o755);
  const server = createServer(connection => { let bytes = '';
    connection.on('data', chunk => { bytes += chunk;
      if (!bytes.includes('\n')) return;
      const { id, method } = JSON.parse(bytes.slice(0, bytes.indexOf('\n')));
      connection.end(JSON.stringify({ id, result: method === 'agent.get'
        ? { type: 'agent_info', agent: pane() }
        : { type: 'pane_read', read: { pane_id: 'w1:p1', source: 'detection', revision: 8,
          text, truncated: false } } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const info = await stat(socket), session = `${info.dev}:${info.ino}`;
  const store = new EpisodeStore(directory, () => milliseconds);
  const observation = await observeStop({ get: async () => pane(),
    read: async () => ({ pane_id: 'w1:p1', source: 'detection', revision: 8, text, truncated: false }) }, 'w1:p1');
  const original = { pane_id: 'w1:p1', session_id: 's1', failure_episode_id: observation.current_episode_id,
    error_evidence_digest: observation.error_evidence_digest, first_observed_at: at, attempt_count: 0,
    last_attempt_at: null, quota_check_count: 0, last_quota_check_at: null, next_check_at: null,
    last_delivery_state: 'none' };
  await store.record('w1:p1', original);
  const oldToken = await store.acquire(session);
  let entered, releaseDecision;
  const pending = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { releaseDecision = resolve; });
  const env = { ...process.env, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: executable,
    HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: directory,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.agent_status_changed', pane_id: 'w1:p1',
      workspace_id: 'w1', agent: 'pi', agent_status: 'idle' }) };
  let replacement;
  try {
    const oldHook = runEvent(env, async input => { entered(); await held; return recovery(input); });
    await pending;
    await store.release(oldToken);
    milliseconds += 1_000;
    replacement = await store.acquire(session);
    assert.ok(replacement && replacement !== oldToken);
    releaseDecision();
    await oldHook;
    assert.deepEqual(await store.retry('w1:p1'), original);
    assert.equal(await store.owned(replacement, session), true);
    const commands = await readFile(calls, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    assert.equal(commands.includes('"agent","prompt"'), false);
  } finally {
    releaseDecision?.();
    if (replacement) await store.release(replacement);
    await new Promise(resolve => server.close(resolve));
  }
});

test('installed event uses the supplied Herdr 0.9.1 agent prompt CLI, not raw pane input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-delivery-wire-'));
  const socket = join(directory, 'herdr.sock'), executable = join(directory, 'fake-herdr');
  const config = join(directory, 'config'), calls = join(directory, 'calls.json');
  await mkdir(config); await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: ['w1:p1'] }));
  await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  await chmod(executable, 0o755);
  const server = createServer(connection => { let bytes = '';
    connection.on('data', chunk => { bytes += chunk;
      if (!bytes.includes('\n')) return;
      const { id, method } = JSON.parse(bytes.slice(0, bytes.indexOf('\n')));
      connection.end(JSON.stringify({ id, result: method === 'agent.get'
        ? { type: 'agent_info', agent: pane() }
        : { type: 'pane_read', read: { pane_id: 'w1:p1', source: 'detection', revision: 8,
          text, truncated: false } } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const info = await stat(socket);
  const store = new EpisodeStore(directory), token = await store.acquire(`${info.dev}:${info.ino}`);
  try {
    await runEvent({ ...process.env, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: executable,
      HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: directory,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.agent_status_changed', pane_id: 'w1:p1',
        workspace_id: 'w1', agent: 'pi', agent_status: 'idle' }) }, async input => recovery(input));
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse),
      [['agent', 'prompt', 'w1:p1', recovery({ request_id: 'unused' }).proposed_action.instruction]]);
    await store.clear('w1:p1');
    await runEvent({ ...process.env, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: executable,
      HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: directory,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.agent_status_changed', pane_id: 'w1:p1',
        workspace_id: 'w1', agent: 'pi', agent_status: 'idle' }) }, async input => ({
      ...recovery(input), proposed_action: { kind: 'manual_review' }, reason_code: 'retry_exhausted' }));
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)[1],
      ['notification', 'show', 'Agent Steward: human review required', '--body', 'Review the stopped agent manually.']);
  } finally { await store.release(token); await new Promise(resolve => server.close(resolve)); }
});

test('fresh stop check subprocess is required before prompt; malformed outcome cannot send', async () => {
  const f = await setup(); const dir = await mkdtemp(join(tmpdir(), 'steward-delivery-cli-'));
  const script = join(dir, 'fake.mjs');
  await writeFile(script, `let data = ''; for await (const part of process.stdin) data += part;
const input = JSON.parse(data);
if (process.argv.slice(2).join(' ') !== 'stop check' || input.context !== ${JSON.stringify(text)}) process.exit(41);
const response = ${JSON.stringify(recovery({ request_id: 'template' }))};
response.request_id = input.request_id;
process.stdout.write(JSON.stringify(response));`);
  assert.equal(await deliver(f, input => decideWithCli(input, script)), 'delivered');
  assert.equal(f.herdr.writes().length, 1);
  const bad = await setup();
  await writeFile(script, `process.stdout.write('{}');`);
  assert.equal(await deliver(bad, input => decideWithCli(input, script)), 'human');
  assert.equal(bad.herdr.writes().length, 0);
});
