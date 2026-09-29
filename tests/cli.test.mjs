import test from 'node:test';
import assert from 'node:assert/strict';
import { run, parseArgs, renderDecisionCard } from '../dist/src/cli.js';
import { config, approval, candidate, choiceAnswer, jevResponse, snapshot } from './helpers.mjs';

const CONFIG_PATH = '/isolated/xdg/agent-steward/config.json';
const SNAPSHOT_PATH = '/isolated/xdg/agent-steward/quota.json';
const NOW = new Date('2026-09-28T10:30:00Z');

function runtime(overrides = {}) {
  const out = [], err = [], reads = [];
  const cfg = config({ accounts: [], candidates: [] });
  return { out, err, reads, io: {
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' }, cwd: '/isolated/work',
    readText: async path => { reads.push(path); return JSON.stringify(cfg); },
    readStdin: async () => JSON.stringify(approval()),
    stdout: text => out.push(text), stderr: text => err.push(text),
    now: () => new Date(NOW), newRequestId: () => 'generated-1',
    post: async () => { throw new Error('unexpected post'); }, ...overrides,
  } };
}

function routeConfig(candidates = [candidate()], tools = [...new Set(candidates.map(item => item.tool))]) {
  return config({ tools, accounts: [{ id: 'shared', source: 'codex', snapshot: 'quota.json' }], candidates });
}

function fakePost(answerFor) {
  const requests = [];
  const post = async request => {
    requests.push(request);
    const wire = JSON.parse(request.body);
    return { status: 200, body: JSON.stringify(answerFor(wire, requests.length)) };
  };
  return { post, requests };
}

function routeAnswer(wire, index = 1) {
  const id = index === 1 ? 'pair' : 'effort';
  const keys = Object.keys(wire.questions[id].criteria);
  const probabilities = keys.length === 1
    ? { [keys[0]]: 1 }
    : Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.8 : 0.2 / (keys.length - 1)]));
  return jevResponse({ [id]: choiceAnswer(probabilities) });
}

function approvalAnswer(wire) {
  const waiting = Object.keys(wire.questions.waiting_for.criteria);
  return jevResponse({
    waiting_for: choiceAnswer(Object.fromEntries(waiting.map(key => [key, key === 'approve_command' ? 1 : 0]))),
    risky: { type: 'noul', noul: 0.2 },
  });
}

const result = out => JSON.parse(out.join(''));

test('launch unavailable before config or API and JSON stdout remains one envelope', async () => {
  const { io, out, err, reads } = runtime({
    readText: async () => { throw new Error('must not read'); },
    post: async () => { throw new Error('must not evaluate'); },
  });
  const code = await run(['session', 'start', 'Task', '--json'], io);
  assert.equal(code, 1);
  assert.equal(result(out).reason_code, 'execution_unavailable');
  assert.equal(result(out).request_id, 'generated-1');
  assert.equal(out.length, 1);
  assert.deepEqual(reads, []);
  assert.ok(err.every(line => !line.includes('Task')));
});

test('parser preserves the standard task data boundary and rejects options and extra arguments', () => {
  assert.deepEqual(parseArgs(['session', 'start', '--dry-run', '--', '--help']),
    { kind: 'route', task: '--help', dryRun: true, json: false });
  assert.deepEqual(parseArgs(['--config', 'chosen.json', 'session', 'start', '--dry-run', '--', '--config other.json']),
    { kind: 'route', config: 'chosen.json', task: '--config other.json', dryRun: true, json: false });
  assert.throws(() => parseArgs(['session', 'start', '--dry-run', '--', 'one', 'two']));
  assert.throws(() => parseArgs(['session', 'start', '--dry-run', '--']));
  assert.throws(() => parseArgs(['session', 'start', '--unknown', 'task']));
  assert.throws(() => parseArgs(['session', 'start', '--unknown', '--help']));
  assert.throws(() => parseArgs(['session', 'show', '--help']));
  assert.throws(() => parseArgs(['session', 'start', '--dry-run', '--', 'one', '--', 'two']));
  assert.throws(() => parseArgs(['session', 'start', '--dry-run', '--dry-run', 'task']));
  assert.deepEqual(parseArgs(['session', 'start', 'Review the parser', '--dry-run']),
    { kind: 'route', task: 'Review the parser', dryRun: true, json: false });
  assert.deepEqual(parseArgs(['session', 'start', 'task', '--json', '--config', 'custom.json']),
    { kind: 'route', config: 'custom.json', task: 'task', dryRun: false, json: true });
  assert.throws(() => parseArgs(['--config']));
  assert.throws(() => parseArgs(['--config', 'a', 'session', 'start', 'task', '--config', 'b']));
  assert.throws(() => parseArgs(['session', 'show', '1']));
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.throws(() => parseArgs(['--help', '-h']));
  assert.deepEqual(parseArgs(['approval', 'check']), { kind: 'approval' });
  assert.throws(() => parseArgs(['approval', 'check', '--json']));
});

