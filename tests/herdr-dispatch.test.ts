import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { deferred, leaseFixture, within } from './herdr-lease-helpers.ts';
import type { AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { SchedulerLeaseStore } from '../src/herdr-adapter/lease.ts';
import { workflowSession, WorkflowState, type WorkflowScope } from '../src/herdr-adapter/workflow-state.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';

const incomplete = 'agent-steward: release unconfirmed; shutdown incomplete. Human review required.\n';
const migration =
  'agent-steward: legacy supervisor state is live or unverifiable. Disable the plugin, stop all adapters and verify they are dead before offline cleanup of a stranded guard or legacy lease. Preserve episode records and generation tombstones.\n';

const snapshot = (overrides: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  agent_status: 'idle',
  agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 's1' },
  revision: 8,
  state_change_seq: 4,
  ...overrides,
});

function quotaDecision(input: StopInput, notBefore = '2099-01-01T00:00:00.000Z'): StopResult {
  return {
    schema_version: 2,
    request_id: input.request_id,
    decision: 'stop_decision',
    proposed_action: { kind: 'wait_for_quota', not_before: notBefore },
    reason_code: 'quota_limit',
    waiting_for: 'quota_limit',
    waiting_confidence: 1,
    risk_probability: 0.1,
    evaluation: {
      model: 'jev-1.13.0',
      usage: {},
      answers: {
        waiting_for: {
          type: 'choice',
          choice: 'quota_limit',
          probabilities: {
            approve_command: 0,
            approve_edit: 0,
            answer_question: 0,
            credentials: 0,
            recoverable_api_error: 0,
            quota_limit: 1,
            permanent_error: 0,
            completed: 0,
            other: 0,
          },
          confidence: 1,
        },
        risky: { type: 'noul', noul: 0.1 },
      },
    },
  };
}

function pluginEntry(root: string, enabled: boolean, extras: Record<string, unknown> = {}) {
  return {
    plugin_id: 'agent-steward-recover',
    name: 'Agent Steward recover',
    version: '0.1.0',
    manifest_path: join(root, 'herdr-plugin.toml'),
    plugin_root: root,
    enabled,
    ...extras,
  };
}

