import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../dist/src/routing.js';
import { loadQuota } from '../dist/src/quota.js';
import { makeEvaluator, validateEvaluation } from '../dist/src/jev.js';
import { ResultSchema, StewardError } from '../dist/src/contracts.js';
import { config, candidate, choice, evaluation, quotaFacts, snapshot, windowFact } from './helpers.mjs';

const task = 'Review parser';
const fixedNow = new Date('2026-09-28T10:30:00Z');

function routeInput(cfg, evaluate, quota = new Map(cfg.candidates
  .filter(item => cfg.tools.includes(item.tool))
  .map(item => [item.id, quotaFacts(item, {
    source: cfg.accounts.find(account => account.id === item.account_id)?.source ?? 'codex',
  })]))) {
  return { task, requestId: 'route-1', config: cfg, quota, evaluate };
}

function selectedPairAnswer(probabilities, confidence = 0.9, returned) {
  return evaluation({ pair: choice(probabilities, confidence, returned) });
}

function selectedEffortAnswer(probabilities, confidence = 0.9, returned) {
  return evaluation({ effort: choice(probabilities, confidence, returned) });
}

function recordingPost() {
  const requests = [];
  const post = async request => {
    requests.push(request);
    const wire = JSON.parse(request.body);
    const answers = Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0]));
        return [id, choice(probabilities)];
      }
      return [id, { type: 'noul', noul: 0.1 }];
    }));
    return { status: 200, body: JSON.stringify(evaluation(answers)) };
  };
  return { post, requests };
}

test('winning low-confidence pair is not returned when effort fails', async () => {
  const cfg = config({ candidates: [candidate({ thinking_levels: [
    { id: 'low', description: 'Low' }, { id: 'high', description: 'High' },
  ] })] });
  const quota = await loadQuota(cfg, { now: fixedNow,
    readText: async () => { throw new Error('absent'); }, diagnostic: () => {} });
  let calls = 0;
  await assert.rejects(route({ task, requestId: 'route-1', config: cfg, quota,
    evaluate: async (_state, questions) => {
      if (++calls === 2) throw new StewardError('evaluation_failed');
      return validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }, 0.01), questions);
    },
  }), e => e.code === 'evaluation_failed');
  assert.equal(calls, 2);
});

