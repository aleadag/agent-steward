import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginWorkflow, reserveJobSlot } from '../src/herdr-adapter/authority.ts';
import { handleEvent, workflowEventDeps } from '../src/herdr-adapter/events.ts';
import { observeStop, type AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { WorkflowState, type WorkflowScope } from '../src/herdr-adapter/workflow-state.ts';
import { assessStop } from '../src/triage.ts';
import type { Evaluation } from '../src/jev.ts';
import { runEpisodeJob } from '../src/herdr-adapter/jobs.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

async function fixture(agent: 'pi' | 'codex' | 'agy' = 'pi') {
  const root = await mkdtemp(join(tmpdir(), 'steward-generic-recovery-'));
  const state = new WorkflowState(root);
  const episodes = new EpisodeStore(root);
  const scope: WorkflowScope = {
    serverId: '47:1',
    agent,
    sessionId: 's1',
    sessionKind: agent === 'pi' ? 'path' : 'id',
    sessionSource: agent === 'agy' ? 'herdr:antigravity_cli' : `herdr:${agent}`,
  };
  let pane: AgentSnapshot = {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent,
    agent_status: 'idle',
    agent_session: { agent, kind: scope.sessionKind, source: scope.sessionSource, value: 's1' },
    revision: 1,
    state_change_seq: 1,
  };
  let text = 'Current API failure: request timed out';
  let choice = 'recoverable_api_error';
  let now = new Date('2026-10-07T00:00:00Z');
  let decisions = 0;
  const prompts: string[] = [];
  const handoffs: string[] = [];
  let beat = () => {};
  let beforeDecision = async () => {};
  let transport = async () => {};
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: pane.pane_id,
    workspaceId: pane.workspace_id,
    permission: async () => ({ serverId: scope.serverId, enabled: true, targets: 'all', autoApprove: false }),
    signal: new AbortController().signal,
    scheduleHeartbeat: (tick) => {
      beat = tick;
      return () => {
        beat = () => {};
      };
    },
  });
  const authority = await attempt.ready;
  assert.ok(authority);
  const herdr = {
    get: async () => pane,
    read: async () => ({ pane_id: pane.pane_id, source: 'detection', revision: pane.revision, text, truncated: false }),
    prompt: async (_pane: string, instruction: string) => {
      prompts.push(instruction);
      await transport();
    },
  };
  const deps = workflowEventDeps(
    {
      herdr,
      store: episodes,
      targets: 'all',
      clock: { now: () => now },
      handoff: async (reason) => {
        handoffs.push(reason);
      },
      decide: async (input) => {
        decisions++;
        const selectedChoice = choice;
        await beforeDecision();
        return assessStop(input, {
          thresholds: { risky: 0.6, choiceConfidence: 0.45 },
          now,
          evaluate: async () =>
            ({
              model: 'jev-1.13.0',
              usage: {},
              answers: {
                waiting_for: {
                  type: 'choice',
                  choice: selectedChoice,
                  confidence: 0.9,
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
                    [selectedChoice]: 0.9,
                  },
                },
                risky: { type: 'noul', noul: 0.1 },
              },
            }) as Evaluation,
        });
      },
    },
    authority,
    state,
  );
  const stop = (due = false) =>
    handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: pane.pane_id,
        workspace_id: pane.workspace_id,
        agent,
        agent_status: pane.agent_status,
      },
      deps,
      due,
    );
  const change = (nextChoice = 'recoverable_api_error') => {
    choice = nextChoice;
    text =
      nextChoice === 'completed'
        ? 'Task completed successfully. No work remains.'
        : 'Current API failure: request timed out';
    pane = { ...pane, revision: pane.revision + 1, state_change_seq: pane.state_change_seq + 1 };
  };
  return {
    root,
    state,
    episodes,
    scope,
    authority,
    herdr,
    deps,
    signal: attempt.signal,
    close: () => attempt.close(),
    beat: () => beat(),
    menu: () => {
      text = 'Requesting permission for:\n echo local-test';
      pane = { ...pane, revision: pane.revision + 1, state_change_seq: pane.state_change_seq + 1 };
    },
    stop,
    change,
    prompts,
    handoffs,
    restore: (saved: AgentSnapshot, savedText: string) => {
      pane = saved;
      text = savedText;
      choice = 'recoverable_api_error';
    },
    decisions: () => decisions,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    beforeDecision: (fn: () => Promise<void>) => {
      beforeDecision = fn;
    },
    transport: (fn: () => Promise<void>) => {
      transport = fn;
    },
    finish: async () => {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Removing fresh classification or preserving session-wide terminal suppression breaks this test.
for (const agent of ['pi', 'codex', 'agy'] as const)
  test(`${agent}: classified completion re-arms future recovery without touching old quarantine`, async () => {
    const f = await fixture(agent);
    try {
      const observed = await observeStop(f.herdr, 'w1:p1');
      assert.ok(observed);
      const old: Episode = {
        pane_id: 'w1:p1',
        session_id: 's1',
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: '2026-10-06T00:00:00Z',
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
        next_check_at: null,
        last_delivery_state: 'human',
      };
      await f.episodes.record('w1:p1', old);
      assert.equal(await f.state.adoptLegacyRetry(f.episodes, f.scope, observed), 'quarantined');
      const prefix = `retry-session-${createHash('sha256')
        .update(JSON.stringify([agent, 's1']))
        .digest('hex')}`;
      const marker = join(f.root, `${prefix}.quarantine.json`);
      const legacy = join(f.root, createHash('sha256').update('w1:p1').digest('hex') + '.json');
      const before = await Promise.all([readFile(marker), readFile(legacy)]);
      f.change('completed');
      await f.stop();
      assert.equal(f.decisions(), 1, 'old quarantine must not suppress current completion classification');
      assert.deepEqual(f.handoffs, [], 'successful re-arming must not emit a false human handoff');
      f.change();
      await f.stop();
      assert.equal((await f.state.sessionRetry(f.scope))?.attempt_count, 0);
      f.advance(30_000);
      await f.stop(true);
      assert.equal(f.prompts.length, 1);
      assert.equal((await f.state.sessionRetry(f.scope))?.attempt_count, 1);
      assert.deepEqual(await Promise.all([readFile(marker), readFile(legacy)]), before);
    } finally {
      await f.finish();
    }
  });

// Resetting on idle/revision changes or failing to carry budgets breaks this test.
test('unresolved failures share three attempts, then fresh classified completion starts a new budget', async () => {
  const f = await fixture();
  try {
    for (const [index, delay] of [30_000, 120_000, 480_000].entries()) {
      if (index) f.change();
      await f.stop();
      f.advance(delay);
      await f.stop(true);
      assert.equal(f.prompts.length, index + 1);
      assert.equal((await f.state.sessionRetry(f.scope))?.attempt_count, index + 1);
      await f.stop();
      assert.equal(f.prompts.length, index + 1, 'the same stopped snapshot must not be replayed');
    }
    f.change();
    await f.stop();
    f.advance(600_000);
    await f.stop();
    assert.equal(f.prompts.length, 3);
    assert.equal((await f.state.sessionRetry(f.scope))?.attempt_count, 3);
    f.change('completed');
    await f.stop();
    f.change();
    await f.stop();
    assert.equal((await f.state.sessionRetry(f.scope))?.attempt_count, 0);
    f.advance(30_000);
    await f.stop(true);
    assert.equal(f.prompts.length, 4);
  } finally {
    await f.finish();
  }
});

test('uncertain delivery remains blocked despite changed screens or a completed classification', async () => {
  const f = await fixture();
  try {
    f.transport(async () => {
      throw new Error('lost acknowledgment');
    });
    await f.stop();
    f.advance(30_000);
    await f.stop(true);
    const old = await f.state.sessionRetry(f.scope);
    assert.equal(old?.last_delivery_state, 'uncertain');
    f.change('completed');
    await f.stop();
    f.change();
    f.advance(600_000);
    await f.stop();
    assert.deepEqual(await f.state.sessionRetry(f.scope), old);
    assert.equal(f.prompts.length, 1);
  } finally {
    await f.finish();
  }
});

for (const completed of [false, true])
  test(`uncertain -> permission handoff -> later failure never replays (completed=${completed})`, async () => {
    const f = await fixture();
    try {
      f.transport(async () => {
        throw new Error('lost acknowledgment');
      });
      await f.stop();
      f.advance(30_000);
      await f.stop(true);
      const old = await f.state.sessionRetry(f.scope);
      assert.equal(old?.last_delivery_state, 'uncertain');
      f.menu();
      await f.stop();
      if (completed) {
        f.change('completed');
        await f.stop();
      }
      f.change();
      f.advance(600_000);
      await f.stop();
      assert.deepEqual(await f.state.sessionRetry(f.scope), old);
      assert.equal(f.prompts.length, 1);
    } finally {
      await f.finish();
    }
  });

test('the real quota job advances changed snapshots and services the next deadline', async () => {
  const f = await fixture();
  let waits = 0;
  try {
    f.change('quota_limit');
    await f.stop();
    await runEpisodeJob({
      state: f.state,
      authority: f.authority,
      episodes: f.episodes,
      deps: f.deps,
      binding: (await f.state.binding(f.scope))!,
      signal: f.signal,
      wait: async (deadline) => {
        waits++;
        if (waits === 1) {
          f.advance(300_000);
          f.change('quota_limit');
        } else {
          assert.equal(deadline.toISOString(), '2026-10-07T00:20:00.000Z');
          f.close();
        }
      },
    });
    assert.equal(waits, 2);
    assert.equal((await f.state.sessionRetry(f.scope))?.quota_check_count, 1);
    assert.equal(f.prompts.length, 0);
  } finally {
    await f.finish();
  }
});

test('a sleeping owner services a new stop published by an admitted second invocation', async () => {
  const f = await fixture();
  const waiting = deferred<void>(),
    wake = deferred<void>();
  let second: ReturnType<typeof beginWorkflow> | undefined;
  let running: Promise<unknown> | undefined;
  let waits = 0;
  try {
    f.change('quota_limit');
    await f.stop();
    running = runEpisodeJob({
      state: f.state,
      authority: f.authority,
      episodes: f.episodes,
      deps: f.deps,
      binding: (await f.state.binding(f.scope))!,
      signal: f.signal,
      wait: async (deadline) => {
        waits++;
        if (waits === 1) {
          waiting.resolve();
          await wake.promise;
        } else {
          assert.equal(deadline.toISOString(), '2026-10-07T00:20:00.000Z');
          f.close();
        }
      },
    });
    await within(waiting.promise);
    second = beginWorkflow({
      state: f.state,
      scope: f.scope,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      permission: async () => ({ serverId: f.scope.serverId, enabled: true, targets: 'all', autoApprove: false }),
      signal: new AbortController().signal,
      scheduleHeartbeat: () => () => {},
    });
    const admitted = await second.ready;
    assert.ok(admitted);
    assert.equal(admitted.ownsGeneration, false);
    f.change('quota_limit');
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' },
      workflowEventDeps(f.deps, admitted, f.state),
    );
    f.advance(300_000);
    wake.resolve();
    await within(running);
    assert.equal(waits, 2, 'the original owner must retain responsibility for the replacement timer');
    assert.equal((await f.state.sessionRetry(f.scope))?.quota_check_count, 1);
  } finally {
    wake.resolve();
    f.close();
    if (running) await within(running);
    second?.close();
    await second?.finish();
    await f.finish();
  }
});

test('a sleeping job observes a successor earlier deadline without waiting for its old timer', async () => {
  const f = await fixture();
  const firstWait = deferred<void>(),
    secondWait = deferred<void>();
  let running: Promise<unknown> | undefined;
  let waits = 0;
  try {
    f.change('quota_limit');
    await f.stop();
    running = runEpisodeJob({
      state: f.state,
      authority: f.authority,
      episodes: f.episodes,
      deps: f.deps,
      binding: (await f.state.binding(f.scope))!,
      signal: f.signal,
      wait: async (deadline, signal) => {
        waits++;
        if (waits === 1) {
          firstWait.resolve();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        } else {
          assert.equal(deadline.toISOString(), '2026-10-07T00:00:31.000Z');
          secondWait.resolve();
          f.close();
        }
      },
    });
    await within(firstWait.promise);
    f.change('completed');
    await f.stop();
    f.advance(1000);
    f.change();
    await f.stop();
    f.beat();
    await within(secondWait.promise);
    await within(running);
    assert.equal(waits, 2);
  } finally {
    f.close();
    if (running) await within(running);
    await f.finish();
  }
});

test('due quota reclassification carries checks across a changed stopped snapshot', async () => {
  const f = await fixture();
  try {
    f.change('quota_limit');
    await f.stop();
    const first = await f.state.sessionRetry(f.scope);
    assert.equal(first?.next_check_at, '2026-10-07T00:05:00.000Z');
    f.advance(300_000);
    f.change('quota_limit');
    await f.stop(true);
    const next = await f.state.sessionRetry(f.scope);
    assert.equal(next?.quota_check_count, 1);
    assert.equal(next?.first_observed_at, first.first_observed_at);
    assert.equal(next?.next_check_at, '2026-10-07T00:20:00.000Z');
    assert.equal(f.prompts.length, 0);
  } finally {
    await f.finish();
  }
});

test('classified completion closes a known no-input handoff after earlier confirmed retries', async () => {
  const f = await fixture();
  try {
    await f.stop();
    f.advance(30_000);
    await f.stop(true);
    f.change();
    await f.stop();
    f.change('permanent_error');
    f.advance(120_000);
    await f.stop(true);
    assert.equal((await f.state.sessionRetry(f.scope))?.last_delivery_state, 'human');
    f.change('completed');
    await f.stop();
    f.change();
    await f.stop();
    assert.equal((await f.state.sessionRetry(f.scope))?.attempt_count, 0);
    f.advance(30_000);
    await f.stop(true);
    assert.equal(f.prompts.length, 2);
  } finally {
    await f.finish();
  }
});

test('a previously attempted snapshot cannot obtain a fresh budget after completion', async () => {
  const f = await fixture();
  try {
    const saved = await f.herdr.get();
    const savedText = (await f.herdr.read()).text;
    await f.stop();
    f.advance(30_000);
    await f.stop(true);
    f.change('completed');
    await f.stop();
    f.restore(saved, savedText);
    try {
      await f.stop();
    } catch (error) {
      assert.equal((error as Error).message, 'invalid episode metadata');
    }
    f.advance(30_000);
    await f.stop(true);
    assert.equal(f.prompts.length, 1, 'an exact old snapshot is still tombstoned');
  } finally {
    await f.finish();
  }
});

test('partial first publication cannot be promoted after missing provenance is made readable', async () => {
  const f = await fixture();
  try {
    const prefix = `retry-session-${createHash('sha256').update('["pi","s1"]').digest('hex')}`;
    const fault = join(f.root, `${prefix}.binding.json`);
    // Fail only provenance publication, after the real private stop record and selector writes.
    const publish = f.state.publishPendingRecoveryProvenance.bind(f.state);
    f.state.publishPendingRecoveryProvenance = async (...args) => {
      await mkdir(fault, { mode: 0o700 });
      await publish(...args);
    };
    await assert.rejects(f.stop());
    f.state.publishPendingRecoveryProvenance = publish;
    const pending = await f.state.sessionRetry(f.scope);
    assert.equal(pending?.attempt_count, 0);
    await rm(fault, { recursive: true, force: true });
    f.advance(30_000);
    await f.stop();
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(await f.state.sessionRetry(f.scope), pending);
    assert.equal(await f.state.recoveryQuarantined(f.scope), true);
  } finally {
    await f.finish();
  }
});

test('a captured old slot cannot write into a new budget after classified completion', async () => {
  const f = await fixture();
  let attempt: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    await f.stop();
    const old = (await f.state.sessionRetry(f.scope))!;
    const binding = (await f.state.binding(f.scope))!;
    await f.state.recordBinding({ ...binding, phase: 'pending', failureEpisodeId: old.workflow_episode_id! });
    attempt = reserveJobSlot(f.state, f.authority);
    const slot = await attempt.ready;
    assert.ok(slot);
    f.change('completed');
    await f.stop();
    f.advance(1000);
    f.change();
    await f.stop();
    const current = await f.state.sessionRetry(f.scope);
    await assert.rejects(
      slot.record({
        ...old,
        next_check_at: null,
        attempt_count: 1,
        last_attempt_at: '2026-10-07T00:00:01.000Z',
        last_delivery_state: 'uncertain',
      }),
    );
    assert.deepEqual(await f.state.sessionRetry(f.scope), current);
    assert.equal(f.prompts.length, 0);
  } finally {
    attempt?.close();
    await attempt?.finish();
    await f.finish();
  }
});

test('completion is rechecked after legacy association before selecting a fresh budget', async () => {
  const f = await fixture();
  try {
    await f.stop();
    f.advance(30_000);
    await f.stop(true);
    const old = await f.state.sessionRetry(f.scope);
    const adopt = f.state.adoptLegacyRetry.bind(f.state);
    f.state.adoptLegacyRetry = async (...args) => {
      const result = await adopt(...args);
      if (args[4]) f.change();
      return result;
    };
    f.change('completed');
    await f.stop();
    assert.deepEqual(await f.state.sessionRetry(f.scope), old);
  } finally {
    await f.finish();
  }
});

test('a changed snapshot while classifying completion cannot reset recovery history', async () => {
  const f = await fixture();
  try {
    await f.stop();
    f.advance(30_000);
    await f.stop(true);
    const old = await f.state.sessionRetry(f.scope);
    f.change('completed');
    f.beforeDecision(async () => {
      f.change();
    });
    await f.stop();
    assert.deepEqual(await f.state.sessionRetry(f.scope), old);
    assert.equal(f.prompts.length, 1);
  } finally {
    await f.finish();
  }
});
