import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { assertByteLength, assertJsonDepth, MAX_JSON_BYTES } from '../src/limits.ts';

test('UTF-8 byte and container-depth limits are exact', () => {
  assert.doesNotThrow(() => assertByteLength('a'.repeat(MAX_JSON_BYTES)));
  assert.throws(() => assertByteLength('a'.repeat(MAX_JSON_BYTES + 1)));
  assert.throws(() => assertByteLength('é'.repeat(MAX_JSON_BYTES / 2 + 1)));
  assert.doesNotThrow(() => assertByteLength(new Uint8Array(MAX_JSON_BYTES)));
  assert.throws(() => assertByteLength(new Uint8Array(MAX_JSON_BYTES + 1)));

  let value: unknown = null;
  for (let i = 0; i < 64; i++) value = [value];
  assert.doesNotThrow(() => assertJsonDepth(value));
  assert.throws(() => assertJsonDepth([value]));

  const shared: { self?: unknown } = {};
  assert.doesNotThrow(() => assertJsonDepth([shared, shared]));
  shared.self = shared;
  assert.throws(() => assertJsonDepth(shared));
});

test('only nested object and array containers count toward depth', () => {
  assert.doesNotThrow(() => assertJsonDepth({ a: { b: 1 }, c: [true, null] }));
  assert.doesNotThrow(() => assertJsonDepth('scalar'));
  assert.doesNotThrow(() => assertJsonDepth(null));
});
