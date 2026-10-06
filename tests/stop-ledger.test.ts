import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendStopEvent,
  formatStopLedgerRecords,
  readStopLedger,
  stopLedgerFile,
  stopTool,
  type StopLedgerEvent,
} from '../src/stop-ledger.ts';
import { StewardError } from '../src/contracts.ts';
import { fileSize, withLedgerLock } from '../src/ledger-io.ts';
import type { LedgerRuntime } from '../src/ledger.ts';

function memoryRuntime(files: Map<string, string>, env: LedgerRuntime['env']) {
  const modes: [string, number][] = [];
  const rt: LedgerRuntime = {
    env,
    appendText: async (p, text) => {
      files.set(p, (files.get(p) ?? '') + text);
    },
    readTextIfPresent: async (p) => files.get(p) ?? null,
    fileSize: async (p) => Buffer.byteLength(files.get(p) ?? ''),
    withLedgerLock: async (_p, action) => action(),
    mkdirp: async (p, mode) => {
      modes.push([p, mode]);
    },
    chmod: async (p, mode) => {
      modes.push([p, mode]);
    },
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, content);
      files.delete(from);
    },
  };
  return { rt, modes };
}

const rotationLimit = 5 * 1024 * 1024;

async function diskRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), 'steward-stop-ledger-'));
  const env = { XDG_STATE_HOME: root };
  const runtime: LedgerRuntime = {
    env,
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
  const file = stopLedgerFile(runtime.env);
  await mkdir(path.dirname(file), { mode: 0o700 });
  return { runtime, file, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const baseStopEvent: StopLedgerEvent = {
  schema_version: 1,
  request_id: 'a',
  recorded_at: '2026-10-06T00:00:00.000Z',
  event: 'assessed',
  action: 'manual_review',
  reason_code: 'insufficient_context',
};

test('stopTool accepts only routing tool identifiers', () => {
  assert.equal(stopTool('agy'), 'agy');
  assert.equal(stopTool('pi'), 'pi');
  assert.equal(stopTool('codex'), 'codex');
  assert.equal(stopTool('/home/alexander/.pi/agent'), undefined);
  assert.equal(stopTool('herdr:antigravity_cli'), undefined);
  assert.equal(stopTool('unknown'), undefined);
  assert.equal(stopTool(''), undefined);
});

test('stop ledger path is not the router ledger', () => {
  const env = { HOME: '/isolated/home' };
  assert.equal(stopLedgerFile(env), '/isolated/home/.local/state/agent-steward/stop.jsonl');
  assert.doesNotMatch(stopLedgerFile(env), /router\.jsonl/);

  const xdgEnv = { XDG_STATE_HOME: '/custom/state' };
  assert.equal(stopLedgerFile(xdgEnv), '/custom/state/agent-steward/stop.jsonl');

  assert.throws(
    () => stopLedgerFile({}),
    (error: unknown) => error instanceof StewardError && error.code === 'invalid_input',
  );
});

test('rotation keeps an exact-limit file and replaces only one backup on overflow', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    const line = `${JSON.stringify(baseStopEvent)}\n`;
    const prefix = ' '.repeat(rotationLimit - Buffer.byteLength(line));
    await writeFile(file, prefix, { mode: 0o600 });
    await appendStopEvent(runtime, baseStopEvent);
    assert.equal((await stat(file)).size, rotationLimit);
    assert.equal(await runtime.readTextIfPresent(`${file}.1`), null);

    await writeFile(`${file}.1`, 'obsolete', { mode: 0o644 });
    await appendStopEvent(runtime, { ...baseStopEvent, request_id: 'new' });
    assert.equal(await readFile(`${file}.1`, 'utf8'), prefix + line);
    assert.equal((await stat(`${file}.1`)).mode & 0o777, 0o600);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readStopLedger(runtime)).map((record) => record.request_id),
      ['new', 'a'],
    );

    await writeFile(file, ' '.repeat(rotationLimit), { mode: 0o600 });
    await appendStopEvent(runtime, { ...baseStopEvent, request_id: 'latest' });
    assert.equal(await readFile(`${file}.1`, 'utf8'), ' '.repeat(rotationLimit));
    assert.deepEqual(
      (await readStopLedger(runtime)).map((record) => record.request_id),
      ['latest'],
    );
  } finally {
    await cleanup();
  }
});

