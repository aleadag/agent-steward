import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, cp, chmod, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleEvent, runEvent } from '../src/herdr-adapter/entry.ts';
import { observeStop } from '../src/herdr-adapter/observe.ts';
import type { HerdrControl } from '../src/herdr-adapter/deliver.ts';
import type { EventDeps } from '../src/herdr-adapter/entry.ts';
import type { AgentSnapshot, HerdrReader, ReadSnapshot } from '../src/herdr-adapter/observe.ts';
import type { Episode } from '../src/herdr-adapter/state.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';

type TestHandoffReason = Parameters<EventDeps['handoff']>[0];
type AdapterHerdr = HerdrReader &
  HerdrControl & {
    replace: (next: AgentSnapshot | null) => void;
    sendKeys: (paneId: string, keys: string[]) => Promise<void>;
  };

const event = { type: 'pane_agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked' };
const agent = (overrides: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'pi',
  agent_status: 'blocked',
  agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 's1' },
  state_change_seq: 4,
  revision: 8,
  ...overrides,
});
const output = (overrides: Omit<Partial<ReadSnapshot>, 'truncated'> & { truncated?: unknown } = {}): ReadSnapshot =>
  ({
    pane_id: 'w1:p1',
    source: 'detection',
    revision: 8,
    text: 'Current API failure: request timed out',
    truncated: false,
    ...overrides,
  }) as ReadSnapshot;
function fakeHerdr(pane: AgentSnapshot | null = agent(), read: ReadSnapshot = output()): AdapterHerdr {
  let current = pane;
  return {
    get: async () => current,
    read: async () => read,
    replace: (next) => {
      current = next;
    },
    prompt: () => {
      throw new Error('unexpected Herdr prompt');
    },
    sendKeys: () => {
      throw new Error('unexpected Herdr keys');
    },
  };
}
function firstCall(calls: StopInput[]): StopInput {
  const input = calls[0];
  assert.ok(input);
  return input;
}
function localDecision(input: StopInput): StopResult {
  return {
    schema_version: 2,
    request_id: input.request_id,
    decision: 'stop_decision',
    proposed_action: { kind: 'manual_review' },
    reason_code: 'insufficient_context',
    waiting_for: 'other',
    waiting_confidence: null,
    risk_probability: null,
    evaluation: null,
  };
}
function fixture(herdr: EventDeps['herdr'] = fakeHerdr()) {
  const calls: StopInput[] = [];
  const handoffs: TestHandoffReason[] = [];
  const records: Episode[] = [];
  let history: Episode | null = null;
  const deps: EventDeps = {
    herdr,
    decide: async (input) => {
      calls.push(input);
      return localDecision(input);
    },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
    store: {
      active: async () => true,
      retry: async () => history,
      record: async (_pane, retry) => {
        records.push(retry);
        history = retry;
      },
    },
    clock: { now: () => new Date('2026-09-29T10:00:00Z') },
    targets: ['w1:p1'],
  };
  return { deps, calls, handoffs, records };
}

for (const paneId of ['w1:p1', 'wG:p1', 'wR:p55', 'wE:p2W', 'wR:p5A', 'wa9:pz8']) {
  test(`observeStop accepts opaque Herdr pane ID ${paneId}`, async () => {
    const pane = agent({ pane_id: paneId, workspace_id: paneId.split(':')[0] });
    const read = output({ pane_id: paneId });
    const observed = await observeStop(fakeHerdr(pane, read), paneId);
    assert.ok(observed);
    assert.equal(observed.pane_id, paneId);
    assert.equal(observed.workspace_id, pane.workspace_id);
    assert.equal(observed.session_id, 's1');
    assert.equal(observed.context, 'Current API failure: request timed out');
  });
}

test('observeStop rejects malformed pane IDs before querying Herdr', async () => {
  const herdr: HerdrReader = {
    get: async () => {
      throw new Error('invalid pane ID must not query Herdr');
    },
    read: async () => {
      throw new Error('invalid pane ID must not read Herdr');
    },
  };
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
    assert.equal(await observeStop(herdr, paneId), null, JSON.stringify(paneId));
  }
});