test('low-confidence winning pair and effort produce a complete selected result', async () => {
  const codex = candidate({ id: 'codex-choice', thinking_levels: [
    { id: 'low', description: 'Low configured effort' }, { id: 'high', description: 'High configured effort' },
  ] });
  const pi = candidate({ id: 'pi-choice', tool: 'pi', provider: 'openai-codex', model: codex.model,
    thinking_levels: [
      { id: 'medium', description: 'Pi medium effort' }, { id: 'high', description: 'Pi high effort' },
    ] });
  const cfg = config({ candidates: [codex, pi] });
  const states = [];
  const result = await route(routeInput(cfg, async (state, questions) => {
    states.push({ state, questions });
    if (states.length === 1) {
      return validateEvaluation(selectedPairAnswer({ 'codex-choice': 0.2, 'pi-choice': 0.8 }, 0.01), questions);
    }
    return validateEvaluation(selectedEffortAnswer({ medium: 0.8, high: 0.2 }, 0.02), questions);
  }));

  assert.equal(states.length, 2);
  assert.deepEqual(Object.keys(states[0].questions.pair.criteria), ['codex-choice', 'pi-choice']);
  assert.deepEqual(states[0].state.candidates[0].thinking_levels, codex.thinking_levels);
  assert.deepEqual(states[0].state.candidates[1].thinking_levels, pi.thinking_levels);
  assert.deepEqual(Object.keys(states[1].questions.effort.criteria), ['medium', 'high']);
  assert.deepEqual(states[1].state, { task, candidate: pi, quota: quotaFacts(pi) });
  assert.equal(result.decision, 'selected');
  assert.equal(result.request_id, 'route-1');
  assert.deepEqual(result.selected, {
    candidate_id: 'pi-choice', tool: 'pi', provider: 'openai-codex', model: codex.model,
    thinking_level: 'medium', account_id: 'shared', quota_pool: 'primary',
  });
  assert.deepEqual(result.planned_command.args, ['--provider', 'openai-codex', '--model', codex.model, '--thinking', 'medium']);
  assert.equal(result.evaluations.pair.answers.pair.confidence, 0.01);
  assert.equal(result.evaluations.pair.model, 'jev-1.13.0');
  assert.deepEqual(result.evaluations.pair.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(result.evaluations.effort.answers.effort.confidence, 0.02);
  assert.equal(result.evaluations.effort.model, 'jev-1.13.0');
  assert.deepEqual(result.evaluations.effort.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(ResultSchema.safeParse(result).success, true);
  assert.deepEqual(Object.keys(result).sort(), ['decision', 'evaluations', 'planned_command', 'quota', 'request_id', 'schema_version', 'selected']);
  assert.equal(Object.hasOwn(result, 'session_id'), false);
  assert.equal(Object.hasOwn(result, 'explanation'), false);
  assert.equal(Object.hasOwn(result, 'reserve'), false);
  assert.equal(Object.hasOwn(result, 'cache'), false);
  assert.equal(Object.hasOwn(result, 'phase'), false);
});

test('configured order breaks exact ties even for numeric-like IDs', async () => {
  const first = candidate({ id: '10' });
  const second = candidate({ id: '2' });
  const cfg = config({ candidates: [first, second] });
  const result = await route(routeInput(cfg, async (_state, questions) =>
    validateEvaluation(selectedPairAnswer({ '10': 0.5, '2': 0.5 }, 0), questions)));

  assert.equal(result.selected.candidate_id, '10');
  assert.deepEqual(result.evaluations.effort, { kind: 'fixed', level: 'low' });
});

test('configured order breaks exact effort ties even for numeric-like IDs', async () => {
  const cfg = config({ candidates: [candidate({ thinking_levels: [
    { id: '10', description: 'First configured' }, { id: '2', description: 'Second configured' },
  ] })] });
  let calls = 0;
  const result = await route(routeInput(cfg, async (_state, questions) => {
    calls++;
    return calls === 1
      ? validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions)
      : validateEvaluation(selectedEffortAnswer({ '10': 0.5, '2': 0.5 }, 0), questions);
  }));

  assert.equal(result.selected.thinking_level, '10');
});

test('prototype-like candidate IDs remain valid record keys', async () => {
  const first = candidate({ id: '__proto__' });
  const second = candidate({ id: 'constructor' });
  const cfg = config({ candidates: [first, second] });
  const probabilities = Object.fromEntries([['__proto__', 0.6], ['constructor', 0.4]]);
  const result = await route(routeInput(cfg, async (_state, questions) =>
    validateEvaluation(selectedPairAnswer(probabilities, 0.1), questions)));

  assert.equal(result.selected.candidate_id, '__proto__');
});

test('same model through Codex and Pi remains independently selectable', async () => {
  const codex = candidate({ id: 'codex-model', model: 'shared-model' });
  const pi = candidate({ id: 'pi-model', tool: 'pi', provider: 'openai-codex', model: 'shared-model' });
  const cfg = config({ candidates: [codex, pi] });
  const result = await route(routeInput(cfg, async (_state, questions) =>
    validateEvaluation(selectedPairAnswer({ 'codex-model': 0.1, 'pi-model': 0.9 }, 0.05), questions)));

  assert.equal(result.selected.candidate_id, 'pi-model');
  assert.equal(result.selected.tool, 'pi');
  assert.equal(result.selected.model, 'shared-model');
  assert.equal(result.planned_command.executable, 'pi');
});

test('unknown quota remains eligible and is preserved in the result', async () => {
  const cfg = config();
  const result = await route(routeInput(cfg, async (_state, questions) =>
    validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }, 0.03), questions)));

  assert.equal(result.selected.candidate_id, 'codex-astra');
  assert.equal(result.quota.snapshot_status, 'missing');
  assert.equal(result.quota.account_status, 'unknown');
  assert.equal(result.quota.pool_status, 'unknown');
  assert.deepEqual(result.quota.windows, []);
});

