import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { StopResultSchema } from '../contracts.ts';
import { readFileText } from '../io.ts';
import { beginWorkflow } from './authority.ts';
import type { HerdrControl } from './deliver.ts';
import { handleEvent, normalizeEvent, workflowEventDeps, type EventDeps, type EventTrigger } from './events.ts';
import { runEpisodeJob, type JobOptions } from './jobs.ts';
import type { HerdrReader, AgentSnapshot, ReadSnapshot } from './observe.ts';
import { quotaResetHint, type QuotaHint } from './quota-hint.ts';
import { EpisodeStore, type Episode } from './state.ts';
import {
  validateWorkflowScope,
  workflowSession,
  WorkflowState,
  type ControlResult,
  type RuntimePermission,
  type WorkflowResult,
  type WorkflowScope,
} from './workflow-state.ts';
import type { StopInput, StopResult } from '../contracts.ts';

export { handleEvent, type EventDeps };

type HandoffReason = 'observation_unavailable' | 'decision_failed' | 'human_review_required';
const socketTimeoutMs = 2_000;
const socketLimitBytes = 65_536;
const recoverPluginId = 'agent-steward-recover';
const incompleteWarning = 'agent-steward: release unconfirmed; shutdown incomplete. Human review required.\n';
const migrationWarning =
  'agent-steward: legacy supervisor state is live or unverifiable. Disable the plugin, stop all adapters and verify they are dead before offline cleanup of a stranded guard or legacy lease. Preserve episode records and generation tombstones.\n';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function recoverable(episode: Episode | null): episode is Episode {
  return (
    episode !== null &&
    episode.last_delivery_state === 'none' &&
    episode.next_check_at !== null &&
    episode.lifecycle_handoff_sent !== true
  );
}

function processOutput(): { write(text: string): void; fail(): void } {
  return {
    write: (text) => {
      process.stderr.write(text);
    },
    fail: () => {
      process.exitCode = 1;
    },
  };
}

// Herdr 0.9.1 newline-delimited socket protocol for bounded observation.
async function request(
  socketPath: string,
  method: 'agent.get' | 'agent.read' | 'agent.list' | 'plugin.list',
  params: object,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const id = randomUUID();
    let data = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Herdr read timeout')), socketTimeoutMs);
    socket.setTimeout(socketTimeoutMs, () => fail(new Error('Herdr read timeout')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('error', (error) => fail(error));
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data, 'utf8') > socketLimitBytes) {
        fail(new Error('Herdr response too large'));
        return;
      }
      const end = data.indexOf('\n');
      if (end < 0) return;
      socket.end();
      try {
        const response = JSON.parse(data.slice(0, end));
        if (response.id !== id || response.error || !response.result) throw new Error('Herdr read failed');
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response.result);
      } catch {
        fail(new Error('Invalid Herdr response'));
      }
    });
    socket.on('end', () => fail(new Error('Incomplete Herdr response')));
  });
}

export function socketReader(path: string): HerdrReader {
  return {
    list: async () => {
      const result = (await request(path, 'agent.list', {})) as { type?: string; agents?: AgentSnapshot[] };
      if (result.type !== 'agent_list' || !Array.isArray(result.agents)) throw new Error('Invalid Herdr agent list');
      return result.agents;
    },
    get: async (paneId) => {
      const result = (await request(path, 'agent.get', { target: paneId })) as { type?: string; agent?: AgentSnapshot };
      return result.type === 'agent_info' ? (result.agent ?? null) : null;
    },
    read: async (paneId) => {
      const read = async (lines: number) => {
        const result = (await request(path, 'agent.read', {
          target: paneId,
          source: 'detection',
          lines,
          format: 'text',
        })) as { type?: string; read?: ReadSnapshot };
        return result.type === 'pane_read' ? (result.read ?? null) : null;
      };
      const snapshot = await read(12);
      // Keep complete compact menus free of historical prefixes. Expand only
      // when wrapped permission text has pushed the header out of the excerpt.
      if (
        typeof snapshot?.text === 'string' &&
        !snapshot.text.includes('Requesting permission for:') &&
        (snapshot.text.includes('Run this command?') || snapshot.text.includes('Apply this edit?')) &&
        (snapshot.text.includes('1. Yes, run command') || snapshot.text.includes('1. Yes, apply edit'))
      )
        return read(16);
      // Detection text is untrusted evidence, not a verified current-stop boundary.
      return snapshot;
    },
  };
}

