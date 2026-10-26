import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { agyAuthPath, readAgyIdentity } from '../src/agy-auth.ts';
import { agyAuth, agyEmailAuth } from './agy-helpers.ts';

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
test('native email identity survives expiry and token renewal without exposing the email', () => {
  const identity = readAgyIdentity(agyEmailAuth());
  assert.deepEqual(identity, {
    identityFingerprint: createHash('sha256').update('antigravity:email:synthetic-user@example.com').digest('hex'),
    expiresAt: '2026-10-02T13:00:00Z',
    renewable: true,
  });
  const renewed = JSON.parse(agyEmailAuth('synthetic-user@example.com', '2030-01-01T00:00:00Z'));
  renewed.token.access_token = 'renewed-access';
  renewed.token.refresh_token = 'renewed-refresh';
  assert.equal(readAgyIdentity(JSON.stringify(renewed))?.identityFingerprint, identity?.identityFingerprint);
  assert.equal(
    readAgyIdentity(agyEmailAuth('synthetic-user@example.com', '2020-01-01T00:00:00Z'))?.identityFingerprint,
    identity?.identityFingerprint,
  );
  delete renewed.token.refresh_token;
  assert.equal(readAgyIdentity(JSON.stringify(renewed))?.renewable, false);
  assert.notEqual(
    readAgyIdentity(agyEmailAuth('other@example.com'))?.identityFingerprint,
    identity?.identityFingerprint,
  );
  assert.notEqual(
    readAgyIdentity(agyAuth('synthetic-user@example.com'))?.identityFingerprint,
    identity?.identityFingerprint,
  );
});

test('email fallback rejects unusable native credentials and malformed present ID tokens', () => {
  for (const overrides of [
    { id_token_email: undefined },
    { id_token_email: null },
    { id_token_email: 1 },
    { id_token_email: '' },
    { id_token_email: 'not-an-email' },
    { id_token_email: ' user@example.com' },
    { id_token_email: 'user@example.com\n' },
    { id_token_email: 'user@example.com\u0000' },
    { auth_method: 'cloud' },
    { id_token: '' },
    { id_token: null },
    { id_token: 1 },
    { id_token: 'broken' },
    { token: {} },
    { token: { ...JSON.parse(agyEmailAuth()).token, expiry: 'invalid' } },
    { token: { ...JSON.parse(agyEmailAuth()).token, access_token: '' } },
  ]) {
    assert.equal(readAgyIdentity(JSON.stringify({ ...JSON.parse(agyEmailAuth()), ...overrides })), null);
  }
  assert.equal(
    readAgyIdentity(JSON.stringify({ ...JSON.parse(agyAuth('')), id_token_email: 'user@example.com' })),
    null,
  );
});

test('legacy subject remains authoritative when native email is also present', () => {
  assert.deepEqual(
    readAgyIdentity(JSON.stringify({ ...JSON.parse(agyAuth()), id_token_email: 'user@example.com' })),
    readAgyIdentity(agyAuth()),
  );
});

test('native auth discovery requires absolute HOME', () => {
  assert.equal(agyAuthPath({ HOME: '/home' }), '/home/.gemini/antigravity-cli/antigravity-oauth-token');
  for (const env of [{}, { HOME: 'relative' }]) assert.throws(() => agyAuthPath(env));
});
