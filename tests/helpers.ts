import type {
  StopInput,
  Candidate,
  ChoiceAnswer,
  Config,
  Evaluation,
  QuotaFacts,
  QuotaWindow,
  Snapshot,
} from '../src/contracts.ts';
import type { HttpPost } from '../src/jev.ts';
import type { Questions } from '../src/jev.ts';

export function config(overrides: Partial<Config> | Record<string, unknown> = {}): Config {
  return {
    tools: ['codex', 'pi', 'agy'],
    candidates: [candidate()],
    evaluator: { type: 'jev', provider: 'typesafe', model: 'jev-1.13.0' },
    thresholds: { risky: 0.6, choiceConfidence: 0.45 },
    ...overrides,
  } as Config;
}

export function candidate(overrides: Partial<Candidate> | Record<string, unknown> = {}): Candidate {
  return {
    id: 'codex-astra',
    tool: 'codex',
    provider: 'openai',
    model: 'gpt-astra-example',
    quota_bucket: 'codex',
    quota_pool: 'primary',
    cost: 1,
    capabilities: 'Illustrative coding model; not verified live',
    thinking_levels: [{ id: 'low', description: 'Configured low effort' }],
    ...overrides,
  } as Candidate;
}

export function choice(probabilities: Record<string, number>, confidence = 0.9, returned?: string): ChoiceAnswer {
  const selected =
    returned ??
    Object.keys(probabilities).find((key) => probabilities[key] === Math.max(...Object.values(probabilities)));
  if (selected === undefined) throw new Error('choice requires at least one outcome');
  return { type: 'choice', choice: selected, probabilities, confidence };
}

export function evaluation(answers: Evaluation['answers'] | Record<string, unknown>): Evaluation {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 12, output_tokens: 3 } } as Evaluation;
}

export function quotaFacts(
  candidate: Candidate,
  overrides: Partial<QuotaFacts> | Record<string, unknown> = {},
): QuotaFacts {
  return {
    source: candidate.quota_bucket,
    quota_bucket: candidate.quota_bucket,
    pool_id: candidate.quota_pool,
    snapshot_status: 'missing',
    account_status: 'unknown',
    pool_status: 'unknown',
    windows: [],
    ...overrides,
  } as QuotaFacts;
}

export function choiceAnswer(probabilities: Record<string, number>, confidence = 0.9, returned?: string): ChoiceAnswer {
  const selected =
    returned ??
    Object.keys(probabilities).find((key) => probabilities[key] === Math.max(...Object.values(probabilities)));
  if (selected === undefined) throw new Error('choice requires at least one outcome');
  return { type: 'choice', choice: selected, probabilities, confidence };
}

export function noulAnswer(noul: number) {
  return { type: 'noul', noul } as const;
}

export function jevResponse(
  answers: Evaluation['answers'] | Record<string, unknown>,
  overrides: Partial<Evaluation> | Record<string, unknown> = {},
): Evaluation {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 12, output_tokens: 3 }, ...overrides } as Evaluation;
}

export function snapshot(
  windows: Snapshot['windows'],
  overrides: Partial<Snapshot> | Record<string, unknown> = {},
): Snapshot {
  return {
    schema_version: 1,
    source: 'codex',
    identity_fingerprint: 'ab'.repeat(32),
    windows,
    ...overrides,
  } as Snapshot;
}

export function windowFact(
  scope: QuotaWindow['scope'],
  overrides: Partial<QuotaWindow> | Record<string, unknown> = {},
): QuotaWindow {
  return {
    scope,
    remaining_percent: 40,
    observed_at: '2026-09-28T10:00:00Z',
    reset_at: '2026-09-28T12:00:00Z',
    valid_until: '2026-09-28T11:00:00Z',
    ...overrides,
  } as QuotaWindow;
}

export function stopInput(overrides: Partial<StopInput> | Record<string, unknown> = {}): StopInput {
  return {
    schema_version: 2,
    request_id: 'request-1',
    agent: { id: 'agent-1', tool: 'codex', pane_id: 'w1:p1', session_id: null },
    status: 'blocked',
    current_episode_id: 'episode-1',
    context: 'Current prompt asks permission to update a local draft.',
    pending_action: { action: 'Edit the local draft' },
    automatic_approval_forbidden: false,
    retry: {
      failure_episode_id: 'episode-1',
      first_observed_at: '2026-09-29T10:00:00Z',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
    },
    ...overrides,
  } as StopInput;
}

export async function runSubcase(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown failure';
    throw new Error(`${label}: ${detail}`, { cause: error });
  }
}

export function recordingPost(
  response:
    | Evaluation
    | ((wire: { questions: Questions }, request: Parameters<HttpPost>[0]) => Evaluation | Promise<Evaluation>),
): { post: HttpPost; requests: Parameters<HttpPost>[0][] } {
  const requests: Parameters<HttpPost>[0][] = [];
  const post: HttpPost = async (request) => {
    requests.push(request);
    const wire = JSON.parse(request.body) as { questions: Questions };
    const payload = typeof response === 'function' ? await response(wire, request) : response;
    return { status: 200, body: JSON.stringify(payload) };
  };
  return { post, requests };
}
