import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPendingApproval } from '../src/herdr-adapter/approval.ts';
import { deliverProposal } from '../src/herdr-adapter/deliver.ts';
import { observeStop } from '../src/herdr-adapter/observe.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { handleEvent, type EventDeps } from '../src/herdr-adapter/entry.ts';
import type { HerdrControl } from '../src/herdr-adapter/deliver.ts';
import type { AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import type { StopResult } from '../src/contracts.ts';

type TestHandoffReason = Parameters<EventDeps['handoff']>[0];
type ApprovalHerdr = HerdrControl & {
  sendKeys: (paneId: string, keys: string[]) => Promise<void>;
  replace: (pane: AgentSnapshot) => void;
  sentKeys: [string, string[]][];
  prompts: [string, string][];
  pendingApproval?: { request_id: string; action: string; control: string };
};

const pane = (tool = 'pi'): AgentSnapshot => ({
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: tool,
  agent_status: 'blocked',
  agent_session: { agent: tool, source: `integration:${tool}`, kind: 'id', value: 's1' },
  revision: 8,
  state_change_seq: 4,
});
const approveProposal = (request_id: string): StopResult => ({
  schema_version: 2,
  request_id,
  decision: 'stop_decision',
  proposed_action: { kind: 'approve_request' },
  reason_code: 'low_risk',
  waiting_for: 'approve_command',
  waiting_confidence: 0.9,
  risk_probability: 0.1,
  evaluation: {
    model: 'jev-1.13.0',
    usage: {},
    answers: {
      waiting_for: {
        type: 'choice',
        choice: 'approve_command',
        probabilities: { approve_command: 0.9, other: 0.1 },
        confidence: 0.9,
      },
      risky: { type: 'noul', noul: 0.1 },
    },
  },
});
async function fixture(tool = 'pi') {
  let current = pane(tool);
  const sentKeys: [string, string[]][] = [];
  const prompts: [string, string][] = [];
  const herdr: ApprovalHerdr = {
    get: async () => current,
    read: async () => ({
      pane_id: 'w1:p1',
      source: 'detection',
      revision: current.revision,
      text: 'Allow proposed command?',
      truncated: false,
    }),
    prompt: async (paneId, text) => {
      prompts.push([paneId, text]);
    },
    sendKeys: async (paneId, keys) => {
      sentKeys.push([paneId, keys]);
    },
    replace: (next) => {
      current = next;
    },
    sentKeys,
    prompts,
  };
  const observation = await observeStop(herdr, 'w1:p1');
  assert.ok(observation);
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-approval-')));
  await store.record('w1:p1', {
    pane_id: 'w1:p1',
    session_id: 's1',
    failure_episode_id: observation.current_episode_id,
    error_evidence_digest: observation.error_evidence_digest,
    first_observed_at: '2026-09-29T10:00:00Z',
    attempt_count: 0,
    last_attempt_at: null,
    quota_check_count: 0,
    last_quota_check_at: null,
    next_check_at: null,
    last_delivery_state: 'none',
  });
  return { herdr, observation, store, proposal: approveProposal('r1') };
}

// Catches treating blocked lifecycle or a low-risk Jev recommendation as request/control proof.
test('unbound blocked approval stays human with zero keys and zero prompts', async () => {
  for (const tool of ['pi', 'codex']) {
    const f = await fixture(tool);
    assert.equal(await verifyPendingApproval(f.herdr, f.observation, f.proposal), null);
    assert.equal(
      await deliverProposal(
        f.herdr,
        f.observation,
        f.proposal,
        f.store,
        { now: () => new Date('2026-09-29T10:00:00Z') },
        async () => f.proposal,
        async () => true,
      ),
      'human',
    );
    assert.deepEqual(f.herdr.sentKeys, []);
    assert.deepEqual(f.herdr.prompts, []);
  }
});

// Catches promoting a forged request ID or a changed acceptance control into authority.
test('changed native-looking request or control still cannot authorize input', async () => {
  for (const tool of ['pi', 'codex']) {
    const f = await fixture(tool);
    f.herdr.pendingApproval = { request_id: 'native-1', action: 'run: safe-command', control: '1' };
    f.herdr.replace(pane(tool));
    assert.equal(await verifyPendingApproval(f.herdr, f.observation, f.proposal), null);
    f.herdr.pendingApproval = { request_id: 'native-2', action: 'run: different-command', control: '2' };
    assert.equal(await verifyPendingApproval(f.herdr, f.observation, f.proposal), null);
    assert.deepEqual(f.herdr.sentKeys, []);
  }
});

// Catches treating detection text with multiple permission dialogs as a unique current request.
test('conflicting approval dialogs in detection text remain unbound', async () => {
  const f = await fixture();
  f.herdr.read = async () => ({
    pane_id: 'w1:p1',
    source: 'detection',
    revision: 8,
    text: 'Allow command A? 1 yes\nAllow edit B? 2 yes',
    truncated: false,
  });
  assert.equal(await verifyPendingApproval(f.herdr, f.observation, f.proposal), null);
  assert.deepEqual(f.herdr.sentKeys, []);
});

// Catches suppressing the human handoff merely because the result passed CLI validation.
test('event approval proposal emits human handoff and never sends keys', async () => {
  const f = await fixture();
  await f.store.clear('w1:p1');
  const token = await f.store.acquire('server-1');
  assert.ok(token);
  const handoffs: TestHandoffReason[] = [];
  try {
    const deps: EventDeps = {
      herdr: f.herdr,
      store: f.store,
      clock: { now: () => new Date('2026-09-29T10:00:00Z') },
      targets: ['w1:p1'],
      sessionId: 'server-1',
      leaseToken: token,
      sessionValid: async () => true,
      decide: async (input) => approveProposal(input.request_id),
      handoff: async (reason) => {
        handoffs.push(reason);
      },
    };
    await handleEvent(
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', agent_status: 'blocked' },
      deps,
    );
    assert.deepEqual(handoffs, ['human_review_required']);
    assert.deepEqual(f.herdr.sentKeys, []);
    assert.deepEqual(f.herdr.prompts, []);
  } finally {
    await f.store.release(token);
  }
});

test('invalidation after either scoped assessment prevents keys and fresh writes', async () => {
  const { beginWorkflow } = await import('../src/herdr-adapter/authority.ts');
  const { WorkflowState } = await import('../src/herdr-adapter/workflow-state.ts');
  const { workflowEventDeps } = await import('../src/herdr-adapter/events.ts');
  const { assessStop } = await import('../src/triage.ts');
  const root = await mkdtemp(join(tmpdir(), 'steward-scoped-invalidation-'));
  const state = new WorkflowState(root);
  const store = new EpisodeStore(root);
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
  try {
    const authority = await attempt.ready;
    assert.ok(authority);
    const dialog =
      'Requesting permission for:\n   printf approval-probe\n\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel\n\n  ↑/↓ Navigate · tab Amend';
    const herdr = {
      get: async () => ({
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent: 'agy',
        agent_status: 'idle' as const,
        agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's1' },
        revision: 259,
        state_change_seq: 4,
      }),
      read: async () => ({ pane_id: 'w1:p1', source: 'detection', revision: 0, text: dialog, truncated: true }),
      sendKeys: async () => {
        throw new Error('invalidated authority must not send keys');
      },
      prompt: async () => {
        throw new Error('invalidated authority must not prompt');
      },
    };
    let assessments = 0;
    const deps = workflowEventDeps(
      {
        herdr,
        store,
        autoApprove: true,
        targets: 'all',
        clock: { now: () => new Date('2026-10-03T12:00:00Z') },
        decide: async (input) => {
          assessments++;
          if (assessments === 1) attempt.close();
          return assessStop(input, {
            thresholds: { risky: 0.6, choiceConfidence: 0.45 },
            now: new Date('2026-10-03T12:00:00Z'),
            evaluate: async () => ({
              model: 'jev-1.13.0',
              usage: {},
              answers: {
                waiting_for: {
                  type: 'choice',
                  choice: 'approve_command',
                  probabilities: { approve_command: 0.9, other: 0.1 },
                  confidence: 0.9,
                },
                risky: { type: 'noul', noul: 0.1 },
              },
            }),
          });
        },
        handoff: async () => {},
      },
      authority,
      state,
    );
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent: 'agy',
        agent_status: 'idle',
      },
      deps,
    );
    assert.equal(assessments, 1);
    assert.equal(await store.approval('agy', 's1'), null);
  } finally {
    attempt.close();
    await attempt.finish();
  }
});