test('help lists exactly implemented forms and requires no configuration or credentials', async () => {
  const { io, out, err, reads } = runtime({
    env: { get TYPESAFE_API_KEY() { throw new Error('help must not read credentials'); } },
    readText: async () => { throw new Error('must not read'); },
  });
  assert.equal(await run(['--help'], io), 0);
  assert.match(out.join(''), /session start <task> \[--dry-run\] \[--json\]/);
  assert.match(out.join(''), /approval check/);
  assert.doesNotMatch(out.join(''), /session show|account list|usage refresh|choose-effort/);
  assert.deepEqual(reads, []);
  assert.deepEqual(err, []);
});

test('human route card contains complete facts, command and explicit limitations', async () => {
  const cfg = routeConfig([candidate({ thinking_levels: [
    { id: 'low', description: 'Low effort' }, { id: 'high', description: 'High effort' },
  ] })]);
  const { post, requests } = fakePost(routeAnswer);
  const { io, out, err } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([
      { scope: { type: 'account' }, remaining_percent: 55, observed_at: '2026-09-28T10:00:00Z', reset_at: '2026-09-28T12:00:00Z', valid_until: '2026-09-28T11:00:00Z' },
      { scope: { type: 'pool', pool_id: 'primary' }, remaining_percent: 30, observed_at: '2026-09-28T10:00:00Z', reset_at: '2026-09-28T12:00:00Z', valid_until: '2026-09-28T11:00:00Z' },
    ])), post,
  });
  assert.equal(await run(['session', 'start', 'Review this parser', '--dry-run'], io), 0);
  const card = out.join('');
  assert.match(card, /tool: "codex"/);
  assert.match(card, /provider: "openai"/);
  assert.match(card, /model: "gpt-astra-example"/);
  assert.match(card, /thinking level: "low"/);
  assert.match(card, /account: "shared"/);
  assert.match(card, /quota source: "codex"/);
  assert.match(card, /pool: "primary"/);
  assert.match(card, /account remaining: 55%/);
  assert.match(card, /pool "primary" remaining: 30%/);
  assert.match(card, /observed at: "2026-09-28T10:00:00Z"/);
  assert.match(card, /valid until: "2026-09-28T11:00:00Z"/);
  assert.match(card, /freshness: known/);
  assert.match(card, /pair probabilities:/);
  assert.match(card, /pair confidence: 0.9/);
  assert.match(card, /effort probabilities:/);
  assert.match(card, /effort confidence: 0.9/);
  assert.match(card, /evaluator model: "jev-1.13.0"/);
  assert.match(card, /input tokens: 12/);
  assert.match(card, /planned command: 'codex'/);
  assert.match(card, /runtime model\/effort: unverified/);
  assert.match(card, /authentication\/account binding: unverified/);
  assert.equal(requests.length, 2);
  assert.deepEqual(err, []);
});

test('JSON route returns one complete schema-v1 result with a generated request ID', async () => {
  const cfg = routeConfig();
  const { post, requests } = fakePost(routeAnswer);
  const { io, out, err } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([])), post,
  });
  assert.equal(await run(['session', 'start', 'Review', '--dry-run', '--json'], io), 0);
  const parsed = result(out);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.decision, 'selected');
  assert.equal(parsed.request_id, 'generated-1');
  assert.equal(parsed.selected.tool, 'codex');
  assert.equal(parsed.planned_command.runtime_selection, 'unverified');
  assert.equal(parsed.evaluations.effort.kind, 'fixed');
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith('\n'));
  assert.deepEqual(err, []);
  assert.equal(requests.length, 1);
});

