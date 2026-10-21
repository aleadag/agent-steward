import type { Evaluate } from '../src/jev.ts';
import { route } from '../src/routing.ts';
import { policyScenarios } from './policy-scenarios.ts';

export async function runPolicyChecks(evaluate: Evaluate): Promise<
  {
    scenario: string;
    selected: string;
    expected: string;
    matched: boolean;
  }[]
> {
  if (
    policyScenarios.length !== 6 ||
    policyScenarios.some((scenario) =>
      scenario.config.candidates.some((candidate) => candidate.thinking_levels.length !== 1),
    )
  )
    throw new Error('Policy checks require six single-level scenarios');
  let calls = 0;
  const boundedEvaluate: Evaluate = (state, questions) => {
    if (calls >= 6) throw new Error('Policy evaluator call limit reached');
    calls++;
    return evaluate(state, questions);
  };
  const results = [];
  for (const scenario of policyScenarios) {
    const result = await route({
      task: scenario.task,
      requestId: `policy-${scenario.id}`,
      config: scenario.config,
      quota: scenario.quota,
      now: scenario.now,
      evaluate: boundedEvaluate,
    });
    results.push({
      scenario: scenario.id,
      selected: result.selected.candidate_id,
      expected: scenario.expected,
      matched: result.selected.candidate_id === scenario.expected,
    });
  }
  return results;
}
