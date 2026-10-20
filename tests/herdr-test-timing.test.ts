import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { constants } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { withTestTiming, type TimingCase, type TimingPhase } from './herdr-test-timing.ts';

const records = (lines: string[]) => lines.map((line) => JSON.parse(line.slice('STEWARD_TEST_TIMING '.length)));

test('timing opt-out leaves injected IO untouched and emits nothing', async () => {
  const lines: string[] = [];
  const overrides = { lstat };
  const result = await withTestTiming(
    'capacity',
    async (timing) => {
      assert.equal(timing.io(overrides), overrides);
      timing.phase('run');
      return 42;
    },
    { enabled: false, write: (line) => lines.push(line) },
  );
  assert.equal(result, 42);
  assert.deepEqual(lines, []);
});

test('timing measures real file handles, delayed metadata and exclusive-create contention without leaking paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sensitive-timing-'));
  const path = join(root, 'synthetic-secret');
  const lines: string[] = [];
  try {
    await withTestTiming(
      'diagnostics',
      async (timing) => {
        const io = timing.io({
          lstat: async (value) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return lstat(value);
          },
        });
        const handle = await io.open!(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await handle.writeFile('private contents');
        await handle.sync();
        await handle.close();
        await io.lstat!(path);
        await assert.rejects(io.open!(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600), {
          code: 'EEXIST',
        });
        timing.phase('release');
      },
      { enabled: true, write: (line) => lines.push(line) },
    );
    const last = records(lines).at(-1);
    assert.ok(last, 'enabled tracing must emit a final record');
    assert.equal(last.event, 'finished');
    assert.equal(last.io.open.count, 2);
    assert.equal(last.io.open.exclusive_exists, 1);
    assert.equal(last.io.writeFile.count, 1);
    assert.equal(last.io.sync.count, 1);
    assert.equal(last.io.close.count, 1);
    assert.ok(last.io.lstat.max_ms >= 20);
    assert.equal(lines.join('').includes(root), false);
    assert.equal(lines.join('').includes('private contents'), false);
    assert.equal(lines.join('').includes('synthetic-secret'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timing retains sub-millisecond latency when aggregating many operations', async () => {
  const lines: string[] = [];
  let now = 0;
  await withTestTiming(
    'capacity',
    async (timing) => {
      const io = timing.io({
        lstat: async (path) => {
          const info = await lstat(path);
          now += 0.2;
          return info;
        },
      });
      for (let i = 0; i < 4; i++) await io.lstat!(import.meta.path);
    },
    { enabled: true, write: (line) => lines.push(line), now: () => now },
  );
  const last = records(lines).at(-1);
  assert.equal(last.io.lstat.total_ms, 0.8);
  assert.equal(last.io.lstat.max_ms, 0.2);
});

test('timing exposes pending IO and preserves the original operation error', async () => {
  const failure = new Error('private operation error');
  const lines: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    withTestTiming(
      'approval',
      async (timing) => {
        const pending = timing.io({
          lstat: async () => {
            await gate;
            throw failure;
          },
        }).lstat!('/private/path');
        try {
          timing.phase('run');
          const snapshot = records(lines).at(-1);
          assert.ok(snapshot, 'phase tracing must expose pending IO');
          assert.equal(snapshot.io.lstat.pending, 1);
        } finally {
          release();
          await pending;
        }
      },
      { enabled: true, write: (line) => lines.push(line) },
    ),
    (error) => error === failure,
  );
  const last = records(lines).at(-1);
  assert.ok(last, 'failed operations must emit a final record');
  assert.equal(last.event, 'failed');
  assert.equal(last.io.lstat.pending, 0);
  assert.equal(last.io.lstat.errors, 1);
  assert.equal(lines.join('').includes(failure.message), false);
});

test('timing reports event-loop stalls separately from asynchronous IO latency', async () => {
  const lines: string[] = [];
  await withTestTiming(
    'capacity',
    async (timing) => {
      const until = performance.now() + 170;
      while (performance.now() < until) {
        /* deliberate scheduler stall */
      }
      timing.phase('run');
    },
    { enabled: true, write: (line) => lines.push(line) },
  );
  assert.ok(
    records(lines).some((record) => record.loop_lag_ms >= 50),
    'event-loop stall must be observable',
  );
});

test('timing output is bounded and rejects arbitrary labels without logging them', async () => {
  const lines: string[] = [];
  await withTestTiming(
    'capacity',
    async (timing) => {
      assert.throws(() => timing.phase('/private/secret' as TimingPhase), /invalid timing phase/);
      for (let i = 0; i < 1000; i++) timing.phase('slot', i % 9);
    },
    { enabled: true, write: (line) => lines.push(line) },
  );
  assert.ok(lines.length > 0 && lines.length <= 64);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 4096));
  assert.equal(lines.join('').includes('/private/secret'), false);
  await assert.rejects(
    withTestTiming('secret' as TimingCase, async () => {}, { enabled: true }),
    /invalid timing case/,
  );
});

test('timing sink failure does not replace the operation result or rejection', async () => {
  const write = () => {
    throw new Error('sink failed');
  };
  assert.equal(await withTestTiming('capacity', async () => 42, { enabled: true, write }), 42);
  const failure = new Error('original');
  await assert.rejects(
    withTestTiming(
      'capacity',
      async () => {
        throw failure;
      },
      { enabled: true, write },
    ),
    (error) => error === failure,
  );
});

test('child timings use fd 3 without contaminating asserted stdout and stderr', async () => {
  const module = new URL('./herdr-test-timing.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    import { withTestTiming } from ${JSON.stringify(module)};
    await withTestTiming('shutdown-child', async (timing) => {
      timing.phase('stop');
      console.log('settled 5000');
      console.error('fixed warning');
    });
  `,
    ],
    {
      env: { AGENT_STEWARD_TEST_TIMING: '1', AGENT_STEWARD_TEST_TIMING_FD: '3' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  );
  const closed = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  let stdout = '',
    stderr = '',
    timing = '';
  child.stdout!.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  const channel = child.stdio[3] as import('node:stream').Readable;
  channel.on('data', (chunk) => {
    timing += chunk;
  });
  try {
    assert.equal(await closed, 0);
    assert.equal(stdout, 'settled 5000\n');
    assert.equal(stderr, 'fixed warning\n');
    assert.ok(timing.startsWith('STEWARD_TEST_TIMING '), 'child must emit timings on fd 3');
    const actual = records(timing.trim().split('\n'));
    assert.equal(actual[0].case, 'shutdown-child');
    assert.equal(actual.at(-1).event, 'finished');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed;
    }
  }
});