test('pair choices remain independent across tools and chosen effort uses configured order', async () => {
  const candidates = [
    candidate({ id: 'codex-choice', thinking_levels: [{ id: 'low', description: 'Low' }, { id: 'high', description: 'High' }] }),
    candidate({ id: 'pi-choice', tool: 'pi', provider: 'openai-codex', thinking_levels: [{ id: 'minimal', description: 'Minimal' }] }),
  ];
  const cfg = routeConfig(candidates);
  const { post, requests } = fakePost((wire, index) => {
    if (index === 1) return jevResponse({ pair: choiceAnswer({ 'codex-choice': 0.2, 'pi-choice': 0.8 }, 0.1) });
    return jevResponse({ effort: choiceAnswer({ low: 0.5, high: 0.5 }, 0.01, 'high') });
  });
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([])), post,
  });
  assert.equal(await run(['session', 'start', 'task', '--dry-run', '--json'], io), 0);
  assert.equal(result(out).selected.candidate_id, 'pi-choice');
  assert.equal(result(out).selected.tool, 'pi');
  assert.equal(result(out).selected.thinking_level, 'minimal');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, 'Bearer test-key');
});

test('fixed and selected effort use explicit safe human rendering', () => {
  const selected = {
    request_id: 'id', decision: 'selected', selected: {
      candidate_id: 'x', tool: 'codex', provider: 'openai', model: 'm', thinking_level: 'low', account_id: 'a', quota_pool: 'p',
    }, quota: { source: 'codex', account_id: 'a', pool_id: 'p', snapshot_status: 'missing', account_status: 'unknown', pool_status: 'unknown', windows: [] },
    planned_command: { executable: 'codex', args: [], display: "'codex'", syntax_validated: true, runtime_selection: 'unverified', authentication: 'unverified', provider_selection: 'explicit_flag' },
    evaluations: { pair: { model: 'jev', answers: { pair: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.8 } }, usage: {} }, effort: { kind: 'fixed', level: 'low' } },
  };
  const card = renderDecisionCard(selected);
  assert.match(card, /snapshot status: missing/);
  assert.match(card, /account status: unknown/);
  assert.match(card, /pool status: unknown/);
  assert.match(card, /account remaining: unknown/);
  assert.match(card, /pool remaining: unknown/);
  assert.match(card, /fixed thinking level: "low"/);
  assert.match(card, /input tokens: not reported/);
  assert.match(card, /output tokens: not reported/);
  assert.match(card, /freshness: unknown/);
});

test('approval JSON exits are approve 0, manual review 2, no action 3, errors 1', async () => {
  for (const [waitingFor, risk, confidence, decision, exit] of [
    ['approve_command', 0.2, 0.9, 'approve', 0],
    ['approve_edit', 0.6, 0.9, 'manual_review', 2],
    ['other', 0.1, 0.9, 'manual_review', 2],
    ['answer_question', 0.1, 0.9, 'no_action', 3],
  ]) {
    const { post } = fakePost(() => jevResponse({
      waiting_for: choiceAnswer(Object.fromEntries(['approve_command', 'approve_edit', 'answer_question', 'credentials', 'error_help', 'other'].map(key => [key, key === waitingFor ? 1 : 0])), confidence),
      risky: { type: 'noul', noul: risk },
    }));
    const { io, out, err } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' }, post,
    });
    assert.equal(await run(['approval', 'check'], io), exit, waitingFor);
    assert.equal(result(out).decision, decision, waitingFor);
    assert.equal(out.length, 1);
    assert.ok(out[0].endsWith('\n'));
    assert.deepEqual(err, []);
  }
  const { io, out } = runtime({ readStdin: async () => '{' });
  assert.equal(await run(['approval', 'check'], io), 1);
  assert.equal(result(out).reason_code, 'invalid_input');
});

test('insufficient-context approval remains local without an API key or transport', async () => {
  const { io, out, reads, err } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
    readStdin: async () => JSON.stringify(approval({ context: {}, pending_action: null })),
    post: async () => { throw new Error('must not post'); },
  });
  assert.equal(await run(['approval', 'check'], io), 2);
  const value = result(out);
  assert.equal(value.reason_code, 'insufficient_context');
  assert.equal(value.waiting_for, null);
  assert.equal(value.evaluation, null);
  assert.deepEqual(reads, [CONFIG_PATH]);
  assert.deepEqual(err, []);
});

