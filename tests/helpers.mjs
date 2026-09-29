export function config(overrides = {}) {
  return {
    tools: ['codex', 'pi', 'agy'],
    accounts: [{ id: 'shared', source: 'codex', snapshot: '/fixture/quota.json' }],
    candidates: [candidate()],
    jev: { model: 'jev-1.13.0' },
    thresholds: { risky: 0.60, choiceConfidence: 0.45 },
    ...overrides,
  };
}

export function candidate(overrides = {}) {
  return {
    id: 'codex-astra', tool: 'codex', provider: 'openai', model: 'gpt-astra-example',
    account_id: 'shared', quota_pool: 'primary', capabilities: 'Illustrative coding model; not verified live',
    thinking_levels: [{ id: 'low', description: 'Configured low effort' }], ...overrides,
  };
}

export function choice(probabilities, confidence = 0.9, returned) {
  const max = Math.max(...Object.values(probabilities));
  return { type: 'choice', choice: returned ?? Object.keys(probabilities).find(k => probabilities[k] === max), probabilities, confidence };
}

export function evaluation(answers) {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 12, output_tokens: 3 } };
}

export function quotaFacts(candidate, overrides = {}) {
  return {
    source: 'codex', account_id: candidate.account_id, pool_id: candidate.quota_pool,
    snapshot_status: 'missing', account_status: 'unknown', pool_status: 'unknown', windows: [],
    ...overrides,
  };
}

export function choiceAnswer(probabilities, confidence = 0.9, returned) {
  const maximum = Math.max(...Object.values(probabilities));
  return {
    type: 'choice',
    choice: returned ?? Object.keys(probabilities).find(key => probabilities[key] === maximum),
    probabilities,
    confidence,
  };
}

export function noulAnswer(noul) {
  return { type: 'noul', noul };
}

export function jevResponse(answers, overrides = {}) {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 12, output_tokens: 3 }, ...overrides };
}

export function snapshot(windows, overrides = {}) {
  return { schema_version: 1, source: 'codex', account_id: 'shared', windows, ...overrides };
}

export function windowFact(scope, overrides = {}) {
  return { scope, remaining_percent: 40, observed_at: '2026-09-28T10:00:00Z',
    reset_at: '2026-09-28T12:00:00Z', valid_until: '2026-09-28T11:00:00Z', ...overrides };
}

export function approval(overrides = {}) {
  return { schema_version: 1, request_id: 'request-1', agent: { id: 'agent-1', tool: 'codex' },
    status: 'stopped', context: 'Current prompt asks permission to update a local draft.',
    automatic_approval_forbidden: false, ...overrides };
}

export function recordingPost(response) {
  const requests = [];
  const post = async request => {
    requests.push(request);
    const wire = JSON.parse(request.body);
    const payload = typeof response === 'function' ? await response(wire, request) : response;
    return { status: 200, body: JSON.stringify(payload) };
  };
  return { post, requests };
}
