import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { runAgyHook } from '../src/agy-hook.ts';
import type { AgyCapture, AgyHookIO } from '../src/agy-hook.ts';
import { agyObserved, agyQuota } from './agy-helpers.ts';

function hookIO(overrides: Partial<AgyHookIO> = {}) {
  const captures: AgyCapture[] = [];
  const rendererInputs: string[] = [];
  const io: AgyHookIO = {
    now: () => new Date(agyObserved),
    readManifest: async () => ({
      schema_version: 1,
      previousStatusLine: { type: 'command', command: '/old/render' },
      installedCommand: '/steward',
    }),
    captureRequest: { requestId: 'request-a', socketPath: '/private/s' },
    sendCapture: async (_r, v) => {
      captures.push(v);
    },
    runRenderer: async (_c, input) => {
      rendererInputs.push(input);
      return { stdout: 'old display\n', exitCode: 0 };
    },
    ...overrides,
  };
  return { io, captures, rendererInputs };
}
test('hook captures whitelisted quota while preserving original renderer bytes', async () => {
  const { io, captures, rendererInputs } = hookIO();
  const input =
    '  ' +
    JSON.stringify({
      quota: agyQuota(),
      email: 'synthetic-secret',
      model: { id: 'synthetic-secret' },
      context_window: { secret: 'synthetic-secret' },
    }) +
    '\n';
  assert.deepEqual(await runAgyHook(input, io), { stdout: 'old display\n', exitCode: 0 });
  assert.deepEqual(rendererInputs, [input]);
  assert.deepEqual(captures, [{ requestId: 'request-a', observedAt: agyObserved, quota: agyQuota() }]);
  assert.equal(JSON.stringify(captures).includes('synthetic-secret'), false);
});
test('normal sessions render without passive captures', async () => {
  const { io, captures, rendererInputs } = hookIO({ captureRequest: null });
  const input = JSON.stringify({ quota: agyQuota() });
  await runAgyHook(input, io);
  assert.equal(captures.length, 0);
  assert.deepEqual(rendererInputs, [input]);
});
test('malformed JSON, excessive depth and capture failure do not suppress admitted renderer input', async () => {
  for (const input of [
    '{',
    JSON.stringify({ nested: Array.from({ length: 70 }).reduce((v) => [v], [] as unknown[]) }),
  ]) {
    const { io, captures, rendererInputs } = hookIO();
    await runAgyHook(input, io);
    assert.equal(captures.length, 0);
    assert.deepEqual(rendererInputs, [input]);
  }
  const { io, rendererInputs } = hookIO({
    sendCapture: async () => {
      throw new Error('secret');
    },
  });
  const input = JSON.stringify({ quota: agyQuota() });
  assert.equal((await runAgyHook(input, io)).stdout, 'old display\n');
  assert.deepEqual(rendererInputs, [input]);
});
test('absent/disabled renderer stays absent/disabled and upstream errors are not output', async () => {
  for (const previous of [null, { type: 'command' as const, command: '/old/render', enabled: false }]) {
    const { io, rendererInputs } = hookIO({
      readManifest: async () => ({ schema_version: 1, previousStatusLine: previous, installedCommand: '/steward' }),
    });
    assert.deepEqual(await runAgyHook('{}', io), { stdout: '', exitCode: 0 });
    assert.equal(rendererInputs.length, 0);
  }
  const { io } = hookIO({
    runRenderer: async () => {
      throw new Error('private-command');
    },
  });
  assert.deepEqual(await runAgyHook('{}', io), { stdout: '', exitCode: 1 });
});
test('over-cap input is refused and renderer exit status is preserved', async () => {
  const { io, rendererInputs } = hookIO();
  assert.deepEqual(await runAgyHook('x'.repeat(1048577), io), { stdout: '', exitCode: 1 });
  assert.equal(rendererInputs.length, 0);
  const { io: nonzero } = hookIO({ runRenderer: async () => ({ stdout: 'old error display', exitCode: 7 }) });
  assert.deepEqual(await runAgyHook('{}', nonzero), { stdout: 'old error display', exitCode: 7 });
});