async function until(check: () => Promise<boolean> | boolean, ms = 2_000): Promise<void> {
  await within(
    (async () => {
      while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 15));
    })(),
    ms,
  );
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (server.listening)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function pluginWorld(
  options: {
    enabled?: boolean;
    config?: unknown | 'absent';
    plugins?: unknown;
    snapshot?: AgentSnapshot | null;
    text?: string;
    hold?: 'total' | 'stream' | 'none';
    holdMethod?: string;
    holdWhen?: (method: string) => boolean;
    getThrow?: boolean;
    reply?: (request: { id: string; method: string; params: unknown }) => unknown | 'hold';
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'steward-dispatch-'));
  const plugin = join(root, 'plugin');
  const config = join(root, 'config');
  const state = join(root, 'state');
  await mkdir(plugin);
  await mkdir(config);
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n');
  if (options.config !== 'absent' && options.config !== undefined)
    await writeFile(join(config, 'targets.json'), JSON.stringify(options.config));
  else if (options.config === undefined)
    await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: [] }));
  const socketPath = join(root, 'herdr.sock');
  const methods: { method: string; params: unknown }[] = [];
  const sockets = new Set<Socket>();
  const extras: Array<{ server: Server; sockets: Set<Socket> }> = [];
  let pane = options.snapshot === undefined ? snapshot() : options.snapshot;
  const text = options.text ?? 'model-one quota exhausted';
  const held = deferred<void>();
  const holdRelease = deferred<void>();
  const attach = (connection: Socket) => {
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    if (options.hold === 'total') return;
    if (options.hold === 'stream') {
      const timer = setInterval(() => connection.write(' '), 400);
      connection.once('close', () => clearInterval(timer));
      return;
    }
    let data = '';
    connection.on('data', (chunk) => {
      void (async () => {
        data += chunk.toString('utf8');
        const end = data.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(data.slice(0, end)) as { id: string; method: string; params: unknown };
        methods.push({ method: request.method, params: request.params });
        if (options.getThrow && request.method === 'agent.get') {
          connection.destroy();
          return;
        }
        if ((options.holdMethod && request.method === options.holdMethod) || options.holdWhen?.(request.method)) {
          held.resolve();
          await holdRelease.promise;
        }
        const custom = options.reply?.(request);
        if (custom === 'hold') return;
        const result =
          custom ??
          (request.method === 'plugin.list'
            ? {
                type: 'plugin_list',
                plugins: options.plugins ?? [
                  pluginEntry(plugin, options.enabled !== false, { source: { kind: 'local' } }),
                ],
              }
            : request.method === 'agent.get'
              ? { type: 'agent_info', agent: pane }
              : request.method === 'agent.list'
                ? { type: 'agent_list', agents: pane ? [pane] : [] }
                : {
                    type: 'pane_read',
                    read: {
                      pane_id: 'w1:p1',
                      source: 'detection',
                      revision: 8,
                      text,
                      truncated: false,
                    },
                  });
        connection.end(`${JSON.stringify({ id: request.id, result })}\n`);
      })();
    });
  };
  const server = createServer(attach);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const info = await stat(socketPath);
  let serverId = `${info.dev}:${info.ino}`;
  const env: NodeJS.ProcessEnv = {
    HERDR_ENV: '1',
    HERDR_PLUGIN_ID: 'agent-steward-recover',
    HERDR_PLUGIN_ROOT: plugin,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_SOCKET_PATH: socketPath,
  };
  return {
    root,
    plugin,
    config,
    state,
    socketPath,
    get serverId() {
      return serverId;
    },
    methods,
    env,
    held,
    setSnapshot(next: AgentSnapshot | null) {
      pane = next;
    },
    releaseHold() {
      holdRelease.resolve();
    },
    async replaceSocket() {
      await unlink(socketPath);
      const extraSockets = new Set<Socket>();
      const extra = createServer((connection) => {
        extraSockets.add(connection);
        connection.once('close', () => extraSockets.delete(connection));
        attach(connection);
      });
      await new Promise<void>((resolve) => extra.listen(socketPath, resolve));
      extras.push({ server: extra, sockets: extraSockets });
      const next = await stat(socketPath);
      serverId = `${next.dev}:${next.ino}`;
      return serverId;
    },
    async close() {
      holdRelease.resolve();
      await closeServer(server, sockets);
      for (const extra of extras) await closeServer(extra.server, extra.sockets);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function seedBoundEpisode(
  directory: string,
  serverId: string,
  overrides: { sessionId?: string; paneId?: string; delivery?: Episode['last_delivery_state'] } = {},
) {
  const sessionId = overrides.sessionId ?? 's1';
  const paneId = overrides.paneId ?? 'w1:p1';
  const state = new WorkflowState(directory);
  const scope: WorkflowScope = {
    serverId,
    agent: 'agy',
    sessionId,
    sessionKind: 'id',
    sessionSource: 'herdr:antigravity_cli',
  };
  const ticket = await state.capture(serverId, true);
  assert.ok(ticket);
  const token = await state.lease(scope).acquire(workflowSession(scope));
  assert.ok(token);
  const episode: Episode = {
    pane_id: paneId,
    session_id: sessionId,
    failure_episode_id: 'a'.repeat(64),
    error_evidence_digest: 'b'.repeat(64),
    first_observed_at: '2026-10-05T00:00:00Z',
    attempt_count: 0,
    last_attempt_at: null,
    quota_check_count: 0,
    last_quota_check_at: null,
    next_check_at: overrides.delivery && overrides.delivery !== 'none' ? null : '2099-01-01T00:00:00Z',
    last_delivery_state: overrides.delivery ?? 'none',
  };
  await new EpisodeStore(directory).recordSessionRetry(scope.agent, scope.sessionId, episode);
  await state.recordBinding({
    protocol: 1,
    scope,
    epoch: ticket.epoch,
    generation: token,
    paneId,
    workspaceId: paneId.split(':')[0]!,
    historyPaneId: paneId,
    failureEpisodeId: episode.failure_episode_id,
    phase: episode.last_delivery_state === 'none' ? 'pending' : 'observing',
    reason: null,
  });
  return { state, scope, ticket, token, episode };
}

test('Herdr socket request fails closed after a 2-second held connection', async () => {
  const world = await pluginWorld({ hold: 'total' });
  try {
    const { socketReader, readPluginContext } = await import('../src/herdr-adapter/entry.ts');
    const started = Date.now();
    await assert.rejects(within(socketReader(world.socketPath).get('w1:p1'), 4_000), /Herdr read timeout/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_000 && elapsed < 2_800, `held elapsed ${elapsed}`);
    const listed = Date.now();
    assert.equal(await within(readPluginContext(world.env), 4_000), null);
    assert.ok(Date.now() - listed >= 2_000 && Date.now() - listed < 2_800);
  } finally {
    await world.close();
  }
});

test('Herdr socket request fails closed when a stream is held past two seconds', async () => {
  const world = await pluginWorld({ hold: 'stream' });
  try {
    const { socketReader } = await import('../src/herdr-adapter/entry.ts');
    const started = Date.now();
    await assert.rejects(within(socketReader(world.socketPath).get('w1:p1'), 4_000), /Herdr read timeout/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_000 && elapsed < 2_800, `stream elapsed ${elapsed}`);
  } finally {
    await world.close();
  }
});

test('Herdr socket request rejects a response larger than 64 KiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-oversize-'));
  const socketPath = join(root, 'herdr.sock');
  const sockets = new Set<Socket>();
  const server = createServer((connection) => {
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    let data = '';
    connection.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.slice(0, data.indexOf('\n'))) as { id: string };
      connection.end(
        `${JSON.stringify({ id: request.id, result: { type: 'agent_info', agent: snapshot(), pad: 'x'.repeat(70_000) } })}\n`,
      );
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const { socketReader } = await import('../src/herdr-adapter/entry.ts');
    await assert.rejects(socketReader(socketPath).get('w1:p1'), /Herdr response too large/);
  } finally {
    await closeServer(server, sockets);
    await rm(root, { recursive: true, force: true });
  }
});