test('opaque pane IDs without agent_session are not read or observed', async () => {
  for (const paneId of ['wG:p1', 'wR:p55', 'wE:p2W', 'wR:p5A']) {
    const pane = agent({ pane_id: paneId, workspace_id: paneId.split(':')[0], agent_session: undefined });
    const herdr = fakeHerdr(pane);
    herdr.read = async () => {
      throw new Error('pane without agent_session must not be read');
    };
    assert.equal(await observeStop(herdr, paneId), null);
  }
});

test('bounded detection snapshot is classified, but event agent mismatch rejects a replacement', async () => {
  const herdr = fakeHerdr();
  const { deps, calls, handoffs } = fixture(herdr);
  const identifiedEvent = { ...event, agent: 'pi' };
  await handleEvent(identifiedEvent, deps);
  assert.equal(calls.length, 1);
  const input = firstCall(calls);
  assert.equal(input.schema_version, 2);
  assert.equal(input.context, 'Current API failure: request timed out');
  assert.deepEqual(input.agent, { id: 's1', tool: 'pi', pane_id: 'w1:p1', session_id: 's1' });
  herdr.replace(
    agent({ agent: 'codex', agent_session: { agent: 'codex', source: 'integration:codex', kind: 'id', value: 's2' } }),
  );
  await handleEvent(identifiedEvent, deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(handoffs, ['human_review_required', 'observation_unavailable']);
});

test('an old status event without occupant identity can classify a replacement, but cannot deliver', async () => {
  const herdr = fakeHerdr();
  const { deps, calls, handoffs } = fixture(herdr);
  await handleEvent(event, deps);
  herdr.replace(
    agent({ agent: 'codex', agent_session: { agent: 'codex', source: 'integration:codex', kind: 'id', value: 's2' } }),
  );
  await handleEvent(event, deps);
  assert.equal(calls.length, 2);
  assert.deepEqual(handoffs, ['human_review_required', 'human_review_required']);
});

test('Herdr event envelope is only a trigger and is re-read before deciding', async () => {
  const { deps, calls } = fixture();
  await handleEvent({ event: 'pane_agent_status_changed', data: event }, deps);
  assert.equal(calls.length, 1);
  assert.equal(firstCall(calls).agent.session_id, 's1');
});

test('moving occupant during read prevents decision', async () => {
  const herdr = fakeHerdr();
  herdr.read = async () => {
    herdr.replace(agent({ state_change_seq: 5 }));
    return output();
  };
  const { deps, calls, handoffs } = fixture(herdr);
  await handleEvent(event, deps);
  assert.equal(calls.length, 0);
  assert.deepEqual(handoffs, ['observation_unavailable']);
});

test('rejected detection or unsupported identity emits only a local handoff and no decision', async () => {
  const rejectedCases: [AgentSnapshot | null, ReadSnapshot][] = [
    [agent(), output({ source: 'recent', text: 'Old terminal history\nCurrent API failure: request timed out' })],
    [agent(), output({ text: 'api_key=supersecretvalue1234' })],
    [agent(), output({ text: 'x'.repeat(4096) })],
    [agent(), output({ text: 'x\n'.repeat(13) })],
    [agent(), output({ truncated: 'unknown' })],
    [agent(), output({ text: '' })],
    [agent({ agent: 'claude' }), output()],
    [agent({ agent_session: null }), output()],
    [agent({ agent_status: 'unknown' }), output()],
    [agent({ agent_status: 'working' }), output()],
    [null, output()],
  ];
  for (const [pane, read] of rejectedCases) {
    const { deps, calls, handoffs, records } = fixture(fakeHerdr(pane, read));
    await handleEvent(event, deps);
    assert.equal(calls.length, 0);
    assert.equal(records.length, 0);
    assert.deepEqual(handoffs, ['observation_unavailable']);
  }
});

test('socket/read failures and credential-looking text produce bounded local handoff without Jev or raw text', async () => {
  for (const herdr of [
    {
      get: async () => {
        throw new Error('sensitive socket details');
      },
      read: async () => output(),
    },
    {
      get: async () => agent(),
      read: async () => {
        throw new Error('sensitive terminal details');
      },
    },
    fakeHerdr(agent(), output({ text: 'Bearer abcdefghijklmnopqrstuvwxyz' })),
  ]) {
    const { deps, calls, records, handoffs } = fixture(herdr);
    await handleEvent(event, deps);
    assert.equal(calls.length, 0);
    assert.equal(records.length, 0);
    assert.deepEqual(handoffs, ['observation_unavailable']);
    assert.equal(JSON.stringify(handoffs).includes('sensitive'), false);
    assert.equal(JSON.stringify(handoffs).includes('Bearer'), false);
  }
});

test('wrong event, stale event identity, unconfigured pane, and absent lease do nothing', async () => {
  const { deps, calls } = fixture();
  await handleEvent({ ...event, type: 'pane_output_changed' }, deps);
  await handleEvent({ ...event, agent: 'codex' }, deps);
  await handleEvent({ ...event, agent_status: 'idle' }, deps);
  await handleEvent(event, { ...deps, targets: ['w2:p2'] });
  await handleEvent(event, { ...deps, store: { ...deps.store, active: async () => false } });
  assert.equal(calls.length, 0);
});

test('empty or omitted pane allowlist watches every Herdr agent pane', async () => {
  const { deps, calls } = fixture();
  await handleEvent(event, { ...deps, targets: 'all' });
  assert.equal(calls.length, 1);
});

test('event hook remains inert without a scheduler lease even with explicit targets', async () => {
  const base = await mkdtemp(join(tmpdir(), 'steward-event-'));
  const configDir = join(base, 'config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'targets.json'), JSON.stringify({ pane_ids: ['w1:p1'] }));
  await runEvent({
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event),
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: base,
    HERDR_SOCKET_PATH: join(base, 'missing.sock'),
  });
});

test('package-relative script uses only its sibling wrapper and rejects other commands', async () => {
  const base = await mkdtemp(join(tmpdir(), 'steward-wrapper-'));
  const script = join(base, 'run.sh');
  const wrapper = join(base, 'agent-steward-herdr-adapter');
  await cp(new URL('../herdr-plugins/agent-steward-recover/run.sh', import.meta.url), script);
  await writeFile(wrapper, '#!/bin/sh\nprintf "%s" "$1"\n');
  await chmod(wrapper, 0o755);
  await writeFile(join(base, 'node'), '#!/bin/sh\nexit 43\n');
  await chmod(join(base, 'node'), 0o755);
  await writeFile(join(base, 'bun'), '#!/bin/sh\nexit 43\n');
  await chmod(join(base, 'bun'), 0o755);
  const result = spawnSync('sh', [script, 'event'], { encoding: 'utf8', env: { PATH: `${base}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'event');
  const refused = spawnSync('sh', [script, 'unknown'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  const override = join(base, 'override-adapter');
  await writeFile(override, '#!/bin/sh\nprintf "over:%s" "$1"\n');
  await chmod(override, 0o755);
  const redirected = spawnSync('sh', [script, 'scheduler'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_STEWARD_HERDR_ADAPTER: override },
  });
  assert.equal(redirected.status, 0, redirected.stderr);
  assert.equal(redirected.stdout, 'over:scheduler');
});

test('plain detection text is untrusted evidence: accepted without asserting an isolated stop', async () => {
  const text = 'Old screen line\nCurrent API failure: request timed out';
  const observed = await observeStop(fakeHerdr(agent(), output({ text })), 'w1:p1');
  assert.ok(observed);
  assert.equal(observed.context, text);
  const { deps, calls } = fixture(fakeHerdr(agent(), output({ text })));
  await handleEvent(event, deps);
  const decision = firstCall(calls);
  assert.equal(decision.context, text);
  assert.equal(decision.pending_action, undefined);
  assert.equal(decision.automatic_approval_forbidden, true);
});

test('invalid decision output, error envelope, mismatch and transport failure never record an assessed episode', async () => {
  const invalidDecisions: EventDeps['decide'][] = [
    async () => undefined,
    async () => ({
      schema_version: 2,
      decision: 'error',
      request_id: null,
      reason_code: 'invalid_response',
      message: 'invalid response',
    }),
    async (input: StopInput) => ({ ...localDecision(input), request_id: 'other-request' }),
    async () => {
      throw new Error('sensitive transport details');
    },
  ];
  for (const decide of invalidDecisions) {
    const { deps, records, handoffs } = fixture();
    await handleEvent(event, { ...deps, decide });
    assert.equal(records.length, 0);
    assert.deepEqual(handoffs, ['decision_failed']);
  }
});

test('valid human-only proposals hand off locally before any episode can suppress the handoff', async () => {
  const approvals = (input: StopInput): StopResult => ({
    schema_version: 2,
    request_id: input.request_id,
    decision: 'stop_decision',
    proposed_action: { kind: 'approve_request' },
    reason_code: 'low_risk',
    waiting_for: 'approve_command',
    waiting_confidence: 0.9,
    risk_probability: 0.1,
    evaluation: {
      model: 'jev-1.13.0',
      usage: {},
      answers: {
        waiting_for: {
          type: 'choice',
          choice: 'approve_command',
          probabilities: { approve_command: 0.9, other: 0.1 },
          confidence: 0.9,
        },
        risky: { type: 'noul', noul: 0.1 },
      },
    },
  });
  for (const decide of [localDecision, approvals]) {
    const { deps, handoffs, records } = fixture();
    await handleEvent(event, { ...deps, decide: async (input) => decide(input) });
    assert.deepEqual(handoffs, ['human_review_required']);
    assert.deepEqual(records, []);
  }
});

test('non-human-only valid decisions record only episode metadata', async () => {
  const { deps, records, handoffs } = fixture();
  await handleEvent(event, {
    ...deps,
    decide: async (input) => ({
      ...localDecision(input),
      proposed_action: { kind: 'no_action' },
      reason_code: 'completed',
      waiting_for: 'completed',
    }),
  });
  assert.equal(records.length, 1);
  assert.equal(JSON.stringify(records).includes('Current API failure'), false);
  assert.deepEqual(handoffs, []);
});

test('read-only Herdr 0.9.1 socket result and event envelope provide bounded classification evidence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'steward-socket-'));
  const path = join(base, 'herdr.sock');
  const methods: [string, unknown][] = [];
  const server = createServer((socket) => {
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk;
      if (!request.includes('\n')) return;
      const { id, method, params } = JSON.parse(request.slice(0, request.indexOf('\n')));
      methods.push([method, params]);
      const result =
        method === 'agent.get'
          ? { type: 'agent_info', agent: { ...agent(), terminal_id: 't1', tab_id: 'tab1', focused: false } }
          : {
              type: 'pane_read',
              read: {
                ...output({ text: 'Old screen line\nAPI failed' }),
                workspace_id: 'w1',
                tab_id: 'tab1',
                format: 'text',
              },
            };
      socket.end(JSON.stringify({ id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  try {
    const adapter = await import('../src/herdr-adapter/entry.ts');
    const { deps, calls } = fixture(adapter.socketReader(path));
    await handleEvent({ event: 'pane_agent_status_changed', data: { ...event, type: undefined } }, deps);
    assert.equal(calls.length, 1);
    assert.equal(firstCall(calls).context, 'Old screen line\nAPI failed');
    assert.deepEqual(methods, [
      ['agent.get', { target: 'w1:p1' }],
      ['agent.read', { target: 'w1:p1', source: 'detection', lines: 12, format: 'text' }],
      ['agent.get', { target: 'w1:p1' }],
      ['agent.get', { target: 'w1:p1' }],
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fake decision subprocess sends version-2 stop check JSON and rejects malformed JSON, exit and error envelope', async () => {
  const base = await mkdtemp(join(tmpdir(), 'steward-cli-'));
  const script = join(base, 'fake.mjs');
  const adapter = await import('../src/herdr-adapter/entry.ts');
  const { deps, calls } = fixture();
  await handleEvent(event, deps);
  const input = firstCall(calls);
  await writeFile(
    script,
    `let data = ''; for await (const chunk of process.stdin) data += chunk;
const input = JSON.parse(data);
if (process.argv.slice(2).join(' ') !== 'stop check' || input.schema_version !== 2) process.exit(21);
process.stdout.write(JSON.stringify({schema_version:2,request_id:input.request_id,decision:'stop_decision',proposed_action:{kind:'manual_review'},reason_code:'insufficient_context',waiting_for:'other',waiting_confidence:null,risk_probability:null,evaluation:null}));\n`,
  );
  assert.equal((await adapter.decideWithCli(input, script)).request_id, input.request_id);
  for (const [body, code] of [
    ["process.stdout.write('{not json');", 0],
    ["process.stdout.write('{}');", 7],
    [
      "process.stdout.write(JSON.stringify({schema_version:2,request_id:null,decision:'error',reason_code:'invalid_response',message:'invalid'}));",
      0,
    ],
  ]) {
    await writeFile(script, body + `\nprocess.exitCode=${code};\n`);
    await assert.rejects(adapter.decideWithCli(input, script));
  }
  await assert.rejects(adapter.decideWithCli(input, join(base, 'no-script.mjs')));
});

test('stalled stop check is killed at a short test deadline and handed off without a record', async () => {
  const base = await mkdtemp(join(tmpdir(), 'steward-hung-cli-'));
  const script = join(base, 'stalled.mjs');
  const pidFile = join(base, 'pid');
  const finishedFile = join(base, 'finished');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => { writeFileSync(${JSON.stringify(finishedFile)}, 'done'); process.exit(0); }, 2_500);\n`,
  );
  const { deps, records, handoffs } = fixture();
  const adapter = await import('../src/herdr-adapter/entry.ts');
  const started = Date.now();
  await handleEvent(event, { ...deps, decide: (input) => adapter.decideWithCli(input, script, 1_000) });
  assert.ok(Date.now() - started < 2_000, 'decision exceeded the bounded subprocess deadline');
  assert.deepEqual(handoffs, ['decision_failed']);
  assert.deepEqual(records, []);
  const childPid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(finishedFile, 'utf8'), { code: 'ENOENT' });
});

// Sanitized Herdr 0.9.1-shaped Pi response: get revisions describe pane state,
// while read revisions are independent. The last newline is not a 13th line.
const piPath = '/home/example/.pi/agent/sessions/synthetic-observation.jsonl';
const piAgent = (change = {}) =>
  agent({
    agent_status: 'idle',
    revision: 3,
    agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: piPath },
    ...change,
  });
const piExcerpt = Array.from({ length: 12 }, (_, i) => `Historical detection line ${i + 1}`).join('\n') + '\n';
const piRead = (change = {}) => output({ revision: 0, text: piExcerpt, truncated: true, ...change });

test('Pi 0.9.1 path session classifies only the bounded untrusted detection excerpt', async () => {
  const pane = piAgent();
  const read = piRead();
  const { deps, calls, records, handoffs } = fixture(fakeHerdr(pane, read));
  await handleEvent({ ...event, agent: 'pi', agent_status: 'idle' }, deps);
  assert.equal(calls.length, 1);
  const decision = firstCall(calls);
  assert.equal(decision.context, piExcerpt);
  assert.deepEqual(decision.agent, { id: piPath, tool: 'pi', pane_id: 'w1:p1', session_id: piPath });
  assert.equal(decision.pending_action, undefined);
  assert.equal(decision.automatic_approval_forbidden, true);
  assert.deepEqual(records, []);
  assert.deepEqual(handoffs, ['human_review_required']);
});

test('Pi 0.9.1 excerpt rejects changed occupants and sequences even when read revision is independent', async () => {
  for (const next of [
    piAgent({ agent: 'codex' }),
    piAgent({ agent_session: { ...piAgent().agent_session, value: '/home/example/.pi/agent/sessions/other.jsonl' } }),
    piAgent({ agent_session: { ...piAgent().agent_session, source: 'integration:pi' } }),
    piAgent({ state_change_seq: 5 }),
    piAgent({ agent_status: 'blocked' }),
  ]) {
    let count = 0;
    const herdr = fakeHerdr(piAgent(), piRead());
    herdr.get = async () => (++count === 1 ? piAgent() : next);
    assert.equal(await observeStop(herdr, 'w1:p1'), null);
  }
});

test('Pi 0.9.1 excerpt rejects oversized bytes, extra actual lines, credentials and malformed read metadata', async () => {
  for (const read of [
    piRead({ text: 'é'.repeat(1025) }),
    piRead({ text: piExcerpt + '13th line\n' }),
    piRead({ text: 'api_key=supersecretvalue1234\n' }),
    piRead({ text: 'Bearer abcdefghijklmnopqrstuvwxyz\n' }),
    piRead({ source: 'recent' }),
    piRead({ truncated: 'unknown' }),
    piRead({ revision: -1 }),
  ]) {
    assert.equal(await observeStop(fakeHerdr(piAgent(), read), 'w1:p1'), null);
  }
});

test('agy kind:id session is observed and classified with tool agy', async () => {
  const pane = agent({
    agent: 'agy',
    agent_status: 'idle',
    agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 'sess-agy-1' },
  });
  const { deps, calls, records, handoffs } = fixture(fakeHerdr(pane, output({ text: 'Error: 503 overloaded\n' })));
  await handleEvent({ ...event, agent: 'agy', agent_status: 'idle' }, deps);
  assert.equal(calls.length, 1);
  assert.equal(firstCall(calls).agent.tool, 'agy');
  assert.equal(firstCall(calls).agent.session_id, 'sess-agy-1');
  assert.deepEqual(records, []);
  assert.deepEqual(handoffs, ['human_review_required']);
});

