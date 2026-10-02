import { afterEach, mock, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { route } from '../src/routing.ts';
import { loadQuota } from '../src/quota.ts';
import { makeEvaluator, validateEvaluation } from '../src/jev.ts';
import { ResultSchema, StewardError } from '../src/contracts.ts';
import type { Candidate, Config, QuotaFacts } from '../src/contracts.ts';
import type { Evaluate, Questions } from '../src/jev.ts';
import { config, candidate, choice, evaluation, quotaFacts, snapshot, windowFact, runSubcase } from './helpers.ts';

afterEach(() => mock.restore());

const task = 'Review parser';
const fixedNow = new Date('2026-09-28T10:30:00Z');

function routeInput(
  cfg: Config,
  evaluate: Evaluate,
  quota: Map<string, QuotaFacts> = new Map(
    cfg.candidates
      .filter((item) => cfg.tools.includes(item.tool))
      .map(
        (item) =>
          [
            item.id,
            quotaFacts(item, {
              source: item.quota_bucket,
            }),
          ] as const,
      ),
  ),
) {
  return { task, requestId: 'route-1', config: cfg, quota, evaluate };
}

function hasCode(error: unknown, code: StewardError['code']): error is StewardError {
  return error instanceof StewardError && error.code === code;
}

function selectedPairAnswer(probabilities: Record<string, number>, confidence = 0.9, returned?: string) {
  return evaluation({ pair: choice(probabilities, confidence, returned) });
}

function selectedEffortAnswer(probabilities: Record<string, number>, confidence = 0.9, returned?: string) {
  return evaluation({ effort: choice(probabilities, confidence, returned) });
}

function recordingPost() {
  const requests: Parameters<import('../src/jev.ts').HttpPost>[0][] = [];
  const post: import('../src/jev.ts').HttpPost = async (request) => {
    requests.push(request);
    const wire = JSON.parse(request.body) as { questions: Questions };
    const answers = Object.fromEntries(
      Object.entries(wire.questions).map(([id, question]) => {
        if (question.type === 'choice') {
          const options = Object.keys(question.criteria);
          const probabilities = Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0]));
          return [id, choice(probabilities)];
        }
        return [id, { type: 'noul', noul: 0.1 }];
      }),
    );
    return { status: 200, body: JSON.stringify(evaluation(answers)) };
  };
  return { post, requests };
}

test('winning low-confidence pair is not returned when effort fails', async () => {
  const cfg = config({
    candidates: [
      candidate({
        thinking_levels: [
          { id: 'low', description: 'Low' },
          { id: 'high', description: 'High' },
        ],
      }),
    ],
  });
  const quota = await loadQuota(cfg, {
    env: { HOME: '/isolated/home' },
    now: fixedNow,
    readText: async () => {
      throw new Error('absent');
    },
    diagnostic: () => {},
  });
  let calls = 0;
  await assert.rejects(
    route({
      task,
      requestId: 'route-1',
      config: cfg,
      quota,
      evaluate: async (_state, questions) => {
        if (++calls === 2) throw new StewardError('evaluation_failed');
        return validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }, 0.01), questions);
      },
    }),
    (error) => hasCode(error, 'evaluation_failed'),
  );
  assert.equal(calls, 2);
});

test('pair evaluation includes relative cost in instructions and candidate state', async () => {
  const cheap = candidate({ id: 'cheap', cost: 1 });
  const dear = candidate({
    id: 'dear',
    tool: 'pi',
    quota_bucket: 'pi_codex',
    provider: 'openai-codex',
    cost: 2,
  });
  const cfg = config({ candidates: [cheap, dear] });
  let pairState: unknown;
  let pairText = '';
  await route(
    routeInput(cfg, async (state, questions) => {
      if (questions.pair !== undefined) {
        pairState = state;
        assert.equal(questions.pair.type, 'choice');
        pairText = questions.pair.instructions;
        return selectedPairAnswer({ cheap: 1, dear: 0 });
      }
      return selectedEffortAnswer({ low: 1 });
    }),
  );
  assert.match(pairText, /relative cost/);
  assert.match(pairText, /not a bill/);
  const candidates = (pairState as { candidates: Candidate[] }).candidates;
  assert.equal(candidates[0]?.cost, 1);
  assert.equal(candidates[1]?.cost, 2);
});

