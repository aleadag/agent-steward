import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent, ledgerFile, readLedger } from '../src/ledger.ts';
import { StewardError } from '../src/contracts.ts';
import { fileSize, withLedgerLock } from '../src/ledger-io.ts';
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
    fileSize: async (path) => Buffer.byteLength(files.get(path) ?? ''),
    withLedgerLock: async (_path, action) => action(),
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

const rotationLimit = 5 * 1024 * 1024;

async function diskRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), 'steward-ledger-'));
  const { rt } = memoryRuntime(new Map(), { XDG_STATE_HOME: root });
  const runtime = {
    ...rt,
    appendText: async (file: string, text: string) => {
      await appendFile(file, text, { mode: 0o600 });
    },
    readTextIfPresent: async (file: string) => {
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    fileSize,
    withLedgerLock,
    mkdirp: async (directory: string, mode: number) => {
      await mkdir(directory, { recursive: true, mode });
    },
    chmod,
    rename,
  };
  const file = ledgerFile(runtime.env);
  await mkdir(path.dirname(file), { mode: 0o700 });
  return { runtime, file, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const rotationEvent = {
  schema_version: 1 as const,
  request_id: 'boundary',
  recorded_at: '2026-10-02T00:00:00.000Z',
  event: 'dry-run' as const,
};

test('rotation keeps an exact-limit file and replaces only one backup on overflow', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    const line = `${JSON.stringify(rotationEvent)}\n`;
    const prefix = ' '.repeat(rotationLimit - Buffer.byteLength(line));
    await writeFile(file, prefix, { mode: 0o600 });
    await appendEvent(runtime, rotationEvent);
    assert.equal((await stat(file)).size, rotationLimit);
    assert.equal(await runtime.readTextIfPresent(`${file}.1`), null);
    await writeFile(`${file}.1`, 'obsolete', { mode: 0o644 });
    await appendEvent(runtime, { ...rotationEvent, request_id: 'new' });
    assert.equal(await readFile(`${file}.1`, 'utf8'), prefix + line);
    assert.equal((await stat(`${file}.1`)).mode & 0o777, 0o600);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readLedger(runtime)).map((record) => record.request_id),
      ['new', 'boundary'],
    );
    await writeFile(file, ' '.repeat(rotationLimit), { mode: 0o600 });
    await appendEvent(runtime, { ...rotationEvent, request_id: 'latest' });
    assert.equal(await readFile(`${file}.1`, 'utf8'), ' '.repeat(rotationLimit));
    assert.deepEqual(
      (await readLedger(runtime)).map((record) => record.request_id),
      ['latest'],
    );
  } finally {
    await cleanup();
  }
});

test('history folds backup before current and reads a backup without a current file', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    const launched = {
      ...rotationEvent,
      event: 'launched',
      selected: { tool: 'pi', provider: 'openai', model: 'm1', thinking_level: 'low', quota_bucket: 'pi_codex' },
    };
    await writeFile(`${file}.1`, JSON.stringify(launched));
    assert.equal((await readLedger(runtime))[0]?.event, 'launched');
    await appendEvent(runtime, { ...rotationEvent, event: 'exited', exit_code: 0 });
    const [record] = await readLedger(runtime);
    assert.equal(record?.event, 'exited');
    assert.equal(record?.selected?.model, 'm1');
    assert.equal(record?.exit_code, 0);
    await writeFile(`${file}.1`, 'invalid json');
    await assert.rejects(readLedger(runtime), StewardError);
    await writeFile(`${file}.1`, JSON.stringify({ ...rotationEvent, request_id: 'secret' }));
    runtime.env.TYPESAFE_API_KEY = 'secret';
    await assert.rejects(readLedger(runtime), StewardError);
  } finally {
    await cleanup();
  }
});

test('concurrent rotation retains every new event and releases the lock after failure', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    await writeFile(file, ' '.repeat(rotationLimit), { mode: 0o600 });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendEvent(runtime, { ...rotationEvent, request_id: `parallel-${index}` }),
      ),
    );
    assert.equal((await readLedger(runtime)).length, 12);
    assert.equal((await stat(`${file}.1`)).size, rotationLimit);
    await assert.rejects(
      runtime.withLedgerLock(file, async () => {
        throw new Error('test failure');
      }),
    );
    await appendEvent(runtime, { ...rotationEvent, request_id: 'after-failure' });
    assert.equal((await readLedger(runtime)).length, 13);
  } finally {
    await cleanup();
  }
});