test('ordinary terminal without agent_session is not watched', async () => {
  const pane = agent({ agent: undefined, agent_session: undefined, agent_status: 'unknown' });
  const herdr = fakeHerdr(pane, output({ text: 'sh-5.3$\n' }));
  assert.equal(await observeStop(herdr, 'w1:p1'), null);
  const { deps, calls, records, handoffs } = fixture(herdr);
  await handleEvent({ ...event, agent_status: 'unknown' }, deps);
  assert.deepEqual(calls, []);
  assert.deepEqual(records, []);
  assert.deepEqual(handoffs, []);
});

test('ordinary terminal with idle status but no agent_session cannot be classified', async () => {
  const pane = agent({ agent: undefined, agent_session: undefined, agent_status: 'idle' });
  const herdr = fakeHerdr(pane, output({ text: 'sh-5.3$\n' }));
  assert.equal(await observeStop(herdr, 'w1:p1'), null);
  const { deps, calls, records, handoffs } = fixture(herdr);
  await handleEvent({ ...event, agent_status: 'idle' }, deps);
  assert.deepEqual(calls, []);
  assert.deepEqual(records, []);
  assert.deepEqual(handoffs, ['observation_unavailable']);
});

test('Codex without session remains unwitnessed', async () => {
  const pane = agent({ agent: 'codex', agent_session: undefined, agent_status: 'idle' });
  const { deps, calls, handoffs } = fixture(fakeHerdr(pane, output({ text: 'error\n' })));
  await handleEvent({ ...event, agent: 'codex', agent_status: 'idle' }, deps);
  assert.deepEqual(calls, []);
  assert.deepEqual(handoffs, ['observation_unavailable']);
});