test('low-confidence winning pair and effort produce a complete selected result', async () => {
  const codex = candidate({
    id: 'codex-choice',
    thinking_levels: [
      { id: 'low', description: 'Low configured effort' },
      { id: 'high', description: 'High configured effort' },
    ],
  });
  const pi = candidate({
    id: 'pi-choice',
    tool: 'pi',
    quota_bucket: 'pi_codex',
    provider: 'openai-codex',
    model: codex.model,
    thinking_levels: [
      { id: 'medium', description: 'Pi medium effort' },
      { id: 'high', description: 'Pi high effort' },
    ],
  });
  const cfg = config({ candidates: [codex, pi] });
  const states: { state: unknown; questions: Questions }[] = [];
  const result = await route(
    routeInput(cfg, async (state, questions) => {
      states.push({ state, questions });
      if (states.length === 1) {
        return validateEvaluation(selectedPairAnswer({ 'codex-choice': 0.2, 'pi-choice': 0.8 }, 0.01), questions);
      }
      return validateEvaluation(selectedEffortAnswer({ medium: 0.8, high: 0.2 }, 0.02), questions);
    }),
  );

  assert.equal(states.length, 2);
  const pairState = states[0];
  const effortState = states[1];
  assert.ok(pairState !== undefined && effortState !== undefined);
  const pairQuestion = pairState.questions['pair'];
  const effortQuestion = effortState.questions['effort'];
  assert.ok(pairQuestion?.type === 'choice' && effortQuestion?.type === 'choice');
  assert.deepEqual(Object.keys(pairQuestion.criteria), ['codex-choice', 'pi-choice']);
  const pairInput = pairState.state as { candidates: Candidate[] };
  assert.deepEqual(pairInput.candidates[0]?.thinking_levels, codex.thinking_levels);
  assert.deepEqual(pairInput.candidates[1]?.thinking_levels, pi.thinking_levels);
  assert.deepEqual(Object.keys(effortQuestion.criteria), ['medium', 'high']);
  assert.deepEqual(effortState.state, { task, candidate: pi, quota: quotaFacts(pi) });
  assert.equal(result.decision, 'selected');
  assert.equal(result.request_id, 'route-1');
  assert.deepEqual(result.selected, {
    candidate_id: 'pi-choice',
    tool: 'pi',
    provider: 'openai-codex',
    model: codex.model,
    thinking_level: 'medium',
    quota_bucket: 'pi_codex',
    quota_pool: 'primary',
  });
  assert.deepEqual(result.planned_command.args, [
    '--provider',
    'openai-codex',
    '--model',
    codex.model,
    '--thinking',
    'medium',
  ]);
  const pairAnswer = result.evaluations.pair.answers['pair'];
  assert.ok(pairAnswer?.type === 'choice');
  assert.equal(pairAnswer.confidence, 0.01);
  assert.equal(result.evaluations.pair.model, 'jev-1.13.0');
  assert.deepEqual(result.evaluations.pair.usage, { input_tokens: 12, output_tokens: 3 });
  const effortEvaluation = result.evaluations.effort;
  assert.ok(!('kind' in effortEvaluation));
  const effortAnswer = effortEvaluation.answers['effort'];
  assert.ok(effortAnswer?.type === 'choice');
  assert.equal(effortAnswer.confidence, 0.02);
  assert.equal(effortEvaluation.model, 'jev-1.13.0');
  assert.deepEqual(effortEvaluation.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(ResultSchema.safeParse(result).success, true);
  assert.deepEqual(Object.keys(result).sort(), [
    'decision',
    'evaluations',
    'planned_command',
    'quota',
    'request_id',
    'schema_version',
    'selected',
  ]);
  assert.equal(Object.hasOwn(result, 'session_id'), false);
  assert.equal(Object.hasOwn(result, 'explanation'), false);
  assert.equal(Object.hasOwn(result, 'reserve'), false);
  assert.equal(Object.hasOwn(result, 'cache'), false);
  assert.equal(Object.hasOwn(result, 'phase'), false);
});

test('agy routing evaluates logical model and effort before translating launch argv', async () => {
  const gemini = candidate({
    id: 'gemini-flash-agy',
    tool: 'agy',
    provider: 'google',
    model: 'gemini-3.8-flash',
    quota_bucket: 'antigravity',
    thinking_levels: [
      { id: 'low', description: 'Brief reasoning' },
      { id: 'medium', description: 'Balanced reasoning' },
      { id: 'high', description: 'Deeper reasoning' },
    ],
  });
  const cfg = config({ candidates: [gemini] });
  const states: unknown[] = [];
  const result = await route(
    routeInput(cfg, async (state, questions) => {
      states.push(state);
      if (questions.pair !== undefined) return selectedPairAnswer({ 'gemini-flash-agy': 1 });
      assert.ok(questions.effort?.type === 'choice');
      assert.deepEqual(Object.keys(questions.effort.criteria), ['low', 'medium', 'high']);
      return selectedEffortAnswer({ low: 0, medium: 1, high: 0 });
    }),
  );
  assert.deepEqual(states, [
    { task, candidates: [{ ...gemini, quota: quotaFacts(gemini) }] },
    { task, candidate: gemini, quota: quotaFacts(gemini) },
  ]);
  assert.equal(result.selected.model, 'gemini-3.8-flash');
  assert.equal(result.selected.thinking_level, 'medium');
  assert.deepEqual(result.planned_command.args, ['--model=gemini-3.8-flash-medium']);
  assert.equal('kind' in result.evaluations.effort, false);
});

test('agy rejects any unsupported configured logical effort before evaluation', async () => {
  const gemini = candidate({
    tool: 'agy',
    model: 'gemini-3.8-flash',
    quota_bucket: 'antigravity',
    thinking_levels: [
      { id: 'low', description: 'Supported' },
      { id: 'max', description: 'Unsupported' },
    ],
  });
  let calls = 0;
  await assert.rejects(
    route(
      routeInput(config({ candidates: [gemini] }), async () => {
        calls++;
        return selectedPairAnswer({ 'codex-astra': 1 });
      }),
    ),
    (error) => hasCode(error, 'invalid_config'),
  );
  assert.equal(calls, 0);
});

test('configured order breaks exact ties even for numeric-like IDs', async () => {
  const first = candidate({ id: '10' });
  const second = candidate({ id: '2' });
  const cfg = config({ candidates: [first, second] });
  const result = await route(
    routeInput(cfg, async (_state, questions) =>
      validateEvaluation(selectedPairAnswer({ 10: 0.5, 2: 0.5 }, 0), questions),
    ),
  );

  assert.equal(result.selected.candidate_id, '10');
  assert.deepEqual(result.evaluations.effort, { kind: 'fixed', level: 'low' });
});

test('configured order breaks exact effort ties even for numeric-like IDs', async () => {
  const cfg = config({
    candidates: [
      candidate({
        thinking_levels: [
          { id: '10', description: 'First configured' },
          { id: '2', description: 'Second configured' },
        ],
      }),
    ],
  });
  let calls = 0;
  const result = await route(
    routeInput(cfg, async (_state, questions) => {
      calls++;
      return calls === 1
        ? validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions)
        : validateEvaluation(selectedEffortAnswer({ 10: 0.5, 2: 0.5 }, 0), questions);
    }),
  );

  assert.equal(result.selected.thinking_level, '10');
});