test('history folds backup before current and duplicate request_id folds with latest event', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    const initial: StopLedgerEvent = {
      ...baseStopEvent,
      request_id: 'a',
      tool: 'agy',
      event: 'assessed',
      action: 'manual_review',
      reason_code: 'insufficient_context',
    };
    await writeFile(`${file}.1`, JSON.stringify(initial));
    assert.equal((await readStopLedger(runtime))[0]?.event, 'assessed');
    assert.equal((await readStopLedger(runtime))[0]?.action, 'manual_review');

    // Duplicate request_id with a later failed event must fold to event: 'failed'
    await appendStopEvent(runtime, {
      schema_version: 1,
      request_id: 'a',
      recorded_at: '2026-10-06T00:01:00.000Z',
      event: 'failed',
      reason_code: 'internal_failure',
    });

    const records = await readStopLedger(runtime);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record?.request_id, 'a');
    assert.equal(record?.event, 'failed');
    assert.equal(record?.reason_code, 'internal_failure');
    assert.equal(record?.tool, 'agy');

    await writeFile(`${file}.1`, 'invalid json');
    await assert.rejects(readStopLedger(runtime), StewardError);

    await writeFile(`${file}.1`, JSON.stringify({ ...baseStopEvent, request_id: 'secret' }));
    runtime.env.TYPESAFE_API_KEY = 'secret';
    await assert.rejects(readStopLedger(runtime), StewardError);
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
        appendStopEvent(runtime, { ...baseStopEvent, request_id: `parallel-${index}` }),
      ),
    );
    assert.equal((await readStopLedger(runtime)).length, 12);
    assert.equal((await stat(`${file}.1`)).size, rotationLimit);
    await assert.rejects(
      runtime.withLedgerLock(file, async () => {
        throw new Error('test failure');
      }),
    );
    await appendStopEvent(runtime, { ...baseStopEvent, request_id: 'after-failure' });
    assert.equal((await readStopLedger(runtime)).length, 13);
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
      appendStopEvent(
        {
          ...runtime,
          rename: async () => {
            throw new Error('rename failed');
          },
        },
        baseStopEvent,
      ),
      /rename failed/,
    );
    assert.equal((await stat(file)).size, rotationLimit);
    assert.equal(await readFile(`${file}.1`, 'utf8'), 'previous backup');
    await appendStopEvent(runtime, baseStopEvent);
    assert.equal((await readStopLedger(runtime))[0]?.request_id, 'a');
  } finally {
    await cleanup();
  }
});

test('oversized UTF-8 events are rejected without changing retained history', async () => {
  const { runtime, file, cleanup } = await diskRuntime();
  try {
    await assert.rejects(
      appendStopEvent(runtime, { ...baseStopEvent, reason_code: 'é'.repeat(rotationLimit / 2) }),
      StewardError,
    );
    assert.equal(await runtime.readTextIfPresent(file), null);
    assert.equal(await runtime.readTextIfPresent(`${file}.1`), null);
  } finally {
    await cleanup();
  }
});

test('credential scan blocks writes before any filesystem side effect', async () => {
  const files = new Map<string, string>();
  const { rt, modes } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state', TYPESAFE_API_KEY: 'sekrit' });
  await assert.rejects(
    () =>
      appendStopEvent(rt, {
        ...baseStopEvent,
        reason_code: 'sekrit',
      }),
    StewardError,
  );
  assert.equal(files.size, 0);
  assert.deepEqual(modes, []);
});

