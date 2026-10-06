// Current-module C2 window: pause after the first canonical deadline write and
// before pending-binding publication, then resume. Spawned by herdr-final-boundaries.
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { lstat, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEvent } from '../src/herdr-adapter/entry.ts';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { assessStop } from '../src/triage.ts';
import type { StopInput } from '../src/contracts.ts';
import type { Evaluation } from '../src/jev.ts';

const defer = () => {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const root = await mkdtemp(join(tmpdir(), 'steward-final-c2-entry-'));
const plugin = join(root, 'plugin'),
  config = join(root, 'config'),
  directory = join(root, 'state');
await Promise.all([mkdir(plugin, { mode: 0o700 }), mkdir(config, { mode: 0o700 }), mkdir(directory, { mode: 0o700 })]);
await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n', { mode: 0o600 });
await writeFile(join(config, 'targets.json'), '{"auto_approve":false}', {
  mode: 0o600,
});
const snapshot = {
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  agent_status: 'idle',
  agent_session: {
    agent: 'agy',
    kind: 'id',
    source: 'herdr:antigravity_cli',
    value: 's1',
  },
  revision: 259,
  state_change_seq: 4,
};
const socketPath = join(root, 'fake.sock');
const sockets = new Set<Socket>();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
  let data = '';
  socket.on('data', (chunk) => {
    data += chunk;
    if (!data.includes('\n')) return;
    const request = JSON.parse(data.slice(0, data.indexOf('\n')));
    data = '';
    const result =
      request.method === 'plugin.list'
        ? {
            type: 'plugin_list',
            plugins: [
              {
                plugin_id: 'agent-steward-recover',
                plugin_root: plugin,
                manifest_path: join(plugin, 'herdr-plugin.toml'),
                enabled: true,
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
                revision: 0,
                text: 'Current API failure: request timed out',
                truncated: false,
              },
            };
    socket.end(JSON.stringify({ id: request.id, result }) + '\n');
  });
});
await new Promise<void>((resolve) => server.listen(socketPath, resolve));
const info = await stat(socketPath),
  serverId = `${info.dev}:${info.ino}`;
const scope = {
  serverId,
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
const env = {
  HERDR_ENV: '1',
  HERDR_PLUGIN_ID: 'agent-steward-recover',
  HERDR_PLUGIN_ROOT: plugin,
  HERDR_PLUGIN_CONFIG_DIR: config,
  HERDR_PLUGIN_STATE_DIR: directory,
  HERDR_SOCKET_PATH: socketPath,
  HERDR_BIN_PATH: join(root, 'nonexistent-native'),
  HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
    type: 'pane.agent_status_changed',
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'agy',
    agent_status: 'idle',
  }),
};
const episodes = new EpisodeStore(directory);
const entered = defer();
const resume = defer();
let held = false,
  decisions = 0,
  waits = 0;
const state = new WorkflowState(directory, undefined, {
  io: {
    lstat: async (path) => {
      const info = await lstat(path);
      if (!held && path.endsWith('/binding.json') && (await episodes.sessionRetry('agy', 's1'))?.next_check_at) {
        held = true;
        entered.resolve('held');
        await resume.promise;
      }
      return info;
    },
  },
});
const decide = async (input: StopInput) => {
  decisions++;
  return assessStop(input, {
    thresholds: { risky: 0.6, choiceConfidence: 0.45 },
    now: new Date(),
    evaluate: async () =>
      ({
        model: 'jev-1.13.0',
        usage: {},
        answers: {
          waiting_for: {
            type: 'choice',
            choice: 'recoverable_api_error',
            confidence: 0.9,
            probabilities: {
              approve_command: 0,
              approve_edit: 0,
              answer_question: 0,
              credentials: 0,
              recoverable_api_error: 0.9,
              quota_limit: 0,
              permanent_error: 0,
              completed: 0,
              other: 0.1,
            },
          },
          risky: { type: 'noul', noul: 0.1 },
        },
      }) as Evaluation,
  });
};
const output = { write: (_text: string) => {}, fail: () => {} };
let first: Promise<void> | undefined;
try {
  first = runEvent(env, decide, {
    state,
    output,
    scheduleHeartbeat: () => () => {},
  });
  const reached = await Promise.race([
    entered.promise,
    first.then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2500)),
  ]);
  assert.equal(reached, 'held');
  const before = await episodes.sessionRetry('agy', 's1');
  assert.ok(before?.next_check_at);
  const unlatched = new WorkflowState(directory);
  const oldBinding = await unlatched.binding(scope);
  assert.equal(oldBinding?.phase, 'observing');
  assert.equal(oldBinding!.failureEpisodeId, null);
  assert.equal(await unlatched.pause(serverId), 'paused');
  assert.equal(await unlatched.matches({ serverId, epoch: oldBinding!.epoch }), false);
  resume.resolve();
  await first;
  assert.deepEqual(await episodes.sessionRetry('agy', 's1'), before);
  assert.equal(await new WorkflowState(directory).resume(serverId, true), 'resumed');
  const beforeDecisions = decisions;
  await runEvent(env, decide, {
    output,
    scheduleHeartbeat: () => () => {},
    wait: async (deadline) => {
      waits++;
      assert.equal(deadline.toISOString(), before.next_check_at);
      throw new Error('canceled pre-promotion deadline must not be waited');
    },
  });
  assert.equal(waits, 0);
  assert.equal(decisions, beforeDecisions);
  assert.deepEqual(await episodes.sessionRetry('agy', 's1'), before);
} finally {
  resume.resolve();
  await first?.catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