test('readPluginContext requires a live recover registry match and socket identity', async () => {
  const world = await pluginWorld({ enabled: true });
  try {
    const { readPluginContext } = await import('../src/herdr-adapter/entry.ts');
    assert.deepEqual(await readPluginContext(world.env), { serverId: world.serverId, enabled: true });
    assert.deepEqual(world.methods[0], {
      method: 'plugin.list',
      params: { plugin_id: 'agent-steward-recover' },
    });
    assert.equal(await readPluginContext({ ...world.env, HERDR_PLUGIN_ID: 'agent-steward-launcher' }), null);
    assert.equal(await readPluginContext({ ...world.env, HERDR_PLUGIN_ROOT: join(world.root, 'missing') }), null);
  } finally {
    await world.close();
  }
});

test('readPluginContext denies mismatched roots, non-boolean enablement and duplicate recover entries', async () => {
  const duplicate = await pluginWorld();
  const other = await pluginWorld({
    plugins: [
      {
        plugin_id: 'agent-steward-recover',
        plugin_root: '/tmp/other',
        manifest_path: '/tmp/other/herdr-plugin.toml',
        enabled: true,
        name: 'x',
        version: '1',
      },
    ],
  });
  const flagged = await pluginWorld({
    plugins: [pluginEntry(duplicate.plugin, true, { enabled: 'yes' })],
  });
  try {
    const { readPluginContext } = await import('../src/herdr-adapter/entry.ts');
    duplicate.methods.length = 0;
    const doubled = await pluginWorld({
      reply: (request) => {
        if (request.method !== 'plugin.list') return undefined;
        return {
          type: 'plugin_list',
          plugins: [pluginEntry(duplicate.plugin, true), pluginEntry(duplicate.plugin, true, { name: 'dup' })],
        };
      },
    });
    try {
      assert.equal(await readPluginContext(doubled.env), null);
    } finally {
      await doubled.close();
    }
    assert.equal(await readPluginContext(other.env), null);
    assert.equal(await readPluginContext(flagged.env), null);
  } finally {
    await duplicate.close();
    await other.close();
    await flagged.close();
  }
});

test('readRuntimePermission requires enablement and does not widen malformed targets', async () => {
  const disabled = await pluginWorld({ enabled: false });
  const absent = await pluginWorld({ enabled: true, config: 'absent' });
  const malformed = await pluginWorld({ enabled: true, config: { pane_ids: ['w1:p1', 2] } });
  const listed = await pluginWorld({ enabled: true, config: { pane_ids: ['w1:p1'], auto_approve: true } });
  const linked = await pluginWorld({ enabled: true, config: 'absent' });
  const target = join(linked.root, 'store-targets.json');
  await writeFile(target, JSON.stringify({ pane_ids: ['w2:p2'], auto_approve: 1 }));
  await symlink(target, join(linked.config, 'targets.json'));
  try {
    const { readRuntimePermission } = await import('../src/herdr-adapter/entry.ts');
    assert.equal(await readRuntimePermission(disabled.env), null);
    assert.deepEqual(await readRuntimePermission(absent.env), {
      serverId: absent.serverId,
      enabled: true,
      targets: 'all',
      autoApprove: false,
    });
    assert.equal(await readRuntimePermission(malformed.env), null);
    assert.deepEqual(await readRuntimePermission(listed.env), {
      serverId: listed.serverId,
      enabled: true,
      targets: ['w1:p1'],
      autoApprove: true,
    });
    assert.deepEqual(await readRuntimePermission(linked.env), {
      serverId: linked.serverId,
      enabled: true,
      targets: ['w2:p2'],
      autoApprove: false,
    });
    assert.equal((await lstat(join(linked.config, 'targets.json'))).isSymbolicLink(), true);
  } finally {
    await disabled.close();
    await absent.close();
    await malformed.close();
    await listed.close();
    await linked.close();
  }
});

test('runControl pause does not need targets or evaluator credentials and resume requires enablement', async () => {
  const enabled = await pluginWorld({ enabled: true, config: { pane_ids: ['not-an-array-scope'] } });
  const disabled = await pluginWorld({ enabled: false });
  try {
    const { runControl } = await import('../src/herdr-adapter/entry.ts');
    const paused = await runControl(
      {
        HERDR_PLUGIN_ID: enabled.env.HERDR_PLUGIN_ID,
        HERDR_PLUGIN_ROOT: enabled.env.HERDR_PLUGIN_ROOT,
        HERDR_SOCKET_PATH: enabled.env.HERDR_SOCKET_PATH,
        HERDR_PLUGIN_STATE_DIR: enabled.env.HERDR_PLUGIN_STATE_DIR,
      },
      'pause',
    );
    assert.equal(paused, 'paused');
    assert.equal(await runControl(disabled.env, 'resume'), 'denied');
    assert.equal(await runControl(enabled.env, 'resume'), 'resumed');
  } finally {
    await enabled.close();
    await disabled.close();
  }
});

test('reportWorkflowResult keeps confirmed and passive refusal results silent', async () => {
  const { reportWorkflowResult } = await import('../src/herdr-adapter/entry.ts');
  for (const result of ['finished', 'stopped', 'not_admitted', 'paused', 'resumed'] as const) {
    let text = '',
      failures = 0;
    reportWorkflowResult(result, {
      write: (value) => {
        text += value;
      },
      fail: () => {
        failures++;
      },
    });
    assert.equal(text, '');
    assert.equal(failures, 0);
  }
  let text = '',
    failures = 0;
  reportWorkflowResult('shutdown_incomplete', {
    write: (value) => {
      text += value;
    },
    fail: () => {
      failures++;
    },
  });
  assert.equal(text, incomplete);
  assert.equal(failures, 1);
  assert.equal(text.includes('event hooks may still'), false);
});

