import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { run, parseArgs, renderDecisionCard } from '../src/cli.ts';
import type { Runtime } from '../src/cli.ts';
import type { Config, Evaluation, SelectedResult, StopInput } from '../src/contracts.ts';
import type { HttpPost, Questions } from '../src/jev.ts';
import type { NativeLaunch } from '../src/launch.ts';
import { config, candidate, choiceAnswer, jevResponse, snapshot, windowFact } from './helpers.ts';

type JevWire = { model: string; state: unknown; questions: Questions };
type PostAnswer = (wire: JevWire, index: number) => unknown;

const CONFIG_PATH = '/isolated/xdg/agent-steward/config.json';
const SNAPSHOT_PATH = '/isolated/home/.local/state/agent-steward/quota/codex.json';
const NOW = new Date('2026-09-28T10:30:00Z');

function runtime(overrides: Partial<Runtime> = {}) {
  const out: string[] = [],
    err: string[] = [],
    reads: string[] = [],
    launches: NativeLaunch[] = [];
  const { launch: launchOverride, ...ioOverrides } = overrides;
  const cfg = config({ candidates: [] });
  const files = new Map<string, string>();
  const io: Runtime = {
    appendText: async (path, text) => {
      files.set(path, (files.get(path) ?? '') + text);
    },
    readTextIfPresent: async (path) => files.get(path) ?? null,
    fileSize: async (path) => Buffer.byteLength(files.get(path) ?? ''),
    withLedgerLock: async (_path, action) => action(),
    writeText: async (path, text) => {
      files.set(path, text);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    unlink: async (path) => {
      files.delete(path);
    },
    httpGet: async () => {
      throw new Error('unexpected quota GET');
    },
    withAgyLock: async (_path, action) => action(),
    collectAgy: async () => {
      throw new Error('unexpected native quota');
    },
    setupAgy: async () => {
      throw new Error('unexpected setup');
    },
    runAgyHook: async () => {
      throw new Error('unexpected hook');
    },
    mkdirp: async () => {},
    chmod: async () => {},
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
    cwd: '/isolated/work',
    terminal: { stdin: true, stdout: true },
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(cfg);
    },
    readStdin: async () => JSON.stringify(stopInput()),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => new Date(NOW),
    newRequestId: () => 'generated-1',
    post: async () => {
      throw new Error('unexpected post');
    },
    launch: async (command) => {
      launches.push(command);
      if (launchOverride === undefined) throw new Error('unexpected launch');
      return launchOverride(command);
    },
    ...ioOverrides,
  };
  return { out, err, reads, launches, io, files };
}

test('doctor parses config and JSON flags and rejects extra arguments', () => {
  assert.deepEqual(parseArgs(['--config', 'local.json', 'doctor', '--json']), {
    kind: 'doctor',
    config: 'local.json',
    json: true,
  });
  assert.deepEqual(parseArgs(['doctor', '--help']), { kind: 'help' });
  for (const flags of [['extra'], ['--json', '--json'], ['--', 'task'], ['--dry-run']])
    assert.throws(() => parseArgs(['doctor', ...flags]));
});

test('doctor checks only enabled referenced tools without network, launches, auth reads or writes', async () => {
  const cfg = config({
    tools: ['codex', 'pi'],
    candidates: [candidate(), candidate({ id: 'disabled', tool: 'agy', quota_bucket: 'antigravity' })],
  });
  const { io, out, err, reads, launches, files } = runtime({
    env: { HOME: '/isolated/home', PATH: '/isolated/bin', TYPESAFE_API_KEY: 'OpaqueSecretValue' },
    terminal: { stdin: false, stdout: false },
    readText: async (path) => {
      reads.push(path);
      assert.equal(path, '/isolated/work/local.json');
      return JSON.stringify(cfg);
    },
    executableAvailable: (tool, path) => tool === 'codex' && path === '/isolated/bin',
  });
  assert.equal(await run(['doctor', '--config', 'local.json', '--json'], io), 0);
  const report = JSON.parse(out.join(''));
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((check: { id: string; status: string }) => [check.id, check.status]),
    [
      ['config', 'pass'],
      ['path', 'pass'],
      ['executable.codex', 'pass'],
      ['evaluator_key', 'pass'],
    ],
  );
  assert.equal(reads.length, 1);
  assert.equal(launches.length, 0);
  assert.equal(files.size, 0);
  assert.equal(err.join(''), '');
  assert.doesNotMatch(out.join(''), /OpaqueSecretValue/);
});

test('doctor continues independent checks after config failures and skips config-dependent checks', async () => {
  for (const [contents, kind] of [
    [null, 'read'],
    ['{', 'json'],
    [JSON.stringify({ tools: [] }), 'schema'],
  ] as const) {
    const { io, out } = runtime({
      env: { HOME: '/isolated/home', PATH: 'relative' },
      readText: async () => {
        if (contents === null) throw new Error('private raw failure');
        return contents;
      },
    });
    assert.equal(await run(['doctor', '--json'], io), 1);
    const report = JSON.parse(out.join(''));
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].kind, kind);
    assert.deepEqual(
      report.checks.map((check: { status: string }) => check.status),
      ['fail', 'fail', 'skipped', 'skipped'],
    );
    assert.ok(report.checks[0].fix);
    assert.doesNotMatch(out.join(''), /private raw failure/);
  }
});

test('doctor reports missing executables and selected evaluator key with actionable fixes', async () => {
  const { io, out } = runtime({
    env: {
      HOME: '/isolated/home',
      PATH: '/isolated/bin',
      TYPESAFE_API_KEY: 'wrong-provider-key',
      OPENROUTER_API_KEY: '  ',
    },
    readText: async () => JSON.stringify(config({ evaluator: { type: 'jev', provider: 'openrouter' } })),
    executableAvailable: () => false,
  });
  assert.equal(await run(['doctor'], io), 1);
  assert.match(out.join(''), /❌ executable.codex — Executable is unavailable\.\n\tFix: Install codex/);
  assert.match(out.join(''), /✅ config —/);
  assert.doesNotMatch(out.join(''), /: (?:pass|fail|skipped) -/);
  assert.match(out.join(''), /Install codex/);
  assert.match(out.join(''), /OPENROUTER_API_KEY/);
  assert.doesNotMatch(out.join(''), /wrong-provider-key/);
});

test('doctor rejects empty candidate sets and does not echo unsafe config fields or paths', async () => {
  for (const cfg of [config({ candidates: [] }), { ...config(), OpaqueSecretValue: 'private' }]) {
    const { io, out } = runtime({
      env: { HOME: '/isolated/home', PATH: '/isolated/bin', TYPESAFE_API_KEY: 'OpaqueSecretValue' },
      readText: async () => JSON.stringify(cfg),
    });
    assert.equal(await run(['doctor', '--config', 'OpaqueSecretValue.json', '--json'], io), 1);
    const report = JSON.parse(out.join(''));
    assert.equal(report.checks[0].status, 'fail');
    assert.doesNotMatch(out.join(''), /OpaqueSecretValue|private/);
  }
});

test('doctor output privacy failures remain local without publishing launcher logs', async () => {
  let logs = 0;
  const { io, out, err } = runtime({
    env: { HOME: '/isolated/home', PATH: '/isolated/bin', TYPESAFE_API_KEY: 'evaluator_key' },
    readText: async () => JSON.stringify(config()),
    executableAvailable: () => true,
    logFailure: async () => {
      logs++;
    },
  });
  assert.equal(await run(['doctor', '--json'], io), 1);
  assert.equal(JSON.parse(out.join('')).reason_code, 'credential_detected');
  assert.doesNotMatch(out.join('') + err.join(''), /evaluator_key/);
  assert.equal(logs, 0);
});

test('OpenRouter routing uses only its selected credential and records normalized Jev answers', async () => {
  const cfg = routeConfig();
  cfg.evaluator = { type: 'jev', provider: 'openrouter', model: '~typesafe/jev-latest' };
  const { post, requests } = fakePost((wire, index) => ({
    ...(routeAnswer(wire, index) as Evaluation),
    id: 'gen-example',
    provider: 'TypeSafe',
    usage: { input_tokens: 12, output_tokens: 3, cost: 0.0001 },
  }));
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', OPENROUTER_API_KEY: 'opaque-openrouter-value', TYPESAFE_API_KEY: 'other-key' },
    readText: async () => JSON.stringify(cfg),
    post,
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run', '--json'], io), 0);
  assert.equal(result(out).decision, 'selected');
  assert.equal(requests[0]?.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(requests[0]?.headers.authorization, 'Bearer opaque-openrouter-value');
  assert.doesNotMatch(out.join(''), /opaque-openrouter-value|other-key/);
});

test('OpenRouter has no credential fallback and empty stop context remains local', async () => {
  const cfg = config({ evaluator: { type: 'jev', provider: 'openrouter', model: '~typesafe/jev-latest' } });
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', TYPESAFE_API_KEY: 'other-key' },
    readText: async () => JSON.stringify(cfg),
  });
  assert.equal(await run(['stop', 'check'], io), 1);
  assert.equal(result(out).reason_code, 'missing_credentials');
  out.length = 0;
  io.readStdin = async () => JSON.stringify(stopInput({ context: null }));
  assert.equal(await run(['stop', 'check'], io), 2);
  assert.equal(result(out).reason_code, 'insufficient_context');
});

