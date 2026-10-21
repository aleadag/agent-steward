import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { StewardError } from '../src/contracts.ts';
import { policyScenarios } from './policy-scenarios.ts';
import { runPolicyChecks } from './policy-check.ts';
import { choice, evaluation } from './helpers.ts';

test('policy recipe makes exactly six injected evaluations and reports actual choices without launches', async () => {
  let calls = 0;
  const results = await runPolicyChecks(async (state, questions) => {
    calls++;
    const pair = questions.pair;
    assert.ok(pair && pair.type === 'choice');
    assert.equal(questions.effort, undefined);
    const ids = Object.keys(pair.criteria);
    assert.ok(ids.length > 0);
    const payload = JSON.parse(JSON.stringify(state));
    assert.ok(payload.task.startsWith('Synthetic:'));
    assert.ok(payload.candidates.every((candidate: { model: string }) => candidate.model.endsWith('-example')));
    return evaluation({ pair: choice(Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 1 : 0]))) });
  });
  assert.equal(calls, 6);
  assert.equal(results.length, 6);
  assert.deepEqual(
    results.map((result) => result.expected),
    ['on-pace', 'on-pace', 'api', 'over-budget', 'api', 'on-pace'],
  );
  assert.ok(
    results.some((result) => result.matched === false),
    'A valid non-preferred choice is reported, not hidden',
  );
  assert.ok(results.every((result) => result.matched === (result.selected === result.expected)));
});

test('policy recipe propagates evaluator failure without retrying or starting later cases', async () => {
  let calls = 0;
  await assert.rejects(
    runPolicyChecks(async (_state, questions) => {
      if (++calls === 2) throw new Error('Synthetic transport failure');
      const pair = questions.pair;
      assert.ok(pair && pair.type === 'choice');
      const ids = Object.keys(pair.criteria);
      return evaluation({ pair: choice(Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 1 : 0]))) });
    }),
    (error) => error instanceof StewardError && error.code === 'evaluation_failed',
  );
  assert.equal(calls, 2);
});

test('policy recipe refuses extra cases or thinking stages before any evaluator call', async () => {
  let calls = 0;
  const evaluate = async () => {
    calls++;
    throw new Error('Must not call');
  };
  policyScenarios.push(policyScenarios[0]!);
  try {
    await assert.rejects(runPolicyChecks(evaluate), /six single-level scenarios/);
  } finally {
    policyScenarios.pop();
  }
  const candidate = policyScenarios[0]!.config.candidates[0]!;
  const levels = candidate.thinking_levels;
  candidate.thinking_levels = [...levels, { id: 'high', description: 'Extra evaluator stage' }];
  try {
    await assert.rejects(runPolicyChecks(evaluate), /six single-level scenarios/);
  } finally {
    candidate.thinking_levels = levels;
  }
  assert.equal(calls, 0);
});

test('policy recipe fails closed on invalid choices rather than inventing a selection', async () => {
  let calls = 0;
  await assert.rejects(
    runPolicyChecks(async () => {
      calls++;
      return evaluation({ pair: choice({ 'not-supplied': 1 }) });
    }),
    (error) => error instanceof StewardError && error.code === 'invalid_response',
  );
  assert.equal(calls, 1);
});
