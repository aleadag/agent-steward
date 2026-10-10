import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvent, runControl, reportWorkflowResult } from '../src/herdr-adapter/entry.ts';
import { WorkflowState, type WorkflowScope } from '../src/herdr-adapter/workflow-state.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { beginWorkflow, reserveJobSlot } from '../src/herdr-adapter/authority.ts';
import { workflowEventDeps, handleEvent } from '../src/herdr-adapter/events.ts';
import { observeStop, type AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import { runEpisodeJob } from '../src/herdr-adapter/jobs.ts';
import { assessStop } from '../src/triage.ts';
import type { StopInput } from '../src/contracts.ts';
import type { Evaluation } from '../src/jev.ts';
import { withPrivateGuard } from '../src/herdr-adapter/private-files.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

const dialog =
  'Requesting permission for:\n printf local-test\n\nRun this command?\n1. Yes, run command\n2. No, cancel';
const snapshot = (): AgentSnapshot => ({
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
});
const event = {
  type: 'pane.agent_status_changed',
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  agent_status: 'idle',
};
const scope: WorkflowScope = {
  serverId: '47:1',
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
const decision = (
  input: StopInput,
  choice: 'approve_command' | 'recoverable_api_error' = 'approve_command',
  now = new Date(),
) =>
  assessStop(input, {
    thresholds: { risky: 0.6, choiceConfidence: 0.45 },
    now,
    evaluate: async () =>
      ({
        model: 'jev-1.13.0',
        usage: {},
        answers: {
          waiting_for: {
            type: 'choice',
            choice,
            probabilities: {
              approve_command: 0,
              approve_edit: 0,
              answer_question: 0,
              credentials: 0,
              recoverable_api_error: 0,
              quota_limit: 0,
              permanent_error: 0,
              completed: 0,
              other: 0.1,
              [choice]: 0.9,
            },
            confidence: 0.9,
          },
          risky: { type: 'noul', noul: 0.1 },
        },
      }) as Evaluation,
  });
const output = { write: () => {}, fail: () => {} };
const start = (
  state: WorkflowState,
  autoApprove = true,
  selected = scope,
  scheduleHeartbeat = (_tick: () => void) => () => {},
) =>
  beginWorkflow({
    state,
    scope: selected,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: async () => ({
      serverId: selected.serverId,
      enabled: true,
      targets: 'all',
      autoApprove,
    }),
    signal: new AbortController().signal,
    scheduleHeartbeat,
  });

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'steward-final-boundaries-'));
  const plugin = join(root, 'plugin'),
    config = join(root, 'config'),
    directory = join(root, 'state');
  await Promise.all([mkdir(plugin), mkdir(config), mkdir(directory, { mode: 0o700 })]);
  await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n');
  const configPath = join(config, 'targets.json');
  await writeFile(configPath, JSON.stringify({ auto_approve: true }));
  const sockets = new Set<Socket>();
  let gets = 0;
  const controls = {
    pane: snapshot() as AgentSnapshot | null,
    enabled: true,
    beforeGet: async (_count: number) => {},
    beforePlugin: async () => {},
  };
  const socketPath = join(root, 'herdr.sock');
  const server = createServer((connection) => {
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    connection.once('error', () => connection.destroy()); // A timed-out client may reject a late fake reply.
    let data = '';
    connection.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.slice(0, data.indexOf('\n'))) as {
        id: string;
        method: string;
      };
      data = '';
      void (async () => {
        if (request.method === 'agent.get') await controls.beforeGet(++gets);
        if (request.method === 'plugin.list') await controls.beforePlugin();
        const result =
          request.method === 'plugin.list'
            ? {
                type: 'plugin_list',
                plugins: [
                  {
                    plugin_id: 'agent-steward-recover',
                    plugin_root: plugin,
                    manifest_path: join(plugin, 'herdr-plugin.toml'),
                    enabled: controls.enabled,
                  },
                ],
              }
            : request.method === 'agent.get'
              ? { type: 'agent_info', agent: controls.pane }
              : {
                  type: 'pane_read',
                  read: {
                    pane_id: 'w1:p1',
                    source: 'detection',
                    revision: 0,
                    text: dialog,
                    truncated: false,
                  },
                };
        connection.end(JSON.stringify({ id: request.id, result }) + '\n');
      })().catch(() => connection.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const info = await stat(socketPath),
    serverId = `${info.dev}:${info.ino}`;
  const env = {
    HERDR_ENV: '1',
    HERDR_PLUGIN_ID: 'agent-steward-recover',
    HERDR_PLUGIN_ROOT: plugin,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: directory,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN_PATH: join(root, 'absent-native'),
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event),
  };
  return {
    root,
    directory,
    configPath,
    controls,
    serverId,
    env,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

// These regressions exercise the current entry/facade, not the immutable review snapshot.
for (const changed of ['session', 'source', 'kind', 'pane'] as const)
  test(`captured approval refuses capture-to-observation ${changed} replacement`, async () => {
    const w = await world();
    let calls = 0;
    try {
      w.controls.beforeGet = async (count) => {
        if (count !== 2) return;
        const pane = w.controls.pane!;
        if (changed === 'session') pane.agent_session!.value = 'replacement-s2';
        if (changed === 'source') pane.agent_session!.source = 'herdr:other';
        if (changed === 'kind') pane.agent_session!.kind = 'path';
        if (changed === 'pane') pane.pane_id = 'w1:p2';
      };
      await runEvent(
        w.env,
        async (input) => {
          calls++;
          return decision(input);
        },
        { output, scheduleHeartbeat: () => () => {} },
      );
      assert.equal(calls, 0);
      assert.equal(await new EpisodeStore(w.directory).approval('agy', 'replacement-s2'), null);
      assert.equal(await new EpisodeStore(w.directory).approval('agy', 's1'), null);
    } finally {
      await w.close();
    }
  });

test('approval enablement comes from authority capture, not the earlier entry permission', async () => {
  const w = await world();
  let approvals = 0;
  try {
    w.controls.beforeGet = async (count) => {
      if (count === 1) await writeFile(w.configPath, JSON.stringify({ auto_approve: false }));
    };
    await runEvent(
      w.env,
      async (input) => {
        if (!input.automatic_approval_forbidden) approvals++;
        return decision(input);
      },
      { output, scheduleHeartbeat: () => () => {} },
    );
    assert.equal(approvals, 0);
    assert.equal(await new EpisodeStore(w.directory).approval('agy', 's1'), null);
  } finally {
    await w.close();
  }
});

test('pending last approval validation cannot invoke keys after another instance confirms pause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-final-pause-'));
  const entered = deferred<void>(),
    resume = deferred<void>();
  let arm = 0,
    keys = 0;
  const reading = new Set<string>();
  const state = new WorkflowState(root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path.endsWith('/heartbeat.json')) {
          reading.add(path);
          const close = handle.close.bind(handle);
          handle.close = async () => {
            try {
              await close();
            } finally {
              reading.delete(path);
            }
          };
        }
        return handle;
      },
      lstat: async (path) => {
        const info = await lstat(path);
        // Count complete lease inspections, not the new post-read inode check.
        if (arm > 0 && !reading.has(path) && path.endsWith('/heartbeat.json') && --arm === 0) {
          entered.resolve();
          await resume.promise;
        }
        return info;
      },
    },
  });
  const attempt = start(state);
  let work: Promise<void> | undefined;
  try {
    const authority = await attempt.ready;
    assert.ok(authority);
    const episodes = new EpisodeStore(root);
    const deps = workflowEventDeps(
      {
        herdr: {
          get: async () => snapshot(),
          read: async () => {
            if ((await episodes.approval('agy', 's1'))?.state === 'uncertain') arm = 2;
            return {
              pane_id: 'w1:p1',
              source: 'detection',
              revision: 0,
              text: dialog,
              truncated: false,
            };
          },
          sendKeys: async () => {
            keys++;
          },
        },
        store: episodes,
        autoApprove: true,
        targets: 'all',
        clock: { now: () => new Date() },
        decide: (input) => decision(input),
        handoff: async () => {},
      },
      authority,
      state,
    );
    work = handleEvent(event, deps);
    await within(entered.promise, 2000);
    assert.equal(await new WorkflowState(root).pause(scope.serverId), 'paused');
    resume.resolve();
    await within(work, 2000);
    assert.equal(keys, 0);
    assert.equal((await episodes.approval('agy', 's1'))?.state, 'uncertain');
  } finally {
    resume.resolve();
    await work?.catch(() => {});
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const restricted of [false, true])
  for (const boundary of ['pause', 'generation', 'closed'] as const) {
    test(`permission assessment loses ${boundary} admission without state effects (restricted=${restricted})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'steward-permission-boundary-'));
      const state = new WorkflowState(root);
      const attempt = start(state);
      const entered = deferred<void>(),
        resume = deferred<void>();
      let replacement: ReturnType<typeof start> | undefined;
      let work: Promise<void> | undefined;
      let calls = 0,
        effects = 0;
      try {
        const authority = await attempt.ready;
        assert.ok(authority);
        const episodes = new EpisodeStore(root);
        const deps = workflowEventDeps(
          {
            herdr: {
              get: async () => snapshot(),
              read: async () => ({
                pane_id: 'w1:p1',
                source: 'detection',
                revision: 0,
                text: restricted ? dialog : 'Requesting permission for:\n echo local-test',
                truncated: false,
                ...(restricted ? { context_restricted: true as const } : {}),
              }),
              sendKeys: async () => {
                effects++;
              },
              prompt: async () => {
                effects++;
              },
            },
            store: episodes,
            autoApprove: true,
            targets: 'all',
            clock: { now: () => new Date() },
            decide: async (input) => {
              calls++;
              entered.resolve();
              await resume.promise;
              return decision(input);
            },
            handoff: async () => {
              effects++;
            },
          },
          authority,
          state,
        );
        work = handleEvent(event, deps);
        await within(entered.promise);
        if (boundary === 'closed') attempt.close();
        else {
          assert.equal(await new WorkflowState(root).pause(scope.serverId), 'paused');
          if (boundary === 'generation') {
            assert.equal(await new WorkflowState(root).resume(scope.serverId, true), 'resumed');
            replacement = start(state);
            assert.ok(await replacement.ready);
          }
        }
        resume.resolve();
        await within(work);
        assert.equal(calls, 1);
        assert.equal(effects, 0);
        assert.equal(await state.sessionRetry(scope), null);
        assert.equal(await episodes.approval('agy', 's1'), null);
      } finally {
        resume.resolve();
        await work?.catch(() => {});
        attempt.close();
        replacement?.close();
        await attempt.finish();
        await replacement?.finish();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

for (const provenance of ['paused', 'terminal', 'association', 'old-server'] as const)
  test(`ordinary recovery classifies but refuses canonical ${provenance} provenance before write`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'steward-final-provenance-'));
    const state = new WorkflowState(root);
    const first = start(state, true);
    let second: ReturnType<typeof start> | undefined;
    try {
      const authority = await first.ready;
      assert.ok(authority);
      const episodes = new EpisodeStore(root);
      let prompts = 0,
        decisions = 0;
      const herdr = {
        get: async () => snapshot(),
        read: async () => ({
          pane_id: 'w1:p1',
          source: 'detection' as const,
          revision: 0,
          text: 'Current API failure: request timed out',
          truncated: false,
        }),
        prompt: async () => {
          prompts++;
        },
      };
      const observed = await observeStop(herdr, 'w1:p1');
      assert.ok(observed);
      const now = new Date();
      await episodes.recordSessionRetry('agy', 's1', {
        pane_id: 'w1:p1',
        session_id: 's1',
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: new Date(now.getTime() - 60000).toISOString(),
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
        next_check_at: new Date(now.getTime() - 30000).toISOString(),
        last_delivery_state: 'none',
      });
      const binding = await state.binding(scope);
      assert.ok(binding);
      await state.recordBinding({
        ...binding,
        phase: 'pending',
        failureEpisodeId: observed.current_episode_id,
      });
      let selected = authority;
      if (provenance === 'paused') {
        assert.equal(await new WorkflowState(root).pause(scope.serverId), 'paused');
        first.close();
        await first.finish();
        assert.equal(await new WorkflowState(root).resume(scope.serverId, true), 'resumed');
        second = start(state, true);
        selected = (await second.ready)!;
        assert.ok(selected);
      } else if (provenance === 'terminal')
        await state.recordBinding({
          ...binding,
          failureEpisodeId: observed.current_episode_id,
          phase: 'terminal',
          reason: 'canceled',
        });
      else if (provenance === 'association')
        await writeFile(
          join(root, `retry-session-${createHash('sha256').update('["agy","s1"]').digest('hex')}.association-guard`),
          '',
          { mode: 0o600 },
        );
      else {
        second = start(state, true, { ...scope, serverId: '47:2' });
        selected = (await second.ready)!;
        assert.ok(selected);
      }
      assert.equal(await state.recoveryQuarantined(selected.scope), true);
      const before = await episodes.sessionRetry('agy', 's1');
      await handleEvent(
        event,
        workflowEventDeps(
          {
            herdr,
            store: episodes,
            targets: 'all',
            autoApprove: false,
            clock: { now: () => now },
            handoff: async () => {},
            decide: (input) => {
              decisions++;
              return decision(input, 'recoverable_api_error', now);
            },
          },
          selected,
          state,
        ),
      );
      assert.equal(decisions, 1);
      assert.equal(prompts, 0);
      assert.deepEqual(await episodes.sessionRetry('agy', 's1'), before);
      let keys = 0,
        assessments = 0;
      await handleEvent(
        event,
        workflowEventDeps(
          {
            herdr: {
              ...herdr,
              read: async () => ({
                pane_id: 'w1:p1',
                source: 'detection',
                revision: 0,
                text: dialog,
                truncated: false,
              }),
              sendKeys: async () => {
                keys++;
              },
            },
            store: episodes,
            autoApprove: true,
            targets: 'all',
            clock: { now: () => now },
            handoff: async () => {},
            decide: (input) => {
              assessments++;
              return decision(input);
            },
          },
          selected,
          state,
        ),
      );
      assert.equal(assessments, 1);
      assert.equal(keys, 1);
      assert.deepEqual(await episodes.sessionRetry('agy', 's1'), before);
    } finally {
      first.close();
      second?.close();
      await first.finish();
      await second?.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

const apiFailure = {
  pane_id: 'w1:p1',
  source: 'detection' as const,
  revision: 0,
  text: 'Current API failure: request timed out',
  truncated: false,
};
const retrySessionHash = () =>
  createHash('sha256')
    .update(JSON.stringify(['agy', 's1']))
    .digest('hex');

test('pause before pending-binding publication cannot resurrect the canceled deadline after resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-final-c2-facade-'));
  const state = new WorkflowState(root);
  const first = start(state, false);
  let second: ReturnType<typeof start> | undefined;
  let at = new Date('2026-10-05T12:00:00Z');
  let prompts = 0,
    decisions = 0;
  const handoffs: string[] = [];
  try {
    const authority = await first.ready;
    assert.ok(authority);
    const episodes = new EpisodeStore(root);
    const herdr = {
      get: async () => snapshot(),
      read: async () => apiFailure,
      prompt: async () => {
        prompts++;
      },
    };
    const depsFor = (selected: NonNullable<Awaited<ReturnType<typeof start>['ready']>>) =>
      workflowEventDeps(
        {
          herdr,
          store: episodes,
          targets: 'all',
          autoApprove: false,
          clock: { now: () => at },
          handoff: async (reason) => {
            handoffs.push(reason);
          },
          decide: (input) => {
            decisions++;
            return decision(input, 'recoverable_api_error', at);
          },
        },
        selected,
        state,
      );
    await handleEvent(event, depsFor(authority));
    const pending = await episodes.sessionRetry('agy', 's1');
    assert.ok(pending?.next_check_at);
    assert.equal(pending.last_delivery_state, 'none');
    assert.equal(pending.attempt_count, 0);
    assert.equal(prompts, 0);
    assert.equal((await state.binding(scope))?.phase, 'observing');
    assert.equal(await new WorkflowState(root).pause(scope.serverId), 'paused');
    assert.equal(await new WorkflowState(root).matches(authority.ticket), false);
    first.close();
    await first.finish();
    assert.equal(await new WorkflowState(root).resume(scope.serverId, true), 'resumed');
    at = new Date(at.getTime() + 31_000);
    second = start(state, false);
    const resumed = await second.ready;
    assert.ok(resumed);
    assert.notEqual(resumed.ticket.epoch, authority.ticket.epoch);
    const beforeDecisions = decisions;
    await handleEvent(event, depsFor(resumed));
    const after = await episodes.sessionRetry('agy', 's1');
    assert.equal(prompts, 0);
    assert.equal(decisions, beforeDecisions + 1);
    assert.equal(after?.last_delivery_state, 'none');
    assert.equal(after?.attempt_count, 0);
    assert.deepEqual(after?.next_check_at, pending.next_check_at);
    assert.deepEqual(handoffs, []);
  } finally {
    first.close();
    second?.close();
    await first.finish();
    await second?.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('first canonical API deadline write publishes provenance so the same unpaused invocation can still wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-final-c2-unpaused-'));
  const state = new WorkflowState(root);
  const attempt = start(state, false);
  let at = new Date('2026-10-05T12:00:00Z');
  let waits = 0;
  try {
    const authority = await attempt.ready;
    assert.ok(authority);
    const episodes = new EpisodeStore(root);
    const herdr = {
      get: async () => snapshot(),
      read: async () => apiFailure,
      prompt: async () => {
        throw new Error('unpaused wait must not send recovery input');
      },
    };
    const base = {
      herdr,
      store: episodes,
      targets: 'all' as const,
      autoApprove: false,
      clock: { now: () => at },
      handoff: async () => {},
      decide: (input: StopInput) => decision(input, 'recoverable_api_error', at),
    };
    await handleEvent(event, workflowEventDeps(base, authority, state));
    const pending = await episodes.sessionRetry('agy', 's1');
    assert.ok(pending?.next_check_at);
    const recorded = JSON.parse(
      await readFile(join(root, `retry-session-${retrySessionHash()}.binding.json`), 'utf8'),
    ) as { phase: string; epoch: string; failureEpisodeId: string | null };
    assert.equal(recorded.phase, 'pending');
    assert.equal(recorded.epoch, authority.ticket.epoch);
    assert.equal(recorded.failureEpisodeId, pending.failure_episode_id);
    const result = await runEpisodeJob({
      state,
      authority,
      episodes,
      deps: base,
      binding: (await state.binding(scope))!,
      signal: attempt.signal,
      wait: async (deadline) => {
        waits++;
        assert.equal(deadline.toISOString(), pending.next_check_at);
        assert.equal(await new WorkflowState(root).pause(scope.serverId), 'paused');
      },
    });
    assert.equal(waits, 1);
    assert.ok(result === 'stopped' || result === 'finished');
    assert.equal((await episodes.sessionRetry('agy', 's1'))?.last_delivery_state, 'none');
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('runEvent does not wait a pre-promotion canceled deadline after pause/resume', async () => {
  const script = fileURLToPath(new URL('./herdr-c2-pre-promotion-window.ts', import.meta.url));
  const running = await child([script], process.env);
  try {
    const result = await within(running.result, 8000);
    assert.equal(result.code, 0, result.stderr || result.stdout);
  } finally {
    running.stop();
  }
}, 10000);

for (const kind of ['association-guard', 'quarantine-marker', 'malformed-reference'] as const)
  test(`unsafe ${kind} hands off once without enabling recovery`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'steward-final-n1-handoff-'));
    const state = new WorkflowState(root);
    const attempt = start(state, false);
    let prompts = 0,
      decisions = 0;
    const handoffs: string[] = [];
    try {
      const authority = await attempt.ready;
      assert.ok(authority);
      const episodes = new EpisodeStore(root);
      const prefix = `retry-session-${retrySessionHash()}`;
      if (kind === 'association-guard')
        await writeFile(join(root, `${prefix}.association-guard`), '', {
          mode: 0o600,
        });
      else if (kind === 'quarantine-marker')
        await writeFile(
          join(root, `${prefix}.quarantine.json`),
          JSON.stringify({
            protocol: 1,
            agent: 'agy',
            sessionId: 's1',
            quarantined: true,
          }),
          { mode: 0o600 },
        );
      else
        await writeFile(join(root, `${prefix}.binding.json`), '{', {
          mode: 0o600,
        });
      assert.equal(await state.recoveryQuarantined(scope), true);
      assert.equal(await episodes.sessionRetry('agy', 's1'), null);
      await handleEvent(
        event,
        workflowEventDeps(
          {
            herdr: {
              get: async () => snapshot(),
              read: async () => apiFailure,
              prompt: async () => {
                prompts++;
              },
            },
            store: episodes,
            targets: 'all',
            autoApprove: false,
            clock: { now: () => new Date() },
            handoff: async (reason) => {
              handoffs.push(reason);
            },
            decide: (input) => {
              decisions++;
              return decision(input, 'recoverable_api_error');
            },
          },
          authority,
          state,
        ),
      );
      assert.equal(decisions, 1);
      assert.equal(prompts, 0);
      assert.deepEqual(handoffs, ['human_review_required']);
      assert.equal(await episodes.sessionRetry('agy', 's1'), null);
      assert.equal(authority.admissionOpen(), true);
      assert.equal(await authority.valid(), true);
    } finally {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

for (const kind of ['replaced-session', 'replaced-source', 'paused-denied'] as const)
  test(`${kind} recovery denial stays silent and sends no input`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'steward-final-n1-silent-'));
    const state = new WorkflowState(root);
    const attempt = start(state, false);
    let prompts = 0,
      decisions = 0,
      keys = 0;
    const handoffs: string[] = [];
    try {
      const authority = await attempt.ready;
      assert.ok(authority);
      const episodes = new EpisodeStore(root);
      await writeFile(join(root, `retry-session-${retrySessionHash()}.association-guard`), '', { mode: 0o600 });
      if (kind === 'paused-denied') assert.equal(await new WorkflowState(root).pause(scope.serverId), 'paused');
      const pane =
        kind === 'replaced-session'
          ? {
              ...snapshot(),
              agent_session: {
                ...snapshot().agent_session!,
                value: 'replacement-s2',
              },
            }
          : kind === 'replaced-source'
            ? {
                ...snapshot(),
                agent_session: {
                  ...snapshot().agent_session!,
                  source: 'herdr:other',
                },
              }
            : snapshot();
      await handleEvent(
        event,
        workflowEventDeps(
          {
            herdr: {
              get: async () => pane,
              read: async () => ({
                ...apiFailure,
                pane_id: pane.pane_id,
              }),
              prompt: async () => {
                prompts++;
              },
              sendKeys: async () => {
                keys++;
              },
            },
            store: episodes,
            targets: 'all',
            autoApprove: false,
            clock: { now: () => new Date() },
            handoff: async (reason) => {
              handoffs.push(reason);
            },
            decide: (input) => {
              decisions++;
              return decision(input, 'recoverable_api_error');
            },
          },
          authority,
          state,
        ),
      );
      assert.equal(decisions, 0);
      assert.equal(prompts, 0);
      assert.equal(keys, 0);
      assert.deepEqual(handoffs, []);
      assert.equal(await episodes.sessionRetry('agy', 's1'), null);
    } finally {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

test('real producer heartbeat replacement during lstat/open retains the captured generation and slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-final-heartbeat-'));
  const entered = deferred<void>(),
    resume = deferred<void>(),
    renewed = deferred<void>();
  let hold = false,
    beat = () => {},
    clock = 10000;
  const state = new WorkflowState(root, () => clock, {
    io: {
      lstat: async (path) => {
        const info = await lstat(path);
        if (hold && path.includes('/workflows/') && path.endsWith('/heartbeat.json')) {
          hold = false;
          entered.resolve();
          await resume.promise;
        }
        return info;
      },
      rename: async (from, to) => {
        await rename(from, to);
        if (clock === 20000 && to.endsWith('/heartbeat.json')) renewed.resolve();
      },
    },
  });
  const attempt = start(state, false, scope, (tick) => {
    beat = tick;
    return () => {};
  });
  let slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const authority = await attempt.ready;
    assert.ok(authority);
    const episodes = new EpisodeStore(root);
    await episodes.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'a'.repeat(64),
      error_evidence_digest: 'b'.repeat(64),
      first_observed_at: '2026-10-05T00:00:00Z',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2099-01-01T00:00:00Z',
      last_delivery_state: 'none',
    });
    await state.recordBinding({
      ...(await state.binding(scope))!,
      phase: 'pending',
      failureEpisodeId: 'a'.repeat(64),
    });
    hold = true;
    slot = reserveJobSlot(state, authority);
    await within(entered.promise);
    clock = 20000;
    beat();
    await within(renewed.promise);
    resume.resolve();
    const job = await slot.ready;
    assert.ok(job);
    assert.equal(authority.signal.aborted, false);
    assert.equal(await job.valid(), true);
  } finally {
    resume.resolve();
    slot?.close();
    await slot?.finish();
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const invalid of ['released', 'expired', 'unknown'] as const)
  test(`located exit refuses ${invalid} captured generation without canonical mutation`, async () => {
    const w = await world();
    let clock = Date.now();
    let alive: boolean | null = true;
    const state = new WorkflowState(w.directory, () => clock, {
      alive: () => alive,
    });
    const selected = { ...scope, serverId: w.serverId };
    const attempt = start(state, false, selected);
    try {
      const authority = await attempt.ready;
      assert.ok(authority);
      const episodes = new EpisodeStore(w.directory);
      await episodes.recordSessionRetry('agy', 's1', {
        pane_id: 'w1:p1',
        session_id: 's1',
        failure_episode_id: 'a'.repeat(64),
        error_evidence_digest: 'b'.repeat(64),
        first_observed_at: new Date(clock).toISOString(),
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
        next_check_at: '2099-01-01T00:00:00Z',
        last_delivery_state: 'none',
      });
      await state.recordBinding({
        ...(await state.binding(selected))!,
        phase: 'pending',
        failureEpisodeId: 'a'.repeat(64),
      });
      const before = await episodes.sessionRetry('agy', 's1');
      if (invalid === 'released') await state.lease(selected).release(authority.generation);
      if (invalid === 'expired') clock += 15001;
      if (invalid === 'unknown') alive = null;
      w.controls.pane = null;
      await runEvent(
        {
          ...w.env,
          HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
            type: 'pane.exited',
            pane_id: 'w1:p1',
          }),
        },
        async () => {
          throw new Error('exit classification forbidden');
        },
        { state, output },
      );
      assert.deepEqual(await episodes.sessionRetry('agy', 's1'), before);
    } finally {
      attempt.close();
      await attempt.finish();
      await w.close();
    }
  });

async function pauseProcess(root: string) {
  const module = fileURLToPath(new URL('../src/herdr-adapter/workflow-state.ts', import.meta.url));
  const running = await child([
    '--eval',
    `import { WorkflowState } from ${JSON.stringify(module)}; console.log(await new WorkflowState(${JSON.stringify(root)}).pause('47:1'));`,
  ]);
  try {
    const result = await within(running.result, 2000);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  } finally {
    running.stop();
  }
}

for (const kind of ['approval', 'ordinary-recovery', 'job-recovery'] as const)
  test(`${kind} raw final validation reserves dispatch across processes but never joins input acknowledgment`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'steward-final-dispatch-'));
    const entered = deferred<void>(),
      resume = deferred<void>(),
      invoked = deferred<void>(),
      ack = deferred<void>();
    let armed = false,
      guarded = false,
      held = false,
      inputs = 0;
    const episodes = new EpisodeStore(root);
    const state = new WorkflowState(root, undefined, {
      io: {
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          if (armed && path.endsWith('/effect-guard')) {
            const uncertain =
              kind === 'approval'
                ? (await episodes.approval('agy', 's1'))?.state === 'uncertain'
                : (await episodes.sessionRetry('agy', 's1'))?.last_delivery_state === 'uncertain';
            if (uncertain) guarded = true;
          }
          return handle;
        },
        lstat: async (path) => {
          if (guarded && !held && path.endsWith('/released')) {
            held = true;
            entered.resolve();
            await resume.promise;
          }
          return lstat(path);
        },
      },
    });
    const attempt = start(state);
    let work: Promise<unknown> | undefined;
    try {
      const authority = await attempt.ready;
      assert.ok(authority);
      const now = new Date();
      const input = async () => {
        inputs++;
        invoked.resolve();
        await ack.promise;
      };
      const herdr = {
        get: async () => snapshot(),
        read: async () => ({
          pane_id: 'w1:p1',
          source: 'detection' as const,
          revision: 0,
          text: kind === 'approval' ? dialog : 'Current API failure: request timed out',
          truncated: false,
        }),
        sendKeys: input,
        prompt: input,
      };
      if (kind !== 'approval') {
        const seen = await observeStop(herdr, 'w1:p1');
        assert.ok(seen);
        await episodes.recordSessionRetry('agy', 's1', {
          pane_id: 'w1:p1',
          session_id: 's1',
          failure_episode_id: seen.current_episode_id,
          error_evidence_digest: seen.error_evidence_digest,
          first_observed_at: new Date(now.getTime() - 60000).toISOString(),
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 0,
          last_quota_check_at: null,
          next_check_at: new Date(now.getTime() - 30000).toISOString(),
          last_delivery_state: 'none',
        });
        await state.recordBinding({
          ...(await state.binding(scope))!,
          phase: 'pending',
          failureEpisodeId: seen.current_episode_id,
        });
      }
      const base = {
        herdr,
        store: episodes,
        autoApprove: true,
        targets: 'all' as const,
        clock: { now: () => now },
        decide: (request: StopInput) =>
          decision(request, kind === 'approval' ? 'approve_command' : 'recoverable_api_error', now),
        handoff: async () => {},
      };
      armed = true;
      work =
        kind === 'job-recovery'
          ? runEpisodeJob({
              state,
              authority,
              episodes,
              deps: base,
              binding: (await state.binding(scope))!,
              signal: attempt.signal,
            })
          : handleEvent(event, workflowEventDeps(base, authority, state));
      await within(entered.promise, 2000);
      assert.equal(inputs, 0);
      assert.equal(await pauseProcess(root), 'shutdown_incomplete');
      resume.resolve();
      await within(invoked.promise, 2000);
      // Guards end at actual transport invocation, while its acknowledgment is held.
      const controlGuard = join(
        root,
        'automation',
        createHash('sha256').update('["47:1"]').digest('hex'),
        'control-guard',
      );
      await within(
        (async () => {
          for (;;) {
            try {
              await lstat(controlGuard);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        })(),
        2000,
      );
      assert.equal(await pauseProcess(root), 'paused');
      assert.equal(inputs, 1);
      ack.resolve();
      await within(work, 2000);
      if (kind === 'approval') assert.equal((await episodes.approval('agy', 's1'))?.state, 'uncertain');
      else assert.equal((await episodes.sessionRetry('agy', 's1'))?.last_delivery_state, 'uncertain');
    } finally {
      resume.resolve();
      ack.resolve();
      await work?.catch(() => {});
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });

async function child(args: string[], env: NodeJS.ProcessEnv = {}) {
  const processChild = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  processChild.stdout.on('data', (data) => {
    stdout += data;
  });
  processChild.stderr.on('data', (data) => {
    stderr += data;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('close', resolve);
  });
  return {
    result: closed.then((code) => ({ code, stdout, stderr })),
    stop: () => processChild.kill('SIGKILL'),
  };
}

for (const refusal of ['corrupt', 'unsafe', 'missing', 'disabled'] as const)
  test(`native control CLI reports ${refusal} refusal as distinct nonzero failure`, async () => {
    const w = await world();
    let processChild: Awaited<ReturnType<typeof child>> | undefined;
    try {
      const state = new WorkflowState(w.directory);
      assert.ok(await state.capture(w.serverId, true));
      const control = join(
        w.directory,
        'automation',
        createHash('sha256')
          .update(JSON.stringify([w.serverId]))
          .digest('hex'),
        'control.json',
      );
      if (refusal === 'corrupt') await writeFile(control, '{bad-json');
      if (refusal === 'unsafe') await chmod(w.directory, 0o777);
      if (refusal === 'disabled') w.controls.enabled = false;
      const env: NodeJS.ProcessEnv = { ...w.env };
      if (refusal === 'missing') delete env.HERDR_PLUGIN_ROOT;
      const before = await readFile(control, 'utf8');
      processChild = await child(
        [
          fileURLToPath(new URL('../src/herdr-adapter/entry.ts', import.meta.url)),
          refusal === 'disabled' ? 'resume' : 'pause',
        ],
        env,
      );
      const result = await within(processChild.result, 3000);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'agent-steward: control denied; no change confirmed. Human review required.\n');
      assert.equal(await readFile(control, 'utf8'), before);
    } finally {
      processChild?.stop();
      await chmod(w.directory, 0o700);
      await w.close();
    }
  });

test('denied reporter does not mislabel a refusal as shutdown timeout', () => {
  let text = '',
    failures = 0;
  reportWorkflowResult('denied', {
    write: (value) => {
      text += value;
    },
    fail: () => {
      failures++;
    },
  });
  assert.equal(failures, 1);
  assert.equal(text, 'agent-steward: control denied; no change confirmed. Human review required.\n');
});

test('native control context and publication consume one five-second result budget', async () => {
  const w = await world();
  const entered = deferred<void>(),
    resume = deferred<void>(),
    settled = deferred<void>();
  try {
    w.controls.beforePlugin = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1700));
    };
    const state = new WorkflowState(w.directory, undefined, {
      io: {
        rename: async (from, to) => {
          if (to.endsWith('/control.json')) {
            entered.resolve();
            await resume.promise;
          }
          await rename(from, to);
          settled.resolve();
        },
      },
    });
    const began = performance.now();
    const running = runControl(w.env, 'pause', { state });
    await within(entered.promise, 2500);
    const result = await running;
    const elapsed = performance.now() - began;
    resume.resolve();
    await within(settled.promise);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(result, 'shutdown_incomplete');
    assert.ok(elapsed >= 4900 && elapsed < 5500, `elapsed ${elapsed}ms`);
  } finally {
    resume.resolve();
    await w.close();
  }
}, 10000);

test('held native control context refuses without publication and ignores its late reply', async () => {
  const w = await world();
  const entered = deferred<void>(),
    resume = deferred<void>();
  try {
    w.controls.beforePlugin = async () => {
      entered.resolve();
      await resume.promise;
    };
    const began = performance.now();
    const running = runControl(w.env, 'pause');
    await within(entered.promise);
    assert.equal(await running, 'denied');
    assert.ok(performance.now() - began < 3000);
    resume.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(lstat(join(w.directory, 'automation')), {
      code: 'ENOENT',
    });
  } finally {
    resume.resolve();
    await w.close();
  }
});

test('eight independent diagnostic writers retain every record across healthy contention and rotation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-final-diagnostic-'));
  const entered = deferred<void>(),
    resume = deferred<void>();
  const writers: Awaited<ReturnType<typeof child>>[] = [];
  const reservation = withPrivateGuard(root, 'workflow-log-guard', async () => {
    entered.resolve();
    await resume.promise;
  });
  try {
    await entered.promise;
    const record = {
      at: '2026-10-05T12:00:00Z',
      scopeHash: 'a'.repeat(64),
      outcome: 'created',
      reason: null,
    };
    const line = JSON.stringify(record) + '\n';
    await writeFile(join(root, 'workflow.log'), line.repeat(Math.floor(1048576 / Buffer.byteLength(line))), {
      mode: 0o600,
    });
    const module = fileURLToPath(new URL('../src/herdr-adapter/diagnostics.ts', import.meta.url));
    for (let index = 0; index < 8; index++)
      writers.push(
        await child([
          '--eval',
          `import { appendDiagnostic } from ${JSON.stringify(module)}; console.log('started'); await appendDiagnostic(${JSON.stringify(root)}, ${JSON.stringify({ ...record, scopeHash: String(index).repeat(64), outcome: 'finished', reason: 'completed' })});`,
        ]),
      );
    await new Promise((resolve) => setTimeout(resolve, 150));
    resume.resolve();
    await reservation;
    for (const writer of writers) {
      const result = await within(writer.result, 3000);
      assert.equal(result.code, 0, result.stderr);
    }
    const records = (await readFile(join(root, 'workflow.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).scopeHash);
    assert.deepEqual(
      records.sort(),
      Array.from({ length: 8 }, (_, index) => String(index).repeat(64)),
    );
    assert.ok((await readFile(join(root, 'workflow.log.1'), 'utf8')).includes('a'.repeat(64)));
  } finally {
    resume.resolve();
    await reservation;
    for (const writer of writers) writer.stop();
    await rm(root, { recursive: true, force: true });
  }
});