test('OpenRouter optional key protects local IDs and config diagnostics before evaluation', async () => {
  const secret = 'OpaqueOpenrouterValue';
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', OPENROUTER_API_KEY: secret },
    readStdin: async () => JSON.stringify(stopInput({ request_id: `prefix-${secret}`, context: null })),
  });
  assert.equal(await run(['stop', 'check'], io), 1);
  assert.doesNotMatch(out.join(''), /OpaqueOpenrouterValue/);
  out.length = 0;
  io.readStdin = async () => JSON.stringify(stopInput());
  io.readText = async () => JSON.stringify({ ...config(), [secret]: 'private' });
  assert.equal(await run(['stop', 'check'], io), 1);
  assert.doesNotMatch(out.join(''), /OpaqueOpenrouterValue|private/);
});

test('exact quota setup/hook parsing rejects config, JSON flags and extra arguments', () => {
  assert.deepEqual(parseArgs(['quota', 'setup', 'agy']), { kind: 'quota-setup-agy' });
  assert.deepEqual(parseArgs(['quota', 'hook', 'agy']), { kind: 'quota-hook-agy' });
  for (const verb of ['setup', 'hook']) {
    assert.deepEqual(parseArgs(['quota', verb, 'agy', '--help']), { kind: 'help' });
    for (const extra of [['--json'], ['extra'], ['--', 'extra'], ['--config', 'config.json']])
      assert.throws(() => parseArgs(['quota', verb, 'agy', ...extra]));
  }
});
test('setup/hook dispatch is config-free, offline and non-TTY', async () => {
  let setups = 0;
  let original = '';
  const { io, reads, out } = runtime({
    terminal: { stdin: false, stdout: false },
    setupAgy: async () => {
      setups++;
    },
    runAgyHook: async (input) => {
      original = input;
      return { stdout: 'original renderer\n', exitCode: 7 };
    },
    readStdin: async () => '{ malformed input',
  });
  assert.equal(await run(['quota', 'setup', 'agy'], io), 0);
  assert.equal(setups, 1);
  assert.match(out.join(''), /trust/i);
  assert.match(out.join(''), /restor/i);
  out.length = 0;
  assert.equal(await run(['quota', 'hook', 'agy'], io), 7);
  assert.equal(original, '{ malformed input');
  assert.deepEqual(out, ['original renderer\n']);
  assert.deepEqual(reads, []);
});

test('AGY setup/trust failure diagnostics are fixed and failed refresh exits one', async () => {
  const { agyAuth } = await import('./agy-helpers.ts');
  for (const diagnostic of ['quota_agy_setup', 'quota_agy_trust'] as const) {
    const cfg = routeConfig([candidate({ tool: 'agy', quota_bucket: 'antigravity' })]);
    const { io, out, err } = runtime({
      terminal: { stdin: false, stdout: false },
      readText: async (path) => (path.endsWith('/config.json') ? JSON.stringify(cfg) : agyAuth()),
      collectAgy: async () => ({ status: 'fetch', diagnostic }),
    });
    assert.equal(await run(['quota', 'refresh', '--json'], io), 1);
    assert.deepEqual(result(out).buckets, [{ bucket: 'antigravity', status: 'fetch' }]);
    assert.deepEqual(err, [`agent-steward: ${diagnostic}\n`, 'agent-steward: quota_fetch\n']);
  }
});

function routeConfig(
  candidates = [candidate()],
  tools: Config['tools'] = [...new Set(candidates.map((item) => item.tool))],
) {
  return config({ tools, candidates });
}

function fakePost(answerFor: PostAnswer) {
  const requests: { url: string; headers: Record<string, string>; body: string; signal: AbortSignal }[] = [];
  const post = async (request: (typeof requests)[number]) => {
    requests.push(request);
    const wire = JSON.parse(request.body) as JevWire;
    return { status: 200, body: JSON.stringify(answerFor(wire, requests.length)) };
  };
  return { post, requests };
}

function routeAnswer(wire: JevWire, index = 1): unknown {
  const id = index === 1 ? 'pair' : 'effort';
  const question = wire.questions[id];
  if (question?.type !== 'choice') throw new Error(`missing choice question: ${id}`);
  const keys = Object.keys(question.criteria);
  const firstKey = keys[0];
  if (firstKey === undefined) throw new Error(`choice question has no options: ${id}`);
  const probabilities =
    keys.length === 1
      ? { [firstKey]: 1 }
      : Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.8 : 0.2 / (keys.length - 1)]));
  return jevResponse({ [id]: choiceAnswer(probabilities) });
}

const result = (out: string[]) => JSON.parse(out.join(''));