test('captured optional key does not leak through local results or safe error IDs', async () => {
  const apiKey = 'SyntheticKey-Not-Pattern-4f91';
  const assertSafe = (out, err) => assert.equal((out.join('') + err.join('')).includes(apiKey), false);
  const env = { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: apiKey };

  const local = runtime({
    env,
    readStdin: async () => JSON.stringify(approval({ request_id: 'local-safe-id', context: {}, pending_action: null })),
    post: async () => { throw new Error('must not post'); },
  });
  assert.equal(await run(['approval', 'check'], local.io), 2);
  assert.equal(result(local.out).decision, 'manual_review');
  assert.equal(result(local.out).request_id, 'local-safe-id');
  assertSafe(local.out, local.err);

  const invalidInput = runtime({
    env,
    readStdin: async () => JSON.stringify(approval({ request_id: 'invalid-input-safe-id', agent: { id: '', tool: 'codex' } })),
  });
  assert.equal(await run(['approval', 'check'], invalidInput.io), 1);
  assert.equal(result(invalidInput.out).reason_code, 'invalid_input');
  assert.equal(result(invalidInput.out).request_id, 'invalid-input-safe-id');
  assertSafe(invalidInput.out, invalidInput.err);

  const invalidConfig = runtime({
    env,
    readStdin: async () => JSON.stringify(approval({ request_id: 'invalid-config-safe-id' })),
    readText: async () => '{',
  });
  assert.equal(await run(['approval', 'check'], invalidConfig.io), 1);
  assert.equal(result(invalidConfig.out).reason_code, 'invalid_config');
  assert.equal(result(invalidConfig.out).request_id, 'invalid-config-safe-id');
  assertSafe(invalidConfig.out, invalidConfig.err);

  const preflightConfig = routeConfig([candidate({ model: '--unmappable' })]);
  const preflight = runtime({
    env,
    newRequestId: () => 'preflight-safe-id',
    readText: async path => path === CONFIG_PATH ? JSON.stringify(preflightConfig) : JSON.stringify(snapshot([])),
  });
  assert.equal(await run(['session', 'start', 'task', '--dry-run', '--json'], preflight.io), 1);
  assert.equal(result(preflight.out).reason_code, 'invalid_config');
  assert.equal(result(preflight.out).request_id, 'preflight-safe-id');
  assertSafe(preflight.out, preflight.err);

  const missingConfig = runtime({
    env,
    newRequestId: () => 'missing-config-safe-id',
    readText: async () => { throw new Error('synthetic missing config'); },
  });
  assert.equal(await run(['session', 'start', 'task', '--dry-run', '--json'], missingConfig.io), 1);
  assert.equal(result(missingConfig.out).reason_code, 'invalid_config');
  assert.equal(result(missingConfig.out).request_id, 'missing-config-safe-id');
  assertSafe(missingConfig.out, missingConfig.err);

  let reads = 0, posts = 0;
  const unavailable = runtime({
    env,
    newRequestId: () => 'safe-generated-id',
    readText: async () => { reads++; throw new Error('must not read'); },
    post: async () => { posts++; throw new Error('must not post'); },
  });
  assert.equal(await run(['session', 'start', 'task', '--json'], unavailable.io), 1);
  assert.equal(result(unavailable.out).reason_code, 'execution_unavailable');
  assert.equal(result(unavailable.out).request_id, 'safe-generated-id');
  assert.equal(reads, 0);
  assert.equal(posts, 0);
  assertSafe(unavailable.out, unavailable.err);
});

test('configured non-pattern key rejects generated and caller IDs containing it as a substring', async () => {
  const apiKey = 'SyntheticKey-Not-Pattern-4f91';
  const contaminatedId = `prefix-${apiKey}-suffix`;
  const env = { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: apiKey };
  for (const [args, overrides] of [
    [['session', 'start', 'task'], { newRequestId: () => contaminatedId }],
    [['approval', 'check'], { readStdin: async () => JSON.stringify(approval({ request_id: contaminatedId })) }],
  ]) {
    const { io, out, err, reads } = runtime({ ...overrides, env, post: async () => { throw new Error('must not post'); } });
    assert.equal(await run(args, io), 1);
    assert.equal((out.join('') + err.join('')).includes(apiKey), false);
    assert.equal(result(out).reason_code, 'credential_detected');
    assert.equal(result(out).request_id, null);
    assert.equal(out.length, 1);
    if (args[0] === 'session') {
      assert.deepEqual(reads, []);
      assert.deepEqual(err, ['agent-steward: credential_detected\n']);
    }
  }
});

