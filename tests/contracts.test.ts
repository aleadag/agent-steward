import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { ErrorCode, StopResult } from '../src/contracts.ts';
import {
  ConfigSchema,
  ResultSchema,
  SnapshotSchema,
  StopInputSchema,
  StewardError,
  errorResult,
} from '../src/contracts.ts';
import * as contractExports from '../src/contracts.ts';
import { stopInput, candidate, config, evaluation, snapshot, windowFact } from './helpers.ts';

type StopDecision = Extract<StopResult, { decision: 'stop_decision' }>;

const validWindow = windowFact({ type: 'account' });

test('config schema is strict, preserves configured text, and defaults only documented settings', () => {
  const { evaluator: _evaluator, thresholds: _thresholds, ...raw } = config();
  const firstCandidate = raw.candidates[0];
  assert.ok(firstCandidate);
  firstCandidate.id = ' candidate-id ';
  const parsed = ConfigSchema.parse(raw);
  const parsedCandidate = parsed.candidates[0];
  assert.ok(parsedCandidate);
  assert.equal(parsedCandidate.id, ' candidate-id ');
  assert.deepEqual(parsed.evaluator, { type: 'jev', provider: 'typesafe', model: 'jev-1.13.0' });
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

test('config requires finite positive cost on each candidate', () => {
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ cost: 1 })] })).success, true);
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ cost: 2 })] })).success, true);
  const { cost: _cost, ...withoutCost } = candidate();
  assert.equal(ConfigSchema.safeParse(config({ candidates: [withoutCost] })).success, false);
  for (const cost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
    assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ cost })] })).success, false, String(cost));
  }
});

test('config requires quota_bucket pairing and rejects accounts and account_id', () => {
  assert.equal(ConfigSchema.safeParse(config()).success, true);
  assert.equal(ConfigSchema.safeParse({ ...config(), accounts: [] }).success, false);
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ account_id: 'shared' })] })).success, false);
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ quota_bucket: undefined })] })).success, false);
  for (const tool of ['codex', 'pi', 'agy']) {
    for (const quota_bucket of ['codex', 'pi_codex', 'pi_xai', 'antigravity', 'unknown']) {
      const allowed =
        tool === 'codex'
          ? quota_bucket === 'codex'
          : tool === 'pi'
            ? ['pi_codex', 'pi_xai'].includes(quota_bucket)
            : quota_bucket === 'antigravity';
      assert.equal(
        ConfigSchema.safeParse(config({ candidates: [candidate({ tool, quota_bucket })] })).success,
        allowed,
        `${tool}/${quota_bucket}`,
      );
    }
  }
});