function stopInput(overrides: Partial<StopInput> = {}): StopInput {
  return {
    schema_version: 2,
    request_id: 'request-1',
    agent: { id: 'agent-1', tool: 'pi', pane_id: 'w1:p2', session_id: null },
    status: 'blocked',
    current_episode_id: 'episode-1',
    context: 'The stopped agent reports a recoverable API error.',
    pending_action: { action: 'Retry the current API operation' },
    automatic_approval_forbidden: false,
    retry: {
      failure_episode_id: 'episode-1',
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
    ...overrides,
  };
}

function stopAnswer(wire: JevWire, waitingFor = 'recoverable_api_error', risk = 0.1, confidence = 0.9): Evaluation {
  const question = wire.questions['waiting_for'];
  if (question?.type !== 'choice') throw new Error('missing waiting-for question');
  const criteria = Object.keys(question.criteria);
  return jevResponse({
    waiting_for: choiceAnswer(Object.fromEntries(criteria.map((key) => [key, key === waitingFor ? 1 : 0])), confidence),
    risky: { type: 'noul', noul: risk },
  });
}

test('quota show parses config, JSON and help but rejects extra arguments', () => {
  assert.deepEqual(parseArgs(['quota', 'show']), { kind: 'quota-show', json: false });
  assert.deepEqual(parseArgs(['quota', 'show', '--json', '--config', 'custom.json']), {
    kind: 'quota-show',
    json: true,
    config: 'custom.json',
  });
  assert.deepEqual(parseArgs(['quota', 'show', '--help']), { kind: 'help' });
  for (const tail of [['extra'], ['--json', '--json'], ['--'], ['--dry-run']])
    assert.throws(() => parseArgs(['quota', 'show', ...tail]), { code: 'invalid_input' });
});

test('quota show is read-only and displays every bucket window once with relative times', async () => {
  const cfg = config({
    candidates: [
      candidate(),
      candidate({ id: 'duplicate' }),
      candidate({ id: 'disabled', tool: 'pi', quota_bucket: 'pi_xai' }),
    ],
    tools: ['codex'],
  });
  const reads: string[] = [];
  const forbidden = async () => {
    throw new Error('quota show must be offline and read-only');
  };
  const { io, out, err } = runtime({
    terminal: { stdin: false, stdout: false },
    readText: async (path) => {
      reads.push(path);
      if (path === CONFIG_PATH) return JSON.stringify(cfg);
      assert.equal(path, SNAPSHOT_PATH);
      return JSON.stringify(
        snapshot([
          windowFact({ type: 'account' }, { id: 'primary', remaining_percent: 0 }),
          windowFact({ type: 'pool', pool_id: 'unconfigured' }, { id: 'weekly', cadence: 'weekly' }),
        ]),
      );
    },
    httpGet: forbidden,
    post: forbidden,
    collectAgy: forbidden,
    readStdin: forbidden,
    writeText: forbidden,
    mkdirp: forbidden,
    chmod: forbidden,
    rename: forbidden,
    unlink: forbidden,
    appendText: forbidden,
  });
  assert.equal(await run(['quota', 'show'], io), 0);
  assert.deepEqual(reads, [CONFIG_PATH, SNAPSHOT_PATH]);
  assert.deepEqual(err, []);
  assert.match(out.join(''), /primary.*░{20}\s+0%/);
  assert.match(out.join(''), /all captured 30m ago/);
  assert.match(out.join(''), /resets in 1h/);
  assert.match(out.join(''), /unconfigured/);
  assert.doesNotMatch(out.join(''), /2026-|identity_fingerprint/);
});

test('quota show renders aligned bars and rounds only the displayed percentage', async () => {
  const { io, out } = runtime({
    terminal: { stdin: false, stdout: false },
    readText: async (path) =>
      path === CONFIG_PATH
        ? JSON.stringify(config())
        : JSON.stringify(
            snapshot([
              windowFact({ type: 'account' }, { id: 'primary', cadence: 'weekly', remaining_percent: 86 }),
              windowFact({ type: 'account' }, { id: 'credits', cadence: 'weekly', remaining_percent: 63 }),
              windowFact({ type: 'account' }, { id: 'reserve', cadence: 'weekly', remaining_percent: 100 }),
              windowFact({ type: 'pool', pool_id: 'gemini' }, { id: '5h', remaining_percent: 99.19171 }),
              windowFact({ type: 'pool', pool_id: 'gemini' }, { id: 'weekly', remaining_percent: 87.33336 }),
            ]),
          ),
  });
  assert.equal(await run(['quota', 'show'], io), 0);
  const text = out.join('');
  assert.match(text, /^codex · loaded\n/);
  assert.match(text, /primary\s+weekly\s+█████████████████░░░\s+86%\s+resets in 1h/);
  assert.match(text, /credits\s+weekly\s+█████████████░░░░░░░\s+63%/);
  assert.match(text, /reserve\s+weekly\s+████████████████████\s+100%/);
  assert.match(text, /gemini\s+5h\s+████████████████████\s+99\.2%/);
  assert.match(text, /gemini\s+weekly\s+█████████████████░░░\s+87\.3%/);
  const rows = text.split('\n').filter((line) => line.includes('█'));
  assert.equal(new Set(rows.map((line) => line.indexOf('█'))).size, 1);
  assert.match(text, /\n\nCaptured remaining · all captured 30m ago\n$/);
  assert.equal(text.match(/captured/g)?.length, 1);
  assert.ok(!text.includes('\u001b'));
  assert.doesNotMatch(text, /99\.19171|87\.33336/);
  out.length = 0;
  assert.equal(await run(['quota', 'show', '--json'], io), 0);
  const windows = JSON.parse(out.join('')).buckets[0].windows;
  assert.equal(windows[3].captured_remaining_percent, 99.19171);
  assert.equal(windows[4].captured_remaining_percent, 87.33336);
});

test('quota show keeps individual capture times and historical warnings when captures differ', async () => {
  const { io, out } = runtime({
    readText: async (path) =>
      path === CONFIG_PATH
        ? JSON.stringify(config())
        : JSON.stringify(
            snapshot([
              windowFact({ type: 'account' }, { id: 'fresh' }),
              windowFact(
                { type: 'account' },
                {
                  id: 'old',
                  observed_at: '2026-09-28T09:30:00Z',
                  valid_until: NOW.toISOString(),
                },
              ),
            ]),
          ),
  });
  assert.equal(await run(['quota', 'show'], io), 0);
  const text = out.join('');
  assert.match(text, /fresh.*captured 30m ago/);
  assert.match(text, /old.*captured 1h ago.*historical, expired/);
  assert.match(text, /Captured remaining\n$/);
  assert.doesNotMatch(text, /all captured/);
});

test('quota show escapes unsafe display labels and handles text empty inventory', async () => {
  const { io, out } = runtime({
    readText: async (path) =>
      path === CONFIG_PATH
        ? JSON.stringify(config())
        : JSON.stringify(snapshot([windowFact({ type: 'account' }, { id: 'line\n\u001b[31m' })])),
  });
  assert.equal(await run(['quota', 'show'], io), 0);
  assert.ok(out.join('').includes('"line\\n\\u001b[31m"'));
  assert.ok(!out.join('').includes('\u001b'));
  const empty = runtime();
  assert.equal(await run(['quota', 'show'], empty.io), 0);
  assert.equal(empty.out.join(''), 'No enabled quota buckets.\n');
});

test('quota show groups providers and shares equivalent capture timestamps across buckets', async () => {
  const cfg = config({ candidates: [candidate(), candidate({ id: 'pi', tool: 'pi', quota_bucket: 'pi_codex' })] });
  const { io, out } = runtime({
    readText: async (path) => {
      if (path === CONFIG_PATH) return JSON.stringify(cfg);
      const source = path === SNAPSHOT_PATH ? 'codex' : 'pi_codex';
      return JSON.stringify(
        snapshot(
          [
            windowFact(
              { type: 'account' },
              {
                id: source === 'codex' ? 'primary' : 'reserve',
                observed_at: source === 'codex' ? '2026-09-28T10:00:00Z' : '2026-09-28T10:00:00.000Z',
              },
            ),
          ],
          { source },
        ),
      );
    },
  });
  assert.equal(await run(['quota', 'show'], io), 0);
  const text = out.join('');
  assert.match(text, /^codex · loaded\n  primary/);
  assert.match(text, /\n\npi_codex · loaded\n  reserve/);
  assert.equal(text.match(/all captured 30m ago/g)?.length, 1);
});

test('quota show JSON separates historical measurements from stale usable capacity', async () => {
  const { io, out } = runtime({
    readText: async (path) =>
      path === CONFIG_PATH
        ? JSON.stringify(config())
        : JSON.stringify(snapshot([windowFact({ type: 'account' }, { valid_until: NOW.toISOString() })])),
  });
  assert.equal(await run(['quota', 'show', '--json'], io), 0);
  const shown = JSON.parse(out.join(''));
  assert.equal(shown.decision, 'quota_show');
  assert.deepEqual(shown.buckets, [
    {
      bucket: 'codex',
      status: 'loaded',
      windows: [
        {
          scope: { type: 'account' },
          status: 'unknown',
          reason: 'expired',
          remaining_percent: null,
          captured_remaining_percent: 40,
          observed_at: '2026-09-28T10:00:00Z',
          reset_at: '2026-09-28T12:00:00Z',
          valid_until: '2026-09-28T10:30:00.000Z',
        },
      ],
    },
  ]);
  assert.doesNotMatch(out.join(''), /identity_fingerprint/);
});

test('quota show relative times handle seconds, days, future captures and past resets', async () => {
  for (const [observed_at, reset_at, capture, reset, reason] of [
    ['2026-09-28T10:29:59Z', '2026-09-28T10:30:01Z', '1s ago', 'in 1s', 'known'],
    ['2026-09-28T10:30:00Z', '2026-09-30T10:30:00Z', 'now', 'in 2d', 'known'],
    ['2026-09-28T10:31:00Z', '2026-09-28T12:00:00Z', 'in 1m', 'in 1h', 'future_observation'],
    ['2026-09-26T10:30:00Z', '2026-09-28T08:30:00Z', '2d ago', '2h ago', 'reset_passed'],
  ]) {
    const { io, out } = runtime({
      readText: async (path) =>
        path === CONFIG_PATH
          ? JSON.stringify(config())
          : JSON.stringify(
              snapshot([
                windowFact(
                  { type: 'account' },
                  {
                    observed_at,
                    reset_at,
                    valid_until: reset_at,
                  },
                ),
              ]),
            ),
    });
    assert.equal(await run(['quota', 'show'], io), 0);
    const text = out.join('');
    assert.ok(text.includes(`all captured ${capture}`), text);
    assert.ok(text.includes(`resets ${reset}`), text);
    if (reason !== 'known') assert.ok(text.includes(`historical, ${reason}`), text);
  }
});

test('quota show reports missing and invalid snapshots without leaking data', async () => {
  for (const [input, status] of [
    [null, 'missing'],
    ['{broken', 'malformed'],
    [JSON.stringify(snapshot([], { source: 'pi_xai' })), 'identity_mismatch'],
    [new Error('private read error'), 'unreadable'],
  ] as const) {
    const { io, out, err } = runtime({
      readText: async (path) => {
        if (path === CONFIG_PATH) return JSON.stringify(config());
        if (input === null) throw Object.assign(new Error('private missing'), { code: 'ENOENT' });
        if (input instanceof Error) throw input;
        return input;
      },
    });
    assert.equal(await run(['quota', 'show', '--json'], io), 1);
    assert.deepEqual(JSON.parse(out.join('')).buckets, [{ bucket: 'codex', status, windows: [] }]);
    assert.deepEqual(err, [`agent-steward: quota_${status}\n`]);
    assert.doesNotMatch(out.join('') + err.join(''), /private|broken/);
  }
});

test('quota show blocks credential-shaped snapshot labels and handles empty inventory', async () => {
  const { io, out } = runtime({
    readText: async (path) =>
      path === CONFIG_PATH
        ? JSON.stringify(config())
        : JSON.stringify(
            snapshot([
              windowFact(
                { type: 'account' },
                {
                  id: 'sk-' + 'x'.repeat(30),
                },
              ),
            ]),
          ),
  });
  assert.equal(await run(['quota', 'show', '--json'], io), 1);
  assert.equal(JSON.parse(out.join('')).reason_code, 'credential_detected');
  assert.doesNotMatch(out.join(''), /sk-/);
  const empty = runtime();
  assert.equal(await run(['quota', 'show', '--json'], empty.io), 0);
  assert.deepEqual(JSON.parse(empty.out.join('')).buckets, []);
});

test('quota refresh parses only config, json and help options', () => {
  assert.deepEqual(parseArgs(['quota', 'refresh']), { kind: 'quota-refresh', json: false });
  assert.deepEqual(parseArgs(['quota', 'refresh', '--json']), { kind: 'quota-refresh', json: true });
  for (const args of [
    ['--config', 'custom.json', 'quota', 'refresh', '--json'],
    ['quota', 'refresh', '--json', '--config', 'custom.json'],
  ])
    assert.deepEqual(parseArgs(args), { kind: 'quota-refresh', config: 'custom.json', json: true });
  assert.deepEqual(parseArgs(['quota', 'refresh', '--help']), { kind: 'help' });
  for (const tail of [
    ['--json', '--json'],
    ['--dry-run'],
    ['task'],
    ['--'],
    ['--', 'task'],
    ['--unknown'],
    ['--unknown', '--help'],
  ]) {
    assert.throws(() => parseArgs(['quota', 'refresh', ...tail]), { code: 'invalid_input' });
  }
});

test('quota refresh JSON writes secret-free snapshots without Jev, launch, stdin or history', async () => {
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(
    JSON.stringify({
      exp: NOW.getTime() / 1000 + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'private-account' },
    }),
  ).toString('base64url')}.signature`;
  const cfg = routeConfig(
    [
      candidate(),
      candidate({ id: 'same-bucket' }),
      candidate({
        id: 'agy',
        tool: 'agy',
        provider: 'google',
        quota_bucket: 'antigravity',
      }),
      candidate({ id: 'disabled', tool: 'pi', quota_bucket: 'pi_xai' }),
    ],
    ['codex', 'agy'],
  );
  const gets: string[] = [];
  let posts = 0,
    stdin = 0;
  const { io, files, out, err, reads, launches } = runtime({
    terminal: { stdin: false, stdout: false },
    env: { HOME: '/isolated/home', CODEX_HOME: '/isolated/codex' },
    readText: async (path) => {
      reads.push(path);
      if (path === '/isolated/work/custom.json') return JSON.stringify(cfg);
      if (path === '/isolated/codex/auth.json')
        return JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } });
      throw new Error('unexpected read');
    },
    readStdin: async () => {
      stdin++;
      throw new Error('must not read stdin');
    },
    post: async () => {
      posts++;
      throw new Error('must not evaluate');
    },
    httpGet: async (url, headers) => {
      gets.push(url);
      assert.equal(headers.Authorization, `Bearer ${token}`);
      return {
        status: 200,
        body: JSON.stringify({
          email: 'private@example.com',
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: '2026-09-29T10:30:00Z' },
          },
        }),
      };
    },
  });
  assert.equal(await run(['--config', 'custom.json', 'quota', 'refresh', '--json'], io), 1);
  assert.deepEqual(result(out), {
    schema_version: 1,
    request_id: 'generated-1',
    decision: 'quota_refresh',
    buckets: [
      { bucket: 'codex', status: 'written' },
      { bucket: 'antigravity', status: 'auth' },
    ],
  });
  assert.equal(out.length, 1);
  assert.ok(out[0]!.endsWith('\n'));
  assert.deepEqual(err, ['agent-steward: quota_auth\n']);
  assert.deepEqual(gets, ['https://chatgpt.com/backend-api/wham/usage']);
  assert.deepEqual(reads, [
    '/isolated/work/custom.json',
    '/isolated/codex/auth.json',
    '/isolated/home/.gemini/antigravity-cli/antigravity-oauth-token',
  ]);
  assert.deepEqual([...files.keys()], [SNAPSHOT_PATH]);
  assert.equal(JSON.parse(files.get(SNAPSHOT_PATH)!).windows[0].remaining_percent, 75);
  assert.doesNotMatch(
    out.join('') + err.join('') + [...files.values()].join(''),
    /private-account|private@example.com|eyJhbGci/,
  );
  assert.deepEqual(launches, []);
  assert.equal(posts, 0);
  assert.equal(stdin, 0);
});

test('quota refresh reports fixed failure diagnostics and exits one only for collectable failures', async () => {
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'private-user' })).toString('base64url')}.signature`;
  for (const status of ['auth', 'fetch', 'malformed', 'written', 'agy_auth', 'empty']) {
    const cfg = routeConfig(
      status === 'empty'
        ? []
        : [
            status === 'agy_auth'
              ? candidate({ tool: 'agy', quota_bucket: 'antigravity' })
              : candidate({ tool: 'pi', quota_bucket: 'pi_xai' }),
          ],
    );
    const { io, out, err, files } = runtime({
      env: { HOME: '/isolated/home', PI_CODING_AGENT_DIR: '/isolated/pi' },
      readText: async (path) => {
        if (path.endsWith('/config.json')) return JSON.stringify(cfg);
        if (path === '/isolated/pi/auth.json' && status !== 'auth')
          return JSON.stringify({ xai: { type: 'oauth', access: token, expires: NOW.getTime() + 3600_000 } });
        throw new Error('private auth path');
      },
      httpGet: async () => {
        if (status === 'fetch') throw new Error('private upstream body');
        return {
          status: 200,
          body:
            status === 'malformed'
              ? '{'
              : JSON.stringify({ config: { creditUsagePercent: 40, billingPeriodEnd: '2026-09-29T10:30:00Z' } }),
        };
      },
    });
    assert.equal(await run(['quota', 'refresh'], io), ['written', 'empty'].includes(status) ? 0 : 1, status);
    assert.equal(
      out.join(''),
      status === 'empty'
        ? ''
        : `${status === 'agy_auth' ? 'antigravity' : 'pi_xai'}: ${status === 'agy_auth' ? 'auth' : status}\n`,
    );
    assert.deepEqual(
      err,
      ['written', 'empty'].includes(status)
        ? []
        : [`agent-steward: quota_${status === 'agy_auth' ? 'auth' : status}\n`],
    );
    assert.ok([...files.keys()].every((path) => path.endsWith('/quota/pi_xai.json')));
  }
});

