import { mkdir as fsMkdir, mkdtemp, rename as fsRename, writeFile, rm, stat } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportWorkflowResult, runControl, runEvent } from '../src/herdr-adapter/entry.ts';
import type { EventDeps } from '../src/herdr-adapter/events.ts';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';
import type { StopInput, StopResult } from '../src/contracts.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

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

export type ChildHold =
  | 'generation'
  | 'capacity'
  | 'both'
  | 'none'
  | 'decide'
  | 'control'
  | 'human'
  | 'lost'
  | 'heartbeat'
  | 'acquisition'
  | 'foreground'
  | 'marker'
  | 'timer';

export async function runHeldEvent(options: {
  hold?: ChildHold;
  signal?: 'SIGINT' | 'SIGTERM' | null;
  rejectRelease?: boolean;
  pause?: boolean;
  inWindow?: boolean;
}): Promise<void> {
  let unhandled = false;
  process.on('unhandledRejection', () => {
    unhandled = true;
    process.exitCode = 1;
  });
  const root = await mkdtemp(join(tmpdir(), 'steward-event-child-'));
  const plugin = join(root, 'plugin');
  const config = join(root, 'config');
  const directory = join(root, 'state');
  await fsMkdir(plugin);
  await fsMkdir(config);
  await fsMkdir(directory, { mode: 0o700 });
  await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n');
  await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: [] }));
  const socketPath = join(root, 'herdr.sock');
  const sockets = new Set<Socket>();
  const held = deferred<void>();
  const resume = deferred<void>();
  const hold = options.hold ?? 'none';
  let armHeartbeat = false;
  const pane = {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'agy',
    agent_status: 'idle' as const,
    agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 's1' },
    revision: 8,
    state_change_seq: 4,
  };
  let denyGet = false;
  let holdGet = false;
  const server = createServer((connection) => {
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    let data = '';
    connection.on('data', (chunk) => {
      void (async () => {
        data += chunk.toString('utf8');
        const end = data.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(data.slice(0, end)) as { id: string; method: string };
        if (request.method === 'agent.get' && holdGet) {
          held.resolve();
          await resume.promise;
          if (options.rejectRelease) throw new Error('synthetic foreground failure');
        }
        const result =
          request.method === 'plugin.list'
            ? {
                type: 'plugin_list',
                plugins: [
                  {
                    plugin_id: 'agent-steward-recover',
                    name: 'Fixture',
                    version: '0.1.0',
                    enabled: true,
                    plugin_root: plugin,
                    manifest_path: join(plugin, 'herdr-plugin.toml'),
                  },
                ],
              }
            : request.method === 'agent.get'
              ? { type: 'agent_info', agent: denyGet ? null : pane }
              : request.method === 'agent.list'
                ? { type: 'agent_list', agents: [pane] }
                : {
                    type: 'pane_read',
                    read: {
                      pane_id: 'w1:p1',
                      source: 'detection',
                      revision: 8,
                      text: 'model-one quota exhausted',
                      truncated: false,
                    },
                  };
        connection.end(`${JSON.stringify({ id: request.id, result })}\n`);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const state = new WorkflowState(directory, undefined, {
    io: {
      mkdir: async (path, mkdirOptions) => {
        const released = path.endsWith('/released');
        const capacity = path.includes('/capacity/');
        const workflow = path.includes('/workflows/');
        if (released && hold === 'marker' && workflow) throw new Error('synthetic fatal marker');
        const match =
          released &&
          ((hold === 'capacity' && capacity) ||
            (hold === 'generation' && workflow) ||
            (hold === 'both' && (capacity || workflow)) ||
            ((hold === 'human' || hold === 'lost') && capacity));
        if (match) {
          held.resolve();
          await resume.promise;
          if (options.rejectRelease) throw new Error('synthetic release failure');
        }
        return fsMkdir(path, mkdirOptions);
      },
      rename: async (from, to) => {
        const match =
          (hold === 'heartbeat' && armHeartbeat && to.includes('/workflows/') && to.endsWith('/heartbeat.json')) ||
          (hold === 'acquisition' && to.includes('/capacity/') && to.endsWith('/active.json'));
        if (match) {
          held.resolve();
          await resume.promise;
          if (options.rejectRelease) throw new Error('synthetic rename failure');
        }
        return fsRename(from, to);
      },
      open: async (path, flags, mode) => {
        const { open } = await import('node:fs/promises');
        if (hold === 'control' && path.includes('control-guard')) {
          held.resolve();
          await resume.promise;
          if (options.rejectRelease) throw new Error('synthetic control failure');
        }
        return open(path, flags, mode);
      },
    },
  });
  const env: NodeJS.ProcessEnv = {
    HERDR_ENV: '1',
    HERDR_PLUGIN_ID: 'agent-steward-recover',
    HERDR_PLUGIN_ROOT: plugin,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: directory,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      type: 'pane.agent_status_changed',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent: 'agy',
      agent_status: hold === 'marker' ? 'running' : 'idle',
    }),
  };
  const decideEntered = deferred<void>();
  const decide: EventDeps['decide'] = async (input) => {
    decideEntered.resolve();
    if (hold === 'decide') {
      held.resolve();
      await resume.promise;
    }
    return quotaDecision(input);
  };
  let beat = () => {};
  const started = Date.now();
  try {
    if (options.pause) {
      const running = runControl(env, 'pause', { state });
      const result = await within(running, 8_000);
      reportWorkflowResult(result, {
        write: (text) => {
          process.stderr.write(text);
        },
        fail: () => {
          process.exitCode = 1;
        },
      });
    } else {
      const running = runEvent(env, decide, {
        state,
        scheduleHeartbeat:
          hold === 'heartbeat'
            ? (tick) => {
                beat = tick;
                return () => {
                  beat = () => {};
                };
              }
            : undefined,
        wait:
          hold === 'human' || hold === 'foreground'
            ? async () => {
                if (hold === 'human') denyGet = true;
                if (hold === 'foreground') holdGet = true;
              }
            : undefined,
      });
      if (hold === 'decide' || hold === 'acquisition') {
        await within(held.promise, 4_000);
      } else if (hold !== 'marker') {
        await within(decideEntered.promise, 3_000);
        const info = await stat(socketPath);
        const serverId = `${info.dev}:${info.ino}`;
        const { createHash } = await import('node:crypto');
        const serverHash = createHash('sha256')
          .update(JSON.stringify([serverId]))
          .digest('hex');
        await within(
          (async () => {
            for (;;) {
              for (let index = 0; index < 8; index++) {
                try {
                  await stat(
                    join(
                      directory,
                      'automation',
                      serverHash,
                      'capacity',
                      String(index),
                      'scheduler-lease',
                      'active.json',
                    ),
                  );
                  return;
                } catch {
                  /* empty */
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
          })(),
          4_000,
        );
        if (hold === 'human') denyGet = true;
        if (hold === 'foreground') holdGet = true;
        if (hold === 'lost') await state.pause(serverId);
        if (hold === 'heartbeat') {
          armHeartbeat = true;
          beat();
        }
        if (hold === 'human' || hold === 'lost' || hold === 'heartbeat' || hold === 'foreground') {
          await within(held.promise, 4_000);
        }
      }
      if (options.signal) process.kill(process.pid, options.signal);
      if (options.inWindow) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        resume.resolve();
      }
      await within(running, 8_000);
    }
    const elapsed = Date.now() - started;
    process.stdout.write(`${unhandled ? 'unhandled' : 'settled'} ${elapsed}\n`);
  } finally {
    resume.resolve();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