test('prototype-like candidate IDs remain valid record keys', async () => {
  const first = candidate({ id: '__proto__' });
  const second = candidate({ id: 'constructor' });
  const cfg = config({ candidates: [first, second] });
  const probabilities = Object.fromEntries([
    ['__proto__', 0.6],
    ['constructor', 0.4],
  ]);
  const result = await route(
    routeInput(cfg, async (_state, questions) => validateEvaluation(selectedPairAnswer(probabilities, 0.1), questions)),
  );

  assert.equal(result.selected.candidate_id, '__proto__');
});

test('same model through Codex and Pi remains independently selectable', async () => {
  const codex = candidate({ id: 'codex-model', model: 'shared-model' });
  const pi = candidate({
    id: 'pi-model',
    tool: 'pi',
    quota_bucket: 'pi_codex',
    provider: 'openai-codex',
    model: 'shared-model',
  });
  const cfg = config({ candidates: [codex, pi] });
  const result = await route(
    routeInput(cfg, async (_state, questions) =>
      validateEvaluation(selectedPairAnswer({ 'codex-model': 0.1, 'pi-model': 0.9 }, 0.05), questions),
    ),
  );

  assert.equal(result.selected.candidate_id, 'pi-model');
  assert.equal(result.selected.tool, 'pi');
  assert.equal(result.selected.model, 'shared-model');
  assert.equal(result.planned_command.executable, 'pi');
});

test('unknown quota remains eligible and is preserved in the result', async () => {
  const cfg = config();
  const result = await route(
    routeInput(cfg, async (_state, questions) =>
      validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }, 0.03), questions),
    ),
  );

  assert.equal(result.selected.candidate_id, 'codex-astra');
  assert.equal(result.quota.snapshot_status, 'missing');
  assert.equal(result.quota.account_status, 'unknown');
  assert.equal(result.quota.pool_status, 'unknown');
  assert.deepEqual(result.quota.windows, []);
});