test('quota refresh validates IDs and errors without leaking credentials or writing history', async () => {
  for (const mode of ['id', 'config', 'env']) {
    const key = 'SyntheticKey-Not-Pattern-4f91';
    const { io, out, err, files } = runtime({
      env: { HOME: '/isolated/home', TYPESAFE_API_KEY: key, CODEX_HOME: 'relative' },
      newRequestId: () => (mode === 'id' ? `prefix-${key}` : 'safe-id'),
      readText: async () => (mode === 'config' ? '{' : JSON.stringify(routeConfig())),
    });
    assert.equal(await run(['quota', 'refresh', '--json'], io), 1);
    assert.equal(
      result(out).reason_code,
      mode === 'id' ? 'credential_detected' : mode === 'config' ? 'invalid_config' : 'invalid_input',
    );
    assert.equal(result(out).request_id, mode === 'id' ? null : 'safe-id');
    assert.equal((out.join('') + err.join('')).includes(key), false);
    assert.equal(files.size, 0);
  }
});

test('router list and show parse local-only options', () => {
  assert.deepEqual(parseArgs(['router', 'list']), { kind: 'list', limit: 20, json: false });
  assert.deepEqual(parseArgs(['router', 'list', '--limit', '3', '--json']), { kind: 'list', limit: 3, json: true });
  assert.deepEqual(parseArgs(['router', 'show', 'req-1']), { kind: 'show', requestId: 'req-1', json: false });
  for (const args of [
    ['--config', 'c.json', 'router', 'list'],
    ['router', 'show', 'req-1', '--config', 'c.json'],
    ['router', 'list', '--limit', '0'],
    ['router', 'list', '--limit', '-1'],
    ['router', 'list', '--limit', '1.5'],
    ['router', 'list', '--limit', 'NaN'],
    ['router', 'list', '--json', '--json'],
    ['router', 'show'],
    ['router', 'show', 'a', 'b'],
  ])
    assert.throws(() => parseArgs(args));
});

test('route history records dry-run, native exit, launch failure and evaluation failure safely', async () => {
  for (const mode of ['dry-run', 'live', 'launch-failed', 'evaluation_failed']) {
    const { post } = fakePost(routeAnswer);
    const { io, files } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'Synthetic-Key-333' },
      readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(routeConfig()) : JSON.stringify(snapshot([]))),
      post:
        mode === 'evaluation_failed'
          ? async () => {
              throw new Error('private evaluator failure');
            }
          : post,
      launch: async () => {
        if (mode === 'launch-failed') throw new Error('private launch failure');
        return 7;
      },
    });
    const args = ['router', 'start', 'Review the parser'];
    if (mode === 'dry-run' || mode === 'evaluation_failed') args.push('--dry-run');
    assert.equal(await run(args, io), mode === 'dry-run' ? 0 : mode === 'live' ? 7 : 1);
    const text = files.get('/isolated/home/.local/state/agent-steward/router.jsonl') ?? '';
    assert.doesNotMatch(text, /Review the parser|planned_command|Synthetic-Key-333|private/);
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((item) => item.event),
      mode === 'live' ? ['launched', 'exited'] : mode === 'launch-failed' ? ['launched', 'launch-failed'] : [mode],
    );
    assert.ok(events.every((item) => item.request_id === 'generated-1'));
    if (mode === 'live') assert.equal(events[1].exit_code, 7);
    if (mode === 'dry-run') {
      assert.equal(events[0].selected.model, 'gpt-astra-example');
      assert.equal(events[0].selected.quota_bucket, 'codex');
      assert.equal(Object.hasOwn(events[0].selected, 'account_id'), false);
      assert.ok(events[0].usage);
    }
  }
});

test('failure diagnostics survive router show without leaking config values or HTTP bodies', async () => {
  for (const mode of ['config', 'credentials', 'http', 'network']) {
    const { io, out, files } = runtime({
      env: {
        HOME: '/isolated/home',
        XDG_CONFIG_HOME: '/isolated/xdg',
        ...(mode === 'credentials' ? {} : { TYPESAFE_API_KEY: 'Synthetic-Key-333' }),
      },
      readText: async (path) =>
        path === CONFIG_PATH
          ? JSON.stringify(
              mode === 'config' ? { ...routeConfig(), auto_approve: 'private-config-value' } : routeConfig(),
            )
          : JSON.stringify(snapshot([])),
      post: async () => {
        if (mode === 'network') throw new Error('private-network-details Synthetic-Key-333');
        return { status: 401, body: 'private-http-body Synthetic-Key-333' };
      },
    });
    assert.equal(await run(['router', 'start', 'private-task', '--dry-run', '--json'], io), 1);
    const failure = result(out);
    assert.equal(
      failure.reason_code,
      mode === 'config' ? 'invalid_config' : mode === 'credentials' ? 'missing_credentials' : 'evaluation_failed',
    );
    assert.equal(
      failure.diagnostics.stage,
      mode === 'credentials' ? 'credentials' : mode === 'config' ? 'config' : 'evaluation',
    );
    if (mode === 'config') assert.deepEqual(failure.diagnostics.config_fields, ['auto_approve']);
    if (mode === 'http') assert.equal(failure.diagnostics.http_status, 401);
    if (mode === 'http' || mode === 'network') {
      assert.equal(failure.diagnostics.kind, mode);
      assert.ok(Number.isInteger(failure.diagnostics.duration_ms) && failure.diagnostics.duration_ms >= 0);
    }
    out.length = 0;
    assert.equal(await run(['router', 'show', 'generated-1', '--json'], io), 0);
    const shown = JSON.parse(out.join(''));
    assert.equal(shown.reason_code, failure.reason_code);
    assert.deepEqual(shown.diagnostics, failure.diagnostics);
    assert.doesNotMatch([...files.values()].join('') + out.join(''), /private-|Synthetic-Key-333/);
  }
});