test('a live legacy supervisor blocks new event admission', async () => {
  const world = await pluginWorld();
  const legacy = await leaseFixture();
  try {
    await rm(world.state, { recursive: true, force: true });
    const { cp } = await import('node:fs/promises');
    await cp(legacy.directory, world.state, { recursive: true });
    await chmod(world.state, 0o700);
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const previousExit = process.exitCode;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runEvent({
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          type: 'pane.agent_status_changed',
          pane_id: 'w1:p1',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'idle',
        }),
      });
    } finally {
      process.stderr.write = original;
      process.exitCode = previousExit ?? 0;
    }
    assert.equal(writes.join(''), migration);
    await assert.rejects(stat(join(world.state, 'workflows')), { code: 'ENOENT' });
  } finally {
    await world.close();
    await rm(legacy.directory, { recursive: true, force: true });
  }
});

test('runEvent blocks unknown, corrupt, and stranded legacy supervisor state without native observation', async () => {
  for (const variant of ['unknown', 'corrupt', 'stranded'] as const) {
    const world = await pluginWorld();
    const episodes = new EpisodeStore(world.state);
    const token = await episodes.acquire('synthetic-old-server');
    assert.ok(token);
    try {
      const state = new WorkflowState(world.state, () => Date.now() + 16_000, { alive: () => null });
      if (variant === 'corrupt')
        await writeFile(join(world.state, 'scheduler-lease', 'active.json'), '{}', { mode: 0o600 });
      if (variant === 'stranded') {
        await episodes.release(token);
        await writeFile(join(world.state, 'takeover-guard'), '', { mode: 0o600 });
      }
      const { runEvent } = await import('../src/herdr-adapter/entry.ts');
      let diagnostic = '';
      let failed = 0;
      let decisions = 0;
      await within(
        runEvent(
          {
            ...world.env,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
              type: 'pane.agent_status_changed',
              pane_id: 'w1:p1',
            }),
          },
          async () => {
            decisions++;
            throw new Error('unexpected decision');
          },
          {
            state,
            output: {
              write: (text) => {
                diagnostic += text;
              },
              fail: () => {
                failed++;
              },
            },
          },
        ),
        3_000,
      );
      assert.equal(decisions, 0, variant);
      assert.equal(failed, 1, variant);
      assert.equal(diagnostic, migration, variant);
      assert.equal(
        world.methods.some((item) => item.method === 'agent.get'),
        false,
        variant,
      );
      await assert.rejects(stat(join(world.state, 'workflows')), { code: 'ENOENT' });
      await assert.rejects(stat(join(world.state, 'automation')), { code: 'ENOENT' });
    } finally {
      await episodes.release(token).catch(() => {});
      await world.close();
    }
  }
});

test('runEvent promotes one owner job, duplicate events stay readers, and pause revokes the epoch', async () => {
  const world = await pluginWorld({ enabled: true });
  try {
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const event = {
      type: 'pane.agent_status_changed',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent: 'agy',
      agent_status: 'idle',
    };
    const env = { ...world.env, HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event) };
    const running = runEvent(env, async (input) => quotaDecision(input));
    const session = JSON.stringify([world.serverId, 'agy', 's1']);
    const scopeHash = createHash('sha256').update(session).digest('hex');
    const leaseRoot = join(world.state, 'workflows', scopeHash, 'scheduler-lease');
    await until(async () => {
      try {
        const selected = JSON.parse(
          await (await import('node:fs/promises')).readFile(join(leaseRoot, 'active.json'), 'utf8'),
        ) as {
          pid: number;
          token: string;
          session: string;
        };
        return selected.pid === process.pid && selected.session === session && selected.token.length > 0;
      } catch {
        return false;
      }
    }, 3_000);
    const selected = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(leaseRoot, 'active.json'), 'utf8'),
    ) as {
      pid: number;
      token: string;
      session: string;
    };
    assert.equal(selected.pid, process.pid);
    const generation = join(leaseRoot, 'generations', selected.token);
    const owner = JSON.parse(await (await import('node:fs/promises')).readFile(join(generation, 'owner.json'), 'utf8'));
    const heartbeat = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(generation, 'heartbeat.json'), 'utf8'),
    );
    assert.deepEqual(owner, { protocol: 2, token: selected.token, pid: process.pid, session });
    assert.equal(heartbeat.protocol, 2);
    assert.equal(heartbeat.token, selected.token);
    assert.ok(heartbeat.heartbeat + 15_000 > Date.now());
    await assert.rejects(stat(join(generation, 'released')));
    const serverHash = createHash('sha256')
      .update(JSON.stringify([world.serverId]))
      .digest('hex');
    await until(async () => {
      for (let index = 0; index < 8; index++) {
        try {
          const slot = JSON.parse(
            await (
              await import('node:fs/promises')
            ).readFile(
              join(world.state, 'automation', serverHash, 'capacity', String(index), 'scheduler-lease', 'active.json'),
              'utf8',
            ),
          ) as { pid: number; token: string };
          if (slot.pid === process.pid && slot.token) return true;
        } catch {
          /* empty slot */
        }
      }
      return false;
    }, 3_000);
    const duplicate = runEvent(env, async () => {
      throw new Error('duplicate reader must not decide');
    });
    await within(duplicate, 3_000);
    assert.equal(await runControl(world.env, 'pause'), 'paused');
    await within(running, 6_000);
    const { WorkflowState } = await import('../src/herdr-adapter/workflow-state.ts');
    const state = new WorkflowState(world.state);
    assert.equal(await state.capture(world.serverId, true), null);
    assert.equal(
      world.methods.some((item) => item.method === 'agent.send-keys' || item.method === 'agent.prompt'),
      false,
    );
  } finally {
    await world.close();
  }
}, 20_000);