test('separate CLI processes serialize rotation with readers', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    await writeFile(file, ' '.repeat(rotationLimit), { mode: 0o600 });
    const ledgerModule = new URL('../src/ledger.ts', import.meta.url).href;
    const ioModule = new URL('../src/ledger-io.ts', import.meta.url).href;
    const source = `
      import { appendEvent, readLedger } from ${JSON.stringify(ledgerModule)};
      import { fileSize, withLedgerLock } from ${JSON.stringify(ioModule)};
      import { appendFile, readFile, mkdir, chmod, rename } from 'node:fs/promises';
      const runtime = {
        env: ${JSON.stringify(runtime.env)}, fileSize, withLedgerLock, chmod, rename,
        mkdirp: (p, mode) => mkdir(p, { recursive: true, mode }),
        appendText: (p, text) => appendFile(p, text, { mode: 0o600 }),
        readTextIfPresent: async (p) => {
          try { return await readFile(p, 'utf8'); }
          catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        },
      };
      await appendEvent(runtime, { ...${JSON.stringify(rotationEvent)}, request_id: process.argv[1] });
      await readLedger(runtime);
    `;
    const processes = Array.from({ length: 6 }, (_, index) =>
      Bun.spawn([process.execPath, '--eval', source, `process-${index}`], { stdout: 'ignore', stderr: 'pipe' }),
    );
    const results = await Promise.all(
      processes.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
    );
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await readLedger(runtime)).map((record) => record.request_id).sort(), [
      'process-0',
      'process-1',
      'process-2',
      'process-3',
      'process-4',
      'process-5',
    ]);
  } finally {
    await cleanup();
  }
});

test('rotation failure preserves both files and releases the lock', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    await writeFile(file, ' '.repeat(rotationLimit), { mode: 0o600 });
    await writeFile(`${file}.1`, 'previous backup', { mode: 0o600 });
    await assert.rejects(
      appendEvent(
        {
          ...runtime,
          rename: async () => {
            throw new Error('rename failed');
          },
        },
        rotationEvent,
      ),
      /rename failed/,
    );
    assert.equal((await stat(file)).size, rotationLimit);
    assert.equal(await readFile(`${file}.1`, 'utf8'), 'previous backup');
    await appendEvent(runtime, rotationEvent);
    assert.equal((await readLedger(runtime))[0]?.request_id, 'boundary');
  } finally {
    await cleanup();
  }
});

test('oversized UTF-8 events are rejected without changing retained history', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    await assert.rejects(
      appendEvent(runtime, { ...rotationEvent, request_id: 'é'.repeat(rotationLimit / 2) }),
      StewardError,
    );
    assert.equal(await runtime.readTextIfPresent(file), null);
    assert.equal(await runtime.readTextIfPresent(`${file}.1`), null);
  } finally {
    await cleanup();
  }
});

test('human list aligns headers and full IDs while retaining exit codes and JSON history', async () => {
  const { rt, out } = memoryRuntime(new Map(), { XDG_STATE_HOME: '/isolated/state' });
  await appendEvent(rt, {
    schema_version: 1,
    request_id: '7f032e75-fc1f-40e1-ac78-1e5a2cbb1d26',
    recorded_at: '2026-10-02T17:01:29.732Z',
    event: 'exited',
    selected: {
      tool: 'pi',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      thinking_level: 'xhigh',
      quota_bucket: 'pi_codex',
    },
    exit_code: 0,
  });
  await appendEvent(rt, {
    schema_version: 1,
    request_id: '102da780-0ae6-49fa-9b88-1ce041d71f57',
    recorded_at: '2026-10-02T14:22:14.422Z',
    event: 'evaluation_failed',
  });
  assert.equal(await run(['router', 'list'], rt), 0);
  const [header, failed, exited, end] = out.join('').split('\n');
  assert.equal(
    header,
    'REQUEST ID                            TIME (UTC)           ROUTE                 ACCOUNT   STATUS             EXIT CODE',
  );
  assert.equal(
    failed,
    '102da780-0ae6-49fa-9b88-1ce041d71f57  2026-10-02 14:22:14  —                     —         evaluation_failed  —',
  );
  assert.equal(
    exited,
    '7f032e75-fc1f-40e1-ac78-1e5a2cbb1d26  2026-10-02 17:01:29  pi/gpt-6.1-sol/xhigh  pi_codex  exited             0',
  );
  assert.equal(end, '');
  out.length = 0;
  assert.equal(await run(['router', 'list', '--json'], rt), 0);
  const records = JSON.parse(out.join(''));
  assert.equal(records[1].recorded_at, '2026-10-02T17:01:29.732Z');
  assert.equal(records[1].request_id, '7f032e75-fc1f-40e1-ac78-1e5a2cbb1d26');
  assert.equal(records[1].exit_code, 0);
});

