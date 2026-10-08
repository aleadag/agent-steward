import { test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Server } from 'node:net';
import { collectNativeAgy, runPreviousAgyRenderer, sendAgyCapture } from '../src/agy-runtime.ts';
import { agyPaths } from '../src/agy-setup.ts';

async function fixture(
  run: (
    paths: ReturnType<typeof agyPaths>,
    executable: string,
    env: Record<string, string | undefined>,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(join(tmpdir(), 'agy-runtime-'));
  const paths = agyPaths({ HOME: root });
  try {
    await fs.mkdir(paths.state, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.workdir, { recursive: true, mode: 0o700 });
    await fs.mkdir(join(root, '.gemini/antigravity-cli'), { recursive: true });
    await fs.writeFile(
      paths.settings,
      JSON.stringify({ statusLine: { type: 'command', command: '/fake-hook', enabled: true } }),
    );
    await fs.writeFile(
      paths.manifest,
      JSON.stringify({ schema_version: 1, previousStatusLine: null, installedCommand: '/fake-hook' }),
      { mode: 0o600 },
    );
    const executable = join(root, 'fake-agy');
    await fs.writeFile(
      executable,
      `#!${process.execPath}\nawait import(${JSON.stringify(resolve('tests/fake-agy.ts'))});\n`,
      { mode: 0o755 },
    );
    await run(paths, executable, { HOME: root, PATH: process.env.PATH });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('terminal cleanup failure still removes the private IPC endpoint', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    const close = Bun.Terminal.prototype.close,
      listen = Server.prototype.listen;
    const servers: Server[] = [];
    const observer = join(nativeEnv.HOME!, 'cleanup-observer');
    let socketPath: string | undefined;
    Object.defineProperty(Server.prototype, 'listen', {
      value: function (this: Server, ...args: unknown[]) {
        servers.push(this);
        return Reflect.apply(listen, this, args);
      },
      writable: true,
      configurable: true,
    });
    Bun.Terminal.prototype.close = function (this: Bun.Terminal) {
      close.call(this);
      throw new Error('synthetic terminal close failure');
    };
    try {
      const result = await collectNativeAgy({
        paths,
        executable,
        nativeEnv: { ...nativeEnv, STEWARD_FAKE_AGY_OBSERVER: observer },
        requestId: 'request-a',
        now: () => new Date(),
      });
      assert.equal(result.status, 'fetch');
      socketPath = JSON.parse(await fs.readFile(observer, 'utf8')).socketPath;
      assert.ok(socketPath);
      await assert.rejects(fs.lstat(socketPath));
    } finally {
      Bun.Terminal.prototype.close = close;
      Object.defineProperty(Server.prototype, 'listen', { value: listen, writable: true, configurable: true });
      for (const server of servers)
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (socketPath) await fs.rm(join(socketPath, '..'), { recursive: true, force: true });
    }
  }));
test('renderer failure waits for confirmed owned child exit', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'renderer-exit-'));
  const pidFile = join(root, 'pid');
  const originalKill = process.kill;
  let delayed: ReturnType<typeof setTimeout> | undefined;
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 'SIGKILL') {
      delayed = setTimeout(() => {
        try {
          originalKill(pid, signal);
        } catch {}
      }, 30);
      return true;
    }
    return originalKill(pid, signal);
  };
  try {
    const code = `await Bun.write(${JSON.stringify(pidFile)},String(process.pid));process.stdout.on('error',()=>{});process.stdout.write('x'.repeat(1048577));await Bun.sleep(10000);`;
    const command = `exec '${process.execPath}' -e '${code.replaceAll("'", "'\\''")}'`;
    assert.deepEqual(await runPreviousAgyRenderer(command, '{}', Bun.which('sh')!), { stdout: '', exitCode: 1 });
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.throws(() => originalKill(pid, 0));
  } finally {
    process.kill = originalKill;
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native collection refuses relative and empty PATH components', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    for (const PATH of ['.', `${nativeEnv.PATH}:`, undefined])
      assert.equal(
        (
          await collectNativeAgy({
            paths,
            executable,
            nativeEnv: { ...nativeEnv, PATH },
            requestId: 'request-a',
            now: () => new Date(),
          })
        ).status,
        'fetch',
      );
  }));

