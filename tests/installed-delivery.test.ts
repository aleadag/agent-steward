import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StopInput, StopResult } from '../src/contracts.ts';
import type { AgentSnapshot } from '../src/herdr-adapter/observe.ts';

const pkg = process.env.AGENT_STEWARD_PACKAGE;
const at = '2026-09-29T10:00:30Z';
const instruction =
  'Continue the interrupted task from the last unfinished step. Before repeating the preceding operation, check whether it succeeded; do not repeat completed actions. If the same failure is still current, retry the operation once. If the task is already complete, report that.';
const decision = (input: Pick<StopInput, 'request_id'>): StopResult => ({
  schema_version: 2,
  request_id: input.request_id,
  decision: 'stop_decision',
  proposed_action: { kind: 'send_recovery_instruction', not_before: at, instruction },
  reason_code: 'recoverable_api_error',
  waiting_for: 'recoverable_api_error',
  waiting_confidence: 1,
  risk_probability: 0.1,
  evaluation: {
    model: 'jev-1.13.0',
    usage: {},
    answers: {
      waiting_for: {
        type: 'choice',
        choice: 'recoverable_api_error',
        probabilities: { recoverable_api_error: 1 },
        confidence: 1,
      },
      risky: { type: 'noul', noul: 0.1 },
    },
  },
});

for (const mode of [
  'success',
  'blocked',
  'changed',
  'session-change',
  'released',
  'lease-loss-after-prewrite',
  'uncertain',
] as const) {
  test.skipIf(!pkg)(`installed delivery fencing: ${mode}`, async () => {
    assert.ok(pkg);
    const installed = (name: string) =>
      pathToFileURL(join(pkg, 'lib/agent-steward/dist/src/herdr-adapter', `${name}.js`)).href;
    const { EpisodeStore } = (await import(installed('state'))) as typeof import('../src/herdr-adapter/state.ts');
    const { observeStop } = (await import(installed('observe'))) as typeof import('../src/herdr-adapter/observe.ts');
    const { deliverProposal } = (await import(
      installed('deliver')
    )) as typeof import('../src/herdr-adapter/deliver.ts');
    const root = mkdtempSync(join(tmpdir(), 'steward-installed-fencing-'));
    const store = new EpisodeStore(root);
    let token: string | null = null;
    let current: AgentSnapshot = {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent: 'pi',
      agent_status: 'idle',
      agent_session: { agent: 'pi', source: 'integration:pi', kind: 'id', value: 'synthetic-s1' },
      revision: 8,
      state_change_seq: 4,
    };
    let prompts = 0,
      checks = 0;
    const herdr = {
      get: async () => current,
      read: async () => ({
        pane_id: 'w1:p1',
        source: 'detection',
        revision: 8,
        text: 'Current API failure: request timed out',
        truncated: false,
      }),
      prompt: async (_target: string, text: string) => {
        assert.equal(text, instruction);
        assert.equal((await store.retry('w1:p1'))?.last_delivery_state, 'uncertain', 'prewrite must precede prompt');
        prompts++;
        if (mode === 'uncertain') throw new Error('synthetic lost acknowledgment');
      },
    };
    try {
      const observed = await observeStop(herdr, 'w1:p1');
      assert.ok(observed);
      await store.record('w1:p1', {
        pane_id: 'w1:p1',
        session_id: observed.session_id,
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: at,
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
        next_check_at: null,
        last_delivery_state: 'none',
      });
      token = await store.acquire('synthetic-server');
      assert.ok(token);
      if (mode === 'blocked') current = { ...current, agent_status: 'blocked' };
      if (mode === 'changed') current = { ...current, revision: current.revision + 1 };
      if (mode === 'session-change')
        current = { ...current, agent_session: { ...current.agent_session!, value: 'synthetic-s2' } };
      if (mode === 'released') await store.release(token);
      const guard = async () => {
        checks++;
        if (mode === 'lease-loss-after-prewrite' && checks === 3) await store.release(token!);
        return store.leaseMatches(token!, 'synthetic-server');
      };
      const deliver = () =>
        deliverProposal(
          herdr,
          observed,
          decision({ request_id: 'old' }),
          store,
          { now: () => new Date(at) },
          async (input) => decision(input),
          guard,
        );
      const expected =
        mode === 'success'
          ? 'delivered'
          : mode === 'uncertain' || mode === 'lease-loss-after-prewrite'
            ? 'uncertain'
            : 'human';
      assert.equal(await deliver(), expected);
      if (mode === 'uncertain' || mode === 'success') assert.equal(await deliver(), expected);
      assert.equal(prompts, mode === 'success' || mode === 'uncertain' ? 1 : 0);
      if (mode === 'lease-loss-after-prewrite')
        assert.equal((await store.retry('w1:p1'))?.last_delivery_state, 'uncertain');
    } finally {
      if (token) await store.release(token).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}