test('human list omits the exit column when no exit codes are recorded', async () => {
  const { rt, out } = memoryRuntime(new Map(), { XDG_STATE_HOME: '/isolated/state' });
  await appendEvent(rt, { ...rotationEvent, recorded_at: 'historical-time' });
  assert.equal(await run(['router', 'list'], rt), 0);
  assert.match(out.join(''), /^REQUEST ID\s+TIME \(UTC\)\s+ROUTE\s+ACCOUNT\s+STATUS\n/);
  assert.doesNotMatch(out.join(''), /EXIT CODE/);
  assert.match(out.join(''), /historical-time/);
});

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
  assert.deepEqual(listed[2].selected, {
    tool: 'codex',
    provider: 'openai',
    model: 'm1',
    thinking_level: 'low',
    quota_bucket: null,
  });
  assert.equal(listed[1].selected.quota_bucket, 'pi_codex');
  assert.equal(Object.hasOwn(listed[1].selected, 'account_id'), false);
  assert.deepEqual(listed[0].selected, {
    tool: 'codex',
    provider: 'openai',
    model: 'm3',
    thinking_level: 'low',
    quota_bucket: null,
  });
  assert.equal(out.join('').includes('private-id'), false);

  out.length = 0;
  assert.equal(await run(['router', 'show', 'legacy', '--json'], rt), 0);
  assert.equal(JSON.parse(out.join('')).selected.quota_bucket, null);
  out.length = 0;
  assert.equal(await run(['router', 'show', 'unknown-account', '--json'], rt), 0);
  assert.deepEqual(JSON.parse(out.join('')).selected, {
    tool: 'codex',
    provider: 'openai',
    model: 'm3',
    thinking_level: 'low',
    quota_bucket: null,
  });
});

for (const alias of ['codex-subscription-example', 'codex', 'pi_codex', 'pi_xai', 'antigravity']) {
  test(`legacy alias ${alias} preserves the historical selection without inventing a bucket`, async () => {
    const event = {
      schema_version: 1,
      request_id: 'legacy-pi',
      recorded_at: '2026-10-01T00:00:00.000Z',
      event: 'launched',
      selected: {
        tool: 'pi',
        provider: 'openai-codex',
        model: 'historical-model',
        thinking_level: 'high',
        account_id: alias,
      },
      usage: { input_tokens: 20, output_tokens: 5 },
    };
    const text = [event, { ...event, event: 'exited', selected: undefined, exit_code: 0 }]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const files = new Map<string, string>();
    const { rt, out, modes } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
    files.set(ledgerFile(rt.env), text);
    const [record] = await readLedger(rt);
    const selected = {
      tool: 'pi',
      provider: 'openai-codex',
      model: 'historical-model',
      thinking_level: 'high',
      quota_bucket: null,
    };
    assert.deepEqual(record?.selected, selected);
    assert.equal(record?.event, 'exited');
    assert.equal(record?.exit_code, 0);
    assert.deepEqual(record?.usage, { input_tokens: 20, output_tokens: 5 });
    assert.equal(await run(['router', 'list'], rt), 0);
    assert.match(out.join(''), /legacy-pi.*pi\/historical-model\/high\s+—\s+exited/);
    out.length = 0;
    assert.equal(await run(['router', 'show', 'legacy-pi', '--json'], rt), 0);
    assert.deepEqual(JSON.parse(out.join('')).selected, selected);
    assert.equal(out.join('').includes('account_id'), false);
    assert.equal(files.get(ledgerFile(rt.env)), text);
    assert.deepEqual(modes, []);
  });
}

test('legacy selections must validate before account IDs are removed', async () => {
  const selected = {
    tool: 'pi',
    provider: 'openai-codex',
    model: 'm2',
    thinking_level: 'high',
    account_id: 'old-alias',
  };
  for (const invalid of [
    {},
    { ...selected, tool: 7 },
    { ...selected, provider: null },
    { ...selected, model: undefined },
    { ...selected, thinking_level: [] },
    { ...selected, account_id: 123 },
    { ...selected, account_id: undefined },
    { ...selected, unexpected: 'field' },
    { ...selected, quota_bucket: 'pi_codex', account_id: 123 },
  ]) {
    const files = new Map<string, string>();
    const { rt } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
    files.set(
      ledgerFile(rt.env),
      JSON.stringify({
        schema_version: 1,
        request_id: 'invalid-legacy',
        recorded_at: '2026-10-01T00:00:00.000Z',
        event: 'launched',
        selected: invalid,
      }),
    );
    await assert.rejects(
      readLedger(rt),
      (error: unknown) => error instanceof StewardError && error.code === 'invalid_input',
    );
  }
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
  assert.equal(out.join('').split('\n').length, 3);
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
