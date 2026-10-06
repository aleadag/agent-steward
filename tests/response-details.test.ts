import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { FailureDiagnosticsSchema, StewardError } from '../src/contracts.ts';
import type { Evaluation } from '../src/contracts.ts';
import { makeEvaluator, validateEvaluation } from '../src/jev.ts';
import type { Questions } from '../src/jev.ts';
import { choiceAnswer, jevResponse, noulAnswer } from './helpers.ts';

const questions: Questions = {
  risk: { type: 'noul', instructions: 'Is this risky?' },
  private_question_label: {
    type: 'choice',
    instructions: 'Select one.',
    criteria: { private_alpha: null, private_beta: null },
  },
};

function response(probabilities = { private_alpha: 0.75, private_beta: 0.25 }, choice?: string): Evaluation {
  return jevResponse({
    risk: noulAnswer(0.1),
    private_question_label: choiceAnswer(probabilities, 0.9, choice),
  });
}

function diagnostics(value: Evaluation) {
  try {
    validateEvaluation(value, questions);
    assert.fail('invalid evaluation was accepted');
  } catch (error) {
    assert.ok(error instanceof StewardError);
    assert.equal(error.code, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /private_/);
    return error.diagnostics;
  }
}

test('all-zero score diagnostics report question position without exposing labels', () => {
  const result = diagnostics(response({ private_alpha: 0, private_beta: 0 }));
  assert.equal(result?.kind, 'schema');
  assert.deepEqual(result?.details, { question_index: 1, option_count: 2 });
});

test('choice diagnostics distinguish missing choice and tied maxima', () => {
  for (const [probabilities, maximumCount] of [
    [{ private_alpha: 0.75, private_beta: 0.25 }, 1],
    [{ private_alpha: 0.5, private_beta: 0.5 }, 2],
  ] as const) {
    const result = diagnostics(response(probabilities, 'private_unknown'));
    assert.equal(result?.kind, 'choice_mismatch');
    assert.deepEqual(result?.details, {
      question_index: 1,
      expected: maximumCount === 2 ? 0.5 : 0.75,
      actual: null,
      choice_present: false,
      option_count: 2,
      maximum_count: maximumCount,
    });
  }
  assert.doesNotThrow(() =>
    validateEvaluation(response({ private_alpha: 0.75, private_beta: 0.25 }, 'private_beta'), questions),
  );
  for (const choice of ['private_alpha', 'private_beta']) {
    assert.doesNotThrow(() =>
      validateEvaluation(response({ private_alpha: 0.5, private_beta: 0.5 }, choice), questions),
    );
  }
});

test('structural diagnostics count missing and extra keys even when totals match', () => {
  const wrongIds = response();
  wrongIds.answers.private_extra = wrongIds.answers.risk!;
  delete wrongIds.answers.risk;
  assert.deepEqual(diagnostics(wrongIds)?.details, { expected: 2, actual: 2, missing_count: 1, extra_count: 1 });

  const wrongOptions = response();
  wrongOptions.answers.private_question_label = choiceAnswer({ private_alpha: 0.75, private_extra: 0.25 });
  assert.deepEqual(diagnostics(wrongOptions)?.details, {
    question_index: 1,
    expected: 2,
    actual: 2,
    missing_count: 1,
    extra_count: 1,
  });

  const wrongChoiceType = response();
  wrongChoiceType.answers.private_question_label = noulAnswer(0.5);
  assert.deepEqual(diagnostics(wrongChoiceType)?.details, { question_index: 1, expected: true, actual: false });
  const wrongNoulType = response();
  wrongNoulType.answers.risk = choiceAnswer({ private_alpha: 1 });
  assert.deepEqual(diagnostics(wrongNoulType)?.details, { question_index: 0, expected: false, actual: true });
});

test('both provider adapters preserve check details and index successive HTTP evaluations', async () => {
  for (const provider of ['typesafe', 'openrouter'] as const) {
    let calls = 0;
    const evaluate = makeEvaluator({
      provider,
      model: 'test-model',
      apiKey: 'SyntheticPrivateKey',
      post: async () => {
        calls++;
        return {
          status: 200,
          body: JSON.stringify(
            calls === 1 ? response({ private_alpha: 0.79, private_beta: 0.2 }) : response(undefined, 'private_unknown'),
          ),
        };
      },
    });
    await evaluate({}, questions);
    await assert.rejects(evaluate({}, questions), (error) => {
      assert.ok(error instanceof StewardError);
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.diagnostics?.http_status, 200);
      assert.ok(Number.isInteger(error.diagnostics?.duration_ms));
      assert.deepEqual(error.diagnostics?.details, {
        evaluation_index: 1,
        question_index: 1,
        expected: 0.75,
        actual: null,
        choice_present: false,
        option_count: 2,
        maximum_count: 1,
      });
      assert.doesNotMatch(JSON.stringify(error), /private_|SyntheticPrivateKey/);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test('HTTP and stream failures retain evaluation position without upstream data', async () => {
  for (const failure of ['http', 'network', 'stream'] as const) {
    let calls = 0;
    const evaluate = makeEvaluator({
      model: 'test-model',
      apiKey: 'SyntheticPrivateKey',
      post: async () => {
        calls++;
        if (calls === 1) return { status: 200, body: JSON.stringify(response()) };
        if (failure === 'network') throw new Error('private transport error');
        if (failure === 'stream') throw new StewardError('invalid_response', { stage: 'response', kind: 'size_limit' });
        return { status: 503, body: 'private upstream body' };
      },
    });
    await evaluate({}, questions);
    await assert.rejects(evaluate({}, questions), (error) => {
      assert.ok(error instanceof StewardError);
      assert.equal(error.code, failure === 'stream' ? 'invalid_response' : 'evaluation_failed');
      assert.deepEqual(error.diagnostics?.details, { evaluation_index: 1 });
      assert.doesNotMatch(JSON.stringify(error), /private|SyntheticPrivateKey/);
      return true;
    });
  }
});

test('local input rejection does not advance the HTTP evaluation index', async () => {
  const evaluate = makeEvaluator({
    model: 'test-model',
    apiKey: 'SyntheticPrivateKey',
    post: async () => ({ status: 200, body: JSON.stringify(response(undefined, 'private_unknown')) }),
  });
  await assert.rejects(
    evaluate({ task: 'SyntheticPrivateKey' }, questions),
    (error) => error instanceof StewardError && error.code === 'credential_detected',
  );
  await assert.rejects(evaluate({}, questions), (error) => {
    assert.ok(error instanceof StewardError);
    assert.equal(error.diagnostics?.details?.evaluation_index, 0);
    return true;
  });
});

test('diagnostic details accept new scalar metrics but reject unbounded or raw content', () => {
  const base = { stage: 'response', kind: 'probability_sum' };
  assert.ok(FailureDiagnosticsSchema.safeParse(base).success);
  assert.ok(
    FailureDiagnosticsSchema.safeParse({ ...base, details: { new_metric: 0.9, present: false, actual: null } }).success,
  );
  for (const details of [
    { actual: 'private body' },
    { actual: { private: 1 } },
    { actual: [0.5, 0.5] },
    { actual: NaN },
    { actual: Infinity },
    { actual: undefined },
    null,
    [],
    { 'private prompt text': 1 },
    { ['x'.repeat(65)]: 1 },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`metric_${index}`, index])),
    JSON.parse('{"__proto__":1}'),
  ])
    assert.equal(FailureDiagnosticsSchema.safeParse({ ...base, details }).success, false);
});
