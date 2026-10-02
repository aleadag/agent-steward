import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendEvent, ledgerFile } from '../src/ledger.ts';
import { run } from '../src/cli.ts';
import type { Runtime } from '../src/cli.ts';

function memoryRuntime(files: Map<string, string>, env: Runtime['env']) {
  const out: string[] = [],
    err: string[] = [],
    modes: [string, number][] = [];
  const rt: Runtime = {
    env,
    cwd: '/isolated',
    writeText: async () => {
      throw new Error('must not write snapshots');
    },
    rename: async () => {
      throw new Error('must not rename files');
    },
    unlink: async () => {
      throw new Error('must not unlink files');
    },
    httpGet: async () => {
      throw new Error('must not fetch quota');
    },
    appendText: async (path, text) => {
      files.set(path, (files.get(path) ?? '') + text);
    },
    readTextIfPresent: async (path) => files.get(path) ?? null,
    mkdirp: async (path, mode) => {
      modes.push([path, mode]);
    },
    chmod: async (path, mode) => {
      modes.push([path, mode]);
    },
    readText: async () => {
      throw new Error('must not load config');
    },
    readStdin: async () => {
      throw new Error('must not read stdin');
    },
    post: async () => {
      throw new Error('must not evaluate');
    },
    launch: async () => {
      throw new Error('must not launch');
    },
    now: () => new Date(0),
    newRequestId: () => 'unused',
    terminal: { stdin: false, stdout: false },
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
  };
  return { rt, out, err, modes };
}

test('append then list folds by request_id without task text', async () => {
  const files = new Map<string, string>();
  const { rt, out, modes } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
  await appendEvent(rt, {
    schema_version: 1,
    request_id: 'req-1',
    recorded_at: '2026-10-02T00:00:00.000Z',
    event: 'launched',
    selected: { tool: 'agy', provider: 'google', model: 'g1', thinking_level: 'low', quota_bucket: 'antigravity' },
  });
  await appendEvent(rt, {
    schema_version: 1,
    request_id: 'req-1',
    recorded_at: '2026-10-02T00:01:00.000Z',
    event: 'exited',
    exit_code: 0,
  });
  const text = files.get('/isolated/state/agent-steward/router.jsonl') ?? '';
  assert.match(text, /launched/);
  assert.doesNotMatch(text, /Review the parser|planned_command|TYPESAFE|api[_-]?key/i);
  assert.ok(modes.some(([path, mode]) => path === '/isolated/state/agent-steward' && mode === 0o700));
  assert.ok(modes.some(([path, mode]) => path.endsWith('/router.jsonl') && mode === 0o600));
  assert.equal(await run(['router', 'list'], rt), 0);
  assert.match(out.join(''), /req-1.*agy\/g1\/low.*exited/);
  assert.equal(out.length, 1);
  out.length = 0;
  assert.equal(await run(['router', 'show', 'req-1', '--json'], rt), 0);
  const shown = JSON.parse(out.join(''));
  assert.equal(shown.selected.provider, 'google');
  assert.equal(shown.selected.quota_bucket, 'antigravity');
  assert.equal(Object.hasOwn(shown.selected, 'account_id'), false);
  assert.equal(shown.exit_code, 0);
  assert.equal(shown.event, 'exited');
});

