import { afterEach, mock, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as main from '../src/main.ts';

afterEach(() => mock.restore());

const URL = 'https://chatgpt.com/backend-api/wham/usage';
const headers = { Authorization: 'Bearer synthetic-secret', Accept: 'application/json' };
type Reply = { status?: number; location?: string; chunks?: Buffer[]; hang?: boolean; error?: boolean };

function transport(replies: Reply[]) {
  const calls: { url: string; options: RequestOptions; request: ClientRequest; response: PassThrough }[] = [];
  const implementation = (
    url: string | globalThis.URL,
    options: RequestOptions,
    callback: (r: IncomingMessage) => void,
  ) => {
    const reply = replies[calls.length];
    assert.ok(reply, 'unexpected extra request');
    const response = Object.assign(new PassThrough(), {
      statusCode: reply.status ?? 200,
      headers: reply.location === undefined ? {} : { location: reply.location },
    });
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true;
        return this;
      },
      end() {
        queueMicrotask(() => {
          if (reply.error) {
            request.emit('error', new Error('private upstream failure'));
            return;
          }
          callback(response as unknown as IncomingMessage);
          if (!reply.hang && !response.destroyed) {
            for (const chunk of reply.chunks ?? [Buffer.from('{}')]) response.write(chunk);
            response.end();
          }
        });
        return this;
      },
    }) as unknown as ClientRequest;
    calls.push({ url: String(url), options, request, response });
    return request;
  };
  spyOn(https, 'request').mockImplementation(implementation as unknown as typeof https.request);
  return calls;
}

test('quota HTTPS GET preserves headers and accepts exactly 1 MiB', async () => {
  const calls = transport([{ chunks: [Buffer.alloc(1_048_576, 'a')] }]);
  const result = await main.httpGet(URL, headers);
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1_048_576);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, URL);
  assert.equal(calls[0]!.options.method, 'GET');
  assert.deepEqual(calls[0]!.options.headers, headers);
});

test('quota HTTPS GET bounds bytes, rejects broken streams and does not retry', async () => {
  for (const reply of [
    { chunks: [Buffer.alloc(1_048_576), Buffer.from('x')] },
    { chunks: [Buffer.from([0xff])] },
    { error: true },
  ]) {
    const calls = transport([reply]);
    await assert.rejects(main.httpGet(URL, headers));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.request.destroyed);
    mock.restore();
  }
});

test('quota HTTPS GET follows one relative or absolute same-host redirect', async () => {
  for (const location of ['/usage', 'https://chatgpt.com/usage']) {
    const calls = transport([{ status: 302, location }, { chunks: [Buffer.from('{"ok":true}')] }]);
    assert.deepEqual(await main.httpGet(URL, headers), { status: 200, body: '{"ok":true}' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, 'https://chatgpt.com/usage');
    assert.deepEqual(calls[1]!.options.headers, headers);
    assert.ok(calls[0]!.response.destroyed);
    mock.restore();
  }
});

test('quota HTTPS GET rejects unsafe redirects before forwarding credentials', async () => {
  for (const location of [
    'https://other.example/usage',
    'https://chatgpt.com:444/usage',
    'http://chatgpt.com/usage',
    'https://user:pass@chatgpt.com/usage',
    undefined,
  ]) {
    const calls = transport([{ status: 302, ...(location === undefined ? {} : { location }) }]);
    await assert.rejects(main.httpGet(URL, headers));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.response.destroyed);
    mock.restore();
  }
  const calls = transport([
    { status: 307, location: '/one' },
    { status: 308, location: '/two' },
  ]);
  await assert.rejects(main.httpGet(URL, headers));
  assert.equal(calls.length, 2);
});

test('quota HTTPS GET refuses non-HTTPS before a request and drops non-200 bodies', async () => {
  const calls = transport([{ status: 401, chunks: [Buffer.from('private provider error')] }]);
  await assert.rejects(main.httpGet('http://chatgpt.com/usage', headers));
  assert.equal(calls.length, 0);
  assert.deepEqual(await main.httpGet(URL, headers), { status: 401, body: '' });
  assert.ok(calls[0]!.response.destroyed);
});

test('quota HTTPS GET uses one 15-second deadline across redirects and aborts the reader', async () => {
  const controller = new AbortController();
  const deadlines: number[] = [];
  spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    deadlines.push(ms);
    return controller.signal;
  });
  const calls = transport([{ status: 301, location: '/redirect' }, { hang: true }]);
  const pending = main.httpGet(URL, headers);
  // Let both request callbacks and the redirect continuation run, without a real timer.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls.length, 2);
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(deadlines, [15_000]);
  assert.ok(calls[1]!.request.destroyed);
  assert.ok(calls[1]!.response.destroyed);
});