test('append rejects extra fields', async () => {
  const files = new Map<string, string>();
  const { rt } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
  for (const invalid of [
    { ...baseStopEvent, extra_field: 'unexpected' },
    { ...baseStopEvent, usage: { input_tokens: 10, extra: 20 } },
    { ...baseStopEvent, tool: 'invalid-tool' },
    { ...baseStopEvent, action: 'invalid-action' },
    { ...baseStopEvent, event: 'unknown' },
    { ...baseStopEvent, schema_version: 2 },
  ]) {
    await assert.rejects(
      () => appendStopEvent(rt, invalid as unknown as StopLedgerEvent),
      (error: unknown) => error instanceof StewardError && error.code === 'invalid_input',
    );
  }
  assert.equal(files.size, 0);
});

test('read rejects extra fields and invalid records in stop ledger', async () => {
  const files = new Map<string, string>();
  const { rt } = memoryRuntime(files, { XDG_STATE_HOME: '/isolated/state' });
  files.set(stopLedgerFile(rt.env), JSON.stringify({ ...baseStopEvent, unexpected: 'field' }) + '\n');
  await assert.rejects(
    readStopLedger(rt),
    (error: unknown) => error instanceof StewardError && error.code === 'invalid_input',
  );
});

test('formatStopLedgerRecords formats columns without pane or context and handles missing fields', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const records: StopLedgerEvent[] = [
    {
      schema_version: 1,
      request_id: 'req-002',
      recorded_at: '2026-10-06T11:59:00.000Z',
      event: 'failed',
      reason_code: 'upstream_timeout',
    },
    {
      schema_version: 1,
      request_id: 'req-001',
      recorded_at: '2026-10-06T11:00:00.000Z',
      event: 'assessed',
      tool: 'agy',
      action: 'approve_request',
      reason_code: 'policy_allowed',
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    {
      schema_version: 1,
      request_id: null,
      recorded_at: '2026-10-06T10:00:00.000Z',
      event: 'failed',
      reason_code: 'malformed_json',
    },
  ];

  const formatted = formatStopLedgerRecords(records, now);
  const lines = formatted.trim().split('\n');

  assert.equal(lines.length, 4); // header + 3 rows
  const [header, row1, row2, row3] = lines;
  assert.match(header!, /^REQUEST ID\s+TIME\s+TOOL\s+ACTION\s+STATUS\s+REASON$/);

  // Output must not contain pane/session/context shapes like w1:p1
  assert.doesNotMatch(formatted, /w\d+:p\d+/);
  assert.doesNotMatch(formatted, /pane/i);
  assert.doesNotMatch(formatted, /session/i);
  assert.doesNotMatch(formatted, /context/i);

  // Row 1 checks
  assert.ok(row1!.includes('req-002'));
  assert.ok(row1!.includes('1m ago'));
  assert.ok(row1!.includes('—')); // missing tool and action
  assert.ok(row1!.includes('failed'));
  assert.ok(row1!.includes('upstream_timeout'));

  // Row 2 checks
  assert.ok(row2!.includes('req-001'));
  assert.ok(row2!.includes('1h ago'));
  assert.ok(row2!.includes('agy'));
  assert.ok(row2!.includes('approve_request'));
  assert.ok(row2!.includes('assessed'));
  assert.ok(row2!.includes('policy_allowed'));

  // Row 3 checks (null request_id)
  assert.ok(row3!.includes('—')); // request_id null -> —
  assert.ok(row3!.includes('2h ago'));
  assert.ok(row3!.includes('failed'));
  assert.ok(row3!.includes('malformed_json'));
});

test('formatStopLedgerRecords returns empty string for empty records', () => {
  assert.equal(formatStopLedgerRecords([], new Date()), '');
});

test('formatStopLedgerRecords escapes control characters in reason and request ID', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const records: StopLedgerEvent[] = [
    {
      schema_version: 1,
      request_id: 'req\u001b[31mescape',
      recorded_at: '2026-10-06T12:00:00.000Z',
      event: 'assessed',
      tool: 'pi',
      action: 'manual_review',
      reason_code: 'reason\nnewline',
    },
  ];
  const formatted = formatStopLedgerRecords(records, now);
  assert.ok(!formatted.includes('\u001b'));
  assert.ok(!formatted.includes('\nnewline'));
  assert.match(formatted, /req\\u001b\[31mescape/);
  assert.match(formatted, /reason\\nnewline/);
});