test('an ordinary status event finishes without a persistent recovery job', async () => {
  const world = await pluginWorld({
    enabled: true,
    text: 'Current API failure: request timed out',
    snapshot: snapshot({ agent_status: 'blocked' }),
  });
  try {
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const previousExit = process.exitCode;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await within(
        runEvent(
          {
            ...world.env,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
              type: 'pane.agent_status_changed',
              pane_id: 'w1:p1',
              workspace_id: 'w1',
              agent: 'agy',
              agent_status: 'blocked',
            }),
          },
          async (input) => ({
            schema_version: 2,
            request_id: input.request_id,
            decision: 'stop_decision',
            proposed_action: { kind: 'manual_review' },
            reason_code: 'insufficient_context',
            waiting_for: 'other',
            waiting_confidence: null,
            risk_probability: null,
            evaluation: null,
          }),
        ),
        6_000,
      );
    } finally {
      process.stderr.write = original;
      process.exitCode = previousExit ?? 0;
    }
    assert.equal(writes.join(''), 'agent-steward: human_review_required (human_review_required)\n');
    const session = JSON.stringify([world.serverId, 'agy', 's1']);
    const scopeHash = createHash('sha256').update(session).digest('hex');
    const selected = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(world.state, 'workflows', scopeHash, 'scheduler-lease', 'active.json'), 'utf8'),
    ) as { token: string };
    assert.equal(
      (
        await lstat(
          join(world.state, 'workflows', scopeHash, 'scheduler-lease', 'generations', selected.token, 'released'),
        )
      ).isDirectory(),
      true,
    );
    const serverHash = createHash('sha256')
      .update(JSON.stringify([world.serverId]))
      .digest('hex');
    for (let index = 0; index < 8; index++) {
      await assert.rejects(
        stat(join(world.state, 'automation', serverHash, 'capacity', String(index), 'scheduler-lease', 'active.json')),
        {
          code: 'ENOENT',
        },
      );
    }
  } finally {
    await world.close();
  }
});

// Catches returning from pane.exited when agent.get throws without locating/quarantining.
test('pane.exited quarantines the located episode when agent.get throws', async () => {
  const world = await pluginWorld({ enabled: true, getThrow: true });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    try {
      await within(
        runEvent(
          {
            ...world.env,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
          },
          async () => {
            throw new Error('exit must not decide');
          },
        ),
        4_000,
      );
    } finally {
      process.exitCode = previousExit ?? 0;
    }
    const after = await seeded.state.sessionRetry(seeded.scope);
    assert.equal(after?.last_delivery_state, 'human');
    assert.equal(after?.next_check_at, null);
    assert.equal(after?.attempt_count, 0);
  } finally {
    await world.close();
  }
});

