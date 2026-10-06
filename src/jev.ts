import https from 'node:https';
import type { ClientRequest } from 'node:http';
import type { Evaluation, FailureDiagnostics } from './contracts.ts';
import { EvaluationSchema, StewardError } from './contracts.ts';
import { assertByteLength, assertJsonDepth, LimitError } from './limits.ts';
import { readBoundedUtf8 } from './io.ts';
import { z } from 'zod';
import { assertNoCredentials } from './privacy.ts';
import type { CredentialKeys } from './privacy.ts';

const OpenRouterEvaluationSchema = EvaluationSchema.extend({
  id: z.string().optional(),
  provider: z.string().optional(),
  usage: EvaluationSchema.shape.usage.extend({ cost: z.number().finite().min(0).optional() }),
}).transform(({ id: _id, provider: _provider, usage: { cost: _cost, ...usage }, ...evaluation }) => ({
  ...evaluation,
  usage,
}));

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
};
export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type Question = ChoiceQuestion | NoulQuestion;
export type Questions = Record<string, Question>;
export type { ChoiceAnswer, NoulAnswer, Evaluation } from './contracts.ts';
export type Evaluate = (state: unknown, questions: Questions) => Promise<Evaluation>;
export type HttpPost = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; body: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function assertJsonValue(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new StewardError('invalid_input');
      continue;
    }
    if (typeof current !== 'object') throw new StewardError('invalid_input');
    if (Object.getOwnPropertySymbols(current).length > 0) throw new StewardError('invalid_input');
    if (Array.isArray(current)) {
      if (Object.keys(current).length !== current.length) throw new StewardError('invalid_input');
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new StewardError('invalid_input');
        pending.push(descriptor.value);
      }
      continue;
    }
    if (!isRecord(current)) throw new StewardError('invalid_input');
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new StewardError('invalid_input');
      pending.push(descriptor.value);
    }
  }
}

function assertQuestions(value: unknown): asserts value is Questions {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new StewardError('invalid_input');
  for (const [id, question] of Object.entries(value)) {
    if (
      id.trim().length === 0 ||
      !isRecord(question) ||
      typeof question.instructions !== 'string' ||
      question.instructions.trim().length === 0
    ) {
      throw new StewardError('invalid_input');
    }
    if (question.type === 'choice') {
      if (!exactKeys(question, ['type', 'instructions', 'criteria']) || !isRecord(question.criteria))
        throw new StewardError('invalid_input');
      const options = Object.keys(question.criteria);
      if (options.length === 0 || options.length > 255 || options.some((option) => option.trim().length === 0))
        throw new StewardError('invalid_input');
      for (const option of options) {
        const description = question.criteria[option];
        if (description !== null && typeof description !== 'string') throw new StewardError('invalid_input');
      }
    } else if (question.type === 'noul') {
      if (
        !exactKeys(
          question,
          Object.hasOwn(question, 'criteria') ? ['type', 'instructions', 'criteria'] : ['type', 'instructions'],
        )
      )
        throw new StewardError('invalid_input');
      if (Object.hasOwn(question, 'criteria')) {
        if (
          !isRecord(question.criteria) ||
          Object.keys(question.criteria).some((key) => key !== 'true' && key !== 'false')
        ) {
          throw new StewardError('invalid_input');
        }
        if (Object.values(question.criteria).some((item) => typeof item !== 'string'))
          throw new StewardError('invalid_input');
      }
    } else {
      throw new StewardError('invalid_input');
    }
  }
}

function invalidResponse(
  kind: FailureDiagnostics['kind'] = 'schema',
  details?: FailureDiagnostics['details'],
): StewardError {
  return new StewardError('invalid_response', {
    stage: 'response',
    kind,
    ...(details === undefined ? {} : { details }),
  });
}

function keyMismatchDetails(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return {
    expected: expected.length,
    actual: keys.length,
    missing_count: expected.filter((key) => !Object.hasOwn(value, key)).length,
    extra_count: keys.filter((key) => !expected.includes(key)).length,
  };
}

