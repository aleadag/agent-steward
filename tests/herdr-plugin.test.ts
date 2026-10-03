import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = process.env.AGENT_STEWARD_PACKAGE;
const fifoWriterModule = process.env.AGENT_STEWARD_FIFO_WRITER ?? new URL('./fifo-writer.ts', import.meta.url).href;
const processObserverModule =
  process.env.AGENT_STEWARD_PROCESS_OBSERVER ?? new URL('./installed-process.ts', import.meta.url).href;

type SpawnedChild = ReturnType<typeof spawn>;
const closeEvents = new WeakMap<SpawnedChild, Promise<number | null>>();

function trackChildClose(child: SpawnedChild): void {
  const closed = once(child, 'close').then(([code]) => code as number | null);
  void closed.catch(() => {});
  closeEvents.set(child, closed);
}

async function waitForChildClose(
  child: SpawnedChild,
  timeoutMs: number,
  signal?: NodeJS.Signals,
): Promise<number | null> {
  const closed = closeEvents.get(child);
  if (!closed) throw new Error('child close event was not tracked at spawn');
  if (signal && child.exitCode === null && child.signalCode === null) child.kill(signal);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('installed child close watchdog expired')), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    let cleanupWatchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed.catch(() => null),
        new Promise((resolve) => {
          cleanupWatchdog = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      if (cleanupWatchdog) clearTimeout(cleanupWatchdog);
    }
    throw error;
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

async function closeFakeServer(server: Server, sockets: Set<Socket>, timeoutMs: number): Promise<boolean> {
  if (!server.listening) return true;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  try {
    const completed = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        watchdog = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (completed) return true;
    const closingSockets = [...sockets];
    const socketClosures = closingSockets.map(
      (socket) => new Promise<void>((resolve) => socket.once('close', resolve)),
    );
    for (const socket of closingSockets) socket.destroy();
    let cleanupWatchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          closed.then(
            () => undefined,
            () => undefined,
          ),
          Promise.all(socketClosures),
        ]),
        new Promise((resolve) => {
          cleanupWatchdog = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      if (cleanupWatchdog) clearTimeout(cleanupWatchdog);
    }
    return false;
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

async function closeFakeServerAndRemoveRoot(
  server: Server,
  sockets: Set<Socket>,
  root: string,
  timeoutMs: number,
): Promise<void> {
  try {
    assert.equal(
      await closeFakeServer(server, sockets, timeoutMs),
      true,
      'fake Herdr server should close without forcing open sockets after children stop',
    );
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Preserve the primary server-close failure if root cleanup also fails. */
    }
    throw error;
  }
  rmSync(root, { recursive: true, force: true });
}

function installedLeaseReady(state: string, expectedPid: number, expectedSession: string): { token: string } | null {
  try {
    const safe = (path: string, directory: boolean): void => {
      const info = lstatSync(path);
      if (
        info.uid !== process.getuid?.() ||
        (directory ? !info.isDirectory() : !info.isFile()) ||
        (info.mode & 0o777) !== (directory ? 0o700 : 0o600)
      )
        throw new Error('not ready');
    };
    const object = (path: string): Record<string, unknown> => {
      safe(path, false);
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not ready');
      return value as Record<string, unknown>;
    };
    safe(state, true);
    const root = join(state, 'scheduler-lease');
    safe(root, true);
    safe(join(root, 'generations'), true);
    const selected = object(join(root, 'active.json'));
    if (
      Object.keys(selected).length !== 4 ||
      selected.protocol !== 2 ||
      typeof selected.token !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(selected.token) ||
      !Number.isSafeInteger(expectedPid) ||
      expectedPid <= 0 ||
      selected.pid !== expectedPid ||
      expectedSession.length === 0 ||
      selected.session !== expectedSession
    )
      return null;
    const generation = join(root, 'generations', selected.token);
    safe(generation, true);
    const owner = object(join(generation, 'owner.json'));
    const equalIdentity = (value: Record<string, unknown>): boolean =>
      Object.keys(value).length === 4 &&
      value.protocol === selected.protocol &&
      value.token === selected.token &&
      value.pid === selected.pid &&
      value.session === selected.session;
    if (!equalIdentity(owner)) return null;
    const heartbeat = object(join(generation, 'heartbeat.json'));
    if (
      Object.keys(heartbeat).length !== 3 ||
      heartbeat.protocol !== 2 ||
      heartbeat.token !== selected.token ||
      typeof heartbeat.heartbeat !== 'number' ||
      !Number.isFinite(heartbeat.heartbeat) ||
      heartbeat.heartbeat + 15_000 <= Date.now()
    )
      return null;
    const absentMarker = (): boolean => {
      try {
        lstatSync(join(generation, 'released'));
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    };
    if (!absentMarker() || !equalIdentity(object(join(root, 'active.json'))) || !absentMarker()) return null;
    process.kill(expectedPid, 0);
    return { token: selected.token };
  } catch {
    return null;
  }
}

test('installed readiness rejects retained generations', () => {
  const state = mkdtempSync(join(tmpdir(), 'steward-readiness-'));
  const token = '00000000-0000-4000-8000-000000000001';
  const root = join(state, 'scheduler-lease');
  const generation = join(root, 'generations', token);
  mkdirSync(generation, { recursive: true, mode: 0o700 });
  const identity = { protocol: 2, token, pid: process.pid, session: 'synthetic-session' };
  const heartbeat = { protocol: 2, token, heartbeat: Date.now() };
  try {
    for (const [path, value] of [
      [join(root, 'active.json'), identity],
      [join(generation, 'owner.json'), identity],
      [join(generation, 'heartbeat.json'), heartbeat],
    ] as const)
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    assert.deepEqual(installedLeaseReady(state, process.pid, identity.session), { token });
    assert.equal(installedLeaseReady(state, process.pid, 'other-session'), null);
    assert.equal(installedLeaseReady(state, process.pid + 1, identity.session), null);
    writeFileSync(join(generation, 'heartbeat.json'), JSON.stringify({ ...heartbeat, heartbeat: 1 }));
    assert.equal(installedLeaseReady(state, process.pid, identity.session), null);
    writeFileSync(join(generation, 'heartbeat.json'), JSON.stringify(heartbeat));
    mkdirSync(join(generation, 'released'), { mode: 0o700 });
    assert.equal(installedLeaseReady(state, process.pid, identity.session), null);
    rmSync(join(generation, 'released'), { recursive: true, force: true });
    writeFileSync(join(root, 'active.json'), JSON.stringify({ ...identity, token: '../outside' }));
    assert.equal(installedLeaseReady(state, process.pid, identity.session), null);
    const successor = { ...identity, token: '00000000-0000-4000-8000-000000000002' };
    writeFileSync(join(root, 'active.json'), JSON.stringify(successor));
    mkdirSync(join(root, 'generations', successor.token), { mode: 0o700 });
    assert.equal(
      installedLeaseReady(state, process.pid, identity.session),
      null,
      'selected successor with no owner must not appear ready',
    );
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('child close wait observes pipe closure after process exit', async () => {
  const waitForClose = waitForChildClose;
  const registerClose = trackChildClose;
  const source = `
    import { spawn } from 'node:child_process';
    const keeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    process.stdout.write(String(keeper.pid) + '\\n', () => process.exit(0));
  `;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  registerClose(child);
  const exited = once(child, 'exit');
  let output = '';
  const keeperPid = new Promise<number>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.split('\n', 1)[0];
      if (line) resolve(Number(line));
    });
    child.once('error', reject);
  });
  let keeper: number | undefined;
  try {
    const [pid] = await Promise.all([keeperPid, exited.then(() => undefined)]);
    keeper = pid;
    assert.ok(keeper && Number.isSafeInteger(keeper));
    assert.equal(child.exitCode, 0);
    const close = waitForClose(child, 2_000);
    const resolvedBeforePipeClose = await Promise.race([
      close.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    assert.equal(resolvedBeforePipeClose, false, 'exit must not substitute for the close event');
    process.kill(keeper, 'SIGKILL');
    assert.equal(await close, 0);
  } finally {
    if (keeper !== undefined) {
      try {
        process.kill(keeper, 'SIGKILL');
      } catch {
        /* The disposable child may already be gone. */
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
});

test('bounded fake socket teardown destroys only its tracked connections', async () => {
  const closeServer = closeFakeServer;
  const root = mkdtempSync(join(tmpdir(), 'steward-fake-server-'));
  const socketPath = join(root, 'fake.sock');
  const sockets = new Set<Socket>();
  let acceptedResolve!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    acceptedResolve = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    acceptedResolve(socket);
  });
  let client: Socket | undefined;
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    client = connect(socketPath);
    const serverSocket = await Promise.race([
      accepted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fake socket accept watchdog expired')), 1_000),
      ),
    ]);
    assert.equal(
      await closeServer(server, sockets, 25),
      false,
      'a live fake connection must hit the bounded close watchdog',
    );
    assert.equal(server.listening, false);
    assert.equal(serverSocket.destroyed, true);
    assert.equal(sockets.size, 0);
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await closeServer(server, sockets, 1_000);
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake server close failure still removes its disposable root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-fake-server-failure-'));
  const socketPath = join(root, 'fake.sock');
  const sockets = new Set<Socket>();
  let acceptedResolve!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    acceptedResolve = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    acceptedResolve(socket);
  });
  let client: Socket | undefined;
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    client = connect(socketPath);
    await accepted;

    let failure: unknown;
    try {
      await closeFakeServerAndRemoveRoot(server, sockets, root, 25);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error, 'a held socket must preserve the close assertion failure');
    assert.match(failure.message, /fake Herdr server should close/);
    assert.equal(existsSync(root), false, 'failed server close must still remove its disposable root');
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await closeFakeServer(server, sockets, 1_000);
    rmSync(root, { recursive: true, force: true });
  }
});

