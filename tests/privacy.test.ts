import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { StewardError } from '../src/contracts.ts';
import { LimitError } from '../src/limits.ts';
import type { HttpPost, Questions } from '../src/jev.ts';
import { assertNoCredentials } from '../src/privacy.ts';
import { makeEvaluator } from '../src/jev.ts';

const patterns: [string, string][] = [
  ['private key', '-----BEGIN PRIVATE KEY-----'],
  ['RSA private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ['EC private key', '-----BEGIN EC PRIVATE KEY-----'],
  ['OpenSSH private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['OpenAI token', 'sk-' + 'A'.repeat(20)],
  ['GitHub token', 'ghp_' + 'A'.repeat(20)],
  ['GitHub OAuth token', 'gho_' + 'A'.repeat(20)],
  ['GitHub user token', 'ghu_' + 'A'.repeat(20)],
  ['GitHub server token', 'ghs_' + 'A'.repeat(20)],
  ['GitHub refresh token', 'ghr_' + 'A'.repeat(20)],
  ['GitHub fine-grained token', 'github_pat_' + 'A'.repeat(20)],
  ['AWS access key', 'AKIA' + 'A'.repeat(16)],
  ['Bearer token', 'Bearer ' + 'A'.repeat(12)],
  ['credential assignment', 'password = ' + 'A'.repeat(8)],
];

for (const [label, secret] of patterns) {
  test(`recognizable ${label} is rejected without echo`, () => {
    assert.throws(
      () => assertNoCredentials({ nested: [secret] }, 'unit-key-not-live'),
      (error) =>
        error instanceof StewardError && error.code === 'credential_detected' && !error.message.includes(secret),
    );
  });
}

test('configured API key and credential-looking object keys are rejected', () => {
  const secret = 'unit-key-not-live';
  const tokenKey = 'ghp_' + 'K'.repeat(20);
  const content = JSON.parse(`{"outer":{"${tokenKey}":"benign"},"payload":"${secret}"}`);
  assert.throws(
    () => assertNoCredentials(content, secret),
    (error) => error instanceof StewardError && error.code === 'credential_detected' && !error.message.includes(secret),
  );
  assert.throws(
    () => assertNoCredentials(Object.fromEntries([[tokenKey, 'benign']]), ''),
    (error) => error instanceof StewardError && error.code === 'credential_detected',
  );
});

test('serialized caller-derived content is checked even if its enumerable form differs', () => {
  const secret = 'ghp_' + 'S'.repeat(20);
  const content = { toJSON: () => ({ derived: secret }) };
  assert.throws(
    () => assertNoCredentials(content, ''),
    (error) => error instanceof StewardError && error.code === 'credential_detected',
  );
});

test('credential validation returns the checked serialization without serializing twice', () => {
  let serializations = 0;
  const content = {
    toJSON: () => {
      serializations++;
      return { safe: true };
    },
  };
  assert.equal(assertNoCredentials(content, ''), '{"safe":true}');
  assert.equal(serializations, 1);
});

test('structured credential names reject nonempty string values', () => {
  for (const key of ['api_key', 'api-key', 'APIKEY', 'access_token', 'client-secret', 'password']) {
    const value = Object.fromEntries([[key, 'ordinary-value']]);
    assert.throws(
      () => assertNoCredentials(value, ''),
      (error) => error instanceof StewardError && error.code === 'credential_detected',
    );
  }
});

test('benign descriptions, flags, short token prefixes, filenames, and risk text remain allowed', () => {
  const benign = {
    instructions: 'API key required for this tool; explain risk honestly.',
    args: '--model',
    token: 'sk-short',
    filename: 'ordinary-credentials.json',
    risk: 'A password prompt may indicate an ordinary sign-in step.',
  };
  assert.doesNotThrow(() => assertNoCredentials(benign, 'different-api-key'));
});

test('privacy traversal rejects excess container depth before walking contents', () => {
  let nested: unknown = 'ordinary';
  for (let index = 0; index < 65; index++) nested = [nested];
  assert.throws(
    () => assertNoCredentials(nested, ''),
    (error) => error instanceof LimitError,
  );
});

test('recognizable credentials in caller criteria never reach transport', async () => {
  let calls = 0;
  const evaluate = makeEvaluator({
    model: 'jev-1.13.0',
    apiKey: 'unit-key-not-live',
    post: async () => {
      calls++;
      throw new Error('must not post');
    },
  });
  const secret = 'ghp_' + 'A'.repeat(36);
  await assert.rejects(
    evaluate(
      { task: 'ordinary text' },
      {
        pair: { type: 'choice', instructions: 'Choose a supplied option', criteria: { a: secret } },
      },
    ),
    (error) => error instanceof StewardError && error.code === 'credential_detected' && !error.message.includes(secret),
  );
  assert.equal(calls, 0);
});

test('configured evaluator model and option names are included in the privacy scan', async () => {
  let calls = 0;
  const pairQuestion = {
    type: 'choice',
    instructions: 'Choose one.',
    criteria: { safe: 'Only option' },
  } satisfies Questions[string];
  const questions: Questions = { pair: pairQuestion };
  const configs: { model: string; apiKey: string; option?: string }[] = [
    { model: 'sk-' + 'M'.repeat(20), apiKey: 'unit-key-not-live' },
    { model: 'jev-1.13.0', apiKey: 'unit-key-not-live', option: 'ghp_' + 'O'.repeat(20) },
  ];
  for (const configure of configs) {
    const evaluate = makeEvaluator({
      model: configure.model,
      apiKey: configure.apiKey,
      post: async () => {
        calls++;
        return { status: 200, body: '{}' };
      },
    });
    const question: Questions =
      configure.option === undefined
        ? questions
        : {
            pair: { ...pairQuestion, criteria: Object.fromEntries([[configure.option, 'Only option']]) },
          };
    await assert.rejects(
      evaluate({}, question),
      (error) => error instanceof StewardError && error.code === 'credential_detected',
    );
  }
  assert.equal(calls, 0);
});

test('API keys must be nonblank and supplied keys are not trimmed', async () => {
  for (const apiKey of ['', '  \t']) {
    assert.throws(
      () => makeEvaluator({ model: 'jev-1.13.0', apiKey, post: async () => ({ status: 200, body: '{}' }) }),
      (error) => error instanceof StewardError && error.code === 'missing_credentials',
    );
  }
  let captured: Parameters<HttpPost>[0] | undefined;
  const evaluate = makeEvaluator({
    model: 'jev-1.13.0',
    apiKey: ' key ',
    post: async (request) => {
      captured = request;
      return {
        status: 200,
        body: JSON.stringify({
          model: 'jev-1.13.0',
          answers: { pair: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0.9 } },
          usage: {},
        }),
      };
    },
  });
  await evaluate({}, { pair: { type: 'choice', instructions: 'Choose one.', criteria: { a: 'Only option' } } });
  assert.ok(captured);
  assert.equal(captured.headers.authorization, 'Bearer  key ');
});