export function validateEvaluation(raw: unknown, questions: Questions): Evaluation {
  try {
    assertJsonDepth(raw);
  } catch {
    throw invalidResponse('depth_limit');
  }
  assertQuestions(questions);

  const parsed = EvaluationSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();

  const expectedAnswers = Object.keys(questions);
  if (!exactKeys(parsed.data.answers, expectedAnswers))
    throw invalidResponse('answer_ids', keyMismatchDetails(parsed.data.answers, expectedAnswers));

  for (const [questionIndex, id] of expectedAnswers.entries()) {
    const question = questions[id];
    const answer = parsed.data.answers[id];
    if (question === undefined || answer === undefined) throw invalidResponse('answer_ids');
    const context = { question_index: questionIndex };
    if (question.type === 'noul') {
      if (answer.type !== 'noul') throw invalidResponse('answer_type', { ...context, expected: false, actual: true });
      continue;
    }
    if (answer.type !== 'choice') throw invalidResponse('answer_type', { ...context, expected: true, actual: false });

    const options = Object.keys(question.criteria);
    if (!exactKeys(answer.probabilities, options))
      throw invalidResponse('choice_options', { ...context, ...keyMismatchDetails(answer.probabilities, options) });
    const probabilities = Object.values(answer.probabilities);
    const maximum = Math.max(...probabilities);
    if (maximum === 0) throw invalidResponse('schema', { ...context, option_count: options.length });
    const choicePresent = Object.hasOwn(answer.probabilities, answer.choice);
    if (!choicePresent) {
      throw invalidResponse('choice_mismatch', {
        ...context,
        expected: maximum,
        actual: null,
        choice_present: false,
        option_count: options.length,
        maximum_count: probabilities.filter((value) => value === maximum).length,
      });
    }
  }
  return parsed.data;
}

export function choiceWinner(
  answer: import('./contracts.ts').ChoiceAnswer,
  _order: readonly string[],
): {
  winner: string;
  tied: boolean;
} {
  const probabilities = Object.values(answer.probabilities);
  if (probabilities.length === 0) throw invalidResponse();
  const maximum = Math.max(...probabilities);
  const maxima = Object.keys(answer.probabilities).filter((key) => answer.probabilities[key] === maximum);
  if (!Object.hasOwn(answer.probabilities, answer.choice)) throw invalidResponse();
  return { winner: answer.choice, tied: maxima.length > 1 };
}

export function labeledChoiceMismatch(
  answer: import('./contracts.ts').ChoiceAnswer,
  evaluationIndex: number,
  questionIndex = 0,
): FailureDiagnostics | undefined {
  const probabilities = Object.values(answer.probabilities);
  if (probabilities.length === 0 || !Object.hasOwn(answer.probabilities, answer.choice)) return undefined;
  const maximum = Math.max(...probabilities);
  const actual = answer.probabilities[answer.choice]!;
  if (actual === maximum) return undefined;
  return {
    stage: 'response',
    kind: 'choice_mismatch',
    details: {
      evaluation_index: evaluationIndex,
      question_index: questionIndex,
      expected: maximum,
      actual,
      choice_present: true,
      option_count: probabilities.length,
      maximum_count: probabilities.filter((value) => value === maximum).length,
    },
  };
}

function mapInputError(error: unknown): never {
  if (error instanceof StewardError) throw error;
  throw new StewardError('invalid_input');
}