// Catches a late human write after pause invalidated the captured epoch during the canonical read.
test('pane.exited does not quarantine after pause during the canonical retry read', async () => {
  const world = await pluginWorld({ enabled: true, snapshot: null });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const original = WorkflowState.prototype.sessionRetry;
    const entered = deferred<void>();
    const resume = deferred<void>();
    let intercepted = false;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await original.call(this, scope);
      if (!intercepted && scope.serverId === world.serverId && scope.sessionId === 's1') {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return current;
    };
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(entered.promise, 3_000);
      assert.equal(await runControl(world.env, 'pause'), 'paused');
      assert.equal(await seeded.state.matches(seeded.ticket), false);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      resume.resolve();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
    } finally {
      resume.resolve();
      WorkflowState.prototype.sessionRetry = original;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches a late human write after pause during the final selected-G inspect (post-canonical).
test('pane.exited does not quarantine after pause during the final selected generation inspect', async () => {
  const world = await pluginWorld({ enabled: true, snapshot: null });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const originalRetry = WorkflowState.prototype.sessionRetry;
    const originalInspect = SchedulerLeaseStore.prototype.inspect;
    const entered = deferred<void>();
    const resume = deferred<void>();
    let armed = false;
    let intercepted = false;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await originalRetry.call(this, scope);
      if (scope.serverId === world.serverId && scope.sessionId === 's1') armed = true;
      return current;
    };
    SchedulerLeaseStore.prototype.inspect = async function () {
      const selected = await originalInspect.call(this);
      if (armed && !intercepted && selected.kind === 'selected' && selected.identity.token === seeded.token) {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return selected;
    };
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(entered.promise, 3_000);
      assert.equal(await runControl(world.env, 'pause'), 'paused');
      assert.equal(await seeded.state.matches(seeded.ticket), false);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      resume.resolve();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
      assert.equal(after?.attempt_count, 0);
    } finally {
      resume.resolve();
      WorkflowState.prototype.sessionRetry = originalRetry;
      SchedulerLeaseStore.prototype.inspect = originalInspect;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches a late human write after pause during the final captured binding read.
test('pane.exited does not quarantine after pause during the final binding check', async () => {
  const world = await pluginWorld({ enabled: true, snapshot: null });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const originalRetry = WorkflowState.prototype.sessionRetry;
    const originalBinding = WorkflowState.prototype.binding;
    const entered = deferred<void>();
    const resume = deferred<void>();
    let armed = false;
    let intercepted = false;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await originalRetry.call(this, scope);
      if (scope.serverId === world.serverId && scope.sessionId === 's1') armed = true;
      return current;
    };
    WorkflowState.prototype.binding = async function (scope) {
      const current = await originalBinding.call(this, scope);
      if (armed && !intercepted && scope.serverId === world.serverId && scope.sessionId === 's1') {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return current;
    };
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(entered.promise, 3_000);
      assert.equal(await runControl(world.env, 'pause'), 'paused');
      assert.equal(await seeded.state.matches(seeded.ticket), false);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      resume.resolve();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
    } finally {
      resume.resolve();
      WorkflowState.prototype.sessionRetry = originalRetry;
      WorkflowState.prototype.binding = originalBinding;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches a late human write after pause while the last returned binding snapshot is held.
// The first-binding test above is not this boundary: post-inspect matches still denied that write.
test('pane.exited does not quarantine after pause during the last returned binding snapshot', async () => {
  const world = await pluginWorld({ enabled: true, snapshot: null });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const originalRetry = WorkflowState.prototype.sessionRetry;
    const originalInspect = SchedulerLeaseStore.prototype.inspect;
    const originalBinding = WorkflowState.prototype.binding;
    const entered = deferred<void>();
    const resume = deferred<void>();
    let armed = false;
    let afterInspect = false;
    let intercepted = false;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await originalRetry.call(this, scope);
      if (scope.serverId === world.serverId && scope.sessionId === 's1') armed = true;
      return current;
    };
    SchedulerLeaseStore.prototype.inspect = async function () {
      const selected = await originalInspect.call(this);
      if (armed && selected.kind === 'selected' && selected.identity.token === seeded.token) afterInspect = true;
      return selected;
    };
    WorkflowState.prototype.binding = async function (scope) {
      const current = await originalBinding.call(this, scope);
      if (armed && afterInspect && !intercepted && scope.serverId === world.serverId && scope.sessionId === 's1') {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return current;
    };
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(entered.promise, 3_000);
      assert.equal(await runControl(world.env, 'pause'), 'paused');
      assert.equal(await seeded.state.matches(seeded.ticket), false);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      resume.resolve();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
      assert.equal(after?.attempt_count, 0);
    } finally {
      resume.resolve();
      WorkflowState.prototype.sessionRetry = originalRetry;
      SchedulerLeaseStore.prototype.inspect = originalInspect;
      WorkflowState.prototype.binding = originalBinding;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches the raw-read race inside write-site authorization using real private IO,
// separate event/control instances, and an exact busy result (never paused || incomplete).
for (const change of [
  'pause',
  'generation',
  'binding',
  'binding-publication',
  'socket',
  'permission',
  'targets',
] as const) {
  test(`pane.exited raw admission read preserves ${change} proof until canonical writer dispatch`, async () => {
    const options = { enabled: true, snapshot: null };
    const world = await pluginWorld(options);
    const resume = deferred<void>();
    let running: Promise<void> | undefined;
    try {
      const seeded = await seedBoundEpisode(world.state, world.serverId);
      const control = join(
        world.state,
        'automation',
        createHash('sha256')
          .update(JSON.stringify([world.serverId]))
          .digest('hex'),
        'control.json',
      );
      const canonical = join(
        world.state,
        `retry-session-${createHash('sha256').update('["agy","s1"]').digest('hex')}.json`,
      );
      const entered = deferred<void>();
      let armed = false,
        read = false,
        held = false,
        writes = 0;
      const writer = new WorkflowState(world.state, undefined, {
        io: {
          open: async (path, flags, mode) => {
            const handle = await open(path, flags, mode);
            if (armed && path === control) {
              const close = handle.close.bind(handle);
              handle.close = async () => {
                await close();
                read = true;
              };
            }
            if (armed && path.startsWith(`${canonical}.`) && path.endsWith('.tmp')) writes++;
            return handle;
          },
          lstat: async (path) => {
            const info = await lstat(path);
            if (path === world.state && read && !held) {
              held = true;
              entered.resolve();
              await resume.promise;
            }
            return info;
          },
        },
      });
      const record = writer.recordAdmittedSessionRetry.bind(writer);
      writer.recordAdmittedSessionRetry = (...args) => {
        armed = true;
        return record(...args);
      };
      const { runEvent, runControl, reportWorkflowResult } = await import('../src/herdr-adapter/entry.ts');
      running = runEvent(
        { ...world.env, HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }) },
        async () => {
          throw new Error('exit must not decide');
        },
        { state: writer },
      );
      await within(entered.promise, 3_000);
      const before = await readFile(canonical, 'utf8');
      if (change === 'pause') {
        const paused = await within(runControl(world.env, 'pause'), 2_000);
        assert.equal(paused, 'shutdown_incomplete');
        let code = 0,
          warning = '';
        reportWorkflowResult(paused, {
          write: (text) => {
            warning += text;
          },
          fail: () => {
            code = 1;
          },
        });
        assert.equal(code, 1);
        assert.equal(warning, incomplete);
        assert.equal((await lstat(join(control, '..', 'control-guard'))).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await readFile(control, 'utf8')).mode, 'open');
      } else if (change === 'generation') {
        const lease = seeded.state.lease(seeded.scope);
        await lease.release(seeded.token);
        assert.equal(await lease.leaseMatches(seeded.token, workflowSession(seeded.scope)), false);
        const successor = await lease.acquire(workflowSession(seeded.scope));
        assert.ok(successor);
        assert.notEqual(successor, seeded.token);
      } else if (change === 'binding-publication') {
        const binding = await seeded.state.binding(seeded.scope);
        assert.ok(binding);
        await assert.rejects(
          seeded.state.recordBinding({ ...binding, phase: 'observing', reason: null }),
          /workflow binding busy/,
        );
      } else if (change === 'binding') {
        const binding = await seeded.state.binding(seeded.scope);
        assert.ok(binding);
        const directory = join(
          world.state,
          'workflows',
          createHash('sha256').update(workflowSession(seeded.scope)).digest('hex'),
        );
        await writeFile(join(directory, 'binding.json'), JSON.stringify({ ...binding, paneId: 'w1:p2' }), {
          mode: 0o600,
        });
      } else if (change === 'socket') {
        assert.notEqual(await world.replaceSocket(), seeded.scope.serverId);
      } else if (change === 'permission') {
        options.enabled = false;
      } else {
        await writeFile(join(world.config, 'targets.json'), JSON.stringify({ pane_ids: ['w2:p2'] }));
      }
      assert.equal(writes, 0);
      assert.equal(await readFile(canonical, 'utf8'), before);
      resume.resolve();
      await within(running, 3_000);
      const after = await seeded.state.sessionRetry(seeded.scope);
      if (change === 'pause' || change === 'binding-publication') {
        assert.equal(writes, 1);
        assert.equal(after?.last_delivery_state, 'human');
        assert.equal(after?.next_check_at, null);
        assert.equal(await runControl(world.env, 'pause'), 'paused');
        assert.equal(await seeded.state.matches(seeded.ticket), false);
      } else {
        assert.equal(writes, 0);
        assert.equal(await readFile(canonical, 'utf8'), before);
        assert.equal(after?.last_delivery_state, 'none');
        assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
      }
      assert.equal(after?.attempt_count, 0);
    } finally {
      resume.resolve();
      await running?.catch(() => {});
      await world.close();
    }
  });
}

// Catches a late human write after pause during the final epoch matches check.
test('pane.exited does not quarantine after pause during the final epoch check', async () => {
  const world = await pluginWorld({ enabled: true, snapshot: null });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const originalRetry = WorkflowState.prototype.sessionRetry;
    const originalMatches = WorkflowState.prototype.matches;
    const entered = deferred<void>();
    const resume = deferred<void>();
    let armed = false;
    let intercepted = false;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await originalRetry.call(this, scope);
      if (scope.serverId === world.serverId && scope.sessionId === 's1') armed = true;
      return current;
    };
    WorkflowState.prototype.matches = async function (ticket) {
      if (armed && !intercepted && ticket.serverId === world.serverId && ticket.epoch === seeded.ticket.epoch) {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return originalMatches.call(this, ticket);
    };
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(entered.promise, 3_000);
      assert.equal(await runControl(world.env, 'pause'), 'paused');
      assert.equal(await seeded.state.matches(seeded.ticket), false);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      resume.resolve();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
    } finally {
      resume.resolve();
      WorkflowState.prototype.sessionRetry = originalRetry;
      WorkflowState.prototype.matches = originalMatches;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches a late human write after pause during the final permission reread.
test('pane.exited does not quarantine after pause during the final permission check', async () => {
  let armed = false;
  let intercepted = false;
  let lists = 0;
  const world = await pluginWorld({
    enabled: true,
    snapshot: null,
    holdWhen: (method) => {
      if (armed && method === 'plugin.list') {
        lists++;
        if (lists === 2 && !intercepted) {
          intercepted = true;
          return true;
        }
      }
      return false;
    },
  });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const originalRetry = WorkflowState.prototype.sessionRetry;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await originalRetry.call(this, scope);
      if (scope.serverId === world.serverId && scope.sessionId === 's1') armed = true;
      return current;
    };
    const { runEvent, runControl } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(world.held.promise, 3_000);
      assert.equal(await runControl(world.env, 'pause'), 'paused');
      assert.equal(await seeded.state.matches(seeded.ticket), false);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      world.releaseHold();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(after?.next_check_at, '2099-01-01T00:00:00Z');
    } finally {
      world.releaseHold();
      WorkflowState.prototype.sessionRetry = originalRetry;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches writing human history that already left the none/deadline state.
test('pane.exited does not rewrite uncertain or delivered session history', async () => {
  for (const delivery of ['uncertain', 'delivered'] as const) {
    const world = await pluginWorld({ enabled: true, snapshot: null });
    try {
      const seeded = await seedBoundEpisode(world.state, world.serverId, { delivery });
      const { runEvent } = await import('../src/herdr-adapter/entry.ts');
      const previousExit = process.exitCode;
      try {
        await within(
          runEvent(
            {
              ...world.env,
              HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
            },
            async () => {
              throw new Error('exit must not decide');
            },
          ),
          4_000,
        );
      } finally {
        process.exitCode = previousExit ?? 0;
      }
      const after = await seeded.state.sessionRetry(seeded.scope);
      assert.equal(after?.last_delivery_state, delivery);
      assert.equal(after?.attempt_count, 0);
    } finally {
      await world.close();
    }
  }
});

// Catches treating a live replacement occupant as permission to mutate the previous session.
test('runEvent replacement occupant does not mutate the previous session history', async () => {
  const world = await pluginWorld({
    enabled: true,
    snapshot: snapshot({
      agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 's2' },
    }),
  });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const previousExit = process.exitCode;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await within(
        runEvent(
          {
            ...world.env,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
              type: 'pane.agent_status_changed',
              pane_id: 'w1:p1',
              workspace_id: 'w1',
              agent: 'agy',
              agent_status: 'idle',
            }),
          },
          async () => {
            throw new Error('replacement occupant must not reuse old recovery');
          },
        ),
        6_000,
      );
    } finally {
      process.stderr.write = original;
      process.exitCode = previousExit ?? 0;
    }
    assert.equal(writes.join(''), 'agent-steward: human_review_required (decision_failed)\n');
    const previous = await seeded.state.sessionRetry(seeded.scope);
    assert.equal(previous?.last_delivery_state, 'none');
    assert.equal(previous?.next_check_at, '2099-01-01T00:00:00Z');
    assert.equal(previous?.failure_episode_id, 'a'.repeat(64));
    const replacement = await seeded.state.sessionRetry({
      ...seeded.scope,
      sessionId: 's2',
    });
    assert.equal(replacement, null);
  } finally {
    await world.close();
  }
});

// Catches a late quarantine write after the live socket identity moved during the canonical read.
test('pane.exited does not quarantine when the socket inode changes during the canonical read', async () => {
  const world = await pluginWorld({ enabled: true, snapshot: null });
  try {
    const seeded = await seedBoundEpisode(world.state, world.serverId);
    const original = WorkflowState.prototype.sessionRetry;
    const entered = deferred<void>();
    const resume = deferred<void>();
    let intercepted = false;
    WorkflowState.prototype.sessionRetry = async function (scope) {
      const current = await original.call(this, scope);
      if (!intercepted && scope.serverId === seeded.scope.serverId && scope.sessionId === 's1') {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return current;
    };
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const previousExit = process.exitCode;
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.exited', pane_id: 'w1:p1' }),
      },
      async () => {
        throw new Error('exit must not decide');
      },
    );
    try {
      await within(entered.promise, 3_000);
      const previous = world.serverId;
      const next = await world.replaceSocket();
      assert.notEqual(next, previous);
      const before = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      resume.resolve();
      await within(running, 4_000);
      const after = await new EpisodeStore(world.state).sessionRetry('agy', 's1');
      assert.deepEqual(after, before);
      assert.equal(after?.last_delivery_state, 'none');
    } finally {
      resume.resolve();
      WorkflowState.prototype.sessionRetry = original;
      process.exitCode = previousExit ?? 0;
      await running.catch(() => {});
    }
  } finally {
    await world.close();
  }
});

// Catches acting on a successor socket inode captured after plugin.list.
test('runEvent denies work when the socket inode changes after plugin.list', async () => {
  const world = await pluginWorld({ enabled: true, holdMethod: 'plugin.list' });
  try {
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          type: 'pane.agent_status_changed',
          pane_id: 'w1:p1',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'idle',
        }),
      },
      async () => {
        throw new Error('replacement socket must not decide');
      },
    );
    await within(world.held.promise, 3_000);
    const previous = world.serverId;
    const next = await world.replaceSocket();
    assert.notEqual(next, previous);
    world.releaseHold();
    await within(running, 4_000);
    await assert.rejects(stat(join(world.state, 'workflows')), { code: 'ENOENT' });
  } finally {
    await world.close();
  }
});

// Catches acting on a successor socket inode captured after agent.get.
test('runEvent denies work when the socket inode changes after agent.get', async () => {
  const world = await pluginWorld({ enabled: true, holdMethod: 'agent.get' });
  try {
    const { runEvent } = await import('../src/herdr-adapter/entry.ts');
    const running = runEvent(
      {
        ...world.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          type: 'pane.agent_status_changed',
          pane_id: 'w1:p1',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'idle',
        }),
      },
      async () => {
        throw new Error('replacement socket must not decide');
      },
    );
    await within(world.held.promise, 3_000);
    const previous = world.serverId;
    const next = await world.replaceSocket();
    assert.notEqual(next, previous);
    world.releaseHold();
    await within(running, 4_000);
    await assert.rejects(stat(join(world.state, 'workflows')), { code: 'ENOENT' });
  } finally {
    await world.close();
  }
});
