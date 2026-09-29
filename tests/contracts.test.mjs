import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ApprovalInputSchema,
  ConfigSchema,
  ResultSchema,
  SnapshotSchema,
  StewardError,
  errorResult,
} from '../dist/src/contracts.js';
import { approval, candidate, config, evaluation, snapshot, windowFact } from './helpers.mjs';

const validWindow = windowFact({ type: 'account' });

test('config schema is strict, preserves configured text, and defaults only documented settings', () => {
  const raw = config();
  delete raw.jev;
  delete raw.thresholds;
  raw.candidates[0].id = ' candidate-id ';
  const parsed = ConfigSchema.parse(raw);
  assert.equal(parsed.candidates[0].id, ' candidate-id ');
  assert.deepEqual(parsed.jev, { model: 'jev-1.13.0' });
  assert.deepEqual(parsed.thresholds, { risky: 0.6, choiceConfidence: 0.45 });

  for (const key of ['unknown', 'api_key', 'token', 'credential']) {
    assert.equal(ConfigSchema.safeParse({ ...config(), [key]: 'secret-material' }).success, false);
  }
  assert.equal(ConfigSchema.safeParse({ ...config(), jev: null }).success, false);
  assert.deepEqual(ConfigSchema.parse({ ...config(), thresholds: { risky: 0, choiceConfidence: 1 } }).thresholds, {
    risky: 0,
    choiceConfidence: 1,
  });
  assert.equal(
    ConfigSchema.safeParse({ ...config(), thresholds: { risky: 0.6, choiceConfidence: 0.45, extra: true } }).success,
    false,
  );
  assert.equal(ConfigSchema.safeParse({ ...config(), candidates: [candidate({ model: null })] }).success, false);
});

test('config schema rejects duplicate IDs, invalid references, invalid numbers, and 256 levels', () => {
  const duplicateAccount = config({
    accounts: [
      { id: 'same', source: 'codex' },
      { id: 'same', source: 'codex' },
    ],
  });
  const duplicateCandidate = config({ candidates: [candidate(), candidate({ id: 'codex-astra' })] });
  const badRef = config({ candidates: [candidate({ account_id: 'unknown' })] });
  const duplicateLevel = config({
    candidates: [
      candidate({
        thinking_levels: [
          { id: 'low', description: 'a' },
          { id: 'low', description: 'b' },
        ],
      }),
    ],
  });
  for (const value of [duplicateAccount, duplicateCandidate, badRef, duplicateLevel])
    assert.equal(ConfigSchema.safeParse(value).success, false);

  const levels = Array.from({ length: 256 }, (_, index) => ({ id: `level-${index}`, description: `Level ${index}` }));
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ thinking_levels: levels })] })).success, false);
  for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      ConfigSchema.safeParse(config({ thresholds: { risky: value, choiceConfidence: 0.45 } })).success,
      false,
    );
  }
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ id: '   ' })] })).success, false);
});

test('checked-in example parses and keeps its three illustrative tool/provider pairs distinct', async () => {
  const raw = JSON.parse(await readFile(new URL('../examples/config.json', import.meta.url), 'utf8'));
  const parsed = ConfigSchema.parse(raw);
  assert.equal(parsed.candidates.length, 3);
  assert.deepEqual(
    parsed.candidates.map(({ tool, provider, account_id, model }) => ({ tool, provider, account_id, model })),
    [
      { tool: 'codex', provider: 'openai', account_id: 'codex-subscription-example', model: 'gpt-astra-example' },
      { tool: 'pi', provider: 'openai-codex', account_id: 'codex-subscription-example', model: 'gpt-astra-example' },
      { tool: 'agy', provider: 'google', account_id: 'antigravity-subscription-example', model: 'gemini-example' },
    ],
  );
  assert.deepEqual(
    parsed.candidates.map(({ thinking_levels }) => thinking_levels.map(({ id }) => id)),
    [['low'], ['low'], ['low']],
  );
});