test('config diagnostics omit credential-bearing field names', async () => {
  const { io, out, files } = runtime({
    env: { HOME: '/isolated/home', TYPESAFE_API_KEY: 'SyntheticKey333' },
    readText: async () =>
      JSON.stringify({
        ...routeConfig(),
        SyntheticKey333: true,
        github_pat_abcdefghijklmnopqrstuvwxyz: true,
        auto_approve: true,
      }),
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run', '--json'], io), 1);
  assert.equal(result(out).reason_code, 'invalid_config');
  assert.deepEqual(result(out).diagnostics.config_fields, ['auto_approve']);
  assert.doesNotMatch(
    out.join('') + [...files.values()].join(''),
    /SyntheticKey333|github_pat_abcdefghijklmnopqrstuvwxyz/,
  );
});

test('successful routing and native nonzero exits do not publish launcher failure logs', async () => {
  for (const dryRun of [true, false]) {
    const { post } = fakePost(routeAnswer);
    const logged: unknown[] = [];
    const { io, out } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
      readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(routeConfig()) : JSON.stringify(snapshot([]))),
      post,
      launch: async () => 7,
      logFailure: async (failure) => {
        logged.push(failure);
      },
    });
    assert.equal(
      await run(['router', 'start', 'private-task', ...(dryRun ? ['--dry-run', '--json'] : [])], io),
      dryRun ? 0 : 7,
    );
    assert.deepEqual(logged, []);
    if (!dryRun) assert.equal(out.join(''), '');
  }
});

test('ledger write failure does not launch or mislabel a selected route as evaluation_failed', async () => {
  const { post } = fakePost(routeAnswer);
  const writes: string[] = [];
  const { io, launches } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(routeConfig()) : JSON.stringify(snapshot([]))),
    post,
    appendText: async (_path, text) => {
      writes.push(text);
      throw new Error('disk failure');
    },
  });
  assert.equal(await run(['router', 'start', 'private task'], io), 1);
  assert.deepEqual(launches, []);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]!).event, 'launched');
});

test('live JSON is rejected before config, evaluation, or launch', async () => {
  let posts = 0;
  const { io, out, err, reads, launches } = runtime({
    readText: async () => {
      throw new Error('must not read');
    },
    post: async () => {
      posts++;
      throw new Error('must not evaluate');
    },
  });
  const code = await run(['router', 'start', 'Task', '--json'], io);
  assert.equal(code, 1);
  assert.equal(result(out).schema_version, 1);
  assert.equal(result(out).reason_code, 'invalid_input');
  assert.equal(result(out).request_id, 'generated-1');
  assert.equal(out.length, 1);
  assert.deepEqual(reads, []);
  assert.equal(posts, 0);
  assert.deepEqual(launches, []);
  assert.ok(err.every((line) => !line.includes('Task')));
});

test('live launch requires both terminal streams before config, evaluation, or spawn', async () => {
  for (const terminal of [
    { stdin: false, stdout: true },
    { stdin: true, stdout: false },
  ]) {
    let posts = 0,
      launchCalls = 0;
    const { io, out, reads } = runtime({
      terminal,
      readText: async () => {
        throw new Error('must not read');
      },
      post: async () => {
        posts++;
        throw new Error('must not evaluate');
      },
      launch: async () => {
        launchCalls++;
        return 0;
      },
    });
    assert.equal(await run(['router', 'start', 'Task'], io), 1);
    assert.equal(result(out).reason_code, 'interactive_terminal_required');
    assert.equal(out.length, 1);
    assert.deepEqual(reads, []);
    assert.equal(posts, 0);
    assert.equal(launchCalls, 0);
  }
});

test('live task controls are rejected before config or evaluation', async () => {
  let posts = 0;
  const { io, out, reads, launches } = runtime({
    readText: async () => {
      throw new Error('must not read');
    },
    post: async () => {
      posts++;
      throw new Error('must not evaluate');
    },
  });
  assert.equal(await run(['router', 'start', 'unsafe\u0000task'], io), 1);
  assert.equal(result(out).reason_code, 'invalid_input');
  assert.deepEqual(reads, []);
  assert.equal(posts, 0);
  assert.deepEqual(launches, []);
});

test('live route launches only the selected native command with a prefixed original task', async () => {
  const candidates = [
    candidate(),
    candidate({
      id: 'pi-chosen',
      tool: 'pi',
      quota_bucket: 'pi_codex',
      provider: 'openai-codex',
      model: 'pi-model',
      thinking_levels: [
        { id: 'medium', description: 'Configured medium effort' },
        { id: 'high', description: 'Configured high effort' },
      ],
    }),
  ];
  const { post, requests } = fakePost((wire, index) =>
    index === 1
      ? jevResponse({ pair: choiceAnswer({ 'codex-astra': 0.1, 'pi-chosen': 0.9 }) })
      : jevResponse({ effort: choiceAnswer({ medium: 0.2, high: 0.8 }) }),
  );
  const task = '-review @private.md\nKeep the second line';
  const commandCalls = [];
  const { io, out, err, launches } = runtime({
    env: {
      HOME: '/isolated/home',
      XDG_CONFIG_HOME: '/isolated/xdg',
      TYPESAFE_API_KEY: 'SyntheticKey-Not-Pattern-4f91',
    },
    readText: async (path) =>
      path === CONFIG_PATH ? JSON.stringify(routeConfig(candidates)) : JSON.stringify(snapshot([])),
    post,
    launch: async (command) => {
      commandCalls.push(command);
      return 7;
    },
  });

  assert.equal(await run(['router', 'start', '--', task], io), 7);
  assert.equal(requests.length, 2);
  assert.equal(commandCalls.length, 1);
  assert.deepEqual(launches, [
    {
      executable: 'pi',
      args: ['--provider', 'openai-codex', '--model', 'pi-model', '--thinking', 'high', '--', `User task:\n${task}`],
    },
  ]);
  assert.deepEqual(out, []);
  assert.match(err.join(''), /provider requested\/unverified: "openai-codex"/);
  assert.match(err.join(''), /model requested\/unverified: "pi-model"/);
  assert.match(err.join(''), /thinking requested\/unverified: "high"/);
  assert.match(err.join(''), /account requested\/unverified: "pi_codex"/);
  assert.doesNotMatch(err.join(''), /-review @private\.md|second line|SyntheticKey-Not-Pattern-4f91/);
});

test('uncertain launch failure emits one sanitized launch error without retry or re-evaluation', async () => {
  const candidates = [
    candidate({
      thinking_levels: [
        { id: 'low', description: 'Configured low effort' },
        { id: 'high', description: 'Configured high effort' },
      ],
    }),
  ];
  const { post, requests } = fakePost((wire, index) =>
    index === 1
      ? jevResponse({ pair: choiceAnswer({ 'codex-astra': 1 }) })
      : jevResponse({ effort: choiceAnswer({ low: 0.1, high: 0.9 }) }),
  );
  const { io, out, err, launches } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) =>
      path === CONFIG_PATH ? JSON.stringify(routeConfig(candidates)) : JSON.stringify(snapshot([])),
    post,
    launch: async () => {
      throw new Error('private path and token');
    },
  });

  assert.equal(await run(['router', 'start', 'sensitive task'], io), 1);
  assert.equal(requests.length, 2);
  assert.equal(launches.length, 1);
  assert.equal(out.length, 1);
  assert.equal(result(out).reason_code, 'launch_failed');
  assert.equal(result(out).message, 'Agent launch failed or its outcome is uncertain.');
  assert.equal(result(out).request_id, 'generated-1');
  assert.doesNotMatch(out.join('') + err.join(''), /private path|token|sensitive task/);
});

test('session start is rejected', () => {
  assert.throws(() => parseArgs(['session', 'start', 'task']), { name: 'StewardError', code: 'invalid_input' });
  assert.throws(() => parseArgs(['session', 'start', 'task', '--dry-run']), {
    name: 'StewardError',
    code: 'invalid_input',
  });
});

test('router start parses like the previous route invocation', () => {
  assert.deepEqual(parseArgs(['router', 'start', 'task']), {
    kind: 'route',
    task: 'task',
    dryRun: false,
    json: false,
  });
  assert.deepEqual(parseArgs(['router', 'start', 'task', '--dry-run', '--json']), {
    kind: 'route',
    task: 'task',
    dryRun: true,
    json: true,
  });
  assert.deepEqual(parseArgs(['router', 'start', '--dry-run', '--', '--help']), {
    kind: 'route',
    task: '--help',
    dryRun: true,
    json: false,
  });
});