test('known quota freshness, source, and unverified command flags survive selection', async () => {
  const cfg = config({ accounts: [{ id: 'shared', source: 'antigravity', snapshot: '/fixture/quota.json' }] });
  const body = JSON.stringify(snapshot([
    windowFact({ type: 'account' }, { remaining_percent: 61 }),
    windowFact({ type: 'pool', pool_id: 'primary' }, { remaining_percent: 37 }),
  ], { source: 'antigravity' }));
  const quota = await loadQuota(cfg, { now: fixedNow, readText: async () => body, diagnostic: () => {} });
  const result = await route(routeInput(cfg, async (_state, questions) =>
    validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions), quota));

  assert.equal(ResultSchema.safeParse(result).success, true);
  assert.equal(result.quota.source, 'antigravity');
  assert.equal(result.quota.snapshot_status, 'loaded');
  assert.equal(result.quota.account_status, 'known');
  assert.equal(result.quota.pool_status, 'known');
  assert.equal(result.quota.windows[1].remaining_percent, 37);
  assert.equal(result.quota.windows[1].observed_at, '2026-09-28T10:00:00Z');
  assert.equal(result.planned_command.syntax_validated, true);
  assert.equal(result.planned_command.runtime_selection, 'unverified');
  assert.equal(result.planned_command.authentication, 'unverified');
});

test('a single configured level uses one evaluation and marks effort fixed', async () => {
  const cfg = config();
  let calls = 0;
  const result = await route(routeInput(cfg, async (_state, questions) => {
    calls++;
    return validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions);
  }));

  assert.equal(calls, 1);
  assert.deepEqual(result.evaluations.effort, { kind: 'fixed', level: 'low' });
});

test('255 enabled candidates are accepted as pair options', async () => {
  const candidates = Array.from({ length: 255 }, (_, index) => candidate({ id: `pair-${index}` }));
  const cfg = config({ candidates });
  const probabilities = Object.fromEntries(candidates.map(item => [item.id, 1 / candidates.length]));
  let calls = 0;
  const result = await route(routeInput(cfg, async (_state, questions) => {
    calls++;
    return validateEvaluation(selectedPairAnswer(probabilities), questions);
  }));

  assert.equal(calls, 1);
  assert.equal(result.selected.candidate_id, 'pair-0');
});

test('256 enabled candidates fail before evaluator invocation', async () => {
  const candidates = Array.from({ length: 256 }, (_, index) => candidate({ id: `pair-${index}` }));
  let calls = 0;
  await assert.rejects(route(routeInput(config({ candidates }), async () => { calls++; })),
    error => error.code === 'invalid_config');
  assert.equal(calls, 0);
});

test('empty inventory and no enabled tools fail without selection', async t => {
  for (const cfg of [config({ candidates: [] }), config({ tools: [], candidates: [candidate()] })]) {
    await t.test('rejects empty enabled inventory', async () => {
      let calls = 0;
      await assert.rejects(route(routeInput(cfg, async () => { calls++; })),
        error => error.code === 'invalid_config');
      assert.equal(calls, 0);
    });
  }
});

test('disabled candidates are excluded without fallback or syntax validation', async () => {
  const disabled = candidate({ id: 'disabled', tool: 'codex', model: '--not-a-model' });
  const enabled = candidate({ id: 'enabled', tool: 'pi', provider: 'openai-codex' });
  const cfg = config({ tools: ['pi'], candidates: [disabled, enabled] });
  let call;
  const result = await route(routeInput(cfg, async (state, questions) => {
    call = { state, questions };
    return validateEvaluation(selectedPairAnswer({ enabled: 1 }), questions);
  }));

  assert.deepEqual(Object.keys(call.questions.pair.criteria), ['enabled']);
  assert.deepEqual(call.state.candidates.map(item => item.id), ['enabled']);
  assert.equal(result.selected.candidate_id, 'enabled');
});