// Use Herdr's agent prompt command: it enforces blocked-dialog permission controls.
// An exit, signal, or timeout after invocation is ambiguous; the episode was already
// marked uncertain before spawn and must never be automatically retried.
function socketControl(
  path: string,
  binary: string | undefined,
): HerdrReader & Partial<Pick<HerdrControl, 'prompt' | 'sendKeys'>> {
  const reader = socketReader(path);
  if (!binary || !isAbsolute(binary)) return reader;
  const invoke = async (args: string[]) =>
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: 'ignore', env: { ...process.env, HERDR_SOCKET_PATH: path } });
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Herdr key outcome unknown'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error('Herdr key outcome unknown'));
        else resolve();
      });
    });
  return {
    ...reader,
    sendKeys: async (paneId, keys) => {
      if (keys.length !== 1 || keys[0] !== '1') throw new Error('Invalid approval input');
      await invoke(['agent', 'send-keys', paneId, '1']);
    },
    prompt: async (paneId, instruction) =>
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, ['agent', 'prompt', paneId, instruction], {
          stdio: 'ignore',
          env: { ...process.env, HERDR_SOCKET_PATH: path },
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 8_000);
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Herdr prompt outcome unknown'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (timedOut || code !== 0) reject(new Error('Herdr prompt outcome unknown'));
          else resolve();
        });
      }),
  };
}