test('parser preserves the standard task data boundary and rejects options and extra arguments', () => {
  assert.deepEqual(parseArgs(['router', 'start', '--dry-run', '--', '--help']), {
    kind: 'route',
    task: '--help',
    dryRun: true,
    json: false,
  });
  assert.deepEqual(
    parseArgs(['--config', 'chosen.json', 'router', 'start', '--dry-run', '--', '--config other.json']),
    { kind: 'route', config: 'chosen.json', task: '--config other.json', dryRun: true, json: false },
  );
  assert.throws(() => parseArgs(['router', 'start', '--dry-run', '--', 'one', 'two']));
  assert.throws(() => parseArgs(['router', 'start', '--dry-run', '--']));
  assert.throws(() => parseArgs(['router', 'start', '--unknown', 'task']));
  assert.throws(() => parseArgs(['router', 'start', '--unknown', '--help']));
  assert.throws(() => parseArgs(['session', 'show', '--help']));
  assert.throws(() => parseArgs(['router', 'start', '--dry-run', '--', 'one', '--', 'two']));
  assert.throws(() => parseArgs(['router', 'start', '--dry-run', '--dry-run', 'task']));
  assert.deepEqual(parseArgs(['router', 'start', 'Review the parser', '--dry-run']), {
    kind: 'route',
    task: 'Review the parser',
    dryRun: true,
    json: false,
  });
  assert.deepEqual(parseArgs(['router', 'start', 'task', '--json', '--config', 'custom.json']), {
    kind: 'route',
    config: 'custom.json',
    task: 'task',
    dryRun: false,
    json: true,
  });
  assert.throws(() => parseArgs(['--config']));
  assert.throws(() => parseArgs(['--config', 'a', 'router', 'start', 'task', '--config', 'b']));
  assert.throws(() => parseArgs(['session', 'show', '1']));
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.throws(() => parseArgs(['--help', '-h']));
  assert.deepEqual(parseArgs(['stop', 'check']), { kind: 'stop' });
  assert.deepEqual(parseArgs(['--config', 'chosen.json', 'stop', 'check']), { kind: 'stop', config: 'chosen.json' });
  assert.throws(() => parseArgs(['approval', 'check']));
  assert.throws(() => parseArgs(['stop', 'check', '--json']));
});

test('help lists exactly implemented forms and requires no configuration or credentials', async () => {
  const { io, out, err, reads } = runtime({
    env: {
      get TYPESAFE_API_KEY(): string {
        throw new Error('help must not read credentials');
      },
    },
    readText: async () => {
      throw new Error('must not read');
    },
  });
  assert.equal(await run(['--help'], io), 0);
  assert.match(out.join(''), /router start <task>\n/);
  assert.match(out.join(''), /router start <task> --dry-run \[--json\]/);
  assert.match(out.join(''), /Live router start requires terminal input and output/);
  assert.doesNotMatch(out.join(''), /session start/);
  assert.match(out.join(''), /Live starts do not support --json/);
  assert.match(out.join(''), /stop check/);
  assert.doesNotMatch(out.join(''), /approval check/);
  assert.doesNotMatch(out.join(''), /session show|account list|usage refresh|choose-effort/);
  assert.deepEqual(reads, []);
  assert.deepEqual(err, []);
});

test('human route card contains complete facts, command and explicit limitations', async () => {
  const cfg = routeConfig([
    candidate({
      thinking_levels: [
        { id: 'low', description: 'Low effort' },
        { id: 'high', description: 'High effort' },
      ],
    }),
  ]);
  const { post, requests } = fakePost(routeAnswer);
  const { io, out, err } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) =>
      path === CONFIG_PATH
        ? JSON.stringify(cfg)
        : JSON.stringify(
            snapshot([
              {
                scope: { type: 'account' },
                remaining_percent: 55,
                observed_at: '2026-09-28T10:00:00Z',
                reset_at: '2026-09-28T12:00:00Z',
                valid_until: '2026-09-28T11:00:00Z',
              },
              {
                scope: { type: 'pool', pool_id: 'primary' },
                remaining_percent: 30,
                observed_at: '2026-09-28T10:00:00Z',
                reset_at: '2026-09-28T12:00:00Z',
                valid_until: '2026-09-28T11:00:00Z',
              },
            ]),
          ),
    post,
  });
  assert.equal(await run(['router', 'start', 'Review this parser', '--dry-run'], io), 0);
  const card = out.join('');
  assert.match(card, /tool: "codex"/);
  assert.match(card, /provider: "openai"/);
  assert.match(card, /model: "gpt-astra-example"/);
  assert.match(card, /thinking level: "low"/);
  assert.match(card, /account: "codex"/);
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
  const { io, out, err, launches } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([]))),
    post,
  });
  io.terminal = { stdin: false, stdout: false };
  assert.equal(await run(['router', 'start', 'Review', '--dry-run', '--json'], io), 0);
  assert.deepEqual(launches, []);
  const parsed = result(out);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.decision, 'selected');
  assert.equal(parsed.request_id, 'generated-1');
  assert.equal(parsed.selected.tool, 'codex');
  assert.equal(parsed.selected.quota_bucket, 'codex');
  assert.equal(parsed.quota.quota_bucket, 'codex');
  assert.equal(Object.hasOwn(parsed.selected, 'account_id'), false);
  assert.equal(Object.hasOwn(parsed.quota, 'account_id'), false);
  assert.equal(parsed.planned_command.runtime_selection, 'unverified');
  assert.equal(parsed.evaluations.effort.kind, 'fixed');
  assert.equal(out.length, 1);
  assert.ok(out[0]?.endsWith('\n'));
  assert.deepEqual(err, []);
  assert.equal(requests.length, 1);
});

test('pair choices remain independent across tools and chosen effort uses configured order', async () => {
  const candidates = [
    candidate({
      id: 'codex-choice',
      thinking_levels: [
        { id: 'low', description: 'Low' },
        { id: 'high', description: 'High' },
      ],
    }),
    candidate({
      id: 'pi-choice',
      tool: 'pi',
      quota_bucket: 'pi_codex',
      provider: 'openai-codex',
      thinking_levels: [{ id: 'minimal', description: 'Minimal' }],
    }),
  ];
  const cfg = routeConfig(candidates);
  const { post, requests } = fakePost((wire, index) => {
    if (index === 1) return jevResponse({ pair: choiceAnswer({ 'codex-choice': 0.2, 'pi-choice': 0.8 }, 0.1) });
    return jevResponse({ effort: choiceAnswer({ low: 0.5, high: 0.5 }, 0.01, 'high') });
  });
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([]))),
    post,
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run', '--json'], io), 0);
  assert.equal(result(out).selected.candidate_id, 'pi-choice');
  assert.equal(result(out).selected.tool, 'pi');
  assert.equal(result(out).selected.thinking_level, 'minimal');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.headers.authorization, 'Bearer test-key');
});

test('fixed and selected effort use explicit safe human rendering', () => {
  const selected: SelectedResult = {
    schema_version: 1,
    request_id: 'id',
    decision: 'selected',
    selected: {
      candidate_id: 'x',
      tool: 'codex',
      provider: 'openai',
      model: 'm',
      thinking_level: 'low',
      quota_bucket: 'codex',
      quota_pool: 'p',
    },
    quota: {
      source: 'codex',
      quota_bucket: 'codex',
      pool_id: 'p',
      snapshot_status: 'missing',
      account_status: 'unknown',
      pool_status: 'unknown',
      windows: [],
    },
    planned_command: {
      executable: 'codex',
      args: [],
      display: "'codex'",
      syntax_validated: true,
      runtime_selection: 'unverified',
      authentication: 'unverified',
      provider_selection: 'explicit_flag',
    },
    evaluations: {
      pair: {
        model: 'jev',
        answers: { pair: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.8 } },
        usage: {},
      },
      effort: { kind: 'fixed', level: 'low' },
    },
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

test('stop JSON exits are proposal 0, manual review 2, no action 3, errors 1', async () => {
  const outcomes: [string, number, StopInput['status'], string, string, number][] = [
    ['approve_command', 0.2, 'blocked', 'stop_decision', 'approve_request', 0],
    ['approve_edit', 0.6, 'blocked', 'stop_decision', 'manual_review', 2],
    ['other', 0.1, 'blocked', 'stop_decision', 'manual_review', 2],
    ['answer_question', 0.1, 'blocked', 'stop_decision', 'manual_review', 2],
    ['completed', 0.1, 'done', 'stop_decision', 'no_action', 3],
    ['recoverable_api_error', 0.1, 'blocked', 'stop_decision', 'send_recovery_instruction', 0],
    ['quota_limit', 0.1, 'blocked', 'stop_decision', 'wait_for_quota', 0],
  ];
  for (const [waitingFor, risk, status, decision, action, exit] of outcomes) {
    const { post } = fakePost((wire) => stopAnswer(wire, waitingFor, risk));
    const { io, out, err } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
      readStdin: async () => JSON.stringify(stopInput({ status })),
      now: () => new Date('2026-09-29T10:00:00Z'),
      post,
    });
    assert.equal(await run(['stop', 'check'], io), exit, waitingFor);
    assert.equal(result(out).schema_version, 2, waitingFor);
    assert.equal(result(out).decision, decision, waitingFor);
    assert.equal(result(out).proposed_action.kind, action, waitingFor);
    assert.equal(out.length, 1);
    assert.ok(out[0]?.endsWith('\n'));
    assert.deepEqual(err, []);
  }
  const { io, out } = runtime({ readStdin: async () => '{' });
  assert.equal(await run(['stop', 'check'], io), 1);
  assert.equal(result(out).schema_version, 2);
  assert.equal(result(out).reason_code, 'invalid_input');
});