test('empty levels and missing quota facts fail before evaluator invocation', async t => {
  await t.test('rejects raw candidate with no levels', async () => {
    const cfg = config({ candidates: [candidate({ thinking_levels: [] })] });
    let calls = 0;
    await assert.rejects(route(routeInput(cfg, async () => { calls++; })),
      error => error.code === 'invalid_config');
    assert.equal(calls, 0);
  });
  await t.test('rejects absent quota map entry', async () => {
    const cfg = config();
    let calls = 0;
    await assert.rejects(route(routeInput(cfg, async () => { calls++; }, new Map())),
      error => error.code === 'invalid_config');
    assert.equal(calls, 0);
  });
});

test('unsupported syntax on any enabled candidate fails before evaluator call', async () => {
  const cfg = config({ candidates: [candidate({ id: 'supported' }), candidate({ id: 'unsupported', model: '--unmappable' })] });
  let calls = 0;
  await assert.rejects(route(routeInput(cfg, async () => { calls++; })),
    error => error.code === 'invalid_config');
  assert.equal(calls, 0);
});

test('routing itself rejects an injected malformed first-stage unknown pair', async () => {
  let calls = 0;
  await assert.rejects(route(routeInput(config(), async () => {
    calls++;
    return evaluation({ pair: {
      type: 'choice', choice: 'not-configured', probabilities: { 'codex-astra': 1 }, confidence: 1,
    } });
  })), error => error.code === 'invalid_response');
  assert.equal(calls, 1);
});

test('injected evaluator answers are revalidated at both route stages', async t => {
  await t.test('rejects an unknown pair selection', async () => {
    const cfg = config();
    await assert.rejects(route(routeInput(cfg, async (_state, questions) =>
      validateEvaluation(evaluation({ pair: {
        type: 'choice', choice: 'not-configured', probabilities: { 'codex-astra': 1 }, confidence: 1,
      } }), questions))), error => error.code === 'invalid_response');
  });
  await t.test('rejects an unknown effort selection', async () => {
    const cfg = config({ candidates: [candidate({ thinking_levels: [
      { id: 'low', description: 'Low' }, { id: 'high', description: 'High' },
    ] })] });
    let calls = 0;
    await assert.rejects(route(routeInput(cfg, async (_state, questions) => {
      calls++;
      return calls === 1
        ? validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions)
        : evaluation({ effort: {
          type: 'choice', choice: 'not-configured', probabilities: { low: 1, high: 0 }, confidence: 1,
        } });
    })), error => error.code === 'invalid_response');
    assert.equal(calls, 2);
  });
});

test('invalid second-stage response rejects instead of returning partial selection', async () => {
  const cfg = config({ candidates: [candidate({ thinking_levels: [
    { id: 'low', description: 'Low' }, { id: 'high', description: 'High' },
  ] })] });
  let calls = 0;
  await assert.rejects(route(routeInput(cfg, async (_state, questions) => {
    calls++;
    return calls === 1
      ? validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions)
      : evaluation({ effort: {
        type: 'choice', choice: 'low', probabilities: { low: 0.7, high: 0.2 }, confidence: 1,
      } });
  })), error => error.code === 'invalid_response');
  assert.equal(calls, 2);
});

test('task and request ID must be nonempty', async t => {
  for (const input of [{ task: '  ', requestId: 'route-1' }, { task, requestId: '' }]) {
    await t.test('rejects blank route input before evaluation', async () => {
      let calls = 0;
      await assert.rejects(route({ ...routeInput(config(), async () => { calls++; }), ...input }),
        error => error.code === 'invalid_input');
      assert.equal(calls, 0);
    });
  }
});

