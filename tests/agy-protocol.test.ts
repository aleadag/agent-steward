import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAgyProtocol } from '../src/agy-protocol.ts';
import { agyQuota } from './agy-helpers.ts';
const prompt = '\n> Accept-edits mode: file edits auto-approved\n';
const suggestion = '\n> /usage  View model quota usage\n';
const panel = '\n└ Models & Quota\nGEMINI MODELS\nCLAUDE AND GPT MODELS\nesc Close\n';
const start = Date.parse('2026-10-02T12:00:00Z');
function fixture() {
  let time = start;
  const machine = createAgyProtocol('request-a', () => new Date(time));
  return {
    machine,
    tick: () => {
      time += 10;
    },
    terminal: (s: string) => machine.accept({ kind: 'terminal', bytes: Buffer.from(s) }),
    capture: (requestId = 'request-a', observedAt = new Date(time).toISOString()) =>
      machine.accept({ kind: 'capture', observation: { requestId, observedAt, quota: agyQuota() } }),
  };
}
test('native /usage is submitted only after recognition and completed only with refreshed panel and capture', () => {
  const f = fixture();
  assert.deepEqual(f.capture(), []);
  assert.deepEqual(f.terminal(prompt), [{ kind: 'write', text: '/usage' }]);
  assert.deepEqual(f.capture(), []);
  assert.deepEqual(f.terminal(suggestion), [{ kind: 'write', text: '\r' }]);
  f.tick();
  assert.deepEqual(f.capture(), []);
  assert.equal(f.machine.result(), null);
  assert.deepEqual(f.terminal(panel), [{ kind: 'write', text: '\x1b' }, { kind: 'stop' }]);
  const result = f.machine.result();
  assert.ok(result && 'observation' in result);
  assert.equal(result.observation.requestId, 'request-a');
});
test('stale, wrong-request, pre-submit and future observations cannot complete refresh', () => {
  for (const [request, time] of [
    ['old', start + 10],
    ['request-a', start],
    ['request-a', start + 1000],
  ] as const) {
    const f = fixture();
    f.terminal(prompt);
    f.terminal(suggestion);
    f.tick();
    f.capture(request, new Date(time).toISOString());
    f.terminal(panel);
    assert.equal(f.machine.result(), null);
    f.machine.accept({ kind: 'deadline' });
    const result = f.machine.result();
    assert.ok(result && 'status' in result);
    assert.equal(result.status, 'fetch');
    f.capture();
    assert.deepEqual(f.machine.result(), result);
  }
});
test('trust/login/settings/refresh errors never receive approval input', () => {
  for (const [screen, status, diagnostic] of [
    ['Do you trust the contents of this project?', 'fetch', 'quota_agy_trust'],
    ['Select login method:', 'auth', undefined],
    ['paste the authorization code', 'auth', undefined],
    ['Settings Error', 'fetch', undefined],
    ['Failed to refresh quota', 'fetch', undefined],
  ] as const) {
    const f = fixture();
    assert.deepEqual(f.terminal(screen), [{ kind: 'stop' }]);
    assert.deepEqual(f.machine.result(), { status, ...(diagnostic ? { diagnostic } : {}) });
    assert.deepEqual(f.terminal(prompt), []);
  }
});
test('unknown slash commands, initial cache, panel alone and early exit fail closed', () => {
  const f = fixture();
  assert.deepEqual(f.terminal('READY'), []);
  assert.deepEqual(f.terminal(prompt), [{ kind: 'write', text: '/usage' }]);
  assert.deepEqual(f.terminal('\n/usage unknown command'), [{ kind: 'stop' }]);
  const cache = fixture();
  cache.capture();
  cache.terminal(prompt);
  cache.terminal(suggestion);
  cache.terminal(panel);
  assert.equal(cache.machine.result(), null);
  cache.machine.accept({ kind: 'exit', code: 0 });
  assert.deepEqual(cache.machine.result(), { status: 'fetch' });
});
test('markers, ANSI, OSC and UTF-8 can split across any byte boundary; loading is not login', () => {
  const stream = Buffer.from('\x1b]0;title\x07Signing in...\x1b[32m' + prompt + '\x1b[0m');
  for (let split = 0; split <= stream.length; split++) {
    const f = fixture();
    const actions = [
      ...f.machine.accept({ kind: 'terminal', bytes: stream.subarray(0, split) }),
      ...f.machine.accept({ kind: 'terminal', bytes: stream.subarray(split) }),
    ];
    assert.deepEqual(actions, [{ kind: 'write', text: '/usage' }]);
  }
  const f = fixture();
  f.terminal(prompt);
  for (const b of Buffer.from(suggestion)) f.machine.accept({ kind: 'terminal', bytes: Uint8Array.of(b) });
  f.tick();
  f.capture();
  let actions: unknown[] = [];
  for (const b of Buffer.from(panel)) actions.push(...f.machine.accept({ kind: 'terminal', bytes: Uint8Array.of(b) }));
  assert.deepEqual(actions, [{ kind: 'write', text: '\x1b' }, { kind: 'stop' }]);
});
test('terminal output cap stops without retaining an unbounded transcript', () => {
  const f = fixture();
  assert.deepEqual(f.machine.accept({ kind: 'terminal', bytes: new Uint8Array(1048577) }), [{ kind: 'stop' }]);
  assert.deepEqual(f.machine.result(), { status: 'fetch' });
});
