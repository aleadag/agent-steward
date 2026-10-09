import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalMenu } from '../src/herdr-adapter/best-effort-approval.ts';
import { handleEvent, runEvent, socketReader, type EventDeps } from '../src/herdr-adapter/entry.ts';
import { beginWorkflow } from '../src/herdr-adapter/authority.ts';
import { workflowEventDeps } from '../src/herdr-adapter/events.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';
import { assessStop } from '../src/triage.ts';
import { observeStop, type AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import type { Evaluation, StopInput } from '../src/contracts.ts';
import { readStopLedger, type StopLedgerEvent } from '../src/stop-ledger.ts';
import { createRuntime } from '../src/main.ts';

const at = '2026-10-03T12:00:00Z';
const dialog = (command = 'printf approval-probe') =>
  `Requesting permission for:\n   ${command}\n\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel\n\n  ↑/↓ Navigate · tab Amend`;
const evaluation = (
  risk = 0.1,
  confidence = 0.9,
  waiting: 'approve_command' | 'approve_edit' = 'approve_command',
): Evaluation => ({
  model: 'jev-1.13.0',
  usage: {},
  answers: {
    waiting_for: {
      type: 'choice',
      choice: waiting,
      probabilities: {
        approve_command: waiting === 'approve_command' ? 0.9 : 0,
        approve_edit: waiting === 'approve_edit' ? 0.9 : 0,
        answer_question: 0,
        credentials: 0,
        recoverable_api_error: 0,
        quota_limit: 0,
        permanent_error: 0,
        completed: 0,
        other: 0.1,
      },
      confidence,
    },
    risky: { type: 'noul', noul: risk },
  },
});

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'steward-best-effort-'));
  const store = new EpisodeStore(directory);
  const token = await store.acquire('server-1');
  assert.ok(token);
  let current: AgentSnapshot = {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'agy',
    agent_status: 'idle',
    agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's1' },
    revision: 259,
    state_change_seq: 4,
  };
  let text = dialog();
  const keys: [string, string[]][] = [];
  const inputs: StopInput[] = [];
  const handoffs: string[] = [];
  const diagnostics: StopLedgerEvent[] = [];
  let risk = 0.1;
  let confidence = 0.9;
  let admission = true;
  let waiting: 'approve_command' | 'approve_edit' = 'approve_command';
  const herdr = {
    get: async () => current,
    list: async () => [current],
    read: async () => ({ pane_id: current.pane_id, source: 'detection', revision: 0, text, truncated: true }),
    sendKeys: async (pane: string, input: string[]) => {
      // Catches submitting before the persistent uncertain-write marker exists.
      const saved = await (
        store as EpisodeStore & { approval: (pane: string, session: string) => Promise<{ state: string } | null> }
      ).approval(current.agent!, current.agent_session!.value);
      assert.equal(saved?.state, 'uncertain');
      keys.push([pane, input]);
    },
    prompt: async () => {
      throw new Error('permission UI must never receive a recovery prompt');
    },
  };
  const deps: EventDeps & { autoApprove: boolean } = {
    herdr,
    store,
    autoApprove: enabled,
    targets: 'all',
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    admissionOpen: () => admission,
    clock: { now: () => new Date(at) },
    decide: async (input) => {
      inputs.push(input);
      return assessStop(input, {
        thresholds: { risky: 0.6, choiceConfidence: 0.45 },
        now: new Date(at),
        evaluate: async () => evaluation(risk, confidence, waiting),
      });
    },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
    approvalDiagnostic: async (event) => {
      diagnostics.push(event);
    },
  };
  const run = () =>
    handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: current.pane_id,
        workspace_id: current.workspace_id,
        agent: current.agent,
        agent_status: current.agent_status,
      },
      deps,
    );
  return {
    deps,
    store,
    herdr,
    keys,
    inputs,
    handoffs,
    diagnostics,
    run,
    changeText: (next: string) => {
      text = next;
    },
    changePane: (changes: Partial<AgentSnapshot>) => {
      current = { ...current, ...changes };
    },
    setRisk: (next: number) => {
      risk = next;
    },
    setConfidence: (next: number) => {
      confidence = next;
    },
    stopAdmission: () => {
      admission = false;
    },
    setWaiting: (next: 'approve_command' | 'approve_edit') => {
      waiting = next;
    },
    cleanup: async () => {
      await store.release(token);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('approval diagnostics correlate both assessments, delivery, and a skipped duplicate without content', async () => {
  const f = await fixture();
  try {
    await f.run();
    const event = f.diagnostics[0]!;
    assert.equal(event.approval?.gate, 'delivered');
    assert.deepEqual(
      event.approval?.assessments.map((assessment) => assessment.request_id),
      f.inputs.map((input) => input.request_id),
    );
    assert.equal(event.approval?.checkpoint, 'delivery_record');
    assert.equal(event.approval?.assessments[0]?.waiting_for, 'approve_command');
    assert.equal(event.approval?.assessments[0]?.waiting_confidence, 0.9);
    assert.equal(event.approval?.assessments[0]?.risk_probability, 0.1);
    assert.equal((await f.store.approval('agy', 's1'))?.attempt_id, event.request_id);
    await f.run();
    assert.equal(f.diagnostics[1]?.request_id, event.request_id);
    assert.equal(f.diagnostics[1]?.approval_skip, 'previous_delivered');
    assert.equal(f.inputs.length, 2);
    assert.equal(f.keys.length, 1);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /printf|approval-probe|w1:p1|herdr:antigravity_cli|"s1"/);
  } finally {
    await f.cleanup();
  }
});

for (const [name, setup, gate, count] of [
  ['high risk', (f: Awaited<ReturnType<typeof fixture>>) => f.setRisk(0.9), 'assessment_rejected', 1],
  [
    'classification mismatch',
    (f: Awaited<ReturnType<typeof fixture>>) => f.setWaiting('approve_edit'),
    'classification_mismatch',
    1,
  ],
  [
    'observation changes after first assessment',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      const decide = f.deps.decide;
      f.deps.decide = async (input) => {
        const result = await decide(input);
        f.changePane({ state_change_seq: 5 });
        return result;
      };
    },
    'observation_changed',
    1,
  ],
  [
    'evaluator failure',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.deps.decide = async () => {
        throw new Error('private upstream output');
      };
    },
    'evaluator_failed',
    1,
  ],
] as const) {
  test(`approval diagnostics explain ${name} without changing human handoff`, async () => {
    const f = await fixture();
    try {
      setup(f);
      await f.run();
      const event = f.diagnostics[0]!;
      assert.equal(event.approval?.gate, gate);
      assert.equal(event.approval?.checkpoint, gate === 'observation_changed' ? 'after_assessment_1' : 'assessment_1');
      assert.equal(event.approval?.assessments.length, count);
      assert.deepEqual(f.keys, []);
      assert.doesNotMatch(JSON.stringify(event), /private upstream output|printf|w1:p1/);
      if (gate !== 'evaluator_failed') {
        await f.run();
        assert.equal(f.diagnostics[1]?.approval_skip, 'previous_human');
        assert.equal(f.diagnostics[1]?.request_id, event.request_id);
      }
    } finally {
      await f.cleanup();
    }
  });
}

