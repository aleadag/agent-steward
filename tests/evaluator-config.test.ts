import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ConfigSchema, StewardError } from '../src/contracts.ts';
import { makeEvaluator } from '../src/jev.ts';
import { assertNoCredentials } from '../src/privacy.ts';

const base = { tools: [], candidates: [] };
const questions = { safe: { type: 'noul' as const, instructions: 'Is this safe?' } };
const response = {
  id: 'gen-example',
  provider: 'TypeSafe',
  model: 'typesafe/jev-1.13-20260917',
  answers: { safe: { type: 'noul', noul: 0.2 } },
  usage: { input_tokens: 12, output_tokens: 3, cost: 0.0001 },
};

test('legacy Jev config normalizes to the extensible evaluator selector', () => {
  assert.deepEqual(ConfigSchema.parse(base).evaluator, { type: 'jev', provider: 'typesafe', model: 'jev-1.13.0' });
  assert.deepEqual(ConfigSchema.parse({ ...base, jev: { model: 'custom-jev' } }).evaluator, {
    type: 'jev',
    provider: 'typesafe',
    model: 'custom-jev',
  });
});

test('OpenRouter evaluator defaults its model and rejects ambiguous or unsupported selectors', () => {
  assert.deepEqual(ConfigSchema.parse({ ...base, evaluator: { type: 'jev', provider: 'openrouter' } }).evaluator, {
    type: 'jev',
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
  });
  for (const evaluator of [
    { type: 'openai', provider: 'openai', model: 'example' },
    { type: 'jev', provider: 'unknown' },
    { type: 'jev', provider: 'openrouter', api_key: 'secret' },
  ])
    assert.equal(ConfigSchema.safeParse({ ...base, evaluator }).success, false);
  assert.equal(
    ConfigSchema.safeParse({ ...base, jev: {}, evaluator: { type: 'jev', provider: 'typesafe' } }).success,
    false,
  );
});

test('OpenRouter uses System One and normalizes only documented response metadata', async () => {
  const evaluate = makeEvaluator({
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    apiKey: 'unit-secret',
    post: async (request) => {
      assert.equal(request.url, 'https://openrouter.ai/api/v1/systemone');
      assert.equal(request.headers.authorization, 'Bearer unit-secret');
      assert.deepEqual(JSON.parse(request.body), {
        model: '~typesafe/jev-latest',
        state: { task: 'check' },
        questions,
      });
      return { status: 200, body: JSON.stringify(response) };
    },
  });
  assert.deepEqual(await evaluate({ task: 'check' }, questions), {
    model: response.model,
    answers: response.answers,
    usage: { input_tokens: 12, output_tokens: 3 },
  });
});

test('OpenRouter rejects malformed answers and unknown response fields', async () => {
  for (const raw of [
    { ...response, hidden: true },
    { ...response, answers: {} },
    { ...response, usage: { ...response.usage, hidden: true } },
    { ...response, answers: { safe: { type: 'noul', noul: 2 } } },
  ]) {
    const evaluate = makeEvaluator({
      provider: 'openrouter',
      model: '~typesafe/jev-latest',
      apiKey: 'unit-secret',
      post: async () => ({ status: 200, body: JSON.stringify(raw) }),
    });
    await assert.rejects(evaluate({}, questions), (e) => e instanceof StewardError && e.code === 'invalid_response');
  }
});

test('OpenRouter rejects secrets in discarded metadata and either configured key in outbound state', async () => {
  let posts = 0;
  const evaluate = makeEvaluator({
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    apiKey: 'opaque-openrouter-value',
    credentialKeys: ['opaque-typesafe-value', 'opaque-openrouter-value'],
    post: async () => {
      posts++;
      return { status: 200, body: JSON.stringify({ ...response, id: 'prefix-opaque-openrouter-value' }) };
    },
  });
  for (const key of ['opaque-typesafe-value', 'opaque-openrouter-value'])
    await assert.rejects(
      evaluate({ task: key }, questions),
      (e) => e instanceof StewardError && e.code === 'credential_detected',
    );
  assert.equal(posts, 0);
  await assert.rejects(evaluate({}, questions), (e) => e instanceof StewardError && e.code === 'credential_detected');
  assert.equal(posts, 1);
});

test('privacy guard detects either configured key including non-pattern keys', () => {
  for (const secret of ['opaque-typesafe-value', 'opaque-openrouter-value'])
    assert.throws(() =>
      assertNoCredentials({ text: `prefix ${secret} suffix` }, ['opaque-typesafe-value', 'opaque-openrouter-value']),
    );
});