test('config FIFO writer fails within a bound when no reader opens it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-herdr-fifo-'));
  const fifo = join(root, 'config.fifo');
  const mkfifo = process.env.AGENT_STEWARD_MKFIFO ?? 'mkfifo';
  const fifoResult = spawnSync(mkfifo, [fifo], { encoding: 'utf8' });
  assert.equal(fifoResult.status, 0, fifoResult.stderr);

  const probeSource = `
    import { writeFifoWithDeadline } from ${JSON.stringify(fifoWriterModule)};
    let timedOut = false;
    try {
      await writeFifoWithDeadline(${JSON.stringify(fifo)}, '{}', () => true, 150);
    } catch (error) {
      timedOut = error instanceof Error && error.message === 'timed out waiting for config FIFO reader';
    }
    if (!timedOut) {
      process.exitCode = 2;
    } else {
      try {
        await writeFifoWithDeadline(${JSON.stringify(fifo)}, '{}', () => false, 150);
        process.exitCode = 3;
      } catch (error) {
        process.exitCode = error instanceof Error && error.message === 'adapter exited before config FIFO reader opened' ? 0 : 4;
      }
    }
  `;
  const probe = spawn(process.execPath, ['-e', probeSource], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let probeStderr = '';
  assert.ok(probe.stderr);
  probe.stderr.setEncoding('utf8');
  probe.stderr.on('data', (chunk) => {
    probeStderr += chunk;
  });

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      once(probe, 'close').then(([code]) => ({ timedOut: false as const, code })),
      new Promise<{ timedOut: true }>((resolve) => {
        watchdog = setTimeout(() => resolve({ timedOut: true }), 1_500);
      }),
    ]);
    if (result.timedOut) {
      probe.kill('SIGKILL');
      await once(probe, 'close');
    }
    assert.equal(result.timedOut, false, 'FIFO writer probe must not block beyond its deadline');
    assert.ok(Date.now() - startedAt < 1_000, 'FIFO writer must observe its 150ms deadline');
    assert.equal(result.code, 0, probeStderr);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (probe.exitCode === null && probe.signalCode === null) {
      probe.kill('SIGKILL');
      await once(probe, 'close');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// Catches the plugin depending on checkout-relative paths or a global JS runtime,
// or a package that activates Herdr configuration during installation.
test.skipIf(!pkg)(
  'installed optional plugin uses package-local Bun and fails closed on bounded fake Herdr observation',
  async () => {
    assert.ok(pkg, 'installed check must supply the package path');
    const root = mkdtempSync(join(tmpdir(), 'steward-herdr-installed-'));
    const plugin = join(pkg, 'share/agent-steward/herdr-plugins/agent-steward-recover');
    const runtime = join(pkg, 'lib/agent-steward/bun/bin/bun');
    const entry = join(pkg, 'lib/agent-steward/dist/src/herdr-adapter/entry.js');
    const main = join(pkg, 'lib/agent-steward/dist/src/main.js');
    const state = join(root, 'state');
    const config = join(root, 'config');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const socket = join(root, 'herdr.sock');
    const fifo = join(config, 'agent-steward/config.json');
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(join(config, 'agent-steward'), { recursive: true });
    mkdirSync(home);
    mkdirSync(bin);
    const dirname = process.env.AGENT_STEWARD_DIRNAME;
    const mkfifo = process.env.AGENT_STEWARD_MKFIFO;
    const shell = process.env.AGENT_STEWARD_SH;
    assert.ok(dirname, 'installed check must supply dirname without a global PATH');
    assert.ok(mkfifo, 'installed check must supply mkfifo without a global PATH');
    assert.ok(shell, 'installed check must supply its sandbox-safe shell');
    const { assertInstalledProcess, findInstalledChild, processAlive, executablePath } = await import(
      processObserverModule
    );
    assert.equal(executablePath(process.pid), realpathSync(process.execPath), 'native observer self-probe');
    assert.throws(() => assertInstalledProcess(process.pid, shell, entry), 'wrong executable must fail');
    assert.throws(() => assertInstalledProcess(process.pid, process.execPath, entry), 'wrong entry must fail');
    symlinkSync(dirname, join(bin, 'dirname'));
    writeFileSync(join(config, 'targets.json'), JSON.stringify({ pane_ids: ['w1:p1'] }));
    const fifoResult = spawnSync(mkfifo, [fifo], { encoding: 'utf8' });
    assert.equal(fifoResult.status, 0, fifoResult.stderr);

    const snapshot = {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent: 'codex',
      agent_status: 'blocked',
      agent_session: { agent: 'codex', source: 'integration:codex', kind: 'id', value: 'synthetic-session' },
      state_change_seq: 4,
      revision: 8,
    };
    const methods: { method: string; params: unknown }[] = [];
    let readSeenResolve: (() => void) | undefined;
    const readSeen = new Promise<void>((resolve) => {
      readSeenResolve = resolve;
    });
    const sockets = new Set<Socket>();
    const server = createServer((connection) => {
      sockets.add(connection);
      connection.once('close', () => sockets.delete(connection));
      let data = '';
      connection.on('data', (chunk) => {
        data += chunk.toString('utf8');
        const end = data.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(data.slice(0, end)) as { id: string; method: string; params: unknown };
        methods.push({ method: request.method, params: request.params });
        const result =
          request.method === 'agent.get'
            ? { type: 'agent_info', agent: snapshot }
            : {
                type: 'pane_read',
                read: {
                  pane_id: 'w1:p1',
                  source: 'detection',
                  revision: 0,
                  text: 'Current API failure: request timed out',
                  truncated: false,
                },
              };
        if (request.method === 'agent.read') readSeenResolve?.();
        setTimeout(
          () => connection.end(`${JSON.stringify({ id: request.id, result })}\n`),
          request.method === 'agent.read' ? 250 : 10,
        );
      });
    });
    let scheduler: ReturnType<typeof spawn> | undefined;
    let eventChild: ReturnType<typeof spawn> | undefined;
    let schedulerStderrG = '';
    let schedulerStderrH = '';
    let eventStderr = '';
    try {
      server.listen(socket);
      await once(server, 'listening');
      const manifest = readFileSync(join(plugin, 'herdr-plugin.toml'), 'utf8');
      assert.ok(manifest.includes('min_herdr_version = "0.9.1"'));
      assert.ok(manifest.includes('[[events]]'));
      assert.ok(existsSync(join(plugin, 'run.sh')));
      const adapterLink = join(plugin, 'agent-steward-herdr-adapter');
      assert.ok(lstatSync(adapterLink).isSymbolicLink());
      assert.equal(readlinkSync(adapterLink), '../../../../bin/agent-steward-herdr-adapter');
      assert.ok(existsSync(join(pkg, 'share/agent-steward/herdr-plugins/agent-steward-launcher/herdr-plugin.toml')));
      assert.ok(existsSync(join(pkg, 'share/agent-steward/herdr-plugins/agent-steward-launcher/dispatch.sh')));
      assert.equal(realpathSync(adapterLink), realpathSync(join(pkg, 'bin/agent-steward-herdr-adapter')));
      assert.ok(existsSync(entry));
      assert.ok(existsSync(main));

      const checkNoGlobalRuntime = (command: string): void => {
        const result = spawnSync(command, ['--version'], { env: { PATH: bin }, encoding: 'utf8' });
        assert.equal(
          (result.error as NodeJS.ErrnoException | undefined)?.code,
          'ENOENT',
          `${command} must not be on plugin PATH`,
        );
      };
      for (const command of ['node', 'bun', 'npm']) checkNoGlobalRuntime(command);

      const baseEnv = {
        PATH: bin,
        HOME: home,
        XDG_CONFIG_HOME: config,
        HERDR_SOCKET_PATH: socket,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_STATE_DIR: state,
      };
      scheduler = spawn(shell, [join(plugin, 'run.sh'), 'scheduler'], {
        cwd: root,
        env: baseEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(scheduler);
      assert.ok(scheduler.stderr);
      scheduler.stderr.setEncoding('utf8');
      scheduler.stderr.on('data', (chunk) => {
        schedulerStderrG += chunk;
      });
      const socketInfo = statSync(socket);
      const session = `${socketInfo.dev}:${socketInfo.ino}`;
      const waitForReady = async (
        child: ReturnType<typeof spawn>,
        diagnostics: () => string,
      ): Promise<{ token: string }> => {
        for (let attempt = 0; attempt < 120; attempt++) {
          if (child.pid === undefined) throw new Error('packaged supervisor did not receive a PID');
          const ready = installedLeaseReady(state, child.pid, session);
          if (ready) return ready;
          if (child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`packaged supervisor must start with its own live generation: ${diagnostics()}`);
      };
      const generationG = await waitForReady(scheduler, () => schedulerStderrG);
      if (scheduler.pid === undefined) throw new Error('packaged supervisor did not receive a PID');
      const schedulerPidG = scheduler.pid;
      assertInstalledProcess(schedulerPidG, runtime, entry);

      eventChild = spawn(shell, [join(plugin, 'run.sh'), 'event'], {
        cwd: root,
        env: {
          ...baseEnv,
          HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
            type: 'pane_agent_status_changed',
            pane_id: 'w1:p1',
            workspace_id: 'w1',
            agent_status: 'blocked',
            agent: 'codex',
          }),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(eventChild);
      assert.ok(eventChild.stderr);
      eventChild.stderr.setEncoding('utf8');
      eventChild.stderr.on('data', (chunk) => {
        eventStderr += chunk;
      });
      await Promise.race([
        readSeen,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('bounded observation did not reach Herdr')), 3_000),
        ),
      ]);
      assertInstalledProcess(eventChild.pid!, runtime, entry);
      const observed = methods.find(({ method }) => method === 'agent.read');
      assert.deepEqual(observed, {
        method: 'agent.read',
        params: { target: 'w1:p1', source: 'detection', lines: 12, format: 'text' },
      });

      let childPid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        childPid = findInstalledChild(eventChild.pid!, runtime, main);
        if (childPid) break;
        if (eventChild.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(childPid, `adapter must execute packaged main.js via process.execPath: ${eventStderr}`);
      const readerIsAlive = (): boolean => processAlive(childPid!);
      assert.ok(readerIsAlive(), 'packaged main.js must remain alive while the config FIFO reader starts');
      assertInstalledProcess(childPid, runtime, main);

      const { writeFifoWithDeadline } = await import(fifoWriterModule);
      await writeFifoWithDeadline(fifo, JSON.stringify({ tools: [], candidates: [] }), readerIsAlive);
      const eventCode = await waitForChildClose(eventChild, 3_000);
      assert.equal(eventCode, 0, eventStderr);
      assert.match(eventStderr, /human_review_required \(decision_failed\)/);
      assert.equal(eventStderr.includes('synthetic-session'), false);
      assert.equal(eventStderr.includes('Current API failure'), false);
      assert.ok(methods.some(({ method }) => method === 'agent.get'));
      assert.ok(methods.every(({ method }) => method === 'agent.get' || method === 'agent.read'));
      assert.equal(existsSync(join(config, 'herdr')), false, 'package must not enable/link plugins');
      assert.equal(existsSync(join(home, '.config/herdr')), false, 'package must not edit Herdr user config');

      const selector = join(state, 'scheduler-lease/active.json');
      const generationPath = (token: string): string => join(state, 'scheduler-lease/generations', token);
      const schedulerCodeG = await waitForChildClose(scheduler, 3_000, 'SIGTERM');
      assert.equal(schedulerCodeG, 0, schedulerStderrG);
      const generationGPath = generationPath(generationG.token);
      const markerG = join(generationGPath, 'released');
      assert.equal(lstatSync(markerG).isDirectory(), true);
      assert.equal(lstatSync(markerG).mode & 0o777, 0o700);
      assert.equal(JSON.parse(readFileSync(selector, 'utf8')).token, generationG.token);
      assert.equal(schedulerStderrG.includes('release unconfirmed'), false, schedulerStderrG);
      assert.equal(
        installedLeaseReady(state, schedulerPidG, session),
        null,
        'retained selector with a release marker must not be ready',
      );

      scheduler = spawn(shell, [join(plugin, 'run.sh'), 'scheduler'], {
        cwd: root,
        env: baseEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(scheduler);
      assert.ok(scheduler.stderr);
      scheduler.stderr.setEncoding('utf8');
      scheduler.stderr.on('data', (chunk) => {
        schedulerStderrH += chunk;
      });
      const generationH = await waitForReady(scheduler, () => schedulerStderrH);
      if (scheduler.pid === undefined) throw new Error('restarted supervisor did not receive a PID');
      const schedulerPidH = scheduler.pid;
      assert.notEqual(generationH.token, generationG.token);
      assertInstalledProcess(schedulerPidH, runtime, entry);
      assert.equal(installedLeaseReady(state, schedulerPidH, session)?.token, generationH.token);
      assert.equal(lstatSync(markerG).isDirectory(), true);
      const generationHPath = generationPath(generationH.token);
      const ownerH = JSON.parse(readFileSync(join(generationHPath, 'owner.json'), 'utf8'));
      const heartbeatH = JSON.parse(readFileSync(join(generationHPath, 'heartbeat.json'), 'utf8'));
      assert.deepEqual(ownerH, { protocol: 2, token: generationH.token, pid: schedulerPidH, session });
      assert.equal(heartbeatH.protocol, 2);
      assert.equal(heartbeatH.token, generationH.token);
      assert.equal(typeof heartbeatH.heartbeat, 'number');
      assert.ok(heartbeatH.heartbeat + 15_000 > Date.now());
      const schedulerCodeH = await waitForChildClose(scheduler, 3_000, 'SIGTERM');
      assert.equal(schedulerCodeH, 0, schedulerStderrH);
      const markerH = join(generationHPath, 'released');
      assert.equal(lstatSync(markerH).isDirectory(), true);
      assert.equal(JSON.parse(readFileSync(selector, 'utf8')).token, generationH.token);
      assert.equal(schedulerStderrH.includes('release unconfirmed'), false, schedulerStderrH);
    } finally {
      if (eventChild) {
        try {
          await waitForChildClose(eventChild, 1_000, 'SIGTERM');
        } catch {
          /* The disposable child and its stdio are force-closed by the watchdog. */
        }
      }
      if (scheduler) {
        try {
          await waitForChildClose(scheduler, 1_000, 'SIGTERM');
        } catch {
          /* The disposable child and its stdio are force-closed by the watchdog. */
        }
      }
      await closeFakeServerAndRemoveRoot(server, sockets, root, 1_000);
    }
  },
  15000,
);