export function makeEvaluator(options: {
  model: string;
  provider?: 'typesafe' | 'openrouter';
  apiKey: string;
  credentialKeys?: CredentialKeys;
  post: HttpPost;
}): Evaluate {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0)
    throw new StewardError('missing_credentials', { stage: 'credentials' });

  let evaluationIndex = 0;
  return async (state, questions) => {
    let body: string;
    const wire = { model: options.model, state, questions };
    try {
      assertJsonDepth(wire);
      assertJsonValue(wire);
      assertQuestions(questions);
      assertNoCredentials(wire, options.credentialKeys ?? options.apiKey);
      const serialized = JSON.stringify(wire);
      if (serialized === undefined) throw new StewardError('invalid_input');
      assertByteLength(serialized);
      body = serialized;
    } catch (error) {
      if (error instanceof LimitError) throw new StewardError('invalid_input');
      mapInputError(error);
    }

    const index = evaluationIndex++;
    const started = performance.now();
    const signal = AbortSignal.timeout(30_000);
    const duration = (): number => Math.max(0, Math.round(performance.now() - started));
    let response: { status: number; body: string };
    try {
      response = await options.post({
        url:
          options.provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1/systemone'
            : 'https://api.typesafe.ai/v1/systemone',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body,
        signal,
      });
    } catch (error) {
      const invalid = error instanceof StewardError && error.code === 'invalid_response';
      throw new StewardError(invalid ? 'invalid_response' : 'evaluation_failed', {
        stage: invalid ? 'response' : 'evaluation',
        ...(invalid ? error.diagnostics : {}),
        ...(!invalid ? ({ kind: signal.aborted ? 'timeout' : 'network' } as const) : {}),
        details: { ...(invalid ? error.diagnostics?.details : {}), evaluation_index: index },
        duration_ms: duration(),
      });
    }

    const timing = {
      duration_ms: duration(),
      ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
        ? { http_status: response.status }
        : {}),
    };
    if (response.status < 200 || response.status >= 300)
      throw new StewardError('evaluation_failed', {
        stage: 'evaluation',
        kind: 'http',
        details: { evaluation_index: index },
        ...timing,
      });

    let kind: FailureDiagnostics['kind'] = 'schema';
    try {
      if (typeof response.body !== 'string') throw invalidResponse();
      kind = 'size_limit';
      assertByteLength(response.body);
      kind = 'json';
      const parsed: unknown = JSON.parse(response.body);
      kind = 'depth_limit';
      assertJsonDepth(parsed);
      kind = 'schema';
      const evaluation = validateEvaluation(
        options.provider === 'openrouter' ? OpenRouterEvaluationSchema.parse(parsed) : parsed,
        questions,
      );
      assertNoCredentials(parsed, options.credentialKeys ?? options.apiKey);
      return evaluation;
    } catch (error) {
      if (error instanceof StewardError && error.code === 'credential_detected') throw error;
      throw new StewardError('invalid_response', {
        stage: 'response',
        kind:
          error instanceof StewardError && error.code === 'invalid_response' ? (error.diagnostics?.kind ?? kind) : kind,
        details: {
          ...(error instanceof StewardError && error.code === 'invalid_response' ? error.diagnostics?.details : {}),
          evaluation_index: index,
        },
        ...timing,
      });
    }
  };
}

export function postHttps(request: Parameters<HttpPost>[0]): ReturnType<HttpPost> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new StewardError('evaluation_failed'));
      return;
    }

    let clientRequest: ClientRequest;
    let responseStream: (NodeJS.ReadableStream & { destroy: (error?: Error) => void }) | undefined;
    let settled = false;
    const finish = (error?: StewardError, value?: { status: number; body: string }): void => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const onAbort = (): void => {
      responseStream?.destroy();
      clientRequest.destroy();
      finish(new StewardError('evaluation_failed'));
    };
    const onRequestError = (): void => {
      responseStream?.destroy();
      finish(new StewardError('evaluation_failed'));
    };

    try {
      clientRequest = https.request(
        request.url,
        {
          method: 'POST',
          headers: request.headers,
          signal: request.signal,
        },
        (response) => {
          responseStream = response;
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            response.destroy();
            finish(undefined, { status, body: '' });
            return;
          }
          readBoundedUtf8(response).then(
            (body) => finish(undefined, { status, body }),
            (error) => {
              const invalidBody = error instanceof LimitError || error instanceof TypeError;
              if (!clientRequest.destroyed) clientRequest.destroy();
              if (!response.destroyed) response.destroy();
              finish(
                invalidBody
                  ? invalidResponse(error instanceof LimitError ? 'size_limit' : 'json')
                  : new StewardError('evaluation_failed'),
              );
            },
          );
        },
      );
      clientRequest.once('error', onRequestError);
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      else clientRequest.end(request.body);
    } catch {
      finish(new StewardError('evaluation_failed'));
    }
  });
}