test('Bun PTY collects only post-/usage observations without a caller terminal', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    const result = await collectNativeAgy({
      paths,
      executable,
      nativeEnv,
      requestId: 'request-a',
      now: () => new Date(),
    });
    assert.equal(result.status, 'captured');
    if (result.status === 'captured') assert.equal(result.observation.requestId, 'request-a');
  }));
test('native refusal/error states, wrong requests and missing executables fail safely', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    for (const scenario of ['trust', 'auth', 'unknown', 'error', 'wrong', 'early', 'overflow']) {
      const result = await collectNativeAgy({
        paths,
        executable,
        nativeEnv: { ...nativeEnv, STEWARD_FAKE_AGY_CASE: scenario },
        requestId: 'request-a',
        now: () => new Date(),
      });
      assert.equal(result.status, scenario === 'auth' ? 'auth' : 'fetch', scenario);
      if (scenario === 'trust') assert.deepEqual(result, { status: 'fetch', diagnostic: 'quota_agy_trust' });
    }
    assert.equal(
      (
        await collectNativeAgy({
          paths,
          executable: '/missing/agy',
          nativeEnv,
          requestId: 'request-a',
          now: () => new Date(),
        })
      ).status,
      'fetch',
    );
  }));
test('missing setup, external auth overrides and symlinked workdir do not start native sessions', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    assert.equal(
      (
        await collectNativeAgy({
          paths,
          executable,
          nativeEnv: { ...nativeEnv, AGY_GATEWAY_URL: 'https://example.test' },
          requestId: 'request-a',
          now: () => new Date(),
        })
      ).status,
      'auth',
    );
    await fs.rm(paths.workdir, { recursive: true });
    await fs.symlink(paths.state, paths.workdir);
    assert.equal(
      (await collectNativeAgy({ paths, executable, nativeEnv, requestId: 'request-a', now: () => new Date() })).status,
      'fetch',
    );
    await fs.unlink(paths.manifest);
    assert.deepEqual(
      await collectNativeAgy({ paths, executable, nativeEnv, requestId: 'request-a', now: () => new Date() }),
      { status: 'fetch', diagnostic: 'quota_agy_setup' },
    );
  }));
test('broken capture endpoints reject boundedly and never expose their error text', async () => {
  await assert.rejects(
    sendAgyCapture(
      { requestId: 'request-a', socketPath: '/missing/s' },
      { requestId: 'request-a', observedAt: new Date().toISOString(), quota: {} },
    ),
  );
});
test('previous renderer receives stdin data unchanged and preserves exit status without stderr', async () => {
  const cmd = `${JSON.stringify(process.execPath)} -e 'let s="";for await(const b of process.stdin)s+=b;console.error("private");process.stdout.write(s);process.exitCode=7;'`;
  assert.deepEqual(await runPreviousAgyRenderer(cmd, 'original bytes\n', Bun.which('sh')!), {
    stdout: 'original bytes\n',
    exitCode: 7,
  });
});
test('renderer timeout and overflow terminate without leaking upstream output', async () => {
  for (const cmd of [
    `${JSON.stringify(process.execPath)} -e 'await Bun.sleep(10000);'`,
    `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(1048577));'`,
  ]) {
    const start = performance.now();
    assert.deepEqual(await runPreviousAgyRenderer(cmd, '{}', Bun.which('sh')!), { stdout: '', exitCode: 1 });
    assert.ok(performance.now() - start < 5500);
  }
});
test('private IPC permissions, late-delivery rejection and owned session cleanup', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    const observer = join(nativeEnv.HOME!, 'observer.json');
    const unrelated = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(10000);'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      assert.equal(
        (
          await collectNativeAgy({
            paths,
            executable,
            nativeEnv: { ...nativeEnv, STEWARD_FAKE_AGY_OBSERVER: observer },
            requestId: 'request-a',
            now: () => new Date(),
          })
        ).status,
        'captured',
      );
      const metadata = JSON.parse(await fs.readFile(observer, 'utf8'));
      assert.equal(metadata.socketMode, 0o600);
      assert.equal(metadata.directoryMode, 0o700);
      assert.equal(metadata.cwd, await fs.realpath(paths.workdir));
      await assert.rejects(fs.lstat(metadata.socketPath));
      assert.throws(() => process.kill(metadata.pid, 0));
      assert.equal(unrelated.exitCode, null);
      await assert.rejects(
        sendAgyCapture(
          { requestId: 'request-a', socketPath: metadata.socketPath },
          { requestId: 'request-a', observedAt: new Date().toISOString(), quota: {} },
        ),
      );
    } finally {
      unrelated.kill();
      await unrelated.exited;
    }
  }));
