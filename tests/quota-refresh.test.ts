import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SnapshotSchema, StewardError } from '../src/contracts.ts';
import {
  authPath,
  fingerprint,
  mapCodexUsage,
  mapGrokBilling,
  readCodexAuth,
  readPiAuth,
} from '../src/quota-refresh.ts';

const observed = '2026-10-02T12:00:00.000Z';
const now = new Date(observed);
const expires = 1790946000; // 2026-10-02T13:00:00Z, in seconds
const accountClaim = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } };

function jwt(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

function codexAuth(access: string): string {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: access, account_id: 'ignored' } });
}

function piAuth(provider: 'openai-codex' | 'xai', access: string, expiry = expires * 1000): string {
  return JSON.stringify({ [provider]: { type: 'oauth', access, refresh: 'unused', expires: expiry } });
}

function measured(overrides: Record<string, unknown> = {}) {
  return { used_percent: 25, limit_window_seconds: 604800, reset_at: 1790985600, ...overrides };
}

function codexUsage(window: unknown) {
  return { rate_limit: { primary_window: window } };
}

function billing(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      creditUsagePercent: 40,
      currentPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' },
      ...overrides,
    },
  };
}

test('fingerprints hash bucket-prefixed identity and keep credential stores separate', () => {
  for (const bucket of ['codex', 'pi_codex', 'pi_xai'] as const) {
    assert.equal(fingerprint(bucket, 'acct'), createHash('sha256').update(`${bucket}:acct`).digest('hex'));
    assert.match(fingerprint(bucket, 'acct'), /^[0-9a-f]{64}$/);
    assert.notEqual(fingerprint(bucket, 'acct'), fingerprint(bucket, 'other'));
  }
  assert.notEqual(fingerprint('codex', 'acct'), fingerprint('pi_codex', 'acct'));
  assert.notEqual(fingerprint('pi_codex', 'acct'), fingerprint('pi_xai', 'acct'));
});

test('native Codex reads the access-token account claim, not stored account metadata', () => {
  const access = jwt({ ...accountClaim, exp: expires, sub: 'wrong', email: 'private@example.com' });
  assert.deepEqual(readCodexAuth(codexAuth(access), now), {
    access,
    accountId: 'acct',
    fingerprint: createHash('sha256').update('codex:acct').digest('hex'),
  });
});

test('native Codex rejects expired or unusable credentials without returning identity', () => {
  const valid = jwt({ ...accountClaim, exp: expires });
  for (const text of [
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: valid } }),
    JSON.stringify({ auth_mode: 'chatgpt', access_token: valid }),
    codexAuth(''),
    codexAuth('opaque'),
    codexAuth('a.%%%%.sig'),
    codexAuth('a.bnVsbA.sig'),
    codexAuth(jwt({ exp: expires })),
    codexAuth(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: ' ' }, exp: expires })),
    ...[0, now.getTime() / 1000, 'future', null, undefined].map((exp) => codexAuth(jwt({ ...accountClaim, exp }))),
  ]) {
    assert.deepEqual(readCodexAuth(text, now), { status: 'auth' });
  }
});

test('Pi Codex uses its own bucket fingerprint and only the requested OAuth entry', () => {
  const access = jwt({ ...accountClaim, exp: expires });
  const text = JSON.stringify({
    'openai-codex': { type: 'oauth', access, expires: expires * 1000 },
    xai: { type: 'oauth', access: jwt({ sub: 'wrong' }), expires: expires * 1000 },
  });
  assert.deepEqual(readPiAuth(text, 'openai-codex', now), {
    access,
    fingerprint: createHash('sha256').update('pi_codex:acct').digest('hex'),
  });
});

test('Pi xAI prefers principal_id and falls back to sub without exposing either', () => {
  for (const [claims, identity] of [
    [{ principal_id: 'principal', sub: 'subject' }, 'principal'],
    [{ principal_id: '', sub: 'subject' }, 'subject'],
    [{ principal_id: ' ', sub: 'subject' }, 'subject'],
    [{ principal_id: 123, sub: 'subject' }, 'subject'],
    [{ sub: 'subject' }, 'subject'],
  ] as const) {
    const access = jwt(claims);
    assert.deepEqual(readPiAuth(piAuth('xai', access), 'xai', now), {
      access,
      fingerprint: createHash('sha256').update(`pi_xai:${identity}`).digest('hex'),
    });
  }
});