test('real evaluator rejects recognizable credentials in every routed field before posting', async t => {
  const secret = 'steward-test-key-9f4c2';
  const scenarios = [
    ['task', cfg => ({ cfg, task: `Review ${secret}` })],
    ['capability', cfg => ({ cfg: config({ candidates: [candidate({ capabilities: `Uses ${secret}` })] }) })],
    ['candidate ID', cfg => ({ cfg: config({ candidates: [candidate({ id: `key=${secret}` })] }) })],
    ['unchosen effort description', cfg => ({ cfg: config({ candidates: [candidate({ thinking_levels: [
      { id: 'low', description: 'Low' }, { id: 'high', description: `High ${secret}` },
    ] })] }) })],
    ['selected effort description', cfg => ({ cfg: config({ candidates: [candidate({ thinking_levels: [
      { id: 'low', description: `Low ${secret}` }, { id: 'high', description: 'High' },
    ] })] }) })],
  ];

  for (const [label, setup] of scenarios) {
    await t.test(label, async () => {
      const original = config();
      const { cfg, task: routedTask = task } = setup(original);
      const { post, requests } = recordingPost();
      const evaluate = makeEvaluator({ model: 'jev-1.13.0', apiKey: secret, post });
      await assert.rejects(route({ ...routeInput(cfg, evaluate), task: routedTask }), error =>
        error.code === 'credential_detected' && !error.message.includes(secret));
      assert.equal(requests.length, 0);
      assert.equal(JSON.stringify(requests).includes(secret), false);
    });
  }
});

test('real evaluator stage-two timeout aborts atomically without a partial route', async t => {
  const cfg = config({ candidates: [candidate({ thinking_levels: [
    { id: 'low', description: 'Low' }, { id: 'high', description: 'High' },
  ] })] });
  const deadlines = [];
  let resolveSecondStarted;
  const secondStarted = new Promise(resolve => { resolveSecondStarted = resolve; });
  let calls = 0;
  let returned = false;
  const upstreamFailure = 'synthetic-upstream-and-request-body-marker';
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  const evaluate = makeEvaluator({ model: 'jev-1.13.0', apiKey: 'unit-key-not-live', post: request => {
    calls++;
    if (calls === 1) return Promise.resolve({
      status: 200,
      body: JSON.stringify(evaluation({ pair: choice({ 'codex-astra': 1 }) })),
    });
    resolveSecondStarted();
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error(`${upstreamFailure}:${request.body}`)), { once: true });
    });
  } });

  const pending = route(routeInput(cfg, evaluate)).then(value => { returned = true; return value; });
  await secondStarted;
  assert.equal(calls, 2);
  assert.deepEqual(deadlines.map(deadline => deadline.milliseconds), [30_000, 30_000]);
  deadlines[1].controller.abort();
  await assert.rejects(pending, error => error.code === 'evaluation_failed' &&
    !error.message.includes(upstreamFailure) && !error.message.includes('unit-key-not-live'));
  assert.equal(returned, false);
});

test('real evaluator rejects a planted credential in an effort-stage payload locally', async () => {
  const secret = 'steward-test-key-9f4c2';
  const { post, requests } = recordingPost();
  const evaluate = makeEvaluator({ model: 'jev-1.13.0', apiKey: secret, post });
  const state = { task, candidate: candidate({ thinking_levels: [
    { id: 'low', description: `Low ${secret}` }, { id: 'high', description: 'High' },
  ] }), quota: quotaFacts(candidate()) };
  await assert.rejects(evaluate(state, { effort: {
    type: 'choice', instructions: 'Choose a supplied level.', criteria: { low: null, high: null },
  } }), error => error.code === 'credential_detected' && !error.message.includes(secret));
  assert.equal(requests.length, 0);
  assert.equal(JSON.stringify(requests).includes(secret), false);
});