test('session tuple change or control characters fail closed', async () => {
  const baseSession = { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 'sess-1' };
  const base = agent({ agent: 'agy', agent_status: 'idle', agent_session: baseSession });
  const read = output({ text: 'Error: 503\n' });
  for (const next of [
    agent({ ...base, agent: 'pi', agent_session: { ...baseSession, agent: 'pi' } }),
    agent({
      agent: 'pi',
      agent_status: 'idle',
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: '/tmp/x.jsonl' },
    }),
    agent({ ...base, agent_session: { ...baseSession, value: 'sess-2' } }),
    agent({ ...base, agent_session: { ...baseSession, source: 'other' } }),
    agent({ ...base, agent_session: { ...baseSession, kind: 'opaque' } }),
    agent({ ...base, agent_session: { ...baseSession, kind: 'id\n' } }),
    agent({ ...base, agent_session: { ...baseSession, value: 'sess-1\x00' } }),
    agent({ agent: 'agy', agent_status: 'idle', agent_session: { ...baseSession, agent: 'pi' } }),
  ]) {
    let count = 0;
    const herdr = fakeHerdr(base, read);
    herdr.get = async () => (++count === 1 ? base : next);
    assert.equal(await observeStop(herdr, 'w1:p1'), null);
  }
});

for (const [field, value] of [
  ['kind', 'opaque'],
  ['source', 'other'],
] as const) {
  test(`session ${field}-only change between stable observations changes episode identity`, async () => {
    const session = { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 'sess-1' };
    const base = agent({ agent: 'agy', agent_status: 'idle', agent_session: session });
    const herdr = fakeHerdr(base);
    const before = await observeStop(herdr, 'w1:p1');
    assert.ok(before);
    herdr.replace({ ...base, agent_session: { ...session, [field]: value } });
    const after = await observeStop(herdr, 'w1:p1');
    assert.ok(after);
    assert.notEqual(after.current_episode_id, before.current_episode_id);
  });
}