test('Pi rejects either expired timestamp, invalid OAuth entries, and missing identities', () => {
  const access = jwt({ sub: 'subject', exp: expires });
  for (const text of [
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ xai: { type: 'api_key', access, expires: expires * 1000 } }),
    JSON.stringify({ xai: { type: 'oauth', access } }),
    JSON.stringify({ xai: { type: 'oauth', access, expires: 'future' } }),
    piAuth('openai-codex', access),
    piAuth('xai', ''),
    piAuth('xai', 'not-a-jwt'),
    piAuth('xai', access, 0),
    piAuth('xai', access, now.getTime()),
    piAuth('xai', jwt({ sub: 'subject', exp: now.getTime() / 1000 })),
    piAuth('xai', jwt({ sub: 'subject', exp: 0 })),
    piAuth('xai', jwt({ sub: 'subject', exp: 'future' })),
    piAuth('xai', jwt({ sub: 'subject', exp: null })),
    piAuth('xai', jwt({ exp: expires })),
    piAuth('xai', jwt({ principal_id: '', sub: ' ' })),
  ]) {
    assert.deepEqual(readPiAuth(text, 'xai', now), { status: 'auth' });
  }
  assert.deepEqual(readPiAuth(piAuth('openai-codex', access), 'openai-codex', now), { status: 'auth' });
  assert.deepEqual(readPiAuth(piAuth('xai', access), 'xai', new Date(NaN)), { status: 'auth' });
  assert.deepEqual(readCodexAuth(codexAuth(jwt({ ...accountClaim, exp: expires })), new Date(NaN)), {
    status: 'auth',
  });
});

test('auth paths use absolute explicit roots or the appropriate HOME fallback', () => {
  assert.equal(authPath('codex', { CODEX_HOME: '/auth/codex', HOME: 'ignored' }), '/auth/codex/auth.json');
  assert.equal(authPath('pi', { PI_CODING_AGENT_DIR: '/auth/pi' }), '/auth/pi/auth.json');
  assert.equal(authPath('codex', { HOME: '/home/test' }), '/home/test/.codex/auth.json');
  assert.equal(authPath('pi', { HOME: '/home/test' }), '/home/test/.pi/agent/auth.json');
  assert.equal(
    authPath('codex', { HOME: '/home/test', PI_CODING_AGENT_DIR: 'ignored' }),
    '/home/test/.codex/auth.json',
  );
});

test('auth paths reject set-but-empty or relative overrides and unusable HOME with fixed invalid_input', () => {
  for (const kind of ['codex', 'pi'] as const) {
    const key = kind === 'codex' ? 'CODEX_HOME' : 'PI_CODING_AGENT_DIR';
    for (const env of [
      { [key]: '', HOME: '/home/test' },
      { [key]: 'relative', HOME: '/home/test' },
      {},
      { HOME: '' },
      { HOME: 'relative' },
    ]) {
      assert.throws(
        () => authPath(kind, env),
        (error: unknown) =>
          error instanceof StewardError && error.code === 'invalid_input' && !error.message.includes('relative'),
      );
    }
  }
});

test('Codex maps weekly primary, secondary, and gpt-reserve without retaining provider metadata', () => {
  const mapped = mapCodexUsage(
    {
      rate_limit: {
        primary_window: measured(),
        secondary_window: measured({ used_percent: 100, limit_window_seconds: 18000 }),
      },
      additional_rate_limits: [
        { limit_name: 'gpt-reserve', rate_limit: { primary_window: measured({ used_percent: 10 }) } },
        { rate_limit: { primary_window: measured({ used_percent: 0 }) } },
        { limit_name: ' ', rate_limit: { secondary_window: measured({ used_percent: 50 }) } },
      ],
      email: 'private@example.com',
      account_id: 'private-account',
    },
    observed,
  );
  assert.ok('windows' in mapped);
  assert.deepEqual(mapped, {
    windows: [
      ['primary', 'weekly', 75],
      ['secondary', 'other', 0],
      ['gpt-reserve', 'weekly', 90],
      ['additional-1', 'weekly', 100],
      ['additional-2', 'weekly', 50],
    ].map(([id, cadence, remaining_percent]) => ({
      scope: { type: 'account' },
      id,
      cadence,
      remaining_percent,
      observed_at: observed,
      reset_at: '2026-10-03T00:00:00.000Z',
      valid_until: '2026-10-02T13:00:00.000Z',
    })),
  });
  assert.equal(
    SnapshotSchema.safeParse({ schema_version: 1, source: 'codex', identity_fingerprint: 'a'.repeat(64), ...mapped })
      .success,
    true,
  );
});

test('Codex ignores absent unmeasured optional limits without fabricating windows', () => {
  assert.deepEqual(
    mapCodexUsage(
      {
        rate_limit: { primary_window: measured(), secondary_window: null },
        additional_rate_limits: [{ limit_name: 'unmeasured', rate_limit: null }],
      },
      observed,
    ),
    mapCodexUsage(codexUsage(measured()), observed),
  );
});

test('Codex rejects missing primary measurements and invalid numeric window data', () => {
  for (const payload of [
    null,
    [],
    {},
    { rate_limit: {} },
    codexUsage(null),
    { rate_limit: { secondary_window: measured() } },
    ...[-1, 101, NaN, Infinity, '25', null, undefined].map((used_percent) => codexUsage(measured({ used_percent }))),
    ...[0, -1, NaN, Infinity, '604800', undefined].map((limit_window_seconds) =>
      codexUsage(measured({ limit_window_seconds })),
    ),
    ...[
      null,
      undefined,
      NaN,
      Infinity,
      1e20,
      'tomorrow',
      '2026-10-03T00:00:00',
      '2026-02-30T00:00:00Z',
      '1790985600',
    ].map((reset_at) => codexUsage(measured({ reset_at }))),
  ]) {
    assert.deepEqual(mapCodexUsage(payload, observed), { status: 'malformed' });
  }
});

