import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { ConfigSchema, StewardError } from '../src/contracts.ts';
import type { QuotaFacts } from '../src/contracts.ts';
import { route } from '../src/routing.ts';
import { inspectQuota, loadQuota } from '../src/quota.ts';
import { apiCandidate, candidate, choice, config, evaluation, quotaFacts, windowFact } from './helpers.ts';

const now = new Date('2026-10-21T00:00:00Z');
const apiFacts = { status: 'not_applicable', reason: 'api_billed' } as const;
const deny = async () => {
  throw new Error('Unexpected native auth/snapshot IO');
};

for (const tool of ['codex', 'pi', 'agy'] as const) {
  test(`${tool} accepts explicit API billing independently of subscription buckets`, async () => {
    const value = apiCandidate({ tool });
    const cfg = ConfigSchema.parse({ tools: [tool], candidates: [value] });
    assert.equal(cfg.candidates[0]?.billing, 'api');
    for (const extra of [{ quota_bucket: 'codex' }, { quota_pool: 'primary' }, { api_key: 'private' }]) {
      assert.equal(ConfigSchema.safeParse({ tools: [tool], candidates: [{ ...value, ...extra }] }).success, false);
    }
    const facts = await loadQuota(cfg, {
      env: { HOME: '/isolated' },
      now,
      readText: deny,
      diagnostic: () => {
        throw new Error('API is not missing subscription quota');
      },
    });
    assert.deepEqual(facts.get(value.id), apiFacts);
    assert.deepEqual(
      await inspectQuota(cfg, { env: { HOME: '/isolated' }, now, readText: deny, diagnostic: () => {} }),
      [],
    );
    let requests = 0;
    const result = await route({
      task: 'Task beyond this candidate’s configured capabilities',
      requestId: 'api-only',
      config: cfg,
      quota: facts,
      now,
      evaluate: async (state, questions) => {
        requests++;
        const pair = questions.pair;
        assert.ok(pair && pair.type === 'choice');
        assert.deepEqual(Object.keys(pair.criteria), [value.id]);
        assert.match(pair.instructions, /must choose a supplied candidate/i);
        const payload = JSON.parse(JSON.stringify(state));
        assert.equal(payload.candidates[0].billing, 'api');
        assert.deepEqual(payload.candidates[0].quota, apiFacts);
        return evaluation({ pair: choice({ [value.id]: 1 }) });
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.schema_version, 2);
    assert.equal(result.selected.candidate_id, value.id);
    assert.deepEqual(result.quota, apiFacts);
    assert.equal(result.selected.quota_bucket, null);
    const expected =
      tool === 'pi'
        ? ['--provider', 'deepseek', '--model', 'deepseek-v4-flash']
        : tool === 'codex'
          ? ['--model', 'deepseek-v4-flash', '-c', 'model_provider="deepseek"']
          : ['--model=deepseek-v4-flash'];
    assert.deepEqual(result.planned_command.args, expected);
  });
}

test('API effort evaluation uses not-applicable facts without inventing pacing', async () => {
  const value = apiCandidate({
    thinking_levels: [
      { id: 'low', description: 'Small budget' },
      { id: 'high', description: 'Larger budget' },
    ],
  });
  const cfg = ConfigSchema.parse(config({ candidates: [value] }));
  let requests = 0;
  const result = await route({
    task: 'Choose effort',
    requestId: 'effort',
    config: cfg,
    quota: new Map([[value.id, apiFacts]]),
    now,
    evaluate: async (state, questions) => {
      requests++;
      if (questions.pair) return evaluation({ pair: choice({ [value.id]: 1 }) });
      const effort = questions.effort;
      assert.ok(effort && effort.type === 'choice');
      assert.match(effort.instructions, /subscription quota is not applicable/);
      const payload = JSON.parse(JSON.stringify(state));
      assert.equal(payload.candidate.billing, 'api');
      assert.deepEqual(payload.quota, apiFacts);
      assert.deepEqual(Object.keys(effort.criteria), ['low', 'high']);
      return evaluation({ effort: choice({ low: 0.1, high: 0.9 }) });
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.selected.thinking_level, 'high');
});

test('legacy billing defaults only on omission and retains strict subscription validation', () => {
  const raw = { ...candidate() } as Record<string, unknown>;
  delete raw.billing;
  const cfg = ConfigSchema.parse({ tools: ['codex'], candidates: [raw] });
  assert.equal(cfg.candidates[0]?.billing, 'subscription');
  for (const change of [
    { billing: 'other' },
    { billing: null },
    { quota_bucket: undefined },
    { quota_pool: undefined },
    { tool: 'claude' },
  ]) {
    assert.equal(ConfigSchema.safeParse({ tools: ['codex'], candidates: [{ ...raw, ...change }] }).success, false);
  }
  assert.equal(
    ConfigSchema.safeParse({ tools: ['codex'], candidates: [{ ...raw, billing: 'subscription' }] }).success,
    true,
  );
});

test('enabled opposite-billing native aliases are rejected without interpreting credentials', () => {
  for (const tool of ['pi', 'codex', 'agy'] as const) {
    const sub = candidate({
      tool,
      id: 'subscription',
      provider: 'one',
      model: 'same-model',
      quota_bucket: tool === 'pi' ? 'pi_codex' : tool === 'codex' ? 'codex' : 'antigravity',
    });
    const api = apiCandidate({ tool, id: 'api', provider: 'one', model: 'same-model' });
    assert.equal(ConfigSchema.safeParse({ tools: [tool], candidates: [sub, api] }).success, false);
    assert.equal(ConfigSchema.safeParse({ tools: [], candidates: [sub, api] }).success, true);
    assert.equal(
      ConfigSchema.safeParse({
        tools: [tool],
        candidates: [
          sub,
          { ...api, thinking_levels: [{ id: 'high', description: 'Another effort is not another login' }] },
        ],
      }).success,
      false,
    );
    const otherProvider = ConfigSchema.safeParse({ tools: [tool], candidates: [sub, { ...api, provider: 'two' }] });
    assert.equal(otherProvider.success, tool !== 'agy');
  }
});

for (const alias of [
  { provider: 'OPENAI-CODEX', model: 'review-model' },
  { provider: 'openai-codex', model: 'openai-codex/review-model' },
  { provider: 'openai-codex', model: 'openai-codex/openai-codex/review-model' },
  { provider: 'openai-codex', model: 'review-model:high' },
  { provider: 'openai-codex', model: 'review-model:high:low' },
  { provider: 'openai-codex', model: ' REVIEW-MODEL ' },
]) {
  test(`Pi opposite-billing selector alias is rejected before exhausted quota can be bypassed: ${alias.model}/${alias.provider}`, async () => {
    const sub = candidate({
      id: 'sub',
      tool: 'pi',
      provider: 'openai-codex',
      model: 'review-model',
      quota_bucket: 'pi_codex',
    });
    const api = apiCandidate({ id: 'api-alias', ...alias });
    const cfg = config({ tools: ['pi'], candidates: [sub, api] });
    assert.equal(ConfigSchema.safeParse(cfg).success, false);
    let evaluated = false;
    await assert.rejects(
      route({
        task: 'T',
        requestId: 'alias',
        config: cfg,
        now,
        quota: new Map<string, QuotaFacts>([
          [sub.id, quotaFacts(sub, { windows: [subscriptionFacts(0)] })],
          [api.id, apiFacts],
        ]),
        evaluate: async () => {
          evaluated = true;
          return evaluation({ pair: choice({ [api.id]: 1 }) });
        },
      }),
      (error) => error instanceof StewardError && error.code === 'invalid_config',
    );
    assert.equal(evaluated, false);
  });
}

test('Pi literal thinking IDs cannot hide an opposite-billing alias behind trimmed suffix whitespace', () => {
  const sub = candidate({
    id: 'sub',
    tool: 'pi',
    provider: 'openai-codex',
    model: 'literal:high',
    quota_bucket: 'pi_codex',
  });
  const api = apiCandidate({ id: 'api', provider: 'openai-codex', model: 'literal:high :low' });
  assert.equal(ConfigSchema.safeParse(config({ tools: ['pi'], candidates: [sub, api] })).success, false);
});

test('Pi provider-qualified aliases preserve literal provider whitespace in the collision check', () => {
  for (const provider of ['custom ', ' custom']) {
    const sub = candidate({ id: 'sub', tool: 'pi', provider, model: 'review-model', quota_bucket: 'pi_codex' });
    const api = apiCandidate({ id: 'api', provider, model: `${provider}/review-model` });
    assert.equal(ConfigSchema.safeParse(config({ tools: ['pi'], candidates: [sub, api] })).success, false);
  }
});

test('literal colon IDs remain accepted and native argv is not rewritten by conservative alias checks', async () => {
  const value = apiCandidate({ model: 'literal-model:high' });
  const cfg = ConfigSchema.parse(config({ candidates: [value] }));
  const result = await route({
    task: 'T',
    requestId: 'literal',
    config: cfg,
    now,
    quota: new Map([[value.id, apiFacts]]),
    evaluate: async () => evaluation({ pair: choice({ [value.id]: 1 }) }),
  });
  assert.deepEqual(result.planned_command.args, ['--provider', 'deepseek', '--model', 'literal-model:high']);
});

test('mixed quota loads retain subscription cache sharing without assigning it to API models', async () => {
  const sub = candidate({ id: 'one', tool: 'pi', provider: 'openai-codex', quota_bucket: 'pi_codex' });
  const cfg = ConfigSchema.parse(config({ tools: ['pi'], candidates: [sub, { ...sub, id: 'two' }, apiCandidate()] }));
  const reads: string[] = [];
  const quota = await loadQuota(cfg, {
    env: { HOME: '/isolated' },
    now,
    readText: async (path) => {
      reads.push(path);
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
    diagnostic: () => {},
  });
  assert.deepEqual(reads, ['/isolated/.local/state/agent-steward/quota/pi_codex.json']);
  assert.deepEqual(quota.get('deepseek-api'), apiFacts);
  assert.deepEqual(quota.get('one'), quota.get('two'));
});

function subscriptionFacts(remaining: number, scope: 'account' | 'pool' = 'account') {
  return {
    ...windowFact(scope === 'account' ? { type: 'account' } : { type: 'pool', pool_id: 'primary' }, {
      cadence: 'weekly',
      remaining_percent: remaining,
      observed_at: '2026-10-20T23:59:00Z',
      valid_until: '2026-10-21T01:00:00Z',
      reset_at: '2026-10-24T12:00:00Z',
    }),
    status: 'known' as const,
    reason: null,
  };
}

test('pair payload preserves independent and simultaneous pacing instead of globally switching to API', async () => {
  const healthy = candidate({ id: 'healthy', tool: 'pi', provider: 'xai', quota_bucket: 'pi_xai' });
  const over = candidate({ id: 'over', thinking_levels: [{ id: 'default', description: 'Native' }] });
  const cfg = ConfigSchema.parse(config({ candidates: [healthy, over, apiCandidate()] }));
  const stale = {
    ...subscriptionFacts(90),
    status: 'unknown' as const,
    reason: 'expired' as const,
    remaining_percent: null,
    valid_until: '2026-10-20T23:59:59Z',
  };
  for (const winner of ['healthy', 'over', 'deepseek-api']) {
    const facts = new Map<string, QuotaFacts>([
      ['healthy', quotaFacts(healthy, { windows: [subscriptionFacts(50)] })],
      ['over', quotaFacts(over, { windows: [subscriptionFacts(90), subscriptionFacts(10, 'pool'), stale] })],
      ['deepseek-api', apiFacts],
    ]);
    const before = JSON.stringify([...facts]);
    const result = await route({
      task: 'Needs the best configured capability',
      requestId: 'mixed',
      config: cfg,
      quota: facts,
      now,
      evaluate: async (state, questions) => {
        const pair = questions.pair;
        assert.ok(pair && pair.type === 'choice');
        assert.deepEqual(Object.keys(pair.criteria), ['healthy', 'over', 'deepseek-api']);
        assert.match(
          pair.instructions,
          /on-pace subscription capacity, then API-paid capacity, then over-budget subscription capacity/,
        );
        assert.match(pair.instructions, /do not trigger a global API preference/);
        assert.match(pair.instructions, /all.*weekly windows/i);
        assert.match(pair.instructions, /not.*on-pace.*unless|neither.*on-pace/i);
        const payload = JSON.parse(JSON.stringify(state));
        const healthyQuota = payload.candidates[0].quota;
        assert.equal(healthyQuota.windows[0].weekly_pacing.expected_remaining_percent, 50);
        assert.equal(healthyQuota.windows[0].weekly_pacing.over_budget, false);
        const windows = payload.candidates[1].quota.windows;
        assert.equal(windows[0].weekly_pacing.over_budget, false);
        assert.equal(windows[1].weekly_pacing.over_budget, true);
        assert.equal(windows[2].weekly_pacing, null);
        assert.equal(windows[2].remaining_percent, null);
        assert.deepEqual(payload.candidates[2].quota, apiFacts);
        return evaluation({
          pair: choice(Object.fromEntries(Object.keys(pair.criteria).map((id) => [id, id === winner ? 1 : 0]))),
        });
      },
    });
    assert.equal(result.selected.candidate_id, winner);
    assert.equal(JSON.stringify([...facts]), before);
  }
});

test('API remains eligible beside exhausted subscription capacity, including subscription agy thresholds', async () => {
  const sub = candidate({
    id: 'agy-sub',
    tool: 'agy',
    provider: 'google',
    model: 'subscription-model',
    quota_bucket: 'antigravity',
  });
  const api = apiCandidate({ tool: 'agy', model: 'api-model' });
  const cfg = ConfigSchema.parse(config({ tools: ['agy'], candidates: [sub, api] }));
  for (const remaining of [0, 0.5]) {
    const facts = new Map<string, QuotaFacts>([
      [sub.id, quotaFacts(sub, { windows: [subscriptionFacts(remaining)] })],
      [api.id, apiFacts],
    ]);
    const result = await route({
      task: 'No fully capable candidate remains',
      requestId: 'exhausted',
      config: cfg,
      quota: facts,
      now,
      evaluate: async (_state, questions) => {
        const pair = questions.pair;
        assert.ok(pair && pair.type === 'choice');
        assert.deepEqual(Object.keys(pair.criteria), [api.id]);
        return evaluation({ pair: choice({ [api.id]: 1 }) });
      },
    });
    assert.equal(result.selected.candidate_id, api.id);
  }
});

test('quota fact branches cannot disguise subscription exhaustion as API usage', async () => {
  const sub = candidate();
  for (const [value, invalid] of [
    [sub, apiFacts],
    [apiCandidate(), quotaFacts(sub)],
  ] as const) {
    const cfg = ConfigSchema.parse(config({ candidates: [value] }));
    await assert.rejects(
      route({
        task: 'T',
        requestId: 'bad-facts',
        config: cfg,
        quota: new Map([[value.id, invalid]]),
        now,
        evaluate: async () => {
          throw new Error('Must reject before evaluating');
        },
      }),
      (error) => error instanceof StewardError && error.code === 'invalid_config',
    );
  }
});
