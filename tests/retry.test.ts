import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { StopInputSchema } from '../src/contracts.ts';
import type { StopInput } from '../src/contracts.ts';
import { retryProposal } from '../src/retry.ts';

const first = '2026-09-29T10:00:00Z';
const now = new Date('2026-09-29T10:00:00Z');

function input(overrides: Partial<StopInput> = {}): StopInput {
  return StopInputSchema.parse({
    schema_version: 2,
    request_id: 'r1',
    agent: { id: 'a', tool: 'pi', pane_id: 'w1:p2', session_id: null },
    status: 'blocked',
    current_episode_id: 'e1',
    context: 'API error',
    automatic_approval_forbidden: false,
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: first,
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
    ...overrides,
  });
}

test('recovery deliveries use episode-anchored 30s, 2m, and 8m deadlines then escalate', () => {
  const cases: [StopInput, Date, string][] = [
    [input(), now, '2026-09-29T10:00:30.000Z'],
    [
      input({
        retry: {
          failure_episode_id: 'e1',
          first_observed_at: first,
          attempt_count: 1,
          last_attempt_at: '2026-09-29T10:01:00Z',
          quota_check_count: 0,
          last_quota_check_at: null,
        },
      }),
      new Date('2026-09-29T10:01:00Z'),
      '2026-09-29T10:03:00.000Z',
    ],
    [
      input({
        retry: {
          failure_episode_id: 'e1',
          first_observed_at: first,
          attempt_count: 2,
          last_attempt_at: '2026-09-29T10:02:00Z',
          quota_check_count: 0,
          last_quota_check_at: null,
        },
      }),
      new Date('2026-09-29T10:02:00Z'),
      '2026-09-29T10:10:00.000Z',
    ],
  ];
  for (const [state, checkedAt, notBefore] of cases) {
    assert.deepEqual(retryProposal(state, 'recoverable_api_error', checkedAt), {
      kind: 'send_recovery_instruction',
      not_before: notBefore,
      instruction:
        'Check whether the preceding operation succeeded. If it did, do nothing. If the same failure is still current, retry the operation once.',
    });
  }
  const fractional = input({
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: '2026-09-29T12:00:00.123456+02:00',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
  });
  assert.deepEqual(retryProposal(fractional, 'recoverable_api_error', new Date('2026-09-29T10:00:01Z')), {
    kind: 'send_recovery_instruction',
    not_before: '2026-09-29T10:00:30.123456Z',
    instruction:
      'Check whether the preceding operation succeeded. If it did, do nothing. If the same failure is still current, retry the operation once.',
  });
  const overdue = input();
  assert.deepEqual(retryProposal(overdue, 'recoverable_api_error', new Date('2026-09-29T11:00:00Z')), {
    kind: 'send_recovery_instruction',
    not_before: '2026-09-29T10:00:30.000Z',
    instruction:
      'Check whether the preceding operation succeeded. If it did, do nothing. If the same failure is still current, retry the operation once.',
  });
  const exhausted = input({
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: first,
      attempt_count: 3,
      last_attempt_at: '2026-09-29T10:02:00Z',
      quota_check_count: 0,
      last_quota_check_at: null,
    },
  });
  assert.deepEqual(retryProposal(exhausted, 'recoverable_api_error', now), { kind: 'manual_review' });
});

test('ready done and idle errors preserve bounded recovery and quota proposals', () => {
  for (const status of ['done', 'idle'] as const) {
    assert.deepEqual(retryProposal(input({ status }), 'recoverable_api_error', now), {
      kind: 'send_recovery_instruction',
      not_before: '2026-09-29T10:00:30.000Z',
      instruction:
        'Check whether the preceding operation succeeded. If it did, do nothing. If the same failure is still current, retry the operation once.',
    });
    assert.deepEqual(retryProposal(input({ status }), 'quota_limit', now), {
      kind: 'wait_for_quota',
      not_before: '2026-09-29T10:05:00.000Z',
    });
    const exhausted = input({ status, retry: { ...input().retry, attempt_count: 3, last_attempt_at: first } });
    assert.deepEqual(retryProposal(exhausted, 'recoverable_api_error', now), { kind: 'manual_review' });
    assert.deepEqual(retryProposal(input({ status }), 'quota_limit', new Date('2026-09-30T10:00:00Z')), {
      kind: 'manual_review',
    });
  }
});

test('invalid recovery episode chronology fails closed', () => {
  const cases = [
    input({
      retry: {
        failure_episode_id: 'e1',
        first_observed_at: '2026-09-29T10:01:00Z',
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
      },
    }),
    input({
      retry: {
        failure_episode_id: 'e1',
        first_observed_at: first,
        attempt_count: 1,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
      },
    }),
    input({
      retry: {
        failure_episode_id: 'e1',
        first_observed_at: first,
        attempt_count: 0,
        last_attempt_at: '2026-09-29T10:00:00Z',
        quota_check_count: 0,
        last_quota_check_at: null,
      },
    }),
    input({
      retry: {
        failure_episode_id: 'e1',
        first_observed_at: first,
        attempt_count: 1,
        last_attempt_at: '2026-09-29T10:01:00Z',
        quota_check_count: 0,
        last_quota_check_at: null,
      },
    }),
  ];
  for (const state of cases)
    assert.deepEqual(retryProposal(state, 'recoverable_api_error', now), { kind: 'manual_review' });
});