test('oversized IPC and overlong socket paths fail, while long XDG paths work', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    assert.equal(
      (
        await collectNativeAgy({
          paths,
          executable,
          nativeEnv: { ...nativeEnv, STEWARD_FAKE_AGY_CASE: 'ipc-overflow' },
          requestId: 'request-a',
          now: () => new Date(),
        })
      ).status,
      'malformed',
    );
    const xdg = join(nativeEnv.HOME!, 'x'.repeat(150));
    const longPaths = agyPaths({ HOME: nativeEnv.HOME!, XDG_STATE_HOME: xdg });
    await fs.mkdir(longPaths.state, { recursive: true });
    await fs.mkdir(longPaths.workdir);
    await fs.copyFile(paths.manifest, longPaths.manifest);
    assert.equal(
      (
        await collectNativeAgy({
          paths: longPaths,
          executable,
          nativeEnv: { ...nativeEnv, XDG_STATE_HOME: xdg },
          requestId: 'request-a',
          now: () => new Date(),
        })
      ).status,
      'captured',
    );
    const old = process.env.TMPDIR;
    const tooLong = join(nativeEnv.HOME!, 't'.repeat(110));
    await fs.mkdir(tooLong);
    try {
      process.env.TMPDIR = tooLong;
      assert.equal(
        (await collectNativeAgy({ paths, executable, nativeEnv, requestId: 'request-a', now: () => new Date() }))
          .status,
        'fetch',
      );
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
  }));
test('native environment matches identity/workdir paths and omits the evaluator key', async () =>
  fixture(async (paths, executable, nativeEnv) => {
    assert.equal(
      (
        await collectNativeAgy({
          paths,
          executable,
          nativeEnv: { ...nativeEnv, HOME: join(nativeEnv.HOME!, 'other') },
          requestId: 'request-a',
          now: () => new Date(),
        })
      ).status,
      'auth',
    );
    const observer = join(nativeEnv.HOME!, 'env-observer');
    assert.equal(
      (
        await collectNativeAgy({
          paths,
          executable,
          nativeEnv: {
            ...nativeEnv,
            STEWARD_FAKE_AGY_OBSERVER: observer,
            TYPESAFE_API_KEY: 'synthetic-private-jev-key',
          },
          requestId: 'request-a',
          now: () => new Date(),
        })
      ).status,
      'captured',
    );
    const metadata = JSON.parse(await fs.readFile(observer, 'utf8'));
    assert.equal(metadata.evaluatorKeyPresent, false);
    assert.equal(metadata.updatesDisabled, true);
  }));

test(
  'native deadline is 45 seconds and cleanup is bounded',
  async () =>
    fixture(async (paths, executable, nativeEnv) => {
      const start = performance.now();
      const result = await collectNativeAgy({
        paths,
        executable,
        nativeEnv: { ...nativeEnv, STEWARD_FAKE_AGY_CASE: 'timeout' },
        requestId: 'request-a',
        now: () => new Date(),
      });
      assert.equal(result.status, 'fetch');
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 44000 && elapsed < 51000);
    }),
  60000,
);