test('known quota freshness, source, and unverified command flags survive selection', async () => {
  const cfg = config();
  const body = JSON.stringify(
    snapshot(
      [
        windowFact({ type: 'account' }, { remaining_percent: 61 }),
        windowFact({ type: 'pool', pool_id: 'primary' }, { remaining_percent: 37 }),
      ],
      { source: 'codex' },
    ),
  );
  const quota = await loadQuota(cfg, {
    env: { HOME: '/isolated/home' },
    now: fixedNow,
    readText: async () => body,
    diagnostic: () => {},
  });
  const result = await route(
    routeInput(
      cfg,
      async (_state, questions) => validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions),
      quota,
    ),
  );

  assert.equal(ResultSchema.safeParse(result).success, true);
  assert.equal(result.quota.source, 'codex');
  assert.equal(result.quota.snapshot_status, 'loaded');
  assert.equal(result.quota.account_status, 'known');
  assert.equal(result.quota.pool_status, 'known');
  const poolWindow = result.quota.windows[1];
  assert.ok(poolWindow !== undefined);
  assert.equal(poolWindow.remaining_percent, 37);
  assert.equal(poolWindow.observed_at, '2026-09-28T10:00:00Z');
  assert.equal(result.planned_command.syntax_validated, true);
  assert.equal(result.planned_command.runtime_selection, 'unverified');
  assert.equal(result.planned_command.authentication, 'unverified');
});

test('a single configured level uses one evaluation and marks effort fixed', async () => {
  const cfg = config();
  let calls = 0;
  const result = await route(
    routeInput(cfg, async (_state, questions) => {
      calls++;
      return validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions);
    }),
  );

  assert.equal(calls, 1);
  assert.deepEqual(result.evaluations.effort, { kind: 'fixed', level: 'low' });
});

test('255 enabled candidates are accepted as pair options', async () => {
  const candidates = Array.from({ length: 255 }, (_, index) => candidate({ id: `pair-${index}` }));
  const cfg = config({ candidates });
  const probabilities = Object.fromEntries(candidates.map((item) => [item.id, 1 / candidates.length]));
  let calls = 0;
  const result = await route(
    routeInput(cfg, async (_state, questions) => {
      calls++;
      return validateEvaluation(selectedPairAnswer(probabilities), questions);
    }),
  );

  assert.equal(calls, 1);
  assert.equal(result.selected.candidate_id, 'pair-0');
});

test('256 enabled candidates fail before evaluator invocation', async () => {
  const candidates = Array.from({ length: 256 }, (_, index) => candidate({ id: `pair-${index}` }));
  let calls = 0;
  await assert.rejects(
    route(
      routeInput(config({ candidates }), async () => {
        calls++;
        return evaluation({});
      }),
    ),
    (error) => hasCode(error, 'invalid_config'),
  );
  assert.equal(calls, 0);
});

test('empty inventory and no enabled tools fail without selection', async () => {
  for (const cfg of [config({ candidates: [] }), config({ tools: [], candidates: [candidate()] })]) {
    await runSubcase('rejects empty enabled inventory', async () => {
      let calls = 0;
      await assert.rejects(
        route(
          routeInput(cfg, async () => {
            calls++;
            return evaluation({});
          }),
        ),
        (error) => hasCode(error, 'invalid_config'),
      );
      assert.equal(calls, 0);
    });
  }
});

test('disabled candidates are excluded without fallback or syntax validation', async () => {
  const disabled = candidate({ id: 'disabled', tool: 'codex', model: '--not-a-model' });
  const enabled = candidate({ id: 'enabled', tool: 'pi', quota_bucket: 'pi_codex', provider: 'openai-codex' });
  const cfg = config({ tools: ['pi'], candidates: [disabled, enabled] });
  let call: { state: unknown; questions: Questions } | undefined;
  const result = await route(
    routeInput(cfg, async (state, questions) => {
      call = { state, questions };
      return validateEvaluation(selectedPairAnswer({ enabled: 1 }), questions);
    }),
  );

  assert.ok(call !== undefined);
  const pairQuestion = call.questions['pair'];
  assert.ok(pairQuestion?.type === 'choice');
  assert.deepEqual(Object.keys(pairQuestion.criteria), ['enabled']);
  const pairState = call.state as { candidates: Candidate[] };
  assert.deepEqual(
    pairState.candidates.map((item) => item.id),
    ['enabled'],
  );
  assert.equal(result.selected.candidate_id, 'enabled');
});