test('snapshot contract validates strict fields, RFC3339 timestamps, ranges, and order', () => {
  assert.equal(SnapshotSchema.safeParse(snapshot([validWindow])).success, true);
  assert.equal(
    SnapshotSchema.safeParse(
      snapshot([
        windowFact(
          { type: 'account' },
          {
            observed_at: '2026-09-28T10:00:00+02:00',
            reset_at: '2026-09-28T12:00:00+02:00',
            valid_until: '2026-09-28T11:00:00+02:00',
          },
        ),
      ]),
    ).success,
    true,
  );
  assert.equal(SnapshotSchema.safeParse({ ...snapshot([]), schema_version: 2 }).success, false);
  assert.equal(SnapshotSchema.safeParse({ ...snapshot([]), hidden: true }).success, false);
  assert.equal(
    SnapshotSchema.safeParse(snapshot([windowFact({ type: 'pool', pool_id: 'primary' }, { remaining_percent: 101 })]))
      .success,
    false,
  );
  assert.equal(
    SnapshotSchema.safeParse(snapshot([windowFact({ type: 'account' }, { observed_at: 'tomorrow' })])).success,
    false,
  );
  assert.equal(
    SnapshotSchema.safeParse(snapshot([windowFact({ type: 'account' }, { reset_at: '2026-09-28T09:00:00Z' })])).success,
    false,
  );
  assert.equal(
    SnapshotSchema.safeParse(
      snapshot([
        windowFact({ type: 'pool', pool_id: 'primary' }, { scope: { type: 'pool', pool_id: 'primary', extra: true } }),
      ]),
    ).success,
    false,
  );
});

test('snapshot ordering preserves sub-millisecond RFC 3339 precision and offset equivalence', () => {
  const precise = windowFact(
    { type: 'account' },
    {
      observed_at: '2026-09-28T10:30:00.0001Z',
      reset_at: '2026-09-28T10:30:00.0002Z',
      valid_until: '2026-09-28T10:30:00.0003Z',
    },
  );
  assert.equal(SnapshotSchema.safeParse(snapshot([precise])).success, true);

  const offsetPrecise = windowFact(
    { type: 'account' },
    {
      observed_at: '2026-09-28T12:30:00.1000+02:00',
      reset_at: '2026-09-28T10:30:00.1001Z',
      valid_until: '2026-09-28T10:30:00.1002Z',
    },
  );
  assert.equal(SnapshotSchema.safeParse(snapshot([offsetPrecise])).success, true);

  const invalidWindows = [
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T10:30:00.0001Z',
        reset_at: '2026-09-28T10:30:00.0001Z',
        valid_until: '2026-09-28T10:30:00.0003Z',
      },
    ),
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T10:30:00.0002Z',
        reset_at: '2026-09-28T10:30:00.0001Z',
        valid_until: '2026-09-28T10:30:00.0003Z',
      },
    ),
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T10:30:00.0001Z',
        reset_at: '2026-09-28T10:30:00.0003Z',
        valid_until: '2026-09-28T10:30:00.0001Z',
      },
    ),
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T10:30:00.0002Z',
        reset_at: '2026-09-28T10:30:00.0003Z',
        valid_until: '2026-09-28T10:30:00.0001Z',
      },
    ),
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T12:30:00.1000+02:00',
        reset_at: '2026-09-28T10:30:00.1Z',
        valid_until: '2026-09-28T10:30:00.1002Z',
      },
    ),
  ];
  for (const window of invalidWindows) assert.equal(SnapshotSchema.safeParse(snapshot([window])).success, false);
});