for (const failure of ['prewrite', 'final_read', 'cleanup_write'] as const) {
  test(`no-send cleanup preserves the primary ${failure} gate and separately reports cleanup`, async () => {
    const f = await fixture();
    try {
      const record = f.store.recordApproval.bind(f.store);
      let finalRead = false;
      f.store.recordApproval = async (pane, attempt) => {
        if (failure === 'prewrite' && attempt.state === 'uncertain') throw new Error('private write error');
        if (failure === 'cleanup_write' && attempt.state === 'not_sent') throw new Error('private cleanup error');
        await record(pane, attempt);
        if (attempt.state === 'uncertain') finalRead = true;
      };
      const read = f.herdr.read;
      f.herdr.read = async () => {
        if (finalRead) {
          finalRead = false;
          return { pane_id: 'w1:p1', source: 'detection', revision: 0, text: '', truncated: true };
        }
        return read();
      };
      await f.run();
      const diagnostic = f.diagnostics[0]?.approval;
      assert.equal(diagnostic?.gate, failure === 'prewrite' ? 'record_failed' : 'observation_unavailable');
      assert.equal(diagnostic?.checkpoint, failure === 'prewrite' ? 'prewrite' : 'before_delivery');
      assert.equal(diagnostic?.no_send_cleanup?.outcome, failure === 'cleanup_write' ? 'record_failed' : 'recorded');
      assert.equal(
        (await f.store.approval('agy', 's1'))?.state,
        failure === 'cleanup_write' ? 'uncertain' : 'not_sent',
      );
      assert.equal(f.inputs.length, 2);
      assert.deepEqual(f.keys, []);
      assert.doesNotMatch(JSON.stringify(f.diagnostics), /private write error|private cleanup error/);
    } finally {
      await f.cleanup();
    }
  });
}

test('second policy rejection retains the first approval and the second risk judgment', async () => {
  const f = await fixture();
  try {
    const decide = f.deps.decide;
    f.deps.decide = async (input) => {
      const result = await decide(input);
      f.setRisk(0.9);
      return result;
    };
    await f.run();
    const diagnostic = f.diagnostics[0]?.approval;
    assert.equal(diagnostic?.gate, 'assessment_rejected');
    assert.equal(diagnostic?.checkpoint, 'assessment_2');
    assert.deepEqual(
      diagnostic?.assessments.map((assessment) => assessment.reason_code),
      ['low_risk', 'high_risk'],
    );
    assert.deepEqual(f.keys, []);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'human');
  } finally {
    await f.cleanup();
  }
});

test('revocation after assessment is diagnosed without writing new approval metadata or input', async () => {
  const f = await fixture();
  try {
    const decide = f.deps.decide;
    f.deps.decide = async (input) => {
      const result = await decide(input);
      f.stopAdmission();
      return result;
    };
    await f.run();
    assert.equal(f.diagnostics[0]?.approval?.gate, 'ownership_lost');
    assert.equal(f.diagnostics[0]?.approval?.assessments.length, 1);
    assert.equal(await f.store.approval('agy', 's1'), null);
    assert.deepEqual(f.keys, []);
  } finally {
    await f.cleanup();
  }
});

test('uncertain transport is diagnosed and duplicate quarantine remains linked to the original attempt', async () => {
  const f = await fixture();
  try {
    const send = f.herdr.sendKeys;
    f.herdr.sendKeys = async (pane, keys) => {
      await send(pane, keys);
      throw new Error('private lost acknowledgment');
    };
    await f.run();
    const event = f.diagnostics[0]!;
    assert.equal(event.approval?.gate, 'uncertain_delivery');
    assert.equal(event.approval?.transport_started, true);
    assert.equal(event.approval?.checkpoint, 'delivery');
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
    f.changeText(dialog('printf different-probe'));
    await f.run();
    assert.equal(f.diagnostics[1]?.approval_skip, 'uncertain_session');
    assert.equal(f.diagnostics[1]?.request_id, event.request_id);
    assert.equal(f.keys.length, 1);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /private lost acknowledgment|different-probe/);
  } finally {
    await f.cleanup();
  }
});

