import https from 'node:https';
import type { ClientRequest } from 'node:http';
import type { Evaluation } from './contracts.js';
import { EvaluationSchema, StewardError } from './contracts.js';
import { assertByteLength, assertJsonDepth, LimitError } from './limits.js';
import { readBoundedUtf8 } from './io.js';
import { assertNoCredentials } from './privacy.js';

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
export type { ChoiceAnswer, NoulAnswer, Evaluation } from './contracts.js';
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
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
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
    if (id.trim().length === 0 || !isRecord(question) || typeof question.instructions !== 'string' || question.instructions.trim().length === 0) {
      throw new StewardError('invalid_input');
    }
    if (question.type === 'choice') {
      if (!exactKeys(question, ['type', 'instructions', 'criteria']) || !isRecord(question.criteria)) throw new StewardError('invalid_input');
      const options = Object.keys(question.criteria);
      if (options.length === 0 || options.length > 255 || options.some(option => option.trim().length === 0)) throw new StewardError('invalid_input');
      for (const option of options) {
        const description = question.criteria[option];
        if (description !== null && typeof description !== 'string') throw new StewardError('invalid_input');
      }
    } else if (question.type === 'noul') {
      if (!exactKeys(question, Object.hasOwn(question, 'criteria')
        ? ['type', 'instructions', 'criteria']
        : ['type', 'instructions'])) throw new StewardError('invalid_input');
      if (Object.hasOwn(question, 'criteria')) {
        if (!isRecord(question.criteria) || Object.keys(question.criteria).some(key => key !== 'true' && key !== 'false')) {
          throw new StewardError('invalid_input');
        }
        if (Object.values(question.criteria).some(item => typeof item !== 'string')) throw new StewardError('invalid_input');
      }
    } else {
      throw new StewardError('invalid_input');
    }
  }
}

function invalidResponse(): StewardError {
  return new StewardError('invalid_response');
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const [significand = '0', exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole = '0', fraction = ''] = significand.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length - exponent };
}

function choiceSumWithinTolerance(values: readonly number[]): boolean {
  // Sum canonical decimal spellings exactly, keeping decimal boundary values inside the specified tolerance.
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map(part => part.scale));
  const total = parts.reduce((sum, part) =>
    sum + part.coefficient * 10n ** BigInt(scale - part.scale), 0n);
  const unit = 10n ** BigInt(scale);
  const difference = total >= unit ? total - unit : unit - total;
  return difference * 1_000_000n <= unit;
}

export function validateEvaluation(raw: unknown, questions: Questions): Evaluation {
  try {
    assertJsonDepth(raw);
  } catch {
    throw invalidResponse();
  }
  assertQuestions(questions);

  const parsed = EvaluationSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();

  const expectedAnswers = Object.keys(questions);
  if (!exactKeys(parsed.data.answers, expectedAnswers)) throw invalidResponse();

  for (const id of expectedAnswers) {
    const question = questions[id];
    const answer = parsed.data.answers[id];
    if (question === undefined || answer === undefined) throw invalidResponse();
    if (question.type === 'noul') {
      if (answer.type !== 'noul') throw invalidResponse();
      continue;
    }
    if (answer.type !== 'choice') throw invalidResponse();

    const options = Object.keys(question.criteria);
    if (!exactKeys(answer.probabilities, options)) throw invalidResponse();
    const probabilities = Object.values(answer.probabilities);
    if (!choiceSumWithinTolerance(probabilities)) throw invalidResponse();
    const maximum = Math.max(...probabilities);
    if (!Object.hasOwn(answer.probabilities, answer.choice) || answer.probabilities[answer.choice] !== maximum) {
      throw invalidResponse();
    }
  }
  return parsed.data;
}

export function choiceWinner(answer: import('./contracts.js').ChoiceAnswer, order: readonly string[]): {
  winner: string;
  tied: boolean;
} {
  const probabilities = Object.values(answer.probabilities);
  if (probabilities.length === 0) throw invalidResponse();
  const maximum = Math.max(...probabilities);
  const maxima = Object.keys(answer.probabilities).filter(key => answer.probabilities[key] === maximum);
  const winner = order.find(key => Object.hasOwn(answer.probabilities, key) && answer.probabilities[key] === maximum);
  if (winner === undefined) throw invalidResponse();
  return { winner, tied: maxima.length > 1 };
}

function mapInputError(error: unknown): never {
  if (error instanceof StewardError) throw error;
  throw new StewardError('invalid_input');
}

export function makeEvaluator(options: { model: string; apiKey: string; post: HttpPost }): Evaluate {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) throw new StewardError('missing_credentials');

  return async (state, questions) => {
    let body: string;
    const wire = { model: options.model, state, questions };
    try {
      assertJsonDepth(wire);
      assertJsonValue(wire);
      assertQuestions(questions);
      assertNoCredentials(wire, options.apiKey);
      const serialized = JSON.stringify(wire);
      if (serialized === undefined) throw new StewardError('invalid_input');
      assertByteLength(serialized);
      body = serialized;
    } catch (error) {
      if (error instanceof LimitError) throw new StewardError('invalid_input');
      mapInputError(error);
    }

    let response: { status: number; body: string };
    try {
      response = await options.post({
        url: 'https://api.typesafe.ai/v1/systemone',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof StewardError && error.code === 'invalid_response') throw error;
      throw new StewardError('evaluation_failed');
    }

    if (response.status < 200 || response.status >= 300) throw new StewardError('evaluation_failed');
    if (typeof response.body !== 'string') throw invalidResponse();

    let parsed: unknown;
    try {
      assertByteLength(response.body);
      parsed = JSON.parse(response.body);
      assertJsonDepth(parsed);
    } catch {
      throw invalidResponse();
    }
    return validateEvaluation(parsed, questions);
  };
}

export function postHttps(request: Parameters<HttpPost>[0]): ReturnType<HttpPost> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new StewardError('evaluation_failed'));
      return;
    }

    let clientRequest: ClientRequest;
    let responseStream: NodeJS.ReadableStream & { destroy: (error?: Error) => void } | undefined;
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
      clientRequest = https.request(request.url, {
        method: 'POST',
        headers: request.headers,
        signal: request.signal,
      }, response => {
        responseStream = response;
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          finish(undefined, { status, body: '' });
          return;
        }
        readBoundedUtf8(response).then(body => finish(undefined, { status, body }), error => {
          const invalidBody = error instanceof LimitError || error instanceof TypeError;
          if (!clientRequest.destroyed) clientRequest.destroy();
          if (!response.destroyed) response.destroy();
          finish(new StewardError(invalidBody ? 'invalid_response' : 'evaluation_failed'));
        });
      });
      clientRequest.once('error', onRequestError);
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      else clientRequest.end(request.body);
    } catch {
      finish(new StewardError('evaluation_failed'));
    }
  });
}