test('empty levels and missing quota facts fail before evaluator invocation', async () => {
  await runSubcase('rejects raw candidate with no levels', async () => {
    const cfg = config({ candidates: [candidate({ thinking_levels: [] })] });
    let calls = 0;
    await assert.rejects(
      route(
        routeInput(cfg, async () => {
          calls++;
          return evaluation({});
        }),
      ),
      (error) => hasCode(error, 'invalid_config'),
    );
    assert.equal(calls, 0);
  });
  await runSubcase('rejects absent quota map entry', async () => {
    const cfg = config();
    let calls = 0;
    await assert.rejects(
      route(
        routeInput(
          cfg,
          async () => {
            calls++;
            return evaluation({});
          },
          new Map(),
        ),
      ),
      (error) => hasCode(error, 'invalid_config'),
    );
    assert.equal(calls, 0);
  });
});

test('unsupported syntax on any enabled candidate fails before evaluator call', async () => {
  const cfg = config({
    candidates: [candidate({ id: 'supported' }), candidate({ id: 'unsupported', model: '--unmappable' })],
  });
  let calls = 0;
  await assert.rejects(
    route(
      routeInput(cfg, async () => {
        calls++;
        return evaluation({});
      }),
    ),
    (error) => hasCode(error, 'invalid_config'),
  );
  assert.equal(calls, 0);
});

test('routing itself rejects an injected malformed first-stage unknown pair', async () => {
  let calls = 0;
  await assert.rejects(
    route(
      routeInput(config(), async () => {
        calls++;
        return evaluation({
          pair: {
            type: 'choice',
            choice: 'not-configured',
            probabilities: { 'codex-astra': 1 },
            confidence: 1,
          },
        });
      }),
    ),
    (error) => hasCode(error, 'invalid_response'),
  );
  assert.equal(calls, 1);
});

test('injected evaluator answers are revalidated at both route stages', async () => {
  await runSubcase('rejects an unknown pair selection', async () => {
    const cfg = config();
    await assert.rejects(
      route(
        routeInput(cfg, async (_state, questions) =>
          validateEvaluation(
            evaluation({
              pair: {
                type: 'choice',
                choice: 'not-configured',
                probabilities: { 'codex-astra': 1 },
                confidence: 1,
              },
            }),
            questions,
          ),
        ),
      ),
      (error) => hasCode(error, 'invalid_response'),
    );
  });
  await runSubcase('rejects an unknown effort selection', async () => {
    const cfg = config({
      candidates: [
        candidate({
          thinking_levels: [
            { id: 'low', description: 'Low' },
            { id: 'high', description: 'High' },
          ],
        }),
      ],
    });
    let calls = 0;
    await assert.rejects(
      route(
        routeInput(cfg, async (_state, questions) => {
          calls++;
          return calls === 1
            ? validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions)
            : evaluation({
                effort: {
                  type: 'choice',
                  choice: 'not-configured',
                  probabilities: { low: 1, high: 0 },
                  confidence: 1,
                },
              });
        }),
      ),
      (error) => hasCode(error, 'invalid_response'),
    );
    assert.equal(calls, 2);
  });
});

test('invalid second-stage response rejects instead of returning partial selection', async () => {
  const cfg = config({
    candidates: [
      candidate({
        thinking_levels: [
          { id: 'low', description: 'Low' },
          { id: 'high', description: 'High' },
        ],
      }),
    ],
  });
  let calls = 0;
  await assert.rejects(
    route(
      routeInput(cfg, async (_state, questions) => {
        calls++;
        return calls === 1
          ? validateEvaluation(selectedPairAnswer({ 'codex-astra': 1 }), questions)
          : evaluation({
              effort: {
                type: 'choice',
                choice: 'low',
                probabilities: { low: 0.7, high: 0.2 },
                confidence: 1,
              },
            });
      }),
    ),
    (error) => hasCode(error, 'invalid_response'),
  );
  assert.equal(calls, 2);
});

test('task and request ID must be nonempty', async () => {
  for (const input of [
    { task: '  ', requestId: 'route-1' },
    { task, requestId: '' },
  ]) {
    await runSubcase('rejects blank route input before evaluation', async () => {
      let calls = 0;
      await assert.rejects(
        route({
          ...routeInput(config(), async () => {
            calls++;
            return evaluation({});
          }),
          ...input,
        }),
        (error) => hasCode(error, 'invalid_input'),
      );
      assert.equal(calls, 0);
    });
  }
});