for (const [field, value] of [
  ['kind', 'opaque'],
  ['source', 'other'],
  ['agent', 'pi'],
] as const) {
  test(`session ${field}-only change on entry's third get prevents classification`, async () => {
    const session = { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 'sess-1' };
    const base = agent({ agent: 'agy', agent_status: 'idle', agent_session: session });
    const next = { ...base, agent_session: { ...session, [field]: value } };
    const herdr = fakeHerdr(base);
    let gets = 0;
    herdr.get = async () => (++gets === 3 ? next : base);
    const { deps, calls, records, handoffs } = fixture(herdr);
    await handleEvent({ ...event, agent: 'agy', agent_status: 'idle' }, deps);
    assert.equal(gets, 3);
    assert.deepEqual(calls, []);
    assert.deepEqual(records, []);
    assert.deepEqual(handoffs, ['observation_unavailable']);
  });
}

test('unknown session kind still observes when the four fields are clean', async () => {
  const pane = agent({
    agent: 'claude',
    agent_status: 'idle',
    agent_session: { agent: 'claude', kind: 'opaque', source: 'herdr:claude', value: 'c1' },
  });
  const observed = await observeStop(fakeHerdr(pane, output({ text: 'Error: 503\n' })), 'w1:p1');
  assert.ok(observed);
  assert.equal(observed.agent, 'claude');
  assert.equal(observed.session_id, 'c1');
});