test('approval reads no quota and needs no non-empty routing inventory', async () => {
  const empty = config({ accounts: [], candidates: [] });
  const { post } = fakePost(approvalAnswer);
  const { io, out, reads } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async path => { reads.push(path); return JSON.stringify(empty); }, post,
  });
  assert.equal(await run(['approval', 'check'], io), 0);
  assert.deepEqual(reads, [CONFIG_PATH]);
  assert.equal(result(out).decision, 'approve');
});

test('lazy credential lookup reports missing API key only when evaluation is needed', async () => {
  for (const args of [['session', 'start', 'task', '--dry-run'], ['approval', 'check']]) {
    const cfg = routeConfig();
    const { io, out } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
      readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([])),
    });
    assert.equal(await run(args, io), 1);
    assert.equal(result(out).reason_code, 'missing_credentials');
  }
});

test('custom config, enabled-tool filtering, and quota diagnostics remain local and safe', async () => {
  const cfg = routeConfig([candidate(), candidate({ id: 'disabled', tool: 'pi', provider: 'openai-codex' })], ['codex']);
  const { post } = fakePost(routeAnswer);
  const { io, out, err, reads } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async path => { reads.push(path); if (path === '/isolated/work/custom.json') return JSON.stringify(cfg); throw new Error('missing fixture'); }, post,
  });
  assert.equal(await run(['session', 'start', 'task', '--config', 'custom.json', '--dry-run', '--json'], io), 0);
  assert.deepEqual(reads, ['/isolated/work/custom.json', '/isolated/work/quota.json']);
  assert.match(err.join(''), /quota_unreadable/);
  assert.doesNotMatch(err.join(''), /missing fixture|custom\.json|task/);
  assert.equal(result(out).selected.candidate_id, 'codex-astra');
});

test('invalid input and configuration produce one safe JSON error envelope', async () => {
  for (const [args, overrides, reason] of [
    [['approval', 'check'], { readStdin: async () => '{' }, 'invalid_input'],
    [['approval', 'check'], { readText: async () => '{' }, 'invalid_config'],
    [['session', 'start', ''], {}, 'invalid_input'],
  ]) {
    const { io, out } = runtime(overrides);
    assert.equal(await run(args, io), 1);
    assert.equal(out.length, 1);
    assert.equal(result(out).reason_code, reason);
  }
  const { io, out } = runtime();
  assert.equal(await run(['not-a-command'], io), 1);
  assert.equal(result(out).decision, 'error');
});

test('approval request IDs are preserved on later validation errors and malformed JSON uses null', async () => {
  const withId = approval({ agent: { id: '', tool: 'codex' } });
  const first = runtime({ readStdin: async () => JSON.stringify(withId) });
  assert.equal(await run(['approval', 'check'], first.io), 1);
  assert.equal(result(first.out).request_id, 'request-1');
  const second = runtime({ readStdin: async () => '{"request_id":"secret' });
  assert.equal(await run(['approval', 'check'], second.io), 1);
  assert.equal(result(second.out).request_id, null);
  const third = runtime({ readStdin: async () => JSON.stringify(approval({ request_id: '   ' })) });
  assert.equal(await run(['approval', 'check'], third.io), 1);
  assert.equal(result(third.out).request_id, null);
});