test('snapshot requires identity_fingerprint and optional window cadence', () => {
  assert.equal(SnapshotSchema.safeParse(snapshot([windowFact({ type: 'account' })])).success, true);
  for (const identity_fingerprint of [
    undefined,
    '',
    'ab'.repeat(31),
    'ab'.repeat(33),
    'AB'.repeat(32),
    'gh'.repeat(32),
  ]) {
    assert.equal(SnapshotSchema.safeParse({ ...snapshot([]), identity_fingerprint }).success, false);
  }
  assert.equal(SnapshotSchema.safeParse({ ...snapshot([]), account_id: 'shared' }).success, false);
  for (const source of ['codex', 'pi_codex', 'pi_xai']) {
    assert.equal(
      SnapshotSchema.safeParse(
        snapshot([windowFact({ type: 'account' }, { id: 'primary', cadence: 'weekly' })], {
          identity_fingerprint: 'ab'.repeat(32),
          source,
        }),
      ).success,
      true,
    );
  }
  assert.equal(SnapshotSchema.safeParse(snapshot([], { source: 'antigravity' })).success, true);
  assert.equal(
    SnapshotSchema.safeParse(snapshot([windowFact({ type: 'account' }, { cadence: 'other' })])).success,
    true,
  );
  for (const overrides of [{ id: '' }, { id: '  ' }, { cadence: 'daily' }, { extra: true }]) {
    assert.equal(SnapshotSchema.safeParse(snapshot([windowFact({ type: 'account' }, overrides)])).success, false);
  }
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
    parsed.candidates.map(({ tool, provider, quota_bucket, model }) => ({ tool, provider, quota_bucket, model })),
    [
      { tool: 'codex', provider: 'openai', quota_bucket: 'codex', model: 'gpt-astra-example' },
      { tool: 'pi', provider: 'openai-codex', quota_bucket: 'pi_codex', model: 'gpt-astra-example' },
      { tool: 'agy', provider: 'google', quota_bucket: 'antigravity', model: 'gemini-3.8-flash' },
    ],
  );
  assert.deepEqual(
    parsed.candidates.map(({ thinking_levels }) => thinking_levels.map(({ id }) => id)),
    [['low'], ['low'], ['low', 'medium', 'high']],
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

test('stop input keeps context and action optional, permits arbitrary agent labels, and defaults restriction false', () => {
  const {
    automatic_approval_forbidden: _restriction,
    context: _context,
    pending_action: _action,
    ...bare
  } = stopInput();
  const parsed = StopInputSchema.parse(bare);
  assert.equal(parsed.automatic_approval_forbidden, false);
  assert.equal(parsed.context, undefined);
  assert.equal(
    StopInputSchema.safeParse({ ...stopInput(), agent: { ...stopInput().agent, tool: 'an-unlisted-tool' } }).success,
    true,
  );
  assert.equal(StopInputSchema.safeParse({ ...stopInput(), schema_version: 1 }).success, false);
  assert.equal(StopInputSchema.safeParse({ ...stopInput(), unexpected: true }).success, false);
  assert.equal(
    StopInputSchema.safeParse({ ...stopInput(), pending_action: { action: null, secret: 'bad' } }).success,
    false,
  );
  assert.equal(
    StopInputSchema.safeParse({ ...stopInput(), context: { terminal: 'output', custom: true } }).success,
    true,
  );
});

test('stop context preserves own __proto__ keys at the top level and in nested objects', () => {
  const context = JSON.parse(
    '{"__proto__":"top-level restriction","terminal":"approve","nested":{"__proto__":"nested restriction","constructor":"nested evidence"}}',
  );
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
  const parsed = StopInputSchema.safeParse(stopInput({ context }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const parsedContext = parsed.data.context;
  assert.ok(parsedContext !== null && typeof parsedContext === 'object');
  const nested = parsedContext.nested;
  assert.ok(nested !== null && typeof nested === 'object');
  const nestedContext = nested as Record<string, unknown>;
  assert.equal(Object.hasOwn(parsedContext, '__proto__'), true);
  assert.equal(parsedContext.__proto__, 'top-level restriction');
  assert.deepEqual(Object.keys(nestedContext), ['__proto__', 'constructor']);
  assert.equal(nestedContext.__proto__, 'nested restriction');
  assert.equal(nestedContext.constructor, 'nested evidence');
  assert.equal(Object.getPrototypeOf(parsedContext), Object.prototype);
  assert.equal(Object.getPrototypeOf(nestedContext), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'), before);
});

test('stop context accepts and preserves an own constructor key', () => {
  const context = JSON.parse('{"constructor":"approval restriction","nested":{"constructor":"nested restriction"}}');
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
  const parsed = StopInputSchema.safeParse(stopInput({ context }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const parsedContext = parsed.data.context;
  assert.ok(parsedContext !== null && typeof parsedContext === 'object');
  const nested = parsedContext.nested;
  assert.ok(nested !== null && typeof nested === 'object');
  const nestedContext = nested as Record<string, unknown>;
  assert.equal(Object.hasOwn(parsedContext, 'constructor'), true);
  assert.equal(parsedContext.constructor, 'approval restriction');
  assert.equal(nestedContext.constructor, 'nested restriction');
  assert.equal(Object.getPrototypeOf(parsedContext), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'), before);
});

test('stop example parses as a version-2 observation with episode-matched retry history', async () => {
  const raw = JSON.parse(await readFile(new URL('../examples/stop.json', import.meta.url), 'utf8'));
  const parsed = StopInputSchema.parse(raw);
  assert.equal(parsed.status, 'blocked');
  assert.equal(parsed.current_episode_id, parsed.retry.failure_episode_id);
  assert.ok(typeof parsed.context === 'string');
  assert.equal(parsed.context.includes('current permission prompt'), true);
  assert.ok(parsed.pending_action !== null && typeof parsed.pending_action === 'object');
  assert.equal(parsed.pending_action.action, "Run the project's unit tests");
  assert.equal(parsed.automatic_approval_forbidden, false);
});

test('result contract accepts selected and error envelopes, but rejects retired approval envelopes', () => {
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
      quota_bucket: 'codex',
      quota_pool: 'primary',
    },
    quota: {
      source: 'codex',
      quota_bucket: 'codex',
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
  assert.equal(ResultSchema.safeParse(selected).success, true);
  for (const key of ['selected', 'quota'] as const) {
    assert.equal(
      ResultSchema.safeParse({ ...selected, [key]: { ...selected[key], account_id: 'shared' } }).success,
      false,
    );
    assert.equal(
      ResultSchema.safeParse({ ...selected, [key]: { ...selected[key], quota_bucket: undefined } }).success,
      false,
    );
  }
  assert.equal(
    ResultSchema.safeParse({
      ...selected,
      quota: {
        ...selected.quota,
        windows: [{ ...validWindow, id: 'primary', cadence: 'weekly', status: 'known', reason: null }],
      },
    }).success,
    true,
  );
  const approvalResult = {
    schema_version: 1,
    request_id: 'request-1',
    evaluation: evaluation({}),
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
  for (const value of [selected, error]) assert.equal(ResultSchema.safeParse(value).success, true);
  for (const value of [approvalResult, local]) assert.equal(ResultSchema.safeParse(value).success, false);
  assert.equal(ResultSchema.safeParse({ ...local, risk_probability: 0 }).success, false);
  assert.equal(ResultSchema.safeParse({ ...approvalResult, unknown: true }).success, false);
  assert.equal(ResultSchema.safeParse({ ...error, reason_code: 'made_up' }).success, false);

  const missingRequiredFields = [
    (({ planned_command: _plannedCommand, ...value }) => value)(selected),
    (({ message: _message, ...value }) => value)(error),
  ];
  for (const value of missingRequiredFields) assert.equal(ResultSchema.safeParse(value).success, false);

  for (const value of [selected, approvalResult, local, error]) {
    assert.equal(ResultSchema.safeParse({ ...value, schema_version: 2 }).success, false);
  }
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

test('live-launch errors use fixed credential-free schema-1 envelopes', () => {
  const expectedMessages: [ErrorCode, string][] = [
    ['interactive_terminal_required', 'Interactive terminal input and output are required.'],
    ['launch_failed', 'Agent launch failed or its outcome is uncertain.'],
  ];

  for (const [code, message] of expectedMessages) {
    const result = errorResult(new StewardError(code), 'req');
    const parsed = ResultSchema.parse(result);
    assert.equal(parsed.schema_version, 1);
    assert.ok(parsed.decision === 'error');
    assert.equal(parsed.reason_code, code);
    assert.equal(parsed.message, message);
  }
});

test('stop input agent.tool accepts any nonempty Herdr agent string', () => {
  const base = {
    schema_version: 2,
    request_id: 'r1',
    agent: { id: 'a', tool: 'pi', pane_id: 'w1:p2', session_id: null },
    status: 'blocked',
    current_episode_id: 'e1',
    context: 'API error',
    automatic_approval_forbidden: false,
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
  };
  for (const tool of ['agy', 'pi', 'codex', 'claude']) {
    assert.equal(StopInputSchema.parse({ ...base, agent: { ...base.agent, tool } }).agent.tool, tool);
  }
  for (const tool of ['', ' ', '\t\n']) {
    assert.equal(StopInputSchema.safeParse({ ...base, agent: { ...base.agent, tool } }).success, false);
  }
});

test('routing rejects arbitrary Herdr agent labels in tools and candidates', () => {
  assert.equal(ConfigSchema.safeParse(config({ tools: ['claude'] })).success, false);
  assert.equal(ConfigSchema.safeParse(config({ candidates: [candidate({ tool: 'claude' })] })).success, false);
});

test('version-2 stop input strictly validates adapter observations and retry/reset metadata', () => {
  const { StopInputSchema } = contractExports;
  assert.equal(typeof StopInputSchema?.parse, 'function');
  const input = {
    schema_version: 2,
    request_id: 'r1',
    agent: { id: 'a', tool: 'pi', pane_id: 'w1:p2', session_id: null },
    status: 'blocked',
    current_episode_id: 'e1',
    context: 'API error',
    automatic_approval_forbidden: false,
    retry: {
      failure_episode_id: 'e1',
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
  };
  const parsed = StopInputSchema.parse(input);
  assert.equal(parsed.agent.pane_id, 'w1:p2');
  assert.equal(parsed.current_episode_id, 'e1');
  const { current_episode_id: _episodeId, ...withoutCurrentEpisodeId } = input;
  assert.equal(StopInputSchema.safeParse(withoutCurrentEpisodeId).success, false);
  const { automatic_approval_forbidden: _restriction, ...withoutRestriction } = input;
  assert.equal(StopInputSchema.parse(withoutRestriction).automatic_approval_forbidden, false);

  const reset = {
    reset_at: '2026-09-29T12:00:00Z',
    observed_at: '2026-09-29T10:00:00Z',
    valid_until: '2026-09-29T11:00:00Z',
    source: 'codex',
    account_id: 'account-1',
    pool_id: 'pool-1',
    scope: { type: 'pool', pool_id: 'pool-1' },
  };
  assert.equal(StopInputSchema.safeParse({ ...input, reset }).success, true);
  assert.equal(StopInputSchema.safeParse({ ...input, reset: { ...reset, source: 'terminal' } }).success, false);
  assert.equal(
    StopInputSchema.safeParse({ ...input, reset: { ...reset, scope: { type: 'account', hidden: true } } }).success,
    false,
  );
  assert.equal(StopInputSchema.safeParse({ ...input, reset: { ...reset, verified: true } }).success, false);

  const invalidInputs = [
    { ...input, hidden: true },
    { ...input, schema_version: 1 },
    { ...input, status: 'stopped' },
    { ...input, agent: { ...input.agent, tool: '' } },
    { ...input, agent: { ...input.agent, session_id: 4 } },
    { ...input, agent: { ...input.agent, unexpected: true } },
    { ...input, pending_action: { action: 'Edit file', secret: 'bad' } },
    { ...input, retry: { ...input.retry, hidden: true } },
    { ...input, reset: { ...reset, hidden: true } },
    { ...input, reset: { ...reset, windows: [reset] } },
    { ...input, reset: { ...reset, observed_at: 'tomorrow' } },
    { ...input, retry: { ...input.retry, attempt_count: -1 } },
    { ...input, retry: { ...input.retry, quota_check_count: -1 } },
    { ...input, retry: { ...input.retry, attempt_count: 0.5 } },
    { ...input, retry: { ...input.retry, first_observed_at: 'tomorrow' } },
    { ...input, retry: { ...input.retry, last_attempt_at: '2026-02-30T10:00:00Z' } },
    { ...input, retry: { ...input.retry, last_quota_check_at: 'not-a-date' } },
  ];
  for (const value of invalidInputs) assert.equal(StopInputSchema.safeParse(value).success, false);
});

test('version-2 stop results enforce action, reason, classification, and metric consistency', () => {
  const { StopResultSchema } = contractExports;
  assert.equal(typeof StopResultSchema?.safeParse, 'function');
  const evaluatedResult = (
    proposed_action: StopDecision['proposed_action'],
    reason_code: StopDecision['reason_code'],
    waiting_for: StopDecision['waiting_for'],
    options: { waiting_confidence?: number | null; risk_probability?: number | null; evaluated?: boolean } = {},
  ) => {
    const { waiting_confidence = 0.9, risk_probability = 0.2, evaluated = true } = options;
    return {
      schema_version: 2,
      request_id: 'r1',
      decision: 'stop_decision',
      proposed_action,
      reason_code,
      waiting_for,
      waiting_confidence,
      risk_probability,
      evaluation: evaluated
        ? evaluation({
            waiting_for: {
              type: 'choice',
              choice: waiting_for,
              probabilities: { [waiting_for]: 1 },
              confidence: waiting_confidence ?? 0.9,
            },
            risky: { type: 'noul', noul: risk_probability ?? 0.2 },
          })
        : null,
    };
  };
  const actions = {
    approve: { kind: 'approve_request' },
    recover: {
      kind: 'send_recovery_instruction',
      not_before: '2026-09-29T10:00:30Z',
      instruction:
        'Continue the interrupted task from the last unfinished step. Before repeating the preceding operation, check whether it succeeded; do not repeat completed actions. If the same failure is still current, retry the operation once. If the task is already complete, report that.',
    },
    quota: { kind: 'wait_for_quota', not_before: '2026-09-29T12:01:00Z' },
    manual: { kind: 'manual_review' },
    done: { kind: 'no_action' },
  } satisfies Record<'approve' | 'recover' | 'quota' | 'manual' | 'done', StopDecision['proposed_action']>;
  const stopWaitingOptions = [
    'approve_command',
    'approve_edit',
    'answer_question',
    'credentials',
    'recoverable_api_error',
    'quota_limit',
    'permanent_error',
    'completed',
    'other',
  ];
  const tiedEvaluation = (
    first: StopDecision['waiting_for'],
    second: StopDecision['waiting_for'],
    choice: StopDecision['waiting_for'],
    risk = 0.2,
  ) =>
    evaluation({
      waiting_for: {
        type: 'choice',
        choice,
        probabilities: Object.fromEntries(
          stopWaitingOptions.map((state) => [state, state === first || state === second ? 0.5 : 0]),
        ),
        confidence: 0.9,
      },
      risky: { type: 'noul', noul: risk },
    });
  const ambiguousManual = {
    ...evaluatedResult(actions.manual, 'unclear_waiting_state', 'credentials', { risk_probability: null }),
    evaluation: tiedEvaluation('approve_command', 'credentials', 'credentials'),
  };
  const validResults = [
    evaluatedResult(actions.approve, 'low_risk', 'approve_command', { risk_probability: 0.1 }),
    evaluatedResult(actions.manual, 'high_risk', 'approve_edit', { risk_probability: 0.9 }),
    evaluatedResult(actions.manual, 'explicit_restriction', 'approve_command', { risk_probability: 0.1 }),
    evaluatedResult(actions.manual, 'unclear_waiting_state', 'other', { risk_probability: null }),
    evaluatedResult(actions.manual, 'ordinary_question', 'answer_question', { risk_probability: null }),
    evaluatedResult(actions.manual, 'credentials', 'credentials', { risk_probability: null }),
    evaluatedResult(actions.manual, 'permanent_error', 'permanent_error', { risk_probability: null }),
    evaluatedResult(actions.manual, 'retry_exhausted', 'recoverable_api_error', { risk_probability: null }),
    evaluatedResult(actions.manual, 'retry_exhausted', 'quota_limit', { risk_probability: null }),
    evaluatedResult(actions.recover, 'recoverable_api_error', 'recoverable_api_error', { risk_probability: null }),
    evaluatedResult(actions.quota, 'quota_limit', 'quota_limit', { risk_probability: null }),
    evaluatedResult(actions.done, 'completed', 'completed', { risk_probability: null }),
    evaluatedResult(actions.manual, 'insufficient_context', 'other', {
      waiting_confidence: null,
      risk_probability: null,
      evaluated: false,
    }),
    ambiguousManual,
  ];
  for (const value of validResults) assert.equal(StopResultSchema.safeParse(value).success, true);

  const approved = validResults[0];
  const recovery = validResults[9];
  const completed = validResults[11];
  const localManual = validResults[12];
  assert.ok(approved);
  assert.ok(approved.evaluation);
  assert.ok(recovery);
  assert.ok(completed);
  assert.ok(localManual);
  const invalidResults = [
    { ...approved, evaluation: tiedEvaluation('approve_command', 'credentials', 'credentials', 0.1) },
    { ...recovery, evaluation: tiedEvaluation('recoverable_api_error', 'quota_limit', 'quota_limit') },
    { ...validResults[10], evaluation: tiedEvaluation('quota_limit', 'answer_question', 'answer_question') },
    { ...approved, waiting_confidence: 0.8 },
    {
      ...approved,
      evaluation: evaluation({
        waiting_for: { type: 'choice', choice: 'credentials', probabilities: { credentials: 1 }, confidence: 0.9 },
        risky: { type: 'noul', noul: 0.1 },
      }),
    },
    {
      ...approved,
      evaluation: evaluation({
        waiting_for: approved.evaluation.answers.waiting_for,
        risky: { type: 'noul', noul: 0.8 },
      }),
    },
    { ...approved, hidden: true },
    { ...approved, schema_version: 1 },
    { ...approved, waiting_for: 'terminal_text' },
    { ...approved, reason_code: 'explicit_restriction' },
    { ...approved, waiting_for: 'credentials' },
    { ...recovery, reason_code: 'completed', waiting_for: 'completed' },
    { ...recovery, waiting_for: 'credentials' },
    { ...validResults[10], reason_code: 'recoverable_api_error', waiting_for: 'recoverable_api_error' },
    { ...validResults[4], waiting_for: 'credentials' },
    { ...completed, waiting_for: 'other' },
    { ...validResults[1], proposed_action: actions.approve },
    { ...approved, evaluation: null, waiting_confidence: null, risk_probability: null },
    { ...approved, evaluation: null, waiting_confidence: 0.9 },
    { ...approved, waiting_confidence: null },
    { ...localManual, waiting_confidence: 0.9 },
    { ...localManual, risk_probability: 0.1 },
    { ...localManual, evaluation: evaluation({}) },
    { ...localManual, waiting_for: 'credentials' },
    { ...localManual, reason_code: 'ordinary_question' },
    { ...localManual, proposed_action: actions.done },
    { ...localManual, proposed_action: actions.recover },
    { ...recovery, proposed_action: { ...actions.approve, not_before: '2026-09-29T10:00:00Z' } },
    { ...validResults[10], proposed_action: { ...actions.quota, instruction: 'send a new command' } },
    { ...recovery, proposed_action: { ...actions.recover, not_before: 'tomorrow' } },
    { ...recovery, proposed_action: { ...actions.recover, instruction: 'run arbitrary command' } },
    {
      ...recovery,
      proposed_action: {
        ...actions.recover,
        instruction:
          'Check whether the preceding operation succeeded. If it did, do nothing. If the same failure is still current, retry the operation once.',
      },
    },
  ];
  for (const [index, value] of invalidResults.entries()) {
    assert.equal(StopResultSchema.safeParse(value).success, false, `invalid result ${index} should fail`);
  }

  const version2Error = {
    schema_version: 2,
    request_id: null,
    decision: 'error',
    reason_code: 'invalid_input',
    message: 'Input is invalid.',
  };
  assert.equal(StopResultSchema.safeParse(version2Error).success, true);
  assert.equal(StopResultSchema.safeParse({ ...version2Error, schema_version: 1 }).success, false);

  const version1Approval = {
    schema_version: 1,
    request_id: 'r1',
    decision: 'approve',
    reason_code: 'low_risk',
    waiting_for: 'approve_command',
    waiting_confidence: 0.9,
    risk_probability: 0.1,
    evaluation: evaluation({}),
  };
  assert.equal(ResultSchema.safeParse(version1Approval).success, false);
  assert.equal(StopResultSchema.safeParse(version1Approval).success, false);
});