test('approval input keeps context and action optional, permits arbitrary agent labels, and defaults restriction false', () => {
  const { automatic_approval_forbidden: _restriction, context: _context, ...bare } = approval();
  const parsed = ApprovalInputSchema.parse(bare);
  assert.equal(parsed.automatic_approval_forbidden, false);
  assert.equal(parsed.context, undefined);
  assert.equal(
    ApprovalInputSchema.safeParse({ ...approval(), agent: { id: 'agent', tool: 'an-unlisted-tool' } }).success,
    true,
  );
  assert.equal(ApprovalInputSchema.safeParse({ ...approval(), schema_version: 2 }).success, false);
  assert.equal(ApprovalInputSchema.safeParse({ ...approval(), unexpected: true }).success, false);
  assert.equal(
    ApprovalInputSchema.safeParse({ ...approval(), pending_action: { action: null, secret: 'bad' } }).success,
    false,
  );
  assert.equal(
    ApprovalInputSchema.safeParse({ ...approval(), context: { terminal: 'output', custom: true } }).success,
    true,
  );
});

test('approval context preserves own __proto__ keys at the top level and in nested objects', () => {
  const context = JSON.parse(
    '{"__proto__":"top-level restriction","terminal":"approve","nested":{"__proto__":"nested restriction","constructor":"nested evidence"}}',
  );
  const before = Object.prototype.polluted;
  const parsed = ApprovalInputSchema.safeParse(approval({ context }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(Object.hasOwn(parsed.data.context, '__proto__'), true);
  assert.equal(parsed.data.context.__proto__, 'top-level restriction');
  assert.deepEqual(Object.keys(parsed.data.context.nested), ['__proto__', 'constructor']);
  assert.equal(parsed.data.context.nested.__proto__, 'nested restriction');
  assert.equal(parsed.data.context.nested.constructor, 'nested evidence');
  assert.equal(Object.getPrototypeOf(parsed.data.context), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.data.context.nested), Object.prototype);
  assert.equal(Object.prototype.polluted, before);
});

test('approval context accepts and preserves an own constructor key', () => {
  const context = JSON.parse('{"constructor":"approval restriction","nested":{"constructor":"nested restriction"}}');
  const before = Object.prototype.polluted;
  const parsed = ApprovalInputSchema.safeParse(approval({ context }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(Object.hasOwn(parsed.data.context, 'constructor'), true);
  assert.equal(parsed.data.context.constructor, 'approval restriction');
  assert.equal(parsed.data.context.nested.constructor, 'nested restriction');
  assert.equal(Object.getPrototypeOf(parsed.data.context), Object.prototype);
  assert.equal(Object.prototype.polluted, before);
});

test('approval example uses the validated non-secret stopped-agent input shape', async () => {
  const raw = JSON.parse(await readFile(new URL('../examples/approval.json', import.meta.url), 'utf8'));
  const parsed = ApprovalInputSchema.parse(raw);
  assert.equal(parsed.status, 'stopped');
  assert.equal(parsed.context.includes('current terminal output'), true);
  assert.equal(parsed.pending_action.action, 'Edit the local draft file');
  assert.equal(parsed.automatic_approval_forbidden, false);
});

test('result contract accepts the shared selected, evaluated approval, local approval, and error envelopes', () => {
  const evalResult = evaluation({
    waiting_for: { type: 'choice', choice: 'approve_command', probabilities: { approve_command: 1 }, confidence: 0.9 },
    risky: { type: 'noul', noul: 0.2 },
  });
  const common = { schema_version: 1, request_id: 'request-1', evaluation: evalResult };
  const selected = {
    schema_version: 1,
    request_id: 'route-1',
    decision: 'selected',
    selected: {
      candidate_id: 'codex-astra',
      tool: 'codex',
      provider: 'openai',
      model: 'gpt-astra-example',
      thinking_level: 'low',
      account_id: 'shared',
      quota_pool: 'primary',
    },
    quota: {
      source: 'codex',
      account_id: 'shared',
      pool_id: 'primary',
      snapshot_status: 'loaded',
      account_status: 'known',
      pool_status: 'unknown',
      windows: [],
    },
    planned_command: {
      executable: 'codex',
      args: ['--model', 'gpt-astra-example'],
      display: 'codex --model gpt-astra-example',
      syntax_validated: true,
      runtime_selection: 'unverified',
      authentication: 'unverified',
      provider_selection: 'existing_settings',
    },
    evaluations: {
      pair: evaluation({
        candidate: { type: 'choice', choice: 'codex-astra', probabilities: { 'codex-astra': 1 }, confidence: 0.8 },
      }),
      effort: { kind: 'fixed', level: 'low' },
    },
  };
  const approvalResult = {
    ...common,
    decision: 'approve',
    reason_code: 'low_risk',
    waiting_for: 'approve_command',
    waiting_confidence: 0.9,
    risk_probability: 0.2,
  };
  const local = {
    schema_version: 1,
    request_id: 'request-2',
    decision: 'manual_review',
    reason_code: 'insufficient_context',
    waiting_for: null,
    waiting_confidence: null,
    risk_probability: null,
    evaluation: null,
  };
  const error = {
    schema_version: 1,
    request_id: null,
    decision: 'error',
    reason_code: 'invalid_config',
    message: 'Configuration is invalid.',
  };
  for (const value of [selected, approvalResult, local, error])
    assert.equal(ResultSchema.safeParse(value).success, true);
  assert.equal(ResultSchema.safeParse({ ...local, risk_probability: 0 }).success, false);
  assert.equal(ResultSchema.safeParse({ ...approvalResult, unknown: true }).success, false);
  assert.equal(ResultSchema.safeParse({ ...error, reason_code: 'made_up' }).success, false);

  const missingRequiredFields = [
    (({ planned_command: _plannedCommand, ...value }) => value)(selected),
    (({ evaluation: _evaluation, ...value }) => value)(approvalResult),
    (({ risk_probability: _riskProbability, ...value }) => value)(local),
    (({ message: _message, ...value }) => value)(error),
  ];
  for (const value of missingRequiredFields) assert.equal(ResultSchema.safeParse(value).success, false);

  for (const value of [selected, approvalResult, local, error]) {
    assert.equal(ResultSchema.safeParse({ ...value, schema_version: 2 }).success, false);
  }
});

test('evaluated approval result decision and reason codes must agree', () => {
  const valid = {
    schema_version: 1,
    request_id: 'request-1',
    decision: 'approve',
    reason_code: 'low_risk',
    waiting_for: 'approve_command',
    waiting_confidence: 0.9,
    risk_probability: 0.1,
    evaluation: evaluation({
      waiting_for: {
        type: 'choice',
        choice: 'approve_command',
        probabilities: {
          approve_command: 1,
          approve_edit: 0,
          answer_question: 0,
          credentials: 0,
          error_help: 0,
          other: 0,
        },
        confidence: 0.9,
      },
      risky: { type: 'noul', noul: 0.1 },
    }),
  };
  assert.equal(ResultSchema.safeParse(valid).success, true);
  for (const value of [
    { ...valid, decision: 'approve', reason_code: 'high_risk' },
    { ...valid, decision: 'no_action', reason_code: 'low_risk' },
    { ...valid, decision: 'no_action', reason_code: 'not_approval' },
    { ...valid, decision: 'approve', reason_code: 'not_approval', waiting_for: 'answer_question' },
    { ...valid, decision: 'manual_review', reason_code: 'explicit_restriction', waiting_for: 'answer_question' },
    { ...valid, decision: 'manual_review', reason_code: 'high_risk', waiting_for: 'other' },
  ])
    assert.equal(ResultSchema.safeParse(value).success, false);
});

test('error envelopes expose only catalogued messages and safe codes', () => {
  const value = errorResult(new StewardError('invalid_config'), 'request-3');
  assert.deepEqual(value, {
    schema_version: 1,
    request_id: 'request-3',
    decision: 'error',
    reason_code: 'invalid_config',
    message: 'Configuration is invalid.',
  });

  const unknown = errorResult(new Error('secret-token and /private/path'), null);
  assert.equal(unknown.reason_code, 'evaluation_failed');
  assert.equal(unknown.message, 'Evaluation failed.');
  assert.equal(unknown.message.includes('secret-token'), false);
});