test('secret-containing caller IDs and untrusted evaluator metadata never reach output', async () => {
  const secret = 'sk-12345678901234567890';
  const badId = runtime({ readStdin: async () => JSON.stringify(approval({ request_id: secret })) });
  assert.equal(await run(['approval', 'check'], badId.io), 1);
  assert.equal(result(badId.out).reason_code, 'credential_detected');
  assert.equal(result(badId.out).request_id, null);
  assert.doesNotMatch(badId.out.join('') + badId.err.join(''), /12345678901234567890/);

  const forConfig = routeConfig();
  const { post } = fakePost(() => jevResponse({ pair: choiceAnswer({ 'codex-astra': 1 }) }, { model: secret }));
  const leaked = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: secret },
    readText: async path => path === CONFIG_PATH ? JSON.stringify(forConfig) : JSON.stringify(snapshot([])), post,
  });
  assert.equal(await run(['session', 'start', 'task', '--dry-run', '--json'], leaked.io), 1);
  assert.equal(result(leaked.out).reason_code, 'credential_detected');
  assert.equal(result(leaked.out).decision, 'error');
  assert.doesNotMatch(leaked.out.join('') + leaked.err.join(''), /12345678901234567890/);

  const { post: humanPost } = fakePost(() => jevResponse(
    { pair: choiceAnswer({ 'codex-astra': 1 }) }, { model: secret },
  ));
  const human = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: secret },
    readText: async path => path === CONFIG_PATH ? JSON.stringify(forConfig) : JSON.stringify(snapshot([])), post: humanPost,
  });
  assert.equal(await run(['session', 'start', 'private task', '--dry-run'], human.io), 1);
  assert.equal(result(human.out).reason_code, 'credential_detected');
  assert.equal(result(human.out).decision, 'error');
  assert.deepEqual(human.err, ['agent-steward: credential_detected\n']);
  assert.doesNotMatch(human.out.join('') + human.err.join(''), /12345678901234567890/);
});

test('approval evaluator metadata is checked before JSON output too', async () => {
  const secret = 'sk-12345678901234567890';
  const { post } = fakePost(() => jevResponse({
    waiting_for: choiceAnswer({ approve_command: 1, approve_edit: 0, answer_question: 0, credentials: 0, error_help: 0, other: 0 }),
    risky: { type: 'noul', noul: 0.1 },
  }, { model: secret }));
  const { io, out, err } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: secret }, post,
  });
  assert.equal(await run(['approval', 'check'], io), 1);
  assert.equal(result(out).reason_code, 'credential_detected');
  assert.equal(result(out).decision, 'error');
  assert.doesNotMatch(out.join('') + err.join(''), /12345678901234567890/);
});

test('failed second evaluation emits only one error and never a partial route', async () => {
  const cfg = routeConfig([candidate({ thinking_levels: [{ id: 'low', description: 'Low' }, { id: 'high', description: 'High' }] })]);
  const { post } = fakePost((wire, index) => index === 1
    ? jevResponse({ pair: choiceAnswer({ 'codex-astra': 1 }) })
    : { model: 'jev-1.13.0', answers: {}, usage: {} });
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([])), post,
  });
  assert.equal(await run(['session', 'start', 'task', '--dry-run'], io), 1);
  assert.equal(out.length, 1);
  assert.equal(result(out).decision, 'error');
  assert.equal(result(out).reason_code, 'invalid_response');
});

test('human cards JSON-escape untrusted metadata and generated IDs are credential checked', async () => {
  const cfg = routeConfig([candidate({ capabilities: 'safe\u001b[31m', thinking_levels: [{ id: 'low', description: 'Low' }, { id: 'high', description: 'High' }] })]);
  const { post } = fakePost(routeAnswer);
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    newRequestId: () => 'generated\u001b[31m',
    readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([])), post,
  });
  assert.equal(await run(['session', 'start', 'task', '--dry-run'], io), 0);
  assert.match(out.join(''), /generated\\u001b/);
  assert.doesNotMatch(out.join(''), /generated\u001b/);
});

test('API and malformed data errors are sanitized and preserve the safe ID', async () => {
  const cfg = routeConfig();
  for (const [post, reason] of [
    [async () => { throw new Error('raw token and task leaked'); }, 'evaluation_failed'],
    [async () => ({ status: 200, body: 'not json' }), 'invalid_response'],
  ]) {
    const { io, out, err } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
      readText: async path => path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([])), post,
    });
    assert.equal(await run(['session', 'start', 'private task', '--dry-run', '--json'], io), 1);
    assert.equal(result(out).reason_code, reason);
    assert.equal(result(out).request_id, 'generated-1');
    assert.doesNotMatch(out.join('') + err.join(''), /raw token|private task/);
  }
});

test('parse failures default to a JSON envelope and do not leak arguments', async () => {
  const { io, out, err } = runtime();
  assert.equal(await run(['session', 'start', '--unknown', 'sensitive-task'], io), 1);
  assert.equal(result(out).reason_code, 'invalid_input');
  assert.doesNotMatch(out.join('') + err.join(''), /sensitive-task/);
});