export async function decideWithCli(
  input: StopInput,
  main = fileURLToPath(new URL('../main.js', import.meta.url)),
  deadlineMs = 35_000,
): Promise<StopResult> {
  const child = spawn(process.execPath, [main, 'stop', 'check'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let data = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    data += chunk;
    if (data.length > 65536) child.kill();
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    let expired = false;
    let exited = false;
    const deadlineError = () => new Error('stop check deadline exceeded');
    const timer = setTimeout(() => {
      expired = true;
      if (exited) reject(deadlineError());
      else child.kill('SIGKILL');
    }, deadlineMs);
    child.on('exit', () => {
      exited = true;
      if (expired) reject(deadlineError());
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(deadlineError());
      else resolve(code);
    });
    child.stdin.on('error', (error) => {
      child.kill('SIGKILL');
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(JSON.stringify(input));
  });
  if (exit !== 0 && exit !== 2 && exit !== 3) throw new Error('stop check failed');
  let result: StopResult;
  try {
    result = StopResultSchema.parse(JSON.parse(data));
  } catch {
    throw new Error('invalid stop check response');
  }
  if (result.decision === 'error' || result.request_id !== input.request_id)
    throw new Error('invalid stop check decision');
  return result;
}

// Socket inode binds this process's lease to a particular Herdr server instance;
// a replaced socket cannot use the old runner's lease.
async function socketSession(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isSocket() ? `${info.dev}:${info.ino}` : null;
  } catch {
    return null;
  }
}

function handoff(reason: HandoffReason): Promise<void> {
  process.stderr.write(`agent-steward: human_review_required (${reason})\n`);
  return Promise.resolve();
}

async function visibleHandoff(env: NodeJS.ProcessEnv, reason: HandoffReason): Promise<void> {
  await handoff(reason);
  if (!env.HERDR_BIN_PATH || !isAbsolute(env.HERDR_BIN_PATH) || !env.HERDR_SOCKET_PATH) return;
  // Herdr 0.9.1 notification.show is a best-effort visible toast, not a
  // guaranteed human acknowledgment; never include context, IDs, or errors.
  await new Promise<void>((resolve) => {
    const child = spawn(
      env.HERDR_BIN_PATH!,
      ['notification', 'show', 'Agent Steward: human review required', '--body', 'Review the stopped agent manually.'],
      { stdio: 'ignore', env: { ...process.env, HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH } },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function quotaHintFrom(env: NodeJS.ProcessEnv): QuotaHint {
  return (observed, now) =>
    quotaResetHint(observed, {
      env: {
        HOME: env.HOME,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
        TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      },
      cwd: process.cwd(),
      readText: readFileText,
      now,
    });
}

async function adapterConfigFrom(
  env: NodeJS.ProcessEnv,
): Promise<{ targets: readonly string[] | 'all'; autoApprove: boolean } | null> {
  if (!env.HERDR_PLUGIN_CONFIG_DIR) return null;
  const path = join(env.HERDR_PLUGIN_CONFIG_DIR, 'targets.json');
  let text: string;
  try {
    text = await readFileText(path);
  } catch (error) {
    return isMissing(error) ? { targets: 'all', autoApprove: false } : null;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const body = config as { pane_ids?: unknown; auto_approve?: unknown };
  if (!Object.hasOwn(body, 'pane_ids') || (Array.isArray(body.pane_ids) && body.pane_ids.length === 0))
    return { targets: 'all', autoApprove: body.auto_approve === true };
  if (!Array.isArray(body.pane_ids) || !body.pane_ids.every((id) => typeof id === 'string')) return null;
  return { targets: body.pane_ids, autoApprove: body.auto_approve === true };
}

export async function readPluginContext(
  env: NodeJS.ProcessEnv,
): Promise<{ serverId: string; enabled: boolean } | null> {
  if (env.HERDR_PLUGIN_ID !== recoverPluginId || !env.HERDR_SOCKET_PATH || !env.HERDR_PLUGIN_ROOT) return null;
  let root: string;
  let manifest: string;
  try {
    root = await realpath(env.HERDR_PLUGIN_ROOT);
    manifest = await realpath(join(env.HERDR_PLUGIN_ROOT, 'herdr-plugin.toml'));
  } catch {
    return null;
  }
  const serverId = await socketSession(env.HERDR_SOCKET_PATH);
  if (!serverId) return null;
  let result: unknown;
  try {
    result = await request(env.HERDR_SOCKET_PATH, 'plugin.list', { plugin_id: recoverPluginId });
  } catch {
    return null;
  }
  if ((await socketSession(env.HERDR_SOCKET_PATH)) !== serverId) return null;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const body = result as { type?: unknown; plugins?: unknown };
  if (body.type !== 'plugin_list' || !Array.isArray(body.plugins)) return null;
  const matches = body.plugins.filter(
    (plugin) =>
      plugin &&
      typeof plugin === 'object' &&
      !Array.isArray(plugin) &&
      (plugin as { plugin_id?: unknown }).plugin_id === recoverPluginId,
  );
  if (matches.length !== 1) return null;
  const plugin = matches[0] as {
    plugin_id?: unknown;
    plugin_root?: unknown;
    manifest_path?: unknown;
    enabled?: unknown;
  };
  if (
    typeof plugin.plugin_id !== 'string' ||
    typeof plugin.plugin_root !== 'string' ||
    typeof plugin.manifest_path !== 'string' ||
    typeof plugin.enabled !== 'boolean'
  )
    return null;
  let listedRoot: string;
  let listedManifest: string;
  try {
    listedRoot = await realpath(plugin.plugin_root);
    listedManifest = await realpath(plugin.manifest_path);
  } catch {
    return null;
  }
  if (listedRoot !== root || listedManifest !== manifest) return null;
  if ((await socketSession(env.HERDR_SOCKET_PATH)) !== serverId) return null;
  return { serverId, enabled: plugin.enabled };
}

export async function readRuntimePermission(env: NodeJS.ProcessEnv): Promise<RuntimePermission | null> {
  const context = await readPluginContext(env);
  if (!context || context.enabled !== true) return null;
  const config = await adapterConfigFrom(env);
  if (!config) return null;
  if (!env.HERDR_SOCKET_PATH || (await socketSession(env.HERDR_SOCKET_PATH)) !== context.serverId) return null;
  return { serverId: context.serverId, enabled: true, targets: config.targets, autoApprove: config.autoApprove };
}

export type EventRunOptions = {
  state?: WorkflowState;
  output?: { write(text: string): void; fail(): void };
  shutdownDeadline?: (ms: number, expire: () => void) => () => void;
  scheduleHeartbeat?: (tick: () => void) => () => void;
  wait?: JobOptions['wait'];
};

export async function runControl(
  env: NodeJS.ProcessEnv,
  mode: 'pause' | 'resume',
  options: Pick<EventRunOptions, 'state'> = {},
): Promise<ControlResult> {
  if (!env.HERDR_PLUGIN_STATE_DIR) return 'denied';
  const deadlineAt = performance.now() + 5000;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async (): Promise<ControlResult> => {
    const context = await readPluginContext(env);
    if (expired || performance.now() >= deadlineAt) return 'shutdown_incomplete';
    if (!context || (mode === 'resume' && context.enabled !== true)) return 'denied';
    const state = options.state ?? new WorkflowState(env.HERDR_PLUGIN_STATE_DIR!);
    return mode === 'pause'
      ? state.pause(context.serverId, deadlineAt)
      : state.resume(context.serverId, context.enabled, deadlineAt);
  };
  try {
    return await Promise.race([
      operation().catch((): ControlResult => 'shutdown_incomplete'),
      new Promise<ControlResult>((resolve) => {
        timer = setTimeout(
          () => {
            expired = true;
            resolve('shutdown_incomplete');
          },
          Math.max(0, deadlineAt - performance.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function reportWorkflowResult(
  result: WorkflowResult | ControlResult,
  output: { write(text: string): void; fail(): void },
): void {
  if (result !== 'shutdown_incomplete' && result !== 'denied') return;
  output.write(
    result === 'denied'
      ? 'agent-steward: control denied; no change confirmed. Human review required.\n'
      : incompleteWarning,
  );
  output.fail();
}

function scopeFromSnapshot(
  serverId: string,
  pane: AgentSnapshot,
): { scope: WorkflowScope; paneId: string; workspaceId: string } | null {
  try {
    if (!pane.agent_session) return null;
    const scope = validateWorkflowScope({
      serverId,
      agent: pane.agent_session.agent,
      sessionId: pane.agent_session.value,
      sessionKind: pane.agent_session.kind,
      sessionSource: pane.agent_session.source,
    });
    if (pane.workspace_id !== pane.pane_id.split(':')[0]) return null;
    return { scope, paneId: pane.pane_id, workspaceId: pane.workspace_id };
  } catch {
    return null;
  }
}

async function currentGrantStillHolds(
  env: NodeJS.ProcessEnv,
  state: WorkflowState,
  serverId: string,
  paneId: string,
  ticket: { serverId: string; epoch: string },
  generation: string,
  occupant: string,
  scope: WorkflowScope,
): Promise<boolean> {
  if ((await socketSession(env.HERDR_SOCKET_PATH!)) !== serverId) return false;
  const permission = await readRuntimePermission(env);
  if (!permission || permission.serverId !== serverId) return false;
  if (permission.targets !== 'all' && !permission.targets.includes(paneId)) return false;
  if (!(await state.matches(ticket))) return false;
  const current = await state.binding(scope);
  if (
    !current ||
    current.paneId !== paneId ||
    current.generation !== generation ||
    current.epoch !== ticket.epoch ||
    current.scope.serverId !== serverId ||
    workflowSession(current.scope) !== occupant
  )
    return false;
  if (!(await state.lease(scope).leaseMatches(generation, occupant))) return false;
  // Pause/socket/permission/G can complete during inspect. Recheck the captured
  // ticket before the caller is allowed to write.
  if ((await socketSession(env.HERDR_SOCKET_PATH!)) !== serverId) return false;
  const latestPermission = await readRuntimePermission(env);
  if (!latestPermission || latestPermission.serverId !== serverId) return false;
  if (latestPermission.targets !== 'all' && !latestPermission.targets.includes(paneId)) return false;
  if (!(await state.matches(ticket))) return false;
  const confirmed = await state.binding(scope);
  return (
    confirmed !== null &&
    confirmed.paneId === paneId &&
    confirmed.generation === generation &&
    confirmed.epoch === ticket.epoch &&
    confirmed.scope.serverId === serverId &&
    workflowSession(confirmed.scope) === occupant
  );
}

async function quarantineLocatedEpisode(
  state: WorkflowState,
  serverId: string,
  paneId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const scope = await state.locate(serverId, paneId);
  if (!scope) return;
  const binding = await state.binding(scope);
  if (!binding || binding.paneId !== paneId || binding.scope.serverId !== serverId) return;
  const ticket = { serverId: binding.scope.serverId, epoch: binding.epoch };
  const generation = binding.generation;
  const occupant = workflowSession(binding.scope);
  if (!(await currentGrantStillHolds(env, state, serverId, paneId, ticket, generation, occupant, scope))) return;
  const episodes = new EpisodeStore(state.directory);
  const retryKey = 'retry-session:' + JSON.stringify([scope.agent, scope.sessionId]);
  await episodes.withEpisodeLock(paneId, () =>
    episodes.withEpisodeLock(retryKey, async () => {
      if (!(await currentGrantStillHolds(env, state, serverId, paneId, ticket, generation, occupant, scope))) return;
      const episode = await state.sessionRetry(scope);
      if (!episode || episode.last_delivery_state !== 'none' || episode.next_check_at === null) return;
      if (episode.pane_id !== paneId) return;
      if (await state.recoveryQuarantined(scope)) return;
      if (!(await currentGrantStillHolds(env, state, serverId, paneId, ticket, generation, occupant, scope))) return;
      await state.recordAdmittedSessionRetry(
        scope,
        ticket,
        { ...episode, next_check_at: null, last_delivery_state: 'human' },
        () => currentGrantStillHolds(env, state, serverId, paneId, ticket, generation, occupant, scope),
        generation,
      );
    }),
  );
}

export async function runEvent(
  env: NodeJS.ProcessEnv,
  decide: EventDeps['decide'] = decideWithCli,
  options: EventRunOptions = {},
): Promise<void> {
  const output = options.output ?? processOutput();
  if (
    !env.HERDR_PLUGIN_EVENT_JSON ||
    !env.HERDR_SOCKET_PATH ||
    !env.HERDR_PLUGIN_CONFIG_DIR ||
    !env.HERDR_PLUGIN_STATE_DIR
  )
    return;
  let trigger: unknown;
  try {
    trigger = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON);
  } catch {
    return;
  }
  const event = normalizeEvent(trigger);
  if (!event || !event.pane_id) return;
  const permission = await readRuntimePermission(env);
  if (!permission) return;
  if (permission.targets !== 'all' && !permission.targets.includes(event.pane_id)) return;
  if ((await socketSession(env.HERDR_SOCKET_PATH)) !== permission.serverId) return;
  const state = options.state ?? new WorkflowState(env.HERDR_PLUGIN_STATE_DIR);
  if (!(await state.legacyInactive())) {
    output.write(migrationWarning);
    output.fail();
    return;
  }
  if ((await socketSession(env.HERDR_SOCKET_PATH)) !== permission.serverId) return;
  const herdr = socketControl(env.HERDR_SOCKET_PATH, env.HERDR_BIN_PATH);
  const exitEvent = event.type === 'pane.exited' || event.type === 'pane_exited';
  let pane: AgentSnapshot | null = null;
  try {
    pane = await herdr.get(event.pane_id);
  } catch {
    if (exitEvent) {
      if ((await socketSession(env.HERDR_SOCKET_PATH)) === permission.serverId)
        await quarantineLocatedEpisode(state, permission.serverId, event.pane_id, env);
      return;
    }
    await visibleHandoff(env, 'observation_unavailable');
    return;
  }
  if ((await socketSession(env.HERDR_SOCKET_PATH)) !== permission.serverId) return;
  const live = pane ? scopeFromSnapshot(permission.serverId, pane) : null;
  if (
    exitEvent &&
    (!live || (await state.locate(permission.serverId, event.pane_id))?.sessionId !== live.scope.sessionId)
  ) {
    await quarantineLocatedEpisode(state, permission.serverId, event.pane_id, env);
    return;
  }
  if (!live) return;
  const abort = new AbortController();
  let deadlineAt: number | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDeadline: ((value: 'deadline') => void) | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    resolveDeadline = resolve;
  });
  const armDeadline = () => {
    deadlineAt ??= Date.now();
    if (deadlineTimer !== undefined) return;
    deadlineTimer = setTimeout(() => resolveDeadline?.('deadline'), 5_000);
  };
  const sharedShutdown =
    options.shutdownDeadline ??
    ((ms: number, expire: () => void) => {
      if (ms !== 5000) {
        const timer = setTimeout(expire, ms);
        return () => clearTimeout(timer);
      }
      armDeadline();
      const remaining = Math.max(0, 5_000 - (Date.now() - (deadlineAt ?? Date.now())));
      const timer = setTimeout(expire, remaining);
      return () => clearTimeout(timer);
    });
  const stop = () => {
    armDeadline();
    abort.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const attempt = beginWorkflow({
    state,
    scope: live.scope,
    paneId: live.paneId,
    workspaceId: live.workspaceId,
    permission: () => readRuntimePermission(env),
    signal: abort.signal,
    shutdownDeadline: sharedShutdown,
    ...(options.scheduleHeartbeat ? { scheduleHeartbeat: options.scheduleHeartbeat } : {}),
  });
  attempt.signal.addEventListener('abort', armDeadline, { once: true });
  const closed = new Promise<WorkflowResult>((resolve) => {
    if (attempt.signal.aborted) resolve('stopped');
    else attempt.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });
  let jobWork: Promise<WorkflowResult> | undefined;
  const foreground = async (): Promise<WorkflowResult> => {
    const authority = await attempt.ready;
    if (!authority) return abort.signal.aborted || attempt.signal.aborted ? 'stopped' : 'not_admitted';
    const episodes = new EpisodeStore(env.HERDR_PLUGIN_STATE_DIR!);
    const base: EventDeps = {
      herdr,
      decide,
      store: {
        active: async () => true,
        retry: (paneId) => episodes.retry(paneId),
        record: (paneId, retry) => episodes.record(paneId, retry),
        clear: (paneId) => episodes.clear(paneId),
        approval: (agent, session) => episodes.approval(agent, session),
        recordApproval: (paneId, attemptRecord) => episodes.recordApproval(paneId, attemptRecord),
        withEpisodeLock: (key, action) => episodes.withEpisodeLock(key, action),
      },
      clock: { now: () => new Date() },
      targets: authority.permission.targets,
      autoApprove: authority.permission.autoApprove,
      quotaHint: quotaHintFrom(env),
      handoff: (reason) => visibleHandoff(env, reason),
    };
    const deps = workflowEventDeps(base, authority, state);
    await handleEvent(event as EventTrigger, deps);
    if (!authority.admissionOpen()) return 'stopped';
    const binding = await state.binding(live.scope);
    const episode = await state.sessionRetry(live.scope);
    if (authority.ownsGeneration && binding && recoverable(episode) && !(await state.recoveryQuarantined(live.scope))) {
      jobWork = runEpisodeJob({
        state,
        authority,
        episodes,
        deps,
        binding,
        signal: attempt.signal,
        ...(options.wait ? { wait: options.wait } : {}),
      });
      return jobWork;
    }
    return 'finished';
  };
  try {
    const workPromise = foreground().catch((): WorkflowResult => (attempt.signal.aborted ? 'stopped' : 'not_admitted'));
    await Promise.race([workPromise, closed]);
    const finishing = attempt.finish();
    const aborted = abort.signal.aborted || attempt.signal.aborted;
    void workPromise.catch(() => {});
    const jobWait = jobWork
      ? aborted
        ? Promise.race([jobWork, deadline]).then((value) => (value === 'deadline' ? 'shutdown_incomplete' : value))
        : jobWork
      : Promise.resolve(aborted ? 'stopped' : await workPromise);
    const [jobResult, release] = await Promise.all([jobWait, finishing]);
    const combined: WorkflowResult =
      release === 'shutdown_incomplete' || jobResult === 'shutdown_incomplete' ? 'shutdown_incomplete' : jobResult;
    reportWorkflowResult(combined, output);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === 'event') await runEvent(process.env);
  if (process.argv[2] === 'pause') reportWorkflowResult(await runControl(process.env, 'pause'), processOutput());
  if (process.argv[2] === 'resume') reportWorkflowResult(await runControl(process.env, 'resume'), processOutput());
}