test('structured evaluator errors retain safe transport diagnostics in the approval attempt', async () => {
  const f = await fixture();
  try {
    f.deps.decide = async (input) => ({
      schema_version: 2,
      request_id: input.request_id,
      decision: 'error',
      reason_code: 'evaluation_failed',
      message: 'private upstream body',
      diagnostics: { stage: 'evaluation', kind: 'http', http_status: 503, duration_ms: 100 },
    });
    await f.run();
    const diagnostic = f.diagnostics[0]?.approval;
    assert.equal(diagnostic?.gate, 'evaluator_failed');
    assert.equal(diagnostic?.assessments[0]?.diagnostics?.http_status, 503);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'human');
    assert.deepEqual(f.keys, []);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /private upstream body/);
  } finally {
    await f.cleanup();
  }
});

test('a stalled diagnostic sink has a bounded wait after delivery and never retries input', async () => {
  const f = await fixture();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    f.deps.approvalDiagnostic = async () => new Promise(() => {});
    await Promise.race([
      f.run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostics stalled approval handler')), 4000);
      }),
    ]);
    assert.equal(f.inputs.length, 2);
    assert.equal(f.keys.length, 1);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    clearTimeout(timer);
    await f.cleanup();
  }
});

test('diagnostic sink failure cannot prevent guarded approval or cause input retries', async () => {
  const f = await fixture();
  try {
    f.deps.approvalDiagnostic = async () => {
      throw new Error('diagnostic disk unavailable');
    };
    await f.run();
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.equal(f.keys.length, 1);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

const partialMenu = 'Requesting permission for:\n   printf approval-probe\n\nRun this command?\n> 1. Yes, run command';

async function scopedApproval() {
  const directory = await mkdtemp(join(tmpdir(), 'steward-scoped-approval-'));
  const state = new WorkflowState(directory);
  const store = new EpisodeStore(directory);
  const attempt = beginWorkflow({
    state,
    scope: {
      serverId: '47:1',
      agent: 'agy',
      sessionId: 's1',
      sessionKind: 'id',
      sessionSource: 'herdr:antigravity_cli',
    },
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all' as const, autoApprove: true }),
    signal: new AbortController().signal,
  });
  const authority = await attempt.ready;
  assert.ok(authority);
  let current: AgentSnapshot = {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'agy',
    agent_status: 'idle',
    agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's1' },
    revision: 259,
    state_change_seq: 4,
  };
  let text = dialog();
  const keys: [string, string[]][] = [];
  const inputs: StopInput[] = [];
  const handoffs: string[] = [];
  const herdr = {
    get: async () => current,
    read: async () => ({ pane_id: current.pane_id, source: 'detection', revision: 0, text, truncated: true }),
    sendKeys: async (pane: string, input: string[]) => {
      const saved = await store.approval(current.agent!, current.agent_session!.value);
      assert.equal(saved?.state, 'uncertain');
      keys.push([pane, input]);
    },
    prompt: async () => {
      throw new Error('permission UI must never receive a recovery prompt');
    },
  };
  const base: EventDeps & { autoApprove: boolean } = {
    herdr,
    store,
    autoApprove: true,
    targets: 'all',
    clock: { now: () => new Date(at) },
    decide: async (input) => {
      inputs.push(input);
      return assessStop(input, {
        thresholds: { risky: 0.6, choiceConfidence: 0.45 },
        now: new Date(at),
        evaluate: async () => evaluation(0.1, 0.9),
      });
    },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  };
  const deps = workflowEventDeps(base, authority, state);
  const run = () =>
    handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: current.pane_id,
        workspace_id: current.workspace_id,
        agent: current.agent,
        agent_status: current.agent_status,
      },
      deps,
    );
  return {
    deps,
    store,
    keys,
    inputs,
    handoffs,
    run,
    attempt,
    changePane: (changes: Partial<AgentSnapshot>) => {
      current = { ...current, ...changes };
    },
    cleanup: async () => {
      attempt.close();
      await attempt.finish();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Catches retaining the default-deny branch when globally enabled, or requiring raw blocked status.
test('global best-effort mode assesses idle permission UI and sends only one key', async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    assert.equal(f.inputs[0]?.pending_action?.action, 'printf approval-probe');
    assert.equal(f.inputs[0]?.automatic_approval_forbidden, false);
    assert.deepEqual(f.handoffs, []);
    await f.run();
    assert.equal(f.keys.length, 1);
    assert.equal(f.inputs.length, 2);
    // A footer or lifecycle sequence change must not grant another attempt for the same menu.
    f.changeText(dialog() + '\nTOOL · ctx 2.6%');
    f.changePane({ state_change_seq: 5 });
    await f.run();
    assert.equal(f.keys.length, 1);
    f.changeText(dialog('printf next-probe'));
    await f.run();
    assert.equal(f.keys.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('recognized permission reported done is approved only in global approval mode', async () => {
  const f = await fixture();
  try {
    f.changePane({ agent_status: 'done' });
    assert.equal((await observeStop(f.herdr, 'w1:p1'))?.status, 'done');
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    assert.ok(f.inputs.every((input) => input.status === 'blocked'));
    await f.run();
    assert.equal(f.keys.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('done permission menus remain default-off', async () => {
  const f = await fixture(false);
  try {
    f.changePane({ agent_status: 'done' });
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.deepEqual(f.inputs, []);
  } finally {
    await f.cleanup();
  }
});

test('done permission menus still require the existing risk policy', async () => {
  const f = await fixture();
  try {
    f.changePane({ agent_status: 'done' });
    f.setRisk(0.6);
    await f.run();
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.keys, []);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'human');
  } finally {
    await f.cleanup();
  }
});

test('done with error text retains recovery quarantine even with approval enabled', async () => {
  const f = await fixture();
  try {
    await f.store.record('w1:p1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'old-error',
      error_evidence_digest: 'old-digest',
      first_observed_at: at,
      attempt_count: 2,
      last_attempt_at: at,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: at,
      last_delivery_state: 'none',
    });
    f.changePane({ agent_status: 'done' });
    f.changeText('API Error: connection timed out');
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.deepEqual(f.inputs, []);
    const history = await f.store.retry('w1:p1');
    assert.equal(history?.attempt_count, 2);
    assert.equal(history?.last_delivery_state, 'human');
    assert.equal(history?.next_check_at, null);
  } finally {
    await f.cleanup();
  }
});

test('approval remains default-off globally', async () => {
  const f = await fixture(false);
  try {
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.ok(f.inputs.every((input) => input.automatic_approval_forbidden));
  } finally {
    await f.cleanup();
  }
});

test('unknown key outcome is persistent and never resent', async () => {
  const f = await fixture();
  try {
    f.herdr.sendKeys = async (pane, keys) => {
      f.keys.push([pane, keys]);
      throw new Error('lost acknowledgment');
    };
    await f.run();
    assert.equal(f.keys.length, 1);
    await f.run();
    f.changeText(dialog('different command'));
    f.deps.store = new EpisodeStore(f.store.directory);
    await f.run();
    assert.equal(f.keys.length, 1);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

test('uncertain session stays quarantined after replacement, restart and return', async () => {
  const f = await fixture();
  let token = f.deps.leaseToken!;
  try {
    const send = f.herdr.sendKeys;
    f.herdr.sendKeys = async (pane, keys) => {
      f.keys.push([pane, keys]);
      throw new Error('lost acknowledgment');
    };
    await f.run();
    assert.equal(f.keys.length, 1);
    f.herdr.sendKeys = send;
    f.changePane({ agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's2' } });
    await f.run();
    assert.equal(f.keys.length, 2);
    await f.store.release(token);
    const restarted = new EpisodeStore(f.store.directory);
    const next = await restarted.acquire('server-1');
    assert.ok(next);
    token = next;
    f.deps.store = restarted;
    f.deps.leaseToken = next;
    f.changePane({
      pane_id: 'w1:p2',
      agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's1' },
    });
    f.changeText(dialog('printf different-probe'));
    await f.run();
    assert.equal(f.keys.length, 2);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await (f.deps.store as EpisodeStore).release(token);
    await f.cleanup();
  }
});

test('same session on different panes shares one approval-attempt lock', async () => {
  const f = await fixture();
  try {
    const native = await f.herdr.get();
    f.deps.herdr = {
      ...f.herdr,
      get: async (pane) => ({ ...native, pane_id: pane }),
      read: async (pane) => ({ pane_id: pane, source: 'detection', revision: 0, text: dialog(), truncated: true }),
      sendKeys: async (pane, keys) => {
        assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
        f.keys.push([pane, keys]);
      },
    };
    await Promise.all(
      ['w1:p1', 'w1:p2'].map((pane) =>
        handleEvent(
          {
            type: 'pane.agent_status_changed',
            pane_id: pane,
            workspace_id: 'w1',
            agent: 'agy',
            agent_status: 'idle',
          },
          f.deps,
        ),
      ),
    );
    assert.equal(f.keys.length, 1);
    assert.deepEqual(f.keys[0]?.[1], ['1']);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

test('approval requires an episode lock', async () => {
  const f = await fixture();
  try {
    f.deps.store = {
      active: async () => true,
      retry: f.store.retry.bind(f.store),
      record: f.store.record.bind(f.store),
    };
    await f.run();
    assert.deepEqual(f.keys, []);
  } finally {
    await f.cleanup();
  }
});

// Catches sending solely from a menu match rather than the real risk/confidence policy.
for (const [name, risk, confidence] of [
  ['high risk', 0.6, 0.9],
  ['low confidence', 0.1, 0.44],
] as const) {
  test(`${name} remains human in global approval mode`, async () => {
    const f = await fixture();
    try {
      f.setRisk(risk);
      f.setConfidence(confidence);
      await f.run();
      assert.deepEqual(f.keys, []);
      assert.equal(f.inputs.length, 1);
      assert.equal(f.inputs[0]?.automatic_approval_forbidden, false);
      assert.ok(f.handoffs.includes('human_review_required'));
    } finally {
      await f.cleanup();
    }
  });
}

const compactDialog =
  'Requesting permission for:\n  printf approval-probe\nRun this command?\n> 1. Yes, run command\n  2. No, cancel';
for (const [name, text] of [
  ['persistent grant on key 1', dialog().replace('1. Yes, run command', '1. Yes, and always allow')],
  ['conflicting dialogs', 'Requesting permission for: command A\n' + dialog()],
  [
    'inline header without a bounded action block',
    dialog().replace(
      'Requesting permission for:\n   printf approval-probe',
      'Requesting permission for: printf approval-probe',
    ),
  ],
  ['setup prefix before an apparent menu', 'Settings Error\n' + dialog()],
  [
    'trailing trust dialog with alternative numbered controls',
    compactDialog + '\nDo you trust this project?\n1) Yes, trust this project\n2) No',
  ],
  ['trailing persistent key 1 in brackets', compactDialog + '\n[1] Always allow in this conversation'],
  ['trailing setup dialog', compactDialog + '\nSettings Error\nContinue with defaults?'],
  ['unknown trailing question', compactDialog + '\nWould you like to delete the file? (y/n)'],
  ['trust', 'Do you trust this project?\n1. Yes'],
  ['login', 'Sign in\n1. Continue'],
  ['settings', 'Settings Error\n1. Continue with defaults'],
] as const) {
  test(`${name} never receives approval input`, async () => {
    const f = await fixture();
    try {
      f.changeText(text);
      await f.run();
      assert.deepEqual(f.keys, []);
    } finally {
      await f.cleanup();
    }
  });
}

const agyUnzipMenu = `● Bash(unzip -l sentinel/android/app/build/outputs/apk/...) (ctrl+o to
expand)

Command
────────────────────────────────────────────────────────────────────────────

Requesting permission for:
   unzip -l
sentinel/android/app/build/outputs/apk/release/app-release-unsigned.ap
k

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with
'unzip'
  3. Yes, and always allow for commands that start with 'unzip' (Persist to
settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
🔧 TOOL ╱ Gemini 3.8 Flash (Medium)
ctx ░·············· 3.1% · tasks 0`;

test('AGY wrapped unzip permission menu is recognized', () => {
  const menu = approvalMenu(agyUnzipMenu);
  assert.ok(menu);
  assert.equal(menu.kind, 'approve_command');
  assert.match(menu.action, /unzip -l/);
});

test('AGY wrapped unzip permission menu can send only 1', async () => {
  const f = await fixture();
  try {
    // Keep the complete action and wrapped choices in the bounded excerpt.
    f.changeText(`Requesting permission for:
   unzip -l
sentinel/android/app/build/outputs/apk/release/app-release-unsigned.apk

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with
'unzip'
  3. Yes, and always allow for commands that start with 'unzip' (Persist to settings.json)
  4. No, cancel`);
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
  } finally {
    await f.cleanup();
  }
});

const agyStatixMenu = `Command
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Requesting permission for:
   statix check packages/cc-connect/default.nix packages/karabiner-driverkit-virtualhiddevice/default.nix packages/newsgoat/default.nix
packages/nix-cleanup/default.nix packages/nix-whereis/default.nix packages/run-bg-alias/default.nix packages/vitaly/default.nix
packages/wpsoffice-cn-fcitx/default.nix packages/herdr-beads/default.nix

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'statix'
  3. Yes, and always allow for commands that start with 'statix' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
🔧 TOOL ╱ Gemini 3.8 Flash (High)  │   ctx ░·············· 3.7% · artifacts 0 · subagents 0 · tasks 0 · sandbox off`;

const agyLoopMenu = `● Bash(for d in /run/user/1000/nix-develop-*; do) (ctrl+o to expand)

Command
────────────────────────────────────────────────────────────────────────────

Requesting permission for:
   for d in /run/user/1000/nix-develop-*; do
     pid=$(basename "$d" | cut -d'-' -f3)
     if kill -0 "$pid" 2>/dev/null; then
       echo "Alive PID: $pid ($d)"
   ⋯ (3 lines hidden)

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'for d in /run/user/1000/nix-develop-*; do
  pid=$(basename "$d" | cut -d'-' -f3)
  ...'
  3. Yes, and always allow for commands that start with 'for d in /run/user/1000/nix-develop-*; do
  pid=$(basename "$d" | cut -d'-' -f3)
  ...' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
🔧 TOOL ╱ Gemini 3.8 Flash (High)  │   ctx ▓·············· 5.8% · tasks 0`;

const agyBashMenu = `Requesting permission for:
   bash -c '
   set -e
   FUNC=$(sed -n "/^wait_for_storage_api() {/,/^}/p"
infra/supabase/scripts/test-schema.sh)
   echo "$FUNC"
   ⋯ (1 lines hidden)

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start
with 'bash -c '
set -e
FUNC=$(sed -n "/^wait_for_storage_api() {/,/^}/p" infra/supabas...'
  3. Yes, and always allow for commands that start with 'bash -c '
set -e
FUNC=$(sed -n "/^wait_for_storage_api() {/,/^}/p" infra/supabas...'
(Persist to settings.json)
  4. No, cancel`;
const agyBashAction = `bash -c '
set -e
FUNC=$(sed -n "/^wait_for_storage_api() {/,/^}/p"
infra/supabase/scripts/test-schema.sh)
echo "$FUNC"
⋯ (1 lines hidden)`;
const agyBashMenuWithFooter =
  agyBashMenu + '\n\n  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\n🔧 TOOL ╱ Gemini 3.8 Flash (High)';

for (const [name, screen, context, action, readCounts] of [
  [
    'wrapped statix permission header',
    agyStatixMenu,
    agyStatixMenu,
    'statix check packages/cc-connect/default.nix packages/karabiner-driverkit-virtualhiddevice/default.nix packages/newsgoat/default.nix\n' +
      'packages/nix-cleanup/default.nix packages/nix-whereis/default.nix packages/run-bg-alias/default.nix packages/vitaly/default.nix\n' +
      'packages/wpsoffice-cn-fcitx/default.nix packages/herdr-beads/default.nix',
    [12, 16],
  ],
  [
    'multiline loop permission header beyond 16 lines',
    agyLoopMenu,
    agyLoopMenu,
    `for d in /run/user/1000/nix-develop-*; do
pid=$(basename "$d" | cut -d'-' -f3)
if kill -0 "$pid" 2>/dev/null; then
echo "Alive PID: $pid ($d)"
⋯ (3 lines hidden)`,
    [12, 16, 24],
  ],
  ['deeply wrapped bash permission paste', agyBashMenu, agyBashMenu, agyBashAction, [12, 16, 24]],
  [
    'deeply wrapped bash permission menu with footer',
    agyBashMenuWithFooter,
    agyBashMenuWithFooter,
    agyBashAction,
    [12, 16, 24],
  ],
  ...[3, 8, 26].map((extraRows) => {
    const screen = agyBashMenuWithFooter.replace('  3. Yes,', 'wrapped\n'.repeat(extraRows) + '  3. Yes,');
    return [
      `bash menu with ${extraRows} additional wrapped option rows`,
      screen,
      screen,
      agyBashAction,
      [12, 16, 24, 48],
    ] as const;
  }),
  [
    'compact permission menu without older transcript',
    'Earlier explanation\nOlder output\n\nCommand\n---\n\n' + dialog(),
    '---\n\n' + dialog(),
    'printf approval-probe',
    [12],
  ],
  [
    'credential in a recovered action line',
    agyLoopMenu.replace('   for d in', '   api_key=supersecretvalue1234 for d in'),
    null,
    null,
    [12, 16, 24],
  ],
  ['oversized recovered excerpt', agyLoopMenu.replace('Alive PID:', 'x'.repeat(2048)), null, null, [12, 16]],
  ['conflicting setup prefix', agyLoopMenu.replace('Command\n', 'Settings Error\n'), null, null, [12, 16, 24, 48]],
  [
    'extra control after cancel',
    agyLoopMenu.replace('  4. No, cancel', '  4. No, cancel\n  5. Yes, always allow').replace('\n\n  ↑/↓', '\n  ↑/↓'),
    null,
    null,
    [12, 16, 24, 48],
  ],
] as const) {
  test(`bounded socket detection handles the ${name}`, async () => {
    const f = await fixture();
    const path = join(f.store.directory, 'herdr.sock');
    const pane = await f.herdr.get();
    const reads: number[] = [];
    const server = createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
        if (!data.includes('\n')) return;
        const { id, method, params } = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (method === 'agent.read') reads.push(params.lines);
        const result =
          method === 'agent.get'
            ? { type: 'agent_info', agent: pane }
            : {
                type: 'pane_read',
                read: {
                  pane_id: pane.pane_id,
                  source: 'detection',
                  revision: 0,
                  text: screen.split('\n').slice(-params.lines).join('\n'),
                  truncated: true,
                },
              };
        socket.end(JSON.stringify({ id, result }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      f.deps.herdr = { ...f.herdr, ...socketReader(path) };
      await f.run();
      assert.equal(f.inputs.length, action ? 2 : name === 'credential in a recovered action line' ? 0 : 1);
      if (action) {
        assert.equal(f.inputs[0]?.context, context);
        assert.equal(f.inputs[0]?.pending_action?.action, action);
        assert.equal(f.inputs[0]?.status, 'blocked');
        assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
      } else {
        assert.deepEqual(f.keys, []);
        assert.equal(f.handoffs.length, 1);
        if (f.inputs[0]) {
          assert.equal(f.inputs[0].context, screen.split('\n').slice(-12).join('\n'));
          assert.equal(f.inputs[0].pending_action, undefined);
          assert.equal(f.inputs[0].automatic_approval_forbidden, true);
        }
      }
      assert.deepEqual(reads.slice(0, readCounts.length), readCounts);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.cleanup();
    }
  });
}

// Catches ignoring a dialog or occupant change after the expensive assessment.
for (const boundary of ['dialog', 'session', 'control', 'lease', 'shutdown'] as const) {
  test(`${boundary} change during classification prevents key delivery`, async () => {
    const f = await fixture();
    try {
      const original = f.deps.decide;
      f.deps.decide = async (input) => {
        const result = await original(input);
        if (boundary === 'dialog') f.changeText(dialog('different command'));
        if (boundary === 'session')
          f.changePane({ agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's2' } });
        if (boundary === 'control') f.changeText(dialog().replace('1. Yes, run command', '1. No, cancel'));
        if (boundary === 'lease') f.deps.sessionValid = async () => false;
        if (boundary === 'shutdown') f.stopAdmission();
        return result;
      };
      await f.run();
      assert.deepEqual(f.keys, []);
    } finally {
      await f.cleanup();
    }
  });
}

for (const boundary of ['focus', 'dialog'] as const) {
  test(`${boundary} change after the uncertain prewrite records no send and permits fresh assessment`, async () => {
    const f = await fixture();
    try {
      f.changePane({ agent_status: 'done' });
      const record = f.store.recordApproval.bind(f.store);
      let changed = false;
      f.store.recordApproval = async (pane, attempt) => {
        await record(pane, attempt);
        if (attempt.state !== 'uncertain' || changed) return;
        changed = true;
        if (boundary === 'focus') f.changePane({ agent_status: 'idle', state_change_seq: 5 });
        else f.changeText(dialog('printf changed-probe'));
      };
      await f.run();
      assert.equal(f.inputs.length, 2);
      assert.deepEqual(f.keys, []);
      const saved = await f.store.approval('agy', 's1');
      assert.equal(saved?.state, 'not_sent');
      assert.equal(saved?.not_sent_reason, 'observation_changed');
      assert.equal(JSON.stringify(saved).includes('approval-probe'), false);

      // Persisted no-send evidence must survive a store reopen, but is not
      // approval: the fresh event still needs both policy assessments.
      f.deps.store = new EpisodeStore(f.store.directory);
      await f.run();
      assert.equal(f.inputs.length, 4);
      assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
      assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
      await f.run();
      assert.equal(f.inputs.length, 4);
      assert.equal(f.keys.length, 1);
    } finally {
      await f.cleanup();
    }
  });
}

test('fresh policy rejection after a known no-send attempt still prevents input', async () => {
  const f = await fixture();
  try {
    const record = f.store.recordApproval.bind(f.store);
    f.store.recordApproval = async (pane, attempt) => {
      await record(pane, attempt);
      if (attempt.state === 'uncertain') f.changePane({ state_change_seq: 5 });
    };
    await f.run();
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'not_sent');
    f.setRisk(0.9);
    await f.run();
    assert.equal(f.inputs.length, 3);
    assert.deepEqual(f.keys, []);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'human');
  } finally {
    await f.cleanup();
  }
});

test('dispatch rejection before transport invocation records no send', async () => {
  const f = await fixture();
  try {
    f.deps.dispatchEffect = async () => {
      throw new Error('effect not admitted');
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
    const saved = await f.store.approval('agy', 's1');
    assert.equal(saved?.state, 'not_sent');
    assert.equal(saved?.not_sent_reason, 'delivery_not_started');
    f.deps.dispatchEffect = async (_kind, effect) => effect();
    await f.run();
    assert.equal(f.inputs.length, 4);
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
  } finally {
    await f.cleanup();
  }
});

test('no-send metadata rejects missing reasons and reasons on uncertain attempts', async () => {
  const f = await fixture();
  try {
    f.deps.dispatchEffect = async () => {
      throw new Error('effect not admitted');
    };
    await f.run();
    const saved = await f.store.approval('agy', 's1');
    assert.ok(saved);
    assert.equal(saved.state, 'not_sent');
    await assert.rejects(f.store.recordApproval('w1:p1', { ...saved, not_sent_reason: undefined }));
    await assert.rejects(f.store.recordApproval('w1:p1', { ...saved, state: 'uncertain' }));
    assert.deepEqual(await f.store.approval('agy', 's1'), saved);
  } finally {
    await f.cleanup();
  }
});

test('dispatch error after transport invocation keeps session uncertainty', async () => {
  const f = await fixture();
  try {
    f.deps.dispatchEffect = async (_kind, effect) => {
      await effect();
      throw new Error('dispatch acknowledgment lost');
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.equal(f.keys.length, 1);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.equal(f.keys.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('failed no-send publication retains uncertainty and never retries', async () => {
  const f = await fixture();
  try {
    const record = f.store.recordApproval.bind(f.store);
    f.store.recordApproval = async (pane, attempt) => {
      if (attempt.state === 'not_sent') throw new Error('publication failed');
      await record(pane, attempt);
      if (attempt.state === 'uncertain') f.changePane({ state_change_seq: 5 });
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
  } finally {
    await f.cleanup();
  }
});

for (const boundary of ['session', 'lease', 'shutdown'] as const) {
  test(`${boundary} loss after the uncertain prewrite prevents input`, async () => {
    const f = await fixture();
    try {
      const record = f.store.recordApproval.bind(f.store);
      f.store.recordApproval = async (pane, attempt) => {
        await record(pane, attempt);
        if (attempt.state !== 'uncertain') return;
        if (boundary === 'session')
          f.changePane({ agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's2' } });
        if (boundary === 'lease') f.deps.sessionValid = async () => false;
        if (boundary === 'shutdown') f.stopAdmission();
      };
      await f.run();
      assert.equal(f.inputs.length, 2);
      assert.deepEqual(f.keys, []);
      assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
    } finally {
      await f.cleanup();
    }
  });
}

test('fresh high-risk decision after initial approval prevents input', async () => {
  const f = await fixture();
  try {
    const decide = f.deps.decide;
    f.deps.decide = async (input) => {
      if (f.inputs.length === 1) f.setRisk(0.8);
      return decide(input);
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
  } finally {
    await f.cleanup();
  }
});

test('explicit restriction result never receives approval input', async () => {
  const f = await fixture();
  try {
    f.deps.decide = async (input) =>
      assessStop(
        { ...input, automatic_approval_forbidden: true },
        {
          thresholds: { risky: 0.6, choiceConfidence: 0.45 },
          now: new Date(at),
          evaluate: async () => evaluation(),
        },
      );
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

test('shared delivery accepts a recognized menu on another live agent session', async () => {
  const f = await fixture();
  try {
    f.changePane({
      agent: 'codex',
      agent_status: 'blocked',
      agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 's1' },
    });
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs[0]?.agent.tool, 'codex');
  } finally {
    await f.cleanup();
  }
});

test('approval metadata is private and does not replace recovery history', async () => {
  const f = await fixture();
  try {
    const history = {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'old-error',
      error_evidence_digest: 'old-digest',
      first_observed_at: at,
      attempt_count: 2,
      last_attempt_at: at,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: null,
      last_delivery_state: 'human' as const,
    };
    await f.store.record('w1:p1', history);
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.deepEqual(await f.store.retry('w1:p1'), history);
    const attempt = await f.store.approval('agy', 's1');
    assert.ok(attempt);
    assert.equal(JSON.stringify(attempt).includes('approval-probe'), false);
    assert.deepEqual(await f.store.targets(), ['w1:p1']);
  } finally {
    await f.cleanup();
  }
});

test('recognized one-time edit menu uses the edit policy and the same key transport', async () => {
  const f = await fixture();
  try {
    f.setWaiting('approve_edit');
    f.changeText(
      dialog('Replace the draft heading')
        .replace('Run this command?', 'Apply this edit?')
        .replace('1. Yes, run command', '1. Yes, apply edit'),
    );
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs[0]?.pending_action?.action, 'Replace the draft heading');
  } finally {
    await f.cleanup();
  }
});

test('configured event entrypoint sends literal agent send-keys once through Herdr', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'steward-approval-entry-'));
  const socket = join(root, 'herdr.sock');
  const plugin = join(root, 'plugin');
  const state = join(root, 'state');
  await mkdir(plugin);
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n');
  const server = createServer((client) => {
    let data = '';
    client.on('data', async (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.split('\n')[0]!);
      const result =
        request.method === 'plugin.list'
          ? {
              type: 'plugin_list',
              plugins: [
                {
                  plugin_id: 'agent-steward-recover',
                  name: 'Agent Steward recover',
                  version: '0.1.0',
                  plugin_root: plugin,
                  manifest_path: join(plugin, 'herdr-plugin.toml'),
                  enabled: true,
                },
              ],
            }
          : request.method === 'agent.get'
            ? { type: 'agent_info', agent: await f.herdr.get() }
            : request.method === 'agent.read'
              ? { type: 'pane_read', read: await f.herdr.read() }
              : { type: 'agent_list', agents: await f.herdr.list() };
      client.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const argv = join(root, 'argv');
  const binary = join(root, 'fake-herdr');
  const config = join(root, 'config');
  await mkdir(config);
  await writeFile(join(config, 'targets.json'), JSON.stringify({ auto_approve: true }));
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argv}'\n`, { mode: 0o700 });
  try {
    assert.equal((await socketReader(socket).list?.())?.[0]?.pane_id, 'w1:p1');
    const env = {
      XDG_STATE_HOME: join(root, 'cli-state'),
      HERDR_SOCKET_PATH: socket,
      HERDR_BIN_PATH: binary,
      HERDR_PLUGIN_ID: 'agent-steward-recover',
      HERDR_PLUGIN_ROOT: plugin,
      HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_PLUGIN_STATE_DIR: state,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent_status: 'idle',
        agent: 'agy',
      }),
    };
    await runEvent(env, f.deps.decide);
    assert.equal(await readFile(argv, 'utf8'), 'agent\nsend-keys\nw1:p1\n1\n');
    const ledger = createRuntime();
    ledger.env = { XDG_STATE_HOME: env.XDG_STATE_HOME };
    const [attempt] = await readStopLedger(ledger);
    assert.equal(attempt?.approval?.gate, 'delivered');
    assert.equal(attempt?.approval?.assessments.length, 2);
    assert.doesNotMatch(JSON.stringify(attempt), /printf|w1:p1|"s1"/);
    await runEvent(env, f.deps.decide);
    assert.equal(await readFile(argv, 'utf8'), 'agent\nsend-keys\nw1:p1\n1\n');
    const [skipped] = await readStopLedger(ledger);
    assert.equal(skipped?.request_id, attempt?.request_id);
    assert.equal(skipped?.approval_skip, 'previous_delivered');
    assert.equal(skipped?.approval?.gate, 'delivered');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await f.cleanup();
  }
});

test('changed partial menu with the same status stays human-only without a recovery schedule', async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    const decisions = f.inputs.length;
    f.changeText(partialMenu);
    await f.run();
    assert.equal(f.keys.length, 1);
    assert.equal(f.inputs.length, decisions);
    assert.equal(await f.store.retry('w1:p1'), null);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

for (const status of ['idle', 'done'] as const) {
  test(`repeated default-off ${status} permission events cancel pending recovery once`, async () => {
    const f = await fixture(false);
    try {
      f.changePane({ agent_status: status });
      const observed = await observeStop(f.herdr, 'w1:p1');
      assert.ok(observed);
      await f.store.record('w1:p1', {
        pane_id: 'w1:p1',
        session_id: observed.session_id,
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: at,
        attempt_count: 2,
        last_attempt_at: at,
        quota_check_count: 1,
        last_quota_check_at: at,
        next_check_at: '2026-10-03T12:05:00Z',
        last_delivery_state: 'none',
      });
      await f.run();
      await f.run();
      const history = await f.store.retry('w1:p1');
      assert.equal(history?.next_check_at, null);
      assert.equal(history?.attempt_count, 2);
      assert.equal(history?.quota_check_count, 1);
      assert.equal(history?.last_delivery_state, 'human');
      assert.equal(f.handoffs.length, 1);
      assert.deepEqual(f.keys, []);
      assert.equal(f.inputs.length, 0);
    } finally {
      await f.cleanup();
    }
  });
}

test('scoped status hook approves a complete menu without a global supervisor lease', async () => {
  const f = await scopedApproval();
  try {
    assert.equal(await f.store.active(), false);
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
    assert.deepEqual(f.handoffs, []);
    assert.equal(await f.store.retry('w1:p1'), null);
  } finally {
    await f.cleanup();
  }
});

test('scoped authority publishes no-send evidence after a focus change and permits fresh assessment', async () => {
  const f = await scopedApproval();
  try {
    f.changePane({ agent_status: 'done' });
    const record = f.deps.store.recordApproval!;
    let changed = false;
    f.deps.store.recordApproval = async (pane, attempt) => {
      await record(pane, attempt);
      if (attempt.state === 'uncertain' && !changed) {
        changed = true;
        f.changePane({ agent_status: 'idle', state_change_seq: 5 });
      }
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
    const saved = await f.store.approval('agy', 's1');
    assert.equal(saved?.state, 'not_sent');
    assert.equal(saved?.not_sent_reason, 'observation_changed');
    await f.run();
    assert.equal(f.inputs.length, 4);
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

test('scoped authority revocation after the uncertain prewrite retains quarantine', async () => {
  const f = await scopedApproval();
  try {
    const record = f.deps.store.recordApproval!;
    f.deps.store.recordApproval = async (pane, attempt) => {
      await record(pane, attempt);
      if (attempt.state === 'uncertain') f.attempt.close();
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
  } finally {
    await f.cleanup();
  }
});

test('captured authority pause after the first assessment sends zero keys', async () => {
  const f = await scopedApproval();
  try {
    const decide = f.deps.decide;
    f.deps.decide = async (input) => {
      const result = await decide(input);
      f.attempt.close();
      return result;
    };
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.equal(f.inputs.length, 1);
    assert.notEqual((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

test('fresh menu uses the shared approval lock without inheriting a recovery grant', async () => {
  const f = await scopedApproval();
  try {
    const observed = await observeStop(f.deps.herdr, 'w1:p1');
    assert.ok(observed);
    await f.store.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'a'.repeat(64),
      error_evidence_digest: 'b'.repeat(64),
      first_observed_at: at,
      attempt_count: 2,
      last_attempt_at: at,
      quota_check_count: 1,
      last_quota_check_at: at,
      next_check_at: '2026-10-03T12:05:00Z',
      last_delivery_state: 'none',
    });
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    const history = await f.store.sessionRetry('agy', 's1');
    assert.equal(history?.attempt_count, 2);
    assert.equal(history?.quota_check_count, 1);
    assert.equal(history?.next_check_at, '2026-10-03T12:05:00Z');
    assert.equal(history?.last_delivery_state, 'none');
  } finally {
    await f.cleanup();
  }
});