test('Pi session source and value need no tool-specific path shape', async () => {
  for (const session of [
    { agent: 'pi', kind: 'path', source: 'integration:pi', value: piPath },
    { agent: 'pi', kind: 'path', source: 'herdr:pi', value: 'relative/session.jsonl' },
    { agent: 'pi', kind: 'path', source: 'herdr:pi', value: '/home/example/session.txt' },
  ]) {
    const { deps, calls, records, handoffs } = fixture(fakeHerdr(piAgent({ agent_session: session }), piRead()));
    await handleEvent({ ...event, agent: 'pi', agent_status: 'idle' }, deps);
    assert.equal(calls.length, 1);
    assert.equal(firstCall(calls).agent.tool, 'pi');
    assert.equal(firstCall(calls).agent.session_id, session.value);
    assert.deepEqual(records, []);
    assert.deepEqual(handoffs, ['human_review_required']);
  }
});

test('empty session fields and ASCII controls in stable snapshots are rejected', async () => {
  const session = { agent: 'pi', kind: 'id', source: 'integration:pi', value: 's1' };
  for (const field of ['agent', 'kind', 'source', 'value'] as const) {
    for (const invalid of [
      '',
      `${session[field]}\x00`,
      `${session[field]}\x1f`,
      `${session[field]}\x7f`,
      `${session[field]}\n`,
    ]) {
      const changed = { ...session, [field]: invalid };
      const pane = agent({ agent: changed.agent, agent_session: changed });
      assert.equal(await observeStop(fakeHerdr(pane), 'w1:p1'), null, `${field}: ${JSON.stringify(invalid)}`);
    }
  }
});

test('session agent must match the pane agent before observation', async () => {
  const pane = agent({
    agent: 'agy',
    agent_session: { agent: 'pi', kind: 'id', source: 'herdr:antigravity_cli', value: 'sess-1' },
  });
  assert.equal(await observeStop(fakeHerdr(pane), 'w1:p1'), null);
});

test('explicit 12-line/2048-byte detection limits accept boundary without clipping', async () => {
  const within = 'a'.repeat(2037) + '\n'.repeat(11);
  const observed = await observeStop(fakeHerdr(agent(), output({ text: within })), 'w1:p1');
  assert.ok(observed);
  assert.equal(observed.context, within);
});