test('insufficient-context stop remains local without an API key or transport', async () => {
  let posts = 0;
  const { io, out, reads, err, launches } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
    terminal: { stdin: false, stdout: false },
    readStdin: async () =>
      JSON.stringify(
        stopInput({ context: null, pending_action: { action: 'Retry the operation', target: 'current task' } }),
      ),
    post: async () => {
      posts++;
      throw new Error('must not post');
    },
  });
  assert.equal(await run(['stop', 'check'], io), 2);
  const value = result(out);
  assert.equal(value.schema_version, 2);
  assert.equal(value.reason_code, 'insufficient_context');
  assert.equal(value.proposed_action.kind, 'manual_review');
  assert.equal(value.waiting_for, 'other');
  assert.equal(value.evaluation, null);
  assert.deepEqual(reads, [CONFIG_PATH]);
  assert.equal(posts, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(launches, []);
});

test('configured optional key is captured for local and early-error request-ID privacy', async () => {
  const apiKey = 'SyntheticKey-Not-Pattern-4f91';
  const assertSafe = (out: string[], err: string[]) =>
    assert.equal((out.join('') + err.join('')).includes(apiKey), false);
  const env = { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: apiKey };

  const local = runtime({
    env,
    readStdin: async () =>
      JSON.stringify(stopInput({ request_id: 'local-safe-id', context: {}, pending_action: null })),
    post: async () => {
      throw new Error('must not post');
    },
  });
  assert.equal(await run(['stop', 'check'], local.io), 2);
  assert.equal(result(local.out).schema_version, 2);
  assert.equal(result(local.out).decision, 'stop_decision');
  assert.equal(result(local.out).request_id, 'local-safe-id');
  assertSafe(local.out, local.err);

  const contaminatedLocalId = runtime({
    env,
    readStdin: async () =>
      JSON.stringify(stopInput({ request_id: `prefix-${apiKey}-suffix`, context: {}, pending_action: null })),
    post: async () => {
      throw new Error('must not post');
    },
  });
  assert.equal(await run(['stop', 'check'], contaminatedLocalId.io), 1);
  assert.equal(result(contaminatedLocalId.out).schema_version, 2);
  assert.equal(result(contaminatedLocalId.out).reason_code, 'credential_detected');
  assert.equal(result(contaminatedLocalId.out).request_id, null);
  assertSafe(contaminatedLocalId.out, contaminatedLocalId.err);

  const invalidInput = runtime({
    env,
    readStdin: async () =>
      JSON.stringify(
        stopInput({
          request_id: `early-${apiKey}-error`,
          agent: { id: '', tool: 'pi', pane_id: 'p', session_id: null },
        }),
      ),
  });
  assert.equal(await run(['stop', 'check'], invalidInput.io), 1);
  assert.equal(result(invalidInput.out).schema_version, 2);
  assert.equal(result(invalidInput.out).reason_code, 'credential_detected');
  assert.equal(result(invalidInput.out).request_id, null);
  assertSafe(invalidInput.out, invalidInput.err);

  const invalidConfig = runtime({
    env,
    readStdin: async () => JSON.stringify(stopInput({ request_id: 'invalid-config-safe-id' })),
    readText: async () => '{',
  });
  assert.equal(await run(['stop', 'check'], invalidConfig.io), 1);
  assert.equal(result(invalidConfig.out).schema_version, 2);
  assert.equal(result(invalidConfig.out).reason_code, 'invalid_config');
  assert.equal(result(invalidConfig.out).request_id, 'invalid-config-safe-id');
  assertSafe(invalidConfig.out, invalidConfig.err);

  const preflightConfig = routeConfig([candidate({ model: '--unmappable' })]);
  const preflight = runtime({
    env,
    newRequestId: () => 'preflight-safe-id',
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(preflightConfig) : JSON.stringify(snapshot([]))),
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run', '--json'], preflight.io), 1);
  assert.equal(result(preflight.out).reason_code, 'invalid_config');
  assert.equal(result(preflight.out).request_id, 'preflight-safe-id');
  assertSafe(preflight.out, preflight.err);

  const missingConfig = runtime({
    env,
    newRequestId: () => 'missing-config-safe-id',
    readText: async () => {
      throw new Error('synthetic missing config');
    },
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run', '--json'], missingConfig.io), 1);
  assert.equal(result(missingConfig.out).reason_code, 'invalid_config');
  assert.equal(result(missingConfig.out).request_id, 'missing-config-safe-id');
  assertSafe(missingConfig.out, missingConfig.err);

  let reads = 0,
    posts = 0;
  const unavailable = runtime({
    env,
    newRequestId: () => 'safe-generated-id',
    readText: async () => {
      reads++;
      throw new Error('must not read');
    },
    post: async () => {
      posts++;
      throw new Error('must not post');
    },
  });
  assert.equal(await run(['router', 'start', 'task', '--json'], unavailable.io), 1);
  assert.equal(result(unavailable.out).reason_code, 'invalid_input');
  assert.equal(result(unavailable.out).request_id, 'safe-generated-id');
  assert.equal(reads, 0);
  assert.equal(posts, 0);
  assertSafe(unavailable.out, unavailable.err);
});

test('configured non-pattern key rejects generated and caller IDs containing it as a substring', async () => {
  const apiKey = 'SyntheticKey-Not-Pattern-4f91';
  const contaminatedId = `prefix-${apiKey}-suffix`;
  const env = { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: apiKey };
  const contaminatedCases: [string[], Partial<Runtime>, number][] = [
    [['router', 'start', 'task'], { newRequestId: () => contaminatedId }, 1],
    [['stop', 'check'], { readStdin: async () => JSON.stringify(stopInput({ request_id: contaminatedId })) }, 2],
  ];
  for (const [args, overrides, version] of contaminatedCases) {
    const { io, out, err, reads } = runtime({
      ...overrides,
      env,
      post: async () => {
        throw new Error('must not post');
      },
    });
    assert.equal(await run(args, io), 1);
    assert.equal((out.join('') + err.join('')).includes(apiKey), false);
    assert.equal(result(out).schema_version, version);
    assert.equal(result(out).reason_code, 'credential_detected');
    assert.equal(result(out).request_id, null);
    assert.equal(out.length, 1);
    if (args[0] === 'router') {
      assert.deepEqual(reads, []);
      assert.deepEqual(err, ['agent-steward: credential_detected\n']);
    }
  }
});

test('stop assessment reads no quota and needs no routing inventory', async () => {
  const empty = config({ candidates: [] });
  const { post } = fakePost((wire) => stopAnswer(wire, 'approve_edit'));
  const { io, out, reads } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readStdin: async () => JSON.stringify(stopInput({ pending_action: { action: 'Edit the current draft' } })),
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(empty);
    },
    post,
  });
  assert.equal(await run(['stop', 'check'], io), 0);
  assert.deepEqual(reads, [CONFIG_PATH]);
  assert.equal(result(out).schema_version, 2);
  assert.equal(result(out).proposed_action.kind, 'approve_request');
});

test('lazy credentials fail only when evaluation is needed and never make a live request without a key', async () => {
  for (const args of [
    ['router', 'start', 'task', '--dry-run'],
    ['stop', 'check'],
  ]) {
    let posts = 0;
    const cfg = routeConfig();
    const { io, out } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
      readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([]))),
      post: async () => {
        posts++;
        throw new Error('must not make a live request');
      },
    });
    assert.equal(await run(args, io), 1);
    assert.equal(result(out).reason_code, 'missing_credentials');
    if (args[0] === 'stop') assert.equal(result(out).schema_version, 2);
    assert.equal(posts, 0);
  }
});

test('custom config, enabled-tool filtering, and quota diagnostics remain local and safe', async () => {
  const cfg = routeConfig(
    [candidate(), candidate({ id: 'disabled', tool: 'pi', quota_bucket: 'pi_codex', provider: 'openai-codex' })],
    ['codex'],
  );
  const { post } = fakePost(routeAnswer);
  const { io, out, err, reads } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) => {
      reads.push(path);
      if (path === '/isolated/work/custom.json') return JSON.stringify(cfg);
      throw new Error('missing fixture');
    },
    post,
  });
  assert.equal(await run(['router', 'start', 'task', '--config', 'custom.json', '--dry-run', '--json'], io), 0);
  assert.deepEqual(reads, ['/isolated/work/custom.json', SNAPSHOT_PATH]);
  assert.match(err.join(''), /quota_unreadable/);
  assert.doesNotMatch(err.join(''), /missing fixture|custom\.json|task/);
  assert.equal(result(out).selected.candidate_id, 'codex-astra');
});

