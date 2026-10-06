import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import {
  chmodSync,
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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function installedLeaseReady(
  leaseRoot: string,
  expectedPid: number,
  expectedSession: string,
): { token: string } | null {
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
    const root = leaseRoot;
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
    assert.deepEqual(installedLeaseReady(root, process.pid, identity.session), { token });
    assert.equal(installedLeaseReady(root, process.pid, 'other-session'), null);
    assert.equal(installedLeaseReady(root, process.pid + 1, identity.session), null);
    writeFileSync(join(generation, 'heartbeat.json'), JSON.stringify({ ...heartbeat, heartbeat: 1 }));
    assert.equal(installedLeaseReady(root, process.pid, identity.session), null);
    writeFileSync(join(generation, 'heartbeat.json'), JSON.stringify(heartbeat));
    mkdirSync(join(generation, 'released'), { mode: 0o700 });
    assert.equal(installedLeaseReady(root, process.pid, identity.session), null);
    rmSync(join(generation, 'released'), { recursive: true, force: true });
    writeFileSync(join(root, 'active.json'), JSON.stringify({ ...identity, token: '../outside' }));
    assert.equal(installedLeaseReady(root, process.pid, identity.session), null);
    const successor = { ...identity, token: '00000000-0000-4000-8000-000000000002' };
    writeFileSync(join(root, 'active.json'), JSON.stringify(successor));
    mkdirSync(join(root, 'generations', successor.token), { mode: 0o700 });
    assert.equal(
      installedLeaseReady(root, process.pid, identity.session),
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
  'installed optional plugin uses package-local Bun and event-owned scoped leases on bounded fake Herdr',
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
      agent: 'agy',
      agent_status: 'idle',
      agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 'synthetic-session' },
      state_change_seq: 4,
      revision: 8,
    };
    const detectionText = 'model-one quota exhausted';
    const pluginRoot = realpathSync(plugin);
    const pluginManifest = realpathSync(join(plugin, 'herdr-plugin.toml'));
    let pluginEnabled = true;
    const methods: { method: string; params: unknown }[] = [];
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
          request.method === 'plugin.list'
            ? {
                type: 'plugin_list',
                plugins: [
                  {
                    plugin_id: 'agent-steward-recover',
                    name: 'Agent Steward recover',
                    version: '0.1.0',
                    plugin_root: pluginRoot,
                    manifest_path: pluginManifest,
                    enabled: pluginEnabled,
                  },
                ],
              }
            : request.method === 'agent.get'
              ? { type: 'agent_info', agent: snapshot }
              : {
                  type: 'pane_read',
                  read: {
                    pane_id: 'w1:p1',
                    source: 'detection',
                    revision: 8,
                    text: detectionText,
                    truncated: false,
                  },
                };
        setTimeout(
          () => connection.end(`${JSON.stringify({ id: request.id, result })}\n`),
          request.method === 'agent.read' ? 250 : 10,
        );
      });
    });
    let eventChild: ReturnType<typeof spawn> | undefined;
    let duplicateChild: ReturnType<typeof spawn> | undefined;
    let pauseChild: ReturnType<typeof spawn> | undefined;
    let finishChild: ReturnType<typeof spawn> | undefined;
    let incompleteChild: ReturnType<typeof spawn> | undefined;
    let incompletePause: ReturnType<typeof spawn> | undefined;
    let eventStderr = '';
    try {
      server.listen(socket);
      await once(server, 'listening');
      const manifest = readFileSync(join(plugin, 'herdr-plugin.toml'), 'utf8');
      assert.ok(manifest.includes('min_herdr_version = "0.9.1"'));
      assert.ok(manifest.includes('[[events]]'));
      assert.ok(manifest.includes('id = "pause"'));
      assert.ok(manifest.includes('id = "resume"'));
      assert.equal(manifest.includes('[[panes]]'), false);
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

      const refused = spawnSync(shell, [join(plugin, 'run.sh'), 'scheduler'], {
        cwd: root,
        env: { PATH: bin },
        encoding: 'utf8',
      });
      assert.equal(refused.status, 2);

      const socketInfo = statSync(socket);
      const serverId = `${socketInfo.dev}:${socketInfo.ino}`;
      const workflowSession = JSON.stringify([serverId, 'agy', 'synthetic-session']);
      const leaseRoot = join(
        state,
        'workflows',
        createHash('sha256').update(workflowSession).digest('hex'),
        'scheduler-lease',
      );
      const installed = (name: string) =>
        pathToFileURL(join(pkg, 'lib/agent-steward/dist/src/herdr-adapter', `${name}.js`)).href;
      const { EpisodeStore } = (await import(installed('state'))) as typeof import('../src/herdr-adapter/state.ts');
      const { observeStop } = (await import(installed('observe'))) as typeof import('../src/herdr-adapter/observe.ts');
      const store = new EpisodeStore(state);
      const observed = await observeStop(
        {
          get: async () => snapshot,
          read: async () => ({
            pane_id: 'w1:p1',
            source: 'detection',
            revision: 8,
            text: detectionText,
            truncated: false,
          }),
        },
        'w1:p1',
      );
      assert.ok(observed);
      const firstObserved = new Date(Date.now() - 60_000).toISOString();
      const pending = {
        pane_id: observed.pane_id,
        session_id: observed.session_id,
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: firstObserved,
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
        next_check_at: '2099-01-01T00:00:00.000Z',
        last_delivery_state: 'none' as const,
      };
      await store.recordSessionRetry('agy', 'synthetic-session', pending);
      assert.deepEqual(await store.sessionRetry('agy', 'synthetic-session'), pending);

      const baseEnv = {
        PATH: bin,
        HOME: home,
        XDG_CONFIG_HOME: config,
        HERDR_SOCKET_PATH: socket,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_PLUGIN_ID: 'agent-steward-recover',
        HERDR_PLUGIN_ROOT: plugin,
        HERDR_ENV: '1',
      };
      const eventJson = JSON.stringify({
        type: 'pane_agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent_status: 'idle',
        agent: 'agy',
      });
      eventChild = spawn(shell, [join(plugin, 'run.sh'), 'event'], {
        cwd: root,
        env: { ...baseEnv, HERDR_PLUGIN_EVENT_JSON: eventJson },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(eventChild);
      assert.ok(eventChild.stderr);
      eventChild.stderr.setEncoding('utf8');
      eventChild.stderr.on('data', (chunk) => {
        eventStderr += chunk;
      });
      const waitForReady = async (
        child: ReturnType<typeof spawn>,
        diagnostics: () => string,
      ): Promise<{ token: string }> => {
        for (let attempt = 0; attempt < 160; attempt++) {
          if (child.pid === undefined) throw new Error('packaged event did not receive a PID');
          const ready = installedLeaseReady(leaseRoot, child.pid, workflowSession);
          if (ready && !existsSync(join(leaseRoot, 'takeover-guard'))) return ready;
          if (child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`packaged event must own a scoped generation: ${diagnostics()}`);
      };
      const generationG = await waitForReady(eventChild, () => eventStderr);
      if (eventChild.pid === undefined) throw new Error('packaged event did not receive a PID');
      const eventPid = eventChild.pid;
      assertInstalledProcess(eventPid, runtime, entry);
      const serverHash = createHash('sha256')
        .update(JSON.stringify([serverId]))
        .digest('hex');
      let slotReady = false;
      for (let attempt = 0; attempt < 160 && !slotReady; attempt++) {
        for (let index = 0; index < 8; index++) {
          const slotRoot = join(state, 'automation', serverHash, 'capacity', String(index), 'scheduler-lease');
          if (
            installedLeaseReady(
              slotRoot,
              eventPid,
              JSON.stringify([createHash('sha256').update(workflowSession).digest('hex'), generationG.token]),
            )
          ) {
            slotReady = true;
            break;
          }
        }
        if (!slotReady) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(slotReady, true, `pending event must own a capacity slot: ${eventStderr}`);

      duplicateChild = spawn(shell, [join(plugin, 'run.sh'), 'event'], {
        cwd: root,
        env: { ...baseEnv, HERDR_PLUGIN_EVENT_JSON: eventJson },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(duplicateChild);
      const duplicateCode = await waitForChildClose(duplicateChild, 5_000);
      assert.equal(duplicateCode, 0);
      assert.equal(installedLeaseReady(leaseRoot, eventPid, workflowSession)?.token, generationG.token);

      pauseChild = spawn(shell, [join(plugin, 'run.sh'), 'pause'], {
        cwd: root,
        env: baseEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(pauseChild);
      assert.equal(await waitForChildClose(pauseChild, 6_000), 0);
      const ownerCode = await waitForChildClose(eventChild, 6_000);
      assert.equal(ownerCode, 0, eventStderr);
      assert.equal(
        installedLeaseReady(leaseRoot, eventPid, workflowSession),
        null,
        'pause must revoke the event-owned generation',
      );
      const denied = spawn(shell, [join(plugin, 'run.sh'), 'event'], {
        cwd: root,
        env: { ...baseEnv, HERDR_PLUGIN_EVENT_JSON: eventJson },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(denied);
      assert.equal(await waitForChildClose(denied, 5_000), 0);
      assert.equal(installedLeaseReady(leaseRoot, denied.pid ?? -1, workflowSession), null);

      const resume = spawn(shell, [join(plugin, 'run.sh'), 'resume'], {
        cwd: root,
        env: baseEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(resume);
      assert.equal(await waitForChildClose(resume, 5_000), 0);
      const sessionHash = createHash('sha256')
        .update(JSON.stringify(['agy', 'synthetic-session']))
        .digest('hex');
      // Ordinary finish must be unbound: a retained canonical reference quarantines without spawning CLI.
      rmSync(join(state, `retry-session-${sessionHash}.json`), { force: true });
      rmSync(join(state, `retry-session-${sessionHash}.binding.json`), { force: true });
      finishChild = spawn(shell, [join(plugin, 'run.sh'), 'event'], {
        cwd: root,
        env: { ...baseEnv, HERDR_PLUGIN_EVENT_JSON: eventJson },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(finishChild);
      let finishStderr = '';
      assert.ok(finishChild.stderr);
      finishChild.stderr.setEncoding('utf8');
      finishChild.stderr.on('data', (chunk) => {
        finishStderr += chunk;
      });
      const { writeFifoWithDeadline } = await import(fifoWriterModule);
      let childPid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (finishChild.pid !== undefined) childPid = findInstalledChild(finishChild.pid, runtime, main);
        if (childPid) break;
        if (finishChild.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(childPid, `packaged finish event must spawn package-local main.js: ${finishStderr}`);
      assertInstalledProcess(childPid, runtime, main);
      await writeFifoWithDeadline(fifo, JSON.stringify({ tools: [], candidates: [] }), () => processAlive(childPid));
      const finishCode = await waitForChildClose(finishChild, 8_000);
      assert.equal(finishCode, 0, finishStderr);
      assert.equal(finishStderr.includes('synthetic-session'), false);
      await store.recordSessionRetry('agy', 'synthetic-session', pending);
      incompleteChild = spawn(shell, [join(plugin, 'run.sh'), 'event'], {
        cwd: root,
        env: { ...baseEnv, HERDR_PLUGIN_EVENT_JSON: eventJson },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(incompleteChild);
      let incompleteStderr = '';
      assert.ok(incompleteChild.stderr);
      incompleteChild.stderr.setEncoding('utf8');
      incompleteChild.stderr.on('data', (chunk) => {
        incompleteStderr += chunk;
      });
      const incompleteGeneration = await waitForReady(incompleteChild, () => incompleteStderr);
      const generationDir = join(leaseRoot, 'generations', incompleteGeneration.token);
      chmodSync(generationDir, 0);
      incompleteChild.kill('SIGINT');
      const incompleteCode = await waitForChildClose(incompleteChild, 8_000);
      try {
        chmodSync(generationDir, 0o700);
      } catch {
        /* The generation directory may already be gone. */
      }
      assert.equal(incompleteCode, 1, incompleteStderr);
      assert.equal(
        incompleteStderr.includes('agent-steward: release unconfirmed; shutdown incomplete. Human review required.'),
        true,
        incompleteStderr,
      );
      const controlDir = join(state, 'automation', serverHash);
      const controlGuard = join(controlDir, 'control-guard');
      // Exclusive publication occupancy is unconfirmed pause; chmod of 0700/0600 paths is denied, not incomplete.
      writeFileSync(controlGuard, '', { mode: 0o600 });
      incompletePause = spawn(shell, [join(plugin, 'run.sh'), 'pause'], {
        cwd: root,
        env: baseEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      trackChildClose(incompletePause);
      let pauseStderr = '';
      assert.ok(incompletePause.stderr);
      incompletePause.stderr.setEncoding('utf8');
      incompletePause.stderr.on('data', (chunk) => {
        pauseStderr += chunk;
      });
      const incompletePauseCode = await waitForChildClose(incompletePause, 8_000);
      try {
        rmSync(controlGuard, { force: true });
      } catch {
        /* restored below if still present */
      }
      assert.equal(incompletePauseCode, 1, pauseStderr);
      assert.equal(
        pauseStderr.includes('agent-steward: release unconfirmed; shutdown incomplete. Human review required.'),
        true,
        pauseStderr,
      );
      // Exercise the actual packaged run.sh/wrapper, with no evaluator credentials
      // or global runtime. A refused metadata control is not a successful pause.
      for (const refusal of ['corrupt', 'unsafe', 'missing', 'disabled'] as const) {
        const refusedRoot = join(root, `control-${refusal}`);
        const refusedControl = join(refusedRoot, 'automation', serverHash, 'control.json');
        mkdirSync(join(refusedRoot, 'automation', serverHash), { recursive: true, mode: 0o700 });
        writeFileSync(
          refusedControl,
          refusal === 'corrupt' ? '{bad-json' : readFileSync(join(controlDir, 'control.json')),
          { mode: 0o600 },
        );
        const before = readFileSync(refusedControl, 'utf8');
        if (refusal === 'unsafe') chmodSync(refusedRoot, 0o777);
        pluginEnabled = refusal !== 'disabled';
        const controlEnv: NodeJS.ProcessEnv = { ...baseEnv, HERDR_PLUGIN_STATE_DIR: refusedRoot };
        if (refusal === 'missing') delete controlEnv.HERDR_PLUGIN_ROOT;
        const refusedControlChild: ReturnType<typeof spawn> = spawn(
          shell,
          [join(plugin, 'run.sh'), refusal === 'disabled' ? 'resume' : 'pause'],
          {
            cwd: root,
            env: controlEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        trackChildClose(refusedControlChild);
        let stdout = '',
          stderr = '';
        refusedControlChild.stdout!.on('data', (chunk) => {
          stdout += chunk;
        });
        refusedControlChild.stderr!.on('data', (chunk) => {
          stderr += chunk;
        });
        try {
          assert.equal(await waitForChildClose(refusedControlChild, 5_000), 1, stderr);
          assert.equal(stdout, '');
          assert.equal(stderr, 'agent-steward: control denied; no change confirmed. Human review required.\n');
          assert.equal(readFileSync(refusedControl, 'utf8'), before);
        } finally {
          pluginEnabled = true;
          chmodSync(refusedRoot, 0o700);
          await waitForChildClose(refusedControlChild, 1_000, 'SIGTERM');
        }
      }
      assert.ok(methods.some(({ method }) => method === 'plugin.list'));
      assert.ok(methods.some(({ method }) => method === 'agent.get'));
      assert.ok(
        methods.every(({ method }) => method === 'agent.get' || method === 'agent.read' || method === 'plugin.list'),
      );
      assert.equal(existsSync(join(config, 'herdr')), false, 'package must not enable/link plugins');
      assert.equal(existsSync(join(home, '.config/herdr')), false, 'package must not edit Herdr user config');
    } finally {
      for (const child of [eventChild, duplicateChild, pauseChild, finishChild, incompleteChild, incompletePause]) {
        if (!child) continue;
        try {
          await waitForChildClose(child, 1_000, 'SIGTERM');
        } catch {
          /* The disposable child and its stdio are force-closed by the watchdog. */
        }
      }
      await closeFakeServerAndRemoveRoot(server, sockets, root, 1_000);
    }
  },
  35_000,
);
