import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { agyAuthPath, readAgyIdentity } from '../src/agy-auth.ts';
import { agyAuth } from './agy-helpers.ts';

test('native consumer principal stays stable through expiry and renewal without exposing tokens', () => {
  const identity = readAgyIdentity(agyAuth());
  assert.deepEqual(identity, {
    identityFingerprint: createHash('sha256')
      .update('antigravity:https://accounts.google.com:synthetic-user')
      .digest('hex'),
    expiresAt: '2026-10-02T13:00:00Z',
    renewable: true,
  });
  assert.equal(
    readAgyIdentity(agyAuth('synthetic-user', '2020-01-01T00:00:00Z'))?.identityFingerprint,
    identity?.identityFingerprint,
  );
  assert.equal(
    readAgyIdentity(agyAuth('synthetic-user', '2030-01-01T00:00:00Z', 'accounts.google.com'))?.identityFingerprint,
    identity?.identityFingerprint,
  );
  assert.notEqual(readAgyIdentity(agyAuth('other'))?.identityFingerprint, identity?.identityFingerprint);
});
test('invalid native identity fails closed', () => {
  for (const input of [
    'null',
    '{',
    agyAuth(''),
    agyAuth('user', 'invalid'),
    agyAuth('user', '2030-01-01T00:00:00Z', 'evil.example'),
    JSON.stringify({ ...JSON.parse(agyAuth()), auth_method: 'cloud' }),
    JSON.stringify({ ...JSON.parse(agyAuth()), id_token: 'broken' }),
  ]) {
    assert.equal(readAgyIdentity(input), null);
  }
});
test('native auth discovery requires absolute HOME', () => {
  assert.equal(agyAuthPath({ HOME: '/home' }), '/home/.gemini/antigravity-cli/antigravity-oauth-token');
  for (const env of [{}, { HOME: 'relative' }]) assert.throws(() => agyAuthPath(env));
});