test('real evaluator rejects recognizable credentials in every routed field before posting', async () => {
  const secret = 'steward-test-key-9f4c2';
  const scenarios: [string, (cfg: Config) => { cfg: Config; task?: string }][] = [
    ['task', (cfg) => ({ cfg, task: `Review ${secret}` })],
    ['capability', (_cfg) => ({ cfg: config({ candidates: [candidate({ capabilities: `Uses ${secret}` })] }) })],
    ['candidate ID', (_cfg) => ({ cfg: config({ candidates: [candidate({ id: `key=${secret}` })] }) })],
    [
      'unchosen effort description',
      (_cfg) => ({
        cfg: config({
          candidates: [
            candidate({
              thinking_levels: [
                { id: 'low', description: 'Low' },
                { id: 'high', description: `High ${secret}` },
              ],
            }),
          ],
        }),
      }),
    ],
    [
      'selected effort description',
      (_cfg) => ({
        cfg: config({
          candidates: [
            candidate({
              thinking_levels: [
                { id: 'low', description: `Low ${secret}` },
                { id: 'high', description: 'High' },
              ],
            }),
          ],
        }),
      }),
    ],
  ];

  for (const [label, setup] of scenarios) {
    await runSubcase(label, async () => {
      const original = config();
      const { cfg, task: routedTask = task } = setup(original);
      const { post, requests } = recordingPost();
      const evaluate = makeEvaluator({ model: 'jev-1.13.0', apiKey: secret, post });
      await assert.rejects(
        route({ ...routeInput(cfg, evaluate), task: routedTask }),
        (error) => hasCode(error, 'credential_detected') && !error.message.includes(secret),
      );
      assert.equal(requests.length, 0);
      assert.equal(JSON.stringify(requests).includes(secret), false);
    });
  }
});

test('real evaluator stage-two timeout aborts atomically without a partial route', async () => {
  const cfg = config({
    candidates: [
      candidate({
        thinking_levels: [
          { id: 'low', description: 'Low' },
          { id: 'high', description: 'High' },
        ],
      }),
    ],
  });
  const deadlines: { milliseconds: number; controller: AbortController }[] = [];
  let resolveSecondStarted: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStarted = resolve;
  });
  let calls = 0;
  let returned = false;
  const upstreamFailure = 'synthetic-upstream-and-request-body-marker';
  spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  const evaluate = makeEvaluator({
    model: 'jev-1.13.0',
    apiKey: 'unit-key-not-live',
    post: (request) => {
      calls++;
      if (calls === 1)
        return Promise.resolve({
          status: 200,
          body: JSON.stringify(evaluation({ pair: choice({ 'codex-astra': 1 }) })),
        });
      if (resolveSecondStarted === undefined) throw new Error('second evaluation signal is not ready');
      resolveSecondStarted();
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error(`${upstreamFailure}:${request.body}`)), {
          once: true,
        });
      });
    },
  });

  const pending = route(routeInput(cfg, evaluate)).then((value) => {
    returned = true;
    return value;
  });
  await secondStarted;
  assert.equal(calls, 2);
  assert.deepEqual(
    deadlines.map((deadline) => deadline.milliseconds),
    [30_000, 30_000],
  );
  const secondDeadline = deadlines[1];
  assert.ok(secondDeadline !== undefined);
  secondDeadline.controller.abort();
  await assert.rejects(
    pending,
    (error) =>
      hasCode(error, 'evaluation_failed') &&
      !error.message.includes(upstreamFailure) &&
      !error.message.includes('unit-key-not-live'),
  );
  assert.equal(returned, false);
});

test('real evaluator rejects a planted credential in an effort-stage payload locally', async () => {
  const secret = 'steward-test-key-9f4c2';
  const { post, requests } = recordingPost();
  const evaluate = makeEvaluator({ model: 'jev-1.13.0', apiKey: secret, post });
  const state = {
    task,
    candidate: candidate({
      thinking_levels: [
        { id: 'low', description: `Low ${secret}` },
        { id: 'high', description: 'High' },
      ],
    }),
    quota: quotaFacts(candidate()),
  };
  await assert.rejects(
    evaluate(state, {
      effort: {
        type: 'choice',
        instructions: 'Choose a supplied level.',
        criteria: { low: null, high: null },
      },
    }),
    (error) => hasCode(error, 'credential_detected') && !error.message.includes(secret),
  );
  assert.equal(requests.length, 0);
  assert.equal(JSON.stringify(requests).includes(secret), false);
});