test('invalid optional Codex measurements fail closed rather than hiding a measured limit', () => {
  for (const payload of [
    { rate_limit: { primary_window: measured(), secondary_window: measured({ used_percent: 101 }) } },
    {
      ...codexUsage(measured()),
      additional_rate_limits: [{ rate_limit: { primary_window: measured({ reset_at: observed }) } }],
    },
  ])
    assert.deepEqual(mapCodexUsage(payload, observed), { status: 'malformed' });
});

test('mappers use the earlier of reset and one hour with offsets and submillisecond precision', () => {
  for (const [reset, observation, validity] of [
    ['2026-10-02T14:30:00+02:00', observed, '2026-10-02T14:30:00+02:00'],
    ['2026-10-03T00:00:00Z', observed, '2026-10-02T13:00:00.000Z'],
    ['2026-10-02T12:00:00.0002Z', '2026-10-02T12:00:00.0001Z', '2026-10-02T12:00:00.0002Z'],
    ['2026-10-03T00:00:00Z', '2026-10-02T14:00:00.0001+02:00', '2026-10-02T13:00:00.0001Z'],
  ] as const) {
    for (const mapped of [
      mapCodexUsage(codexUsage(measured({ reset_at: reset })), observation),
      mapGrokBilling(billing({ currentPeriod: { end: reset } }), observation),
    ]) {
      assert.ok('windows' in mapped);
      assert.equal(mapped.windows[0]?.reset_at, reset);
      assert.equal(mapped.windows[0]?.observed_at, observation);
      assert.equal(mapped.windows[0]?.valid_until, validity);
    }
  }
});

test('mappers reject observations at or after reset and non-RFC3339 observations', () => {
  for (const observation of [
    '2026-10-03T00:00:00Z',
    '2026-10-03T00:00:00.0001Z',
    'invalid',
    '2026-10-02T12:00:00',
    '2026-02-30T12:00:00Z',
    '2026-10-02T12:00:00+99:00',
  ]) {
    assert.deepEqual(mapCodexUsage(codexUsage(measured()), observation), { status: 'malformed' });
    assert.deepEqual(mapGrokBilling(billing({ currentPeriod: { end: '2026-10-03T00:00:00Z' } }), observation), {
      status: 'malformed',
    });
  }
});

test('Grok maps 168-hour credits only, dropping productUsage and provider metadata', () => {
  const mapped = mapGrokBilling(
    { ...billing(), productUsage: [{ usagePercent: 99 }], email: 'private@example.com' },
    observed,
  );
  assert.deepEqual(mapped, {
    windows: [
      {
        scope: { type: 'account' },
        id: 'credits',
        cadence: 'weekly',
        remaining_percent: 60,
        observed_at: observed,
        reset_at: '2026-10-08T00:00:00Z',
        valid_until: '2026-10-02T13:00:00.000Z',
      },
    ],
  });
});

test('Grok falls back to billingPeriodEnd and marks missing or nonweekly periods other', () => {
  for (const currentPeriod of [
    undefined,
    { start: 'invalid', end: 'invalid' },
    { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00+99:00' },
    { start: '2026-10-09T00:00:00Z' },
    { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00' },
  ]) {
    const mapped = mapGrokBilling(billing({ currentPeriod, billingPeriodEnd: '2026-10-04T00:00:00Z' }), observed);
    assert.ok('windows' in mapped);
    assert.equal(mapped.windows[0]?.reset_at, '2026-10-04T00:00:00Z');
    assert.equal(mapped.windows[0]?.cadence, 'other');
  }
  const mapped = mapGrokBilling(
    billing({
      currentPeriod: { start: '2026-10-01T02:00:00+02:00', end: '2026-10-08T00:00:00Z' },
      billingPeriodEnd: '2026-10-04T00:00:00Z',
    }),
    observed,
  );
  assert.ok('windows' in mapped);
  assert.equal(mapped.windows[0]?.cadence, 'weekly');
  assert.equal(mapped.windows[0]?.reset_at, '2026-10-08T00:00:00Z');
});

test('Grok requires a finite measured percent and usable reset, not just a billing period', () => {
  for (const payload of [
    null,
    [],
    {},
    { config: null },
    ...[undefined, null, '40', -1, 101, NaN, Infinity].map((creditUsagePercent) => billing({ creditUsagePercent })),
    billing({ currentPeriod: {} }),
    billing({ currentPeriod: { end: 'invalid' }, billingPeriodEnd: '2026-10-08T00:00:00' }),
  ])
    assert.deepEqual(mapGrokBilling(payload, observed), { status: 'malformed' });
  for (const [used, remaining] of [
    [0, 100],
    [100, 0],
  ] as const) {
    const mapped = mapGrokBilling(billing({ creditUsagePercent: used }), observed);
    assert.ok('windows' in mapped);
    assert.equal(mapped.windows[0]?.remaining_percent, remaining);
  }
});