test('list and show read legacy account_id-only and mixed ledger history', async () => {
  const files = new Map<string, string>();
  const { rt, out } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
  files.set(
    ledgerFile(rt.env),
    [
      JSON.stringify({
        schema_version: 1,
        request_id: 'legacy',
        recorded_at: '2026-10-01T00:00:00.000Z',
        event: 'launched',
        selected: { tool: 'codex', provider: 'openai', model: 'm1', thinking_level: 'low', account_id: 'codex' },
      }),
      JSON.stringify({
        schema_version: 1,
        request_id: 'mixed',
        recorded_at: '2026-10-02T00:00:00.000Z',
        event: 'launched',
        selected: {
          tool: 'pi',
          provider: 'openai-codex',
          model: 'm2',
          thinking_level: 'low',
          account_id: 'not-a-bucket',
          quota_bucket: 'pi_codex',
        },
      }),
      JSON.stringify({
        schema_version: 1,
        request_id: 'unknown-account',
        recorded_at: '2026-10-03T00:00:00.000Z',
        event: 'launched',
        selected: { tool: 'codex', provider: 'openai', model: 'm3', thinking_level: 'low', account_id: 'private-id' },
      }),
    ].join('\n'),
  );

  assert.equal(await run(['router', 'list', '--json'], rt), 0);
  const listed = JSON.parse(out.join(''));
  assert.equal(listed.length, 3);
  assert.equal(listed[2].selected.quota_bucket, 'codex');
  assert.equal(listed[1].selected.quota_bucket, 'pi_codex');
  assert.equal(Object.hasOwn(listed[1].selected, 'account_id'), false);
  assert.equal(Object.hasOwn(listed[0], 'selected'), false);

  out.length = 0;
  assert.equal(await run(['router', 'show', 'legacy', '--json'], rt), 0);
  assert.equal(JSON.parse(out.join('')).selected.quota_bucket, 'codex');
  out.length = 0;
  assert.equal(await run(['router', 'show', 'unknown-account', '--json'], rt), 0);
  assert.equal(Object.hasOwn(JSON.parse(out.join('')), 'selected'), false);
});

test('credential scan blocks writes before any filesystem side effect', async () => {
  const files = new Map<string, string>();
  const { rt, modes } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state', TYPESAFE_API_KEY: 'sekrit' });
  await assert.rejects(() =>
    appendEvent(rt, {
      schema_version: 1,
      request_id: 'sekrit',
      recorded_at: '2026-10-02T00:00:00.000Z',
      event: 'dry-run',
    }),
  );
  assert.equal(files.size, 0);
  assert.deepEqual(modes, []);
});

test('missing ledger is empty list and show not_found, without config or Jev', async () => {
  const { rt, out, err } = memoryRuntime(new Map(), { HOME: '/isolated/home' });
  assert.equal(ledgerFile(rt.env), '/isolated/home/.local/state/agent-steward/router.jsonl');
  assert.equal(await run(['router', 'list'], rt), 0);
  assert.deepEqual(out, []);
  assert.equal(await run(['router', 'show', 'unknown'], rt), 2);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ['agent-steward: not_found\n']);
});

test('human list escapes control characters in decision metadata', async () => {
  const { rt, out } = memoryRuntime(new Map(), { XDG_STATE_HOME: '/isolated/state' });
  await appendEvent(rt, {
    schema_version: 1,
    request_id: 'req-escape',
    recorded_at: '2026-10-02T00:00:00.000Z',
    event: 'dry-run',
    selected: {
      tool: 'agy',
      provider: 'google',
      model: 'model\u001b[31m\nspoof',
      thinking_level: 'low',
      quota_bucket: 'antigravity',
    },
  });
  assert.equal(await run(['router', 'list'], rt), 0);
  assert.equal(out.join('').split('\n').length, 2);
  assert.ok(!out.join('').includes('\u001b'));
  assert.match(out.join(''), /model\\u001b\[31m\\nspoof/);
});

test('list limit is display-only and shows latest folded records first', async () => {
  const files = new Map<string, string>();
  const { rt, out } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
  for (const id of ['old', 'new'])
    await appendEvent(rt, {
      schema_version: 1,
      request_id: id,
      recorded_at: '2026-10-02T00:00:00.000Z',
      event: 'dry-run',
    });
  const before = files.get(ledgerFile(rt.env));
  assert.equal(await run(['router', 'list', '--limit', '1', '--json'], rt), 0);
  assert.deepEqual(
    JSON.parse(out.join('')).map((item: { request_id: string }) => item.request_id),
    ['new'],
  );
  assert.equal(files.get(ledgerFile(rt.env)), before);
});
