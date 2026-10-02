import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mapAgyQuota } from '../src/agy-quota.ts';
import { agyObserved, agyQuota } from './agy-helpers.ts';

test('finite fractional reset seconds are a valid bounded fallback', () => {
  const quota = agyQuota();
  quota['gemini-5h'] = { remaining_fraction: 0.5, reset_in_seconds: 60.25 };
  const result = mapAgyQuota(quota, agyObserved);
  assert.ok('windows' in result);
  assert.equal(result.windows[0]?.reset_at, '2026-10-02T12:01:00.250Z');
});

test('native quota keeps complete Gemini and third-party pools separate', () => {
  const result = mapAgyQuota(agyQuota(), agyObserved);
  assert.ok('windows' in result);
  assert.deepEqual(
    result.windows.map((w) => [w.id, w.scope, w.remaining_percent, w.cadence]),
    [
      ['gemini-5h', { type: 'pool', pool_id: 'gemini' }, 50, 'other'],
      ['gemini-weekly', { type: 'pool', pool_id: 'gemini' }, 50, 'weekly'],
      ['3p-5h', { type: 'pool', pool_id: 'third_party' }, 50, 'other'],
      ['3p-weekly', { type: 'pool', pool_id: 'third_party' }, 50, 'weekly'],
    ],
  );
  assert.equal(result.windows[0]?.valid_until, '2026-10-02T13:00:00.000Z');
});
test('incomplete pools are omitted, not represented by one known limit', () => {
  const quota = agyQuota();
  delete quota['gemini-weekly'];
  const result = mapAgyQuota(quota, agyObserved);
  assert.ok('windows' in result);
  assert.equal(result.windows.length, 2);
  assert.ok(result.windows.every((w) => w.scope.type === 'pool' && w.scope.pool_id === 'third_party'));
  delete quota['3p-weekly'];
  assert.deepEqual(mapAgyQuota(quota, agyObserved), { status: 'malformed' });
});
test('invalid present measurements fail rather than clamp or invent allowance', () => {
  for (const value of [-1, 1.1, NaN, Infinity, '1', null]) {
    const quota = agyQuota();
    (quota['gemini-5h'] as unknown as Record<string, unknown>).remaining_fraction = value;
    assert.deepEqual(mapAgyQuota(quota, agyObserved), { status: 'malformed' });
  }
  for (const value of [null, [], {}, { 'gemini-5h': null }])
    assert.deepEqual(mapAgyQuota(value, agyObserved), { status: 'malformed' });
});
test('resets use valid absolute time or bounded relative fallback and cap validity', () => {
  const quota = agyQuota();
  quota['gemini-5h'] = { remaining_fraction: 1, reset_time: 'invalid', reset_in_seconds: 60 };
  const result = mapAgyQuota(quota, agyObserved);
  assert.ok('windows' in result);
  assert.equal(result.windows[0]?.reset_at, '2026-10-02T12:01:00.000Z');
  assert.equal(result.windows[0]?.valid_until, '2026-10-02T12:01:00.000Z');
  for (const seconds of [0, -1, Infinity, Number.MAX_VALUE]) {
    quota['gemini-5h'] = { remaining_fraction: 1, reset_in_seconds: seconds };
    assert.deepEqual(mapAgyQuota(quota, agyObserved), { status: 'malformed' });
  }
  quota['gemini-5h'] = { remaining_fraction: 1, reset_time: '2020-01-01T00:00:00Z' };
  assert.deepEqual(mapAgyQuota(quota, agyObserved), { status: 'malformed' });
  assert.deepEqual(mapAgyQuota(agyQuota(), 'invalid'), { status: 'malformed' });
});
