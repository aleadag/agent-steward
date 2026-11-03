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

test('legacy Jev config normalizes to provider and model only', () => {
  assert.deepEqual(ConfigSchema.parse(base).evaluator, { provider: 'typesafe', model: 'jev-1.13.0' });
  assert.deepEqual(ConfigSchema.parse({ ...base, jev: { model: 'custom-jev' } }).evaluator, {
    provider: 'typesafe',
    model: 'custom-jev',
  });
});

test('evaluator providers default their models and preserve explicit model IDs', () => {
  for (const [provider, model] of [
    ['typesafe', 'jev-1.13.0'],
    ['openrouter', '~typesafe/jev-latest'],
    ['ollama', 'laya'],
  ]) {
    assert.deepEqual(ConfigSchema.parse({ ...base, evaluator: { provider } }).evaluator, { provider, model });
    assert.deepEqual(ConfigSchema.parse({ ...base, evaluator: { provider, model: 'custom-model' } }).evaluator, {
      provider,
      model: 'custom-model',
    });
    assert.equal(ConfigSchema.safeParse({ ...base, jev: {}, evaluator: { provider } }).success, false);
  }
  assert.equal(
    ConfigSchema.parse({ ...base, evaluator: { provider: 'ollama', model: 'kev:4b-q8_0' } }).evaluator.model,
    'kev:4b-q8_0',
  );
});

test('evaluator rejects removed type, unknown providers, credentials and endpoint overrides', () => {
  for (const evaluator of [
    { type: 'jev', provider: 'typesafe' },
    { type: 'jev', provider: 'openrouter' },
    { type: 'laya', provider: 'ollama' },
    { model: 'example' },
    { provider: 'unknown' },
    { provider: 'openrouter', api_key: 'secret' },
    { provider: 'ollama', api_key: 'secret' },
    { provider: 'ollama', base_url: 'http://remote' },
    { provider: 'ollama', model: ' ' },
  ])
    assert.equal(ConfigSchema.safeParse({ ...base, evaluator }).success, false);
});

test('Ollama sends System One without credentials and preserves typed answers', async () => {
  const raw = {
    model: 'laya',
    answers: { safe: { type: 'noul', noul: 0.2 } },
    usage: { input_tokens: 59, output_tokens: 0 },
  };
  const evaluate = makeEvaluator({
    provider: 'ollama',
    model: 'laya',
    post: async (request) => {
      assert.equal(request.url, 'http://localhost:11434/v1/systemone');
      assert.deepEqual(request.headers, { 'content-type': 'application/json' });
      assert.deepEqual(JSON.parse(request.body), { model: 'laya', state: { task: 'check' }, questions });
      return { status: 200, body: JSON.stringify(raw) };
    },
  });
  assert.deepEqual(await evaluate({ task: 'check' }, questions), raw);
});

test('Ollama retains strict response validation and configured cloud-key privacy guards', async () => {
  let posts = 0;
  let raw: unknown = { model: 'laya', answers: {}, usage: {} };
  const evaluate = makeEvaluator({
    provider: 'ollama',
    model: 'laya',
    credentialKeys: ['opaque-typesafe-value', 'opaque-openrouter-value'],
    post: async () => {
      posts++;
      return { status: 200, body: JSON.stringify(raw) };
    },
  });
  for (const secret of ['opaque-typesafe-value', 'opaque-openrouter-value'])
    await assert.rejects(
      evaluate({ task: secret }, questions),
      (e) => e instanceof StewardError && e.code === 'credential_detected',
    );
  assert.equal(posts, 0);
  await assert.rejects(evaluate({}, questions), (e) => e instanceof StewardError && e.code === 'invalid_response');
  raw = { model: 'prefix-opaque-typesafe-value', answers: { safe: { type: 'noul', noul: 0.2 } }, usage: {} };
  await assert.rejects(evaluate({}, questions), (e) => e instanceof StewardError && e.code === 'credential_detected');
});

test('Ollama failures do not fall back to a cloud provider', async () => {
  for (const status of [404, 500]) {
    let posts = 0;
    const evaluate = makeEvaluator({
      provider: 'ollama',
      model: 'laya',
      post: async (request) => {
        posts++;
        assert.equal(request.url, 'http://localhost:11434/v1/systemone');
        return { status, body: 'private server error' };
      },
    });
    await assert.rejects(
      evaluate({}, questions),
      (e) => e instanceof StewardError && e.code === 'evaluation_failed' && e.diagnostics?.http_status === status,
    );
    assert.equal(posts, 1);
  }
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
