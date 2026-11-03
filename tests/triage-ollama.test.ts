import { test } from 'bun:test';
import assert from 'node:assert/strict';
import type { StopInput } from '../src/contracts.ts';
import { makeEvaluator, postHttps } from '../src/jev.ts';
import { assessStop } from '../src/triage.ts';

// Requires a running local Ollama with the specified model already pulled:
// AGENT_STEWARD_TEST_OLLAMA_MODEL=kev:4b-q8_0 bun test tests/triage-ollama.test.ts
const model = process.env.AGENT_STEWARD_TEST_OLLAMA_MODEL;
const connectionError = 'Error: Unable to connect. Is the computer able to access the url?';
const cases = [
  ['connection error', connectionError, 'idle', 'recoverable_api_error', 'send_recovery_instruction'],
  ['done connection error', connectionError, 'done', 'recoverable_api_error', 'send_recovery_instruction'],
  [
    'wrapped connection error',
    'Error: Unable to connect. Is the computer able to\naccess the url?',
    'idle',
    'recoverable_api_error',
    'send_recovery_instruction',
  ],
  [
    'timeout',
    'Error: API request timed out. Retry failed after 3 attempts.',
    'idle',
    'recoverable_api_error',
    'send_recovery_instruction',
  ],
  [
    'overload',
    'Error: Our servers are currently overloaded. Please try again later.',
    'idle',
    'recoverable_api_error',
    'send_recovery_instruction',
  ],
  [
    'quota detail overrides connection diagnostic',
    `${connectionError}\nHTTP 429: daily quota exhausted. Wait for the daily quota reset.`,
    'idle',
    'quota_limit',
    'wait_for_quota',
  ],
  [
    'authentication detail overrides connection diagnostic',
    `${connectionError}\nHTTP 401: invalid API key. Authentication is required before making another request.`,
    'idle',
    'credentials',
    'manual_review',
  ],
  [
    'expired certificate is not transient',
    `${connectionError}\nCause: certificate verification failed because the server certificate expired. Fix the certificate; retrying unchanged cannot work.`,
    'idle',
    'permanent_error',
    'manual_review',
  ],
  [
    'resolved historical error',
    `Earlier: ${connectionError}\nThe connection recovered. The task is now complete, all tests passed, and there is no remaining error.`,
    'idle',
    'completed',
    'no_action',
  ],
  [
    'quoted diagnostic is not a current error',
    `Please explain what the following documentation example means: "${connectionError}". There is no current connection error.`,
    'idle',
    'answer_question',
    'manual_review',
  ],
  [
    'current permission after resolved error',
    `Previous error (resolved): ${connectionError}\nCurrent: Requesting permission for: bun test\n1. Allow once\n2. Reject`,
    'blocked',
    'approve_command',
    'manual_review',
  ],
] as const;

for (const [name, context, status, waitingFor, action] of cases) {
  test.skipIf(!model)(
    `local Ollama stop classification: ${name}`,
    async () => {
      assert.ok(model);
      const now = new Date('2026-11-03T10:00:00Z');
      const input: StopInput = {
        schema_version: 2,
        request_id: 'diagnostic-prompt-comparison',
        agent: { id: 'diagnostic-only', tool: 'pi', pane_id: 'diagnostic-only', session_id: null },
        status,
        current_episode_id: 'diagnostic-only',
        context,
        pending_action: null,
        automatic_approval_forbidden: false,
        retry: {
          failure_episode_id: 'diagnostic-only',
          first_observed_at: now.toISOString(),
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 0,
          last_quota_check_at: null,
        },
      };
      const result = await assessStop(input, {
        now,
        thresholds: { risky: 0.6, choiceConfidence: 0.45 },
        evaluate: makeEvaluator({ model, provider: 'ollama', post: postHttps }),
      });
      assert.equal(result.decision, 'stop_decision');
      if (result.decision !== 'stop_decision') throw new Error('expected stop decision');
      assert.equal(result.waiting_for, waitingFor);
      assert.equal(result.proposed_action.kind, action);
    },
    35_000,
  );
}
