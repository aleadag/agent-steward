import type { Candidate, Config, QuotaFacts, QuotaWindowFact } from '../src/contracts.ts';
import { ConfigSchema } from '../src/contracts.ts';
import { apiCandidate, candidate, config, quotaFacts, windowFact } from './helpers.ts';

export type PolicyScenario = {
  id: string;
  task: string;
  config: Config;
  quota: Map<string, QuotaFacts>;
  now: Date;
  expected: string;
};

const levels = [{ id: 'default', description: 'Use the native default' }];
const capability = 'General routine coding and refactoring for this synthetic evaluation';
const onPace = candidate({
  id: 'on-pace',
  tool: 'pi',
  provider: 'xai',
  model: 'healthy-example',
  quota_bucket: 'pi_xai',
  cost: 2,
  capabilities: capability,
  thinking_levels: levels,
});
const overBudget = candidate({
  id: 'over-budget',
  model: 'overspent-example',
  cost: 2,
  capabilities: capability,
  thinking_levels: levels,
});
const api = apiCandidate({ id: 'api', provider: 'synthetic-api', model: 'api-example', capabilities: capability });
const weakApi = { ...api, capabilities: 'Simple mechanical edits only; cannot solve architectural problems' };

function weekly(remaining: number, index: number): QuotaWindowFact {
  return {
    ...windowFact(index === 0 ? { type: 'account' } : { type: 'pool', pool_id: 'primary' }, {
      cadence: 'weekly',
      remaining_percent: remaining,
      observed_at: '2026-10-20T23:59:00Z',
      valid_until: '2026-10-21T01:00:00Z',
      reset_at: '2026-10-24T12:00:00Z',
    }),
    status: 'known',
    reason: null,
  };
}

function scenario(
  id: string,
  task: string,
  candidates: Candidate[],
  windows: Record<string, number[]>,
  expected: string,
): PolicyScenario {
  const cfg = ConfigSchema.parse(config({ tools: ['codex', 'pi'], candidates }));
  const quota = new Map<string, QuotaFacts>(
    cfg.candidates.map((value) => [
      value.id,
      value.billing === 'api'
        ? { status: 'not_applicable', reason: 'api_billed' }
        : quotaFacts(value, {
            snapshot_status: 'loaded',
            account_status: 'known',
            pool_status: 'known',
            windows: (windows[value.id] ?? []).map(weekly),
          }),
    ]),
  );
  return { id, task: 'Synthetic: ' + task, config: cfg, quota, now: new Date('2026-10-21T00:00:00Z'), expected };
}

export const policyScenarios: PolicyScenario[] = [
  scenario(
    'healthy',
    'Routine refactoring with equally suitable models',
    [onPace, api],
    { 'on-pace': [80] },
    'on-pace',
  ),
  scenario(
    'independent',
    'Routine refactoring; use independent healthy subscription capacity before paid API',
    [overBudget, onPace, api],
    { 'over-budget': [10], 'on-pace': [80] },
    'on-pace',
  ),
  scenario(
    'overspent',
    'Routine refactoring when the subscription is ahead of its spending budget',
    [overBudget, api],
    { 'over-budget': [10] },
    'api',
  ),
  scenario(
    'capability',
    'Difficult ambiguous architectural diagnosis requiring expert architectural reasoning',
    [{ ...overBudget, capabilities: 'Expert architectural reasoning and ambiguous root-cause diagnosis' }, weakApi],
    { 'over-budget': [10] },
    'over-budget',
  ),
  scenario(
    'only-api',
    'Difficult architectural diagnosis beyond the only eligible model; still choose a candidate',
    [overBudget, weakApi],
    { 'over-budget': [0] },
    'api',
  ),
  scenario(
    'simultaneous',
    'Routine refactoring with simultaneous account and pool constraints',
    [overBudget, onPace, api],
    { 'over-budget': [90, 10], 'on-pace': [80] },
    'on-pace',
  ),
];