test('stop input and configuration errors use v2; malformed argv remains generic v1', async () => {
  const invalidStopCases: [Partial<Runtime>, string][] = [
    [{ readStdin: async () => '{' }, 'invalid_input'],
    [{ readText: async () => '{' }, 'invalid_config'],
  ];
  for (const [overrides, reason] of invalidStopCases) {
    const { io, out } = runtime(overrides);
    assert.equal(await run(['stop', 'check'], io), 1);
    assert.equal(out.length, 1);
    assert.equal(result(out).schema_version, 2);
    assert.equal(result(out).reason_code, reason);
  }
  let reads = 0,
    posts = 0;
  const obsolete = runtime({
    readStdin: async () => {
      reads++;
      return JSON.stringify(stopInput());
    },
    post: async () => {
      posts++;
      throw new Error('must not post');
    },
  });
  assert.equal(await run(['approval', 'check'], obsolete.io), 1);
  assert.equal(result(obsolete.out).schema_version, 1);
  assert.equal(result(obsolete.out).reason_code, 'invalid_input');
  assert.equal(reads, 0);
  assert.equal(posts, 0);

  const malformed = runtime();
  assert.equal(await run(['not-a-command'], malformed.io), 1);
  assert.equal(result(malformed.out).schema_version, 1);
  assert.equal(result(malformed.out).decision, 'error');
});

test('stop stdin retains the bounded byte and JSON-depth limits', async () => {
  let posts = 0;
  let nestedContext: unknown = 'deep';
  for (let index = 0; index < 64; index++) nestedContext = [nestedContext];
  const deepInput = { ...stopInput(), context: nestedContext };
  for (const body of ['x'.repeat(1_048_577), JSON.stringify(deepInput)]) {
    const { io, out } = runtime({
      readStdin: async () => body,
      post: async () => {
        posts++;
        throw new Error('must not post');
      },
    });
    assert.equal(await run(['stop', 'check'], io), 1);
    assert.equal(result(out).schema_version, 2);
    assert.equal(result(out).reason_code, 'invalid_input');
    assert.equal(result(out).request_id, null);
  }
  assert.equal(posts, 0);
});

test('stop request IDs are preserved after validation errors and malformed JSON uses null', async () => {
  const withId = stopInput({ agent: { id: '', tool: 'pi', pane_id: 'p', session_id: null } });
  const first = runtime({ readStdin: async () => JSON.stringify(withId) });
  assert.equal(await run(['stop', 'check'], first.io), 1);
  assert.equal(result(first.out).schema_version, 2);
  assert.equal(result(first.out).request_id, 'request-1');
  const second = runtime({ readStdin: async () => '{"request_id":"secret' });
  assert.equal(await run(['stop', 'check'], second.io), 1);
  assert.equal(result(second.out).schema_version, 2);
  assert.equal(result(second.out).request_id, null);
  const third = runtime({ readStdin: async () => JSON.stringify(stopInput({ request_id: '   ' })) });
  assert.equal(await run(['stop', 'check'], third.io), 1);
  assert.equal(result(third.out).schema_version, 2);
  assert.equal(result(third.out).request_id, null);
});

test('secret-containing caller IDs and untrusted evaluator metadata never reach output', async () => {
  const secret = 'sk-12345678901234567890';
  const badId = runtime({ readStdin: async () => JSON.stringify(stopInput({ request_id: secret })) });
  assert.equal(await run(['stop', 'check'], badId.io), 1);
  assert.equal(result(badId.out).schema_version, 2);
  assert.equal(result(badId.out).reason_code, 'credential_detected');
  assert.equal(result(badId.out).request_id, null);
  assert.doesNotMatch(badId.out.join('') + badId.err.join(''), /12345678901234567890/);

  const forConfig = routeConfig();
  const { post } = fakePost(() => jevResponse({ pair: choiceAnswer({ 'codex-astra': 1 }) }, { model: secret }));
  const leaked = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: secret },
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(forConfig) : JSON.stringify(snapshot([]))),
    post,
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run', '--json'], leaked.io), 1);
  assert.equal(result(leaked.out).reason_code, 'credential_detected');
  assert.equal(result(leaked.out).decision, 'error');
  assert.doesNotMatch(leaked.out.join('') + leaked.err.join(''), /12345678901234567890/);

  const { post: humanPost } = fakePost(() =>
    jevResponse({ pair: choiceAnswer({ 'codex-astra': 1 }) }, { model: secret }),
  );
  const human = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: secret },
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(forConfig) : JSON.stringify(snapshot([]))),
    post: humanPost,
  });
  assert.equal(await run(['router', 'start', 'private task', '--dry-run'], human.io), 1);
  assert.equal(result(human.out).reason_code, 'credential_detected');
  assert.equal(result(human.out).decision, 'error');
  assert.deepEqual(human.err, ['agent-steward: credential_detected\n']);
  assert.doesNotMatch(human.out.join('') + human.err.join(''), /12345678901234567890/);
});

test('stop evaluator metadata is checked before JSON output with no partial proposal', async () => {
  const secret = 'sk-12345678901234567890';
  const { post } = fakePost((wire) => ({ ...stopAnswer(wire, 'approve_command'), model: secret }));
  const { io, out, err } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: secret },
    post,
  });
  assert.equal(await run(['stop', 'check'], io), 1);
  assert.equal(result(out).schema_version, 2);
  assert.equal(result(out).reason_code, 'credential_detected');
  assert.equal(result(out).decision, 'error');
  assert.equal(out.length, 1);
  assert.doesNotMatch(out.join('') + err.join(''), /12345678901234567890/);
});

test('failed second evaluation emits only one error and never a partial route', async () => {
  const cfg = routeConfig([
    candidate({
      thinking_levels: [
        { id: 'low', description: 'Low' },
        { id: 'high', description: 'High' },
      ],
    }),
  ]);
  const { post } = fakePost((wire, index) =>
    index === 1
      ? jevResponse({ pair: choiceAnswer({ 'codex-astra': 1 }) })
      : { model: 'jev-1.13.0', answers: {}, usage: {} },
  );
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([]))),
    post,
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run'], io), 1);
  assert.equal(out.length, 1);
  assert.equal(result(out).decision, 'error');
  assert.equal(result(out).reason_code, 'invalid_response');
});

test('configured non-pattern key in evaluator metadata suppresses a partial stop proposal', async () => {
  const apiKey = 'SyntheticKey-Not-Pattern-4f91';
  const { post } = fakePost((wire) => ({ ...stopAnswer(wire, 'approve_command'), model: apiKey }));
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: apiKey },
    post,
  });
  assert.equal(await run(['stop', 'check'], io), 1);
  const value = result(out);
  assert.equal(value.schema_version, 2);
  assert.equal(value.decision, 'error');
  assert.equal(value.reason_code, 'credential_detected');
  assert.equal(Object.hasOwn(value, 'proposed_action'), false);
  assert.doesNotMatch(out.join(''), /SyntheticKey-Not-Pattern-4f91/);
});

test('stop transport failures return one v2 error and never a partial proposal', async () => {
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    post: async () => {
      throw new Error('private evaluator response');
    },
  });
  assert.equal(await run(['stop', 'check'], io), 1);
  assert.equal(out.length, 1);
  assert.equal(result(out).schema_version, 2);
  assert.equal(result(out).decision, 'error');
  assert.equal(result(out).reason_code, 'evaluation_failed');
  assert.equal(result(out).request_id, 'request-1');
  assert.doesNotMatch(out.join(''), /private evaluator response|proposed_action/);
});

test('human cards JSON-escape untrusted metadata and generated IDs are credential checked', async () => {
  const cfg = routeConfig([
    candidate({
      capabilities: 'safe\u001b[31m',
      thinking_levels: [
        { id: 'low', description: 'Low' },
        { id: 'high', description: 'High' },
      ],
    }),
  ]);
  const { post } = fakePost(routeAnswer);
  const { io, out } = runtime({
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
    newRequestId: () => 'generated\u001b[31m',
    readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([]))),
    post,
  });
  assert.equal(await run(['router', 'start', 'task', '--dry-run'], io), 0);
  assert.match(out.join(''), /generated\\u001b/);
  // eslint-disable-next-line no-control-regex -- Verify a raw terminal escape never reaches the human card.
  assert.doesNotMatch(out.join(''), /generated\u001b/);
});

test('API and malformed data errors are sanitized and preserve the safe ID', async () => {
  const cfg = routeConfig();
  const postCases: [HttpPost, string][] = [
    [
      async () => {
        throw new Error('raw token and task leaked');
      },
      'evaluation_failed',
    ],
    [async () => ({ status: 200, body: 'not json' }), 'invalid_response'],
  ];
  for (const [post, reason] of postCases) {
    const { io, out, err } = runtime({
      env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg', TYPESAFE_API_KEY: 'test-key' },
      readText: async (path) => (path === CONFIG_PATH ? JSON.stringify(cfg) : JSON.stringify(snapshot([]))),
      post,
    });
    assert.equal(await run(['router', 'start', 'private task', '--dry-run', '--json'], io), 1);
    assert.equal(result(out).reason_code, reason);
    assert.equal(result(out).request_id, 'generated-1');
    assert.doesNotMatch(out.join('') + err.join(''), /raw token|private task/);
  }
});

test('parse failures default to a JSON envelope and do not leak arguments', async () => {
  const { io, out, err } = runtime();
  assert.equal(await run(['router', 'start', '--unknown', 'sensitive-task'], io), 1);
  assert.equal(result(out).reason_code, 'invalid_input');
  assert.doesNotMatch(out.join('') + err.join(''), /sensitive-task/);
});