test('asserted resets without independently verified account and all-window binding use fallback timing', () => {
  const state = input({
    reset: {
      reset_at: '2026-09-29T11:00:00Z',
      observed_at: '2026-09-29T09:30:00Z',
      valid_until: '2026-09-29T10:30:00Z',
      source: 'codex',
      account_id: 'unbound-account',
      pool_id: 'primary',
      scope: { type: 'pool', pool_id: 'primary' },
    },
  });
  assert.deepEqual(retryProposal(state, 'quota_limit', now), {
    kind: 'wait_for_quota',
    not_before: '2026-09-29T10:05:00.000Z',
  });
});

test('quota without a fresh usable reset backs off from recorded check history', () => {
  const cases: [StopInput, Date, string][] = [
    [input(), now, '2026-09-29T10:05:00.000Z'],
    [
      input({
        retry: {
          failure_episode_id: 'e1',
          first_observed_at: first,
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 1,
          last_quota_check_at: '2026-09-29T10:05:00Z',
        },
      }),
      new Date('2026-09-29T10:05:00Z'),
      '2026-09-29T10:20:00.000Z',
    ],
    [
      input({
        retry: {
          failure_episode_id: 'e1',
          first_observed_at: first,
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 2,
          last_quota_check_at: '2026-09-29T10:20:00Z',
        },
      }),
      new Date('2026-09-29T10:20:00Z'),
      '2026-09-29T11:05:00.000Z',
    ],
    [
      input({
        retry: {
          failure_episode_id: 'e1',
          first_observed_at: first,
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 3,
          last_quota_check_at: '2026-09-29T11:05:00Z',
        },
      }),
      new Date('2026-09-29T11:05:00Z'),
      '2026-09-29T13:05:00.000Z',
    ],
    [
      input({
        retry: {
          failure_episode_id: 'e1',
          first_observed_at: first,
          attempt_count: 0,
          last_attempt_at: null,
          quota_check_count: 4,
          last_quota_check_at: '2026-09-29T13:05:00Z',
        },
      }),
      new Date('2026-09-29T13:05:00Z'),
      '2026-09-29T19:05:00.000Z',
    ],
  ];
  for (const [state, checkedAt, notBefore] of cases) {
    assert.deepEqual(retryProposal(state, 'quota_limit', checkedAt), { kind: 'wait_for_quota', not_before: notBefore });
  }
  const overdue = input();
  assert.deepEqual(retryProposal(overdue, 'quota_limit', new Date('2026-09-29T10:06:00Z')), { kind: 'manual_review' });
  assert.deepEqual(retryProposal(overdue, 'quota_limit', new Date('2026-09-29T10:05:00Z')), { kind: 'manual_review' });
  const advancedCheck = input({
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: first,
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 1,
      last_quota_check_at: '2026-09-29T10:05:00Z',
    },
  });
  assert.deepEqual(retryProposal(advancedCheck, 'quota_limit', new Date('2026-09-29T10:05:00Z')), {
    kind: 'wait_for_quota',
    not_before: '2026-09-29T10:20:00.000Z',
  });
});

test('stale, future-observed, or passed reset evidence uses bounded fallback timing', () => {
  for (const reset of [
    { observed_at: '2026-09-29T09:00:00Z', valid_until: '2026-09-29T09:59:59Z', reset_at: '2026-09-29T11:00:00Z' },
    { observed_at: '2026-09-29T10:00:01Z', valid_until: '2026-09-29T11:00:00Z', reset_at: '2026-09-29T11:00:00Z' },
    { observed_at: '2026-09-29T09:00:00Z', valid_until: '2026-09-29T11:00:00Z', reset_at: '2026-09-29T10:00:00Z' },
  ]) {
    const state = input({
      reset: {
        ...reset,
        source: 'codex',
        account_id: 'acct',
        pool_id: 'primary',
        scope: { type: 'pool', pool_id: 'primary' },
      },
    });
    assert.deepEqual(retryProposal(state, 'quota_limit', now), {
      kind: 'wait_for_quota',
      not_before: '2026-09-29T10:05:00.000Z',
    });
  }
  const mismatchedPool = input({
    reset: {
      reset_at: '2026-09-29T11:00:00Z',
      observed_at: '2026-09-29T09:30:00Z',
      valid_until: '2026-09-29T10:30:00Z',
      source: 'codex',
      account_id: 'acct',
      pool_id: 'primary',
      scope: { type: 'pool', pool_id: 'other' },
    },
  });
  assert.deepEqual(retryProposal(mismatchedPool, 'quota_limit', now), {
    kind: 'wait_for_quota',
    not_before: '2026-09-29T10:05:00.000Z',
  });
});

test('foreign episode history and non-actionable statuses fail closed', () => {
  const foreign = input({ current_episode_id: 'different' });
  assert.deepEqual(retryProposal(foreign, 'recoverable_api_error', now), { kind: 'manual_review' });
  assert.deepEqual(retryProposal(foreign, 'quota_limit', now), { kind: 'manual_review' });
  assert.deepEqual(retryProposal(input({ status: 'unknown' }), 'recoverable_api_error', now), {
    kind: 'manual_review',
  });
  assert.deepEqual(retryProposal(input({ status: 'unknown' }), 'quota_limit', now), { kind: 'manual_review' });
});

test('quota history must be chronological and hands off after 24 hours', () => {
  const invalid = input({
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: first,
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 1,
      last_quota_check_at: null,
    },
  });
  assert.deepEqual(retryProposal(invalid, 'quota_limit', now), { kind: 'manual_review' });
  const expired = input({
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: first,
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
  });
  assert.deepEqual(retryProposal(expired, 'quota_limit', new Date('2026-09-30T10:00:00Z')), { kind: 'manual_review' });
});
