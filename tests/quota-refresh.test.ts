import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { SnapshotSchema, StewardError } from '../src/contracts.ts';
import type { QuotaBucket, SnapshotSource } from '../src/contracts.ts';
import { candidate, choice, config, evaluation, recordingPost, snapshot, windowFact } from './helpers.ts';
import { makeEvaluator } from '../src/jev.ts';
import { route } from '../src/routing.ts';
import type { QuotaHttpGet, QuotaRefreshIO } from '../src/quota-refresh.ts';
import { loadQuota } from '../src/quota.ts';
import {
  authPath,
  fingerprint,
  mapCodexUsage,
  mapGrokBilling,
  readCodexAuth,
  readPiAuth,
  refreshQuota,
} from '../src/quota-refresh.ts';

import { agyAuth, agyQuota } from './agy-helpers.ts';
import { readAgyIdentity } from '../src/agy-auth.ts';

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

const quotaDir = '/home/.local/state/agent-steward/quota';
const nativeAccess = jwt({ ...accountClaim, exp: expires });
const xaiAccess = jwt({ principal_id: 'principal', sub: 'ignored', exp: expires });

function storedSnapshot(bucket: SnapshotSource, identity = 'acct'): string {
  return JSON.stringify(
    snapshot([windowFact({ type: 'account' })], {
      source: bucket,
      identity_fingerprint: createHash('sha256').update(`${bucket}:${identity}`).digest('hex'),
    }),
  );
}

function refreshConfig(buckets: QuotaBucket[], tools = ['codex', 'pi', 'agy']) {
  return config({
    tools,
    candidates: buckets.map((bucket, index) =>
      candidate({
        id: `candidate-${index}`,
        tool: bucket === 'codex' ? 'codex' : bucket === 'antigravity' ? 'agy' : 'pi',
        quota_bucket: bucket,
      }),
    ),
  });
}

function refreshIO(
  httpGet: QuotaHttpGet = async () => ({ status: 200, body: JSON.stringify(codexUsage(measured())) }),
) {
  const files = new Map<string, string>([
    ['/home/.codex/auth.json', codexAuth(nativeAccess)],
    [
      '/home/.pi/agent/auth.json',
      JSON.stringify({
        'openai-codex': { type: 'oauth', access: nativeAccess, expires: expires * 1000 },
        xai: { type: 'oauth', access: xaiAccess, expires: expires * 1000 },
      }),
    ],
  ]);
  const operations: unknown[][] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const io: QuotaRefreshIO = {
    env: { HOME: '/home' },
    withAgyLock: async (_path, action) => action(),
    collectAgy: async () => ({ status: 'fetch' }),
    now: () => now,
    readText: async (path) => {
      operations.push(['read', path]);
      const text = files.get(path);
      if (text === undefined) throw missing();
      return text;
    },
    mkdirp: async (path, mode) => {
      operations.push(['mkdir', path, mode]);
    },
    chmod: async (path, mode) => {
      operations.push(['chmod', path, mode]);
    },
    writeText: async (path, text, mode) => {
      operations.push(['write', path, mode]);
      if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(path, text);
    },
    rename: async (from, to) => {
      operations.push(['rename', from, to]);
      const text = files.get(from);
      if (text === undefined) throw missing();
      files.set(to, text);
      files.delete(from);
    },
    unlink: async (path) => {
      operations.push(['unlink', path]);
      if (!files.delete(path)) throw missing();
    },
    httpGet: async (url, headers) => {
      requests.push({ url, headers });
      return httpGet(url, headers);
    },
  };
  return { io, files, operations, requests };
}

test('AGY renewal accepts the same principal and writes separate private pools once', async () => {
  const { io, files, operations, requests } = refreshIO();
  const auth = '/home/.gemini/antigravity-cli/antigravity-oauth-token';
  let calls = 0;
  files.set(auth, agyAuth('same', '2026-10-02T11:00:00Z'));
  io.withAgyLock = async (_path, action) => action();
  io.collectAgy = async (paths, requestId) => {
    calls++;
    assert.equal(paths.auth, auth);
    files.set(auth, agyAuth('same'));
    return { status: 'captured', observation: { requestId, observedAt: observed, quota: agyQuota() } };
  };
  assert.deepEqual(await refreshQuota(refreshConfig(['antigravity', 'antigravity']), io), {
    buckets: [{ bucket: 'antigravity', status: 'written' }],
  });
  assert.equal(calls, 1);
  assert.equal(requests.length, 0);
  const body = files.get(`${quotaDir}/antigravity.json`)!;
  const saved = SnapshotSchema.parse(JSON.parse(body));
  assert.equal(saved.source, 'antigravity');
  assert.equal(saved.identity_fingerprint, readAgyIdentity(agyAuth('same'))!.identityFingerprint);
  assert.deepEqual([...new Set(saved.windows.map((w) => (w.scope.type === 'pool' ? w.scope.pool_id : null)))].sort(), [
    'gemini',
    'third_party',
  ]);
  assert.equal(body.includes('synthetic-access'), false);
  assert.equal(body.includes('same'), false);
  assert.equal(operations.filter(([op]) => op === 'write').length, 1);
  assert.equal(operations.find(([op]) => op === 'write')?.[2], 0o600);
});
test('AGY changed or unknown identity invalidates previous data; same-principal failure preserves bytes', async () => {
  for (const next of ['same', 'changed', null]) {
    const { io, files } = refreshIO();
    const auth = '/home/.gemini/antigravity-cli/antigravity-oauth-token',
      dest = `${quotaDir}/antigravity.json`;
    const original = JSON.stringify(
      snapshot([windowFact({ type: 'pool', pool_id: 'gemini' })], {
        source: 'antigravity',
        identity_fingerprint: readAgyIdentity(agyAuth('same'))!.identityFingerprint,
      }),
    );
    files.set(auth, agyAuth('same'));
    files.set(dest, original);
    io.withAgyLock = async (_p, a) => a();
    io.collectAgy = async () => {
      if (next === null) files.delete(auth);
      else files.set(auth, agyAuth(next));
      return { status: 'fetch' };
    };
    assert.deepEqual(await refreshQuota(refreshConfig(['antigravity']), io), {
      buckets: [{ bucket: 'antigravity', status: next === 'same' ? 'fetch' : 'auth' }],
    });
    assert.equal(files.get(dest), next === 'same' ? original : undefined);
  }
});
test('AGY native failure still checks changed identity, and serialized updates do not overlap', async () => {
  const { io, files } = refreshIO();
  const auth = '/home/.gemini/antigravity-cli/antigravity-oauth-token',
    dest = `${quotaDir}/antigravity.json`;
  files.set(auth, agyAuth('same'));
  files.set(dest, storedSnapshot('antigravity'));
  io.collectAgy = async () => {
    files.set(auth, agyAuth('changed'));
    throw new Error('private-native-error');
  };
  assert.equal((await refreshQuota(refreshConfig(['antigravity']), io)).buckets[0]?.status, 'auth');
  assert.equal(files.has(dest), false);
  let queue = Promise.resolve(),
    active = 0,
    peak = 0;
  io.withAgyLock = async (_path, action) => {
    const before = queue;
    let release = () => {};
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await action();
    } finally {
      release();
    }
  };
  io.collectAgy = async (_paths, requestId) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { status: 'captured', observation: { requestId, observedAt: observed, quota: agyQuota() } };
  };
  const results = await Promise.all([
    refreshQuota(refreshConfig(['antigravity']), io),
    refreshQuota(refreshConfig(['antigravity']), io),
  ]);
  assert.equal(peak, 1);
  assert.ok(results.every((r) => r.buckets[0]?.status === 'written'));
});
test('mixed HTTP/native collection feeds offline reader without borrowing the other AGY pool', async () => {
  const { io, files, requests, operations } = refreshIO();
  files.set('/home/.gemini/antigravity-cli/antigravity-oauth-token', agyAuth());
  let native = 0;
  const quota = agyQuota();
  for (const [key, window] of Object.entries(quota)) window.remaining_fraction = key.startsWith('gemini') ? 0.2 : 0.8;
  io.collectAgy = async (_paths, requestId) => {
    native++;
    return { status: 'captured', observation: { requestId, observedAt: observed, quota } };
  };
  assert.deepEqual(
    (await refreshQuota(refreshConfig(['antigravity', 'codex']), io)).buckets.map((b) => b.status),
    ['written', 'written'],
  );
  assert.equal(requests.length, 1);
  assert.equal(native, 1);
  const cfg = config({
    tools: ['agy'],
    candidates: [
      candidate({ id: 'gemini', tool: 'agy', quota_bucket: 'antigravity', quota_pool: 'gemini' }),
      candidate({ id: 'third', tool: 'agy', quota_bucket: 'antigravity', quota_pool: 'third_party' }),
    ],
  });
  operations.length = 0;
  const facts = await loadQuota(cfg, { env: io.env, now, readText: io.readText, diagnostic: () => {} });
  const gemini = facts.get('gemini'),
    third = facts.get('third');
  assert.ok(gemini && third);
  assert.equal(gemini.pool_status, 'known');
  assert.ok(gemini.windows.every((w) => w.remaining_percent === 20));
  assert.equal(third.pool_status, 'known');
  assert.ok(third.windows.every((w) => w.remaining_percent === 80));
  assert.deepEqual(operations, [['read', `${quotaDir}/antigravity.json`]]);
  assert.equal(native, 1);
});

test('AGY unsupported auth starts no process; malformed capture retains same-identity snapshot', async () => {
  const { io, files } = refreshIO();
  const auth = '/home/.gemini/antigravity-cli/antigravity-oauth-token';
  let calls = 0;
  io.withAgyLock = async (_p, a) => a();
  io.collectAgy = async (_p, requestId) => {
    calls++;
    return {
      status: 'captured',
      observation: { requestId, observedAt: observed, quota: { 'gemini-5h': { remaining_fraction: 2 } } },
    };
  };
  files.set(auth, JSON.stringify({ ...JSON.parse(agyAuth()), auth_method: 'adc' }));
  assert.equal((await refreshQuota(refreshConfig(['antigravity']), io)).buckets[0]?.status, 'auth');
  assert.equal(calls, 0);
  files.set(auth, agyAuth());
  assert.equal((await refreshQuota(refreshConfig(['antigravity']), io)).buckets[0]?.status, 'malformed');
  assert.equal(calls, 1);
});

// Each assertion covers the collector's boundary effects, not mapper internals:
// bucket gating, pinned requests, atomic permissions, or preservation/invalidation.
test('refresh writes a private atomic snapshot without Jev or auth-store writes', async () => {
  const { io, files, operations, requests } = refreshIO(async () => ({
    status: 200,
    body: JSON.stringify({ ...codexUsage(measured()), email: 'private@example.com', account_id: 'raw-account' }),
  }));
  const authBefore = files.get('/home/.codex/auth.json');
  assert.deepEqual(await refreshQuota(refreshConfig(['codex', 'codex']), io), {
    buckets: [{ bucket: 'codex', status: 'written' }],
  });
  assert.deepEqual(requests, [
    {
      url: 'https://chatgpt.com/backend-api/wham/usage',
      headers: {
        Authorization: `Bearer ${nativeAccess}`,
        'ChatGPT-Account-Id': 'acct',
        Accept: 'application/json',
        'User-Agent': 'agent-steward-quota-refresh',
      },
    },
  ]);
  const dest = `${quotaDir}/codex.json`;
  const temp = operations.find(([op]) => op === 'write')?.[1];
  assert.ok(typeof temp === 'string');
  assert.equal(dirname(temp), quotaDir);
  assert.notEqual(temp, dest);
  assert.deepEqual(
    operations.filter(([op]) => op !== 'read'),
    [
      ['mkdir', quotaDir, 0o700],
      ['chmod', quotaDir, 0o700],
      ['write', temp, 0o600],
      ['rename', temp, dest],
    ],
  );
  const body = files.get(dest)!;
  const saved = SnapshotSchema.parse(JSON.parse(body));
  assert.equal(saved.source, 'codex');
  assert.equal(saved.identity_fingerprint, createHash('sha256').update('codex:acct').digest('hex'));
  assert.equal(saved.windows[0]?.remaining_percent, 75);
  assert.equal(saved.windows[0]?.observed_at, observed);
  for (const secret of [nativeAccess, 'private@example.com', 'raw-account']) assert.ok(!body.includes(secret));
  assert.equal(files.get('/home/.codex/auth.json'), authBefore);
  assert.equal(files.has(temp), false);
});

test('refresh uses distinct Pi credentials, pinned headers, and XDG state paths', async () => {
  const { io, files, requests } = refreshIO(async (url) => ({
    status: 200,
    body: JSON.stringify(url.includes('grok.com') ? billing() : codexUsage(measured())),
  }));
  io.env.XDG_STATE_HOME = '/state';
  io.env.PI_CODING_AGENT_DIR = '/pi';
  files.set('/pi/auth.json', files.get('/home/.pi/agent/auth.json')!);
  files.delete('/home/.pi/agent/auth.json');
  assert.deepEqual(await refreshQuota(refreshConfig(['pi_codex', 'pi_xai', 'pi_codex']), io), {
    buckets: [
      { bucket: 'pi_codex', status: 'written' },
      { bucket: 'pi_xai', status: 'written' },
    ],
  });
  assert.deepEqual(requests, [
    {
      url: 'https://chatgpt.com/backend-api/wham/usage',
      headers: {
        Authorization: `Bearer ${nativeAccess}`,
        'ChatGPT-Account-Id': 'acct',
        Accept: 'application/json',
        'User-Agent': 'agent-steward-quota-refresh',
      },
    },
    {
      url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      headers: {
        Authorization: `Bearer ${xaiAccess}`,
        'x-xai-token-auth': 'xai-grok-cli',
        Accept: 'application/json',
        'User-Agent': 'agent-steward-quota-refresh',
      },
    },
  ]);
  for (const [bucket, identity, remaining] of [
    ['pi_codex', 'acct', 75],
    ['pi_xai', 'principal', 60],
  ] as const) {
    const saved = SnapshotSchema.parse(JSON.parse(files.get(`/state/agent-steward/quota/${bucket}.json`)!));
    assert.equal(saved.source, bucket);
    assert.equal(saved.identity_fingerprint, createHash('sha256').update(`${bucket}:${identity}`).digest('hex'));
    assert.equal(saved.windows[0]?.remaining_percent, remaining);
  }
});

test('disabled and unreferenced Antigravity buckets do not open files or sockets', async () => {
  const { io, operations, requests } = refreshIO();
  io.env = {};
  assert.deepEqual(await refreshQuota(refreshConfig(['antigravity', 'codex', 'pi_xai', 'antigravity'], []), io), {
    buckets: [],
  });
  assert.deepEqual(await refreshQuota(refreshConfig(['codex'], []), io), { buckets: [] });
  assert.deepEqual(operations, []);
  assert.deepEqual(requests, []);
});

test('mixed buckets continue after failure and collect each enabled bucket only once', async () => {
  const { io, files, requests } = refreshIO(async (url) => ({
    status: url.includes('grok.com') ? 200 : 403,
    body: JSON.stringify(billing()),
  }));
  files.delete('/home/.codex/auth.json');
  assert.deepEqual(await refreshQuota(refreshConfig(['codex', 'pi_codex', 'pi_xai', 'antigravity', 'pi_xai']), io), {
    buckets: [
      { bucket: 'codex', status: 'auth' },
      { bucket: 'pi_codex', status: 'fetch' },
      { bucket: 'pi_xai', status: 'written' },
      { bucket: 'antigravity', status: 'auth' },
    ],
  });
  assert.equal(requests.length, 2);
  assert.ok(files.has(`${quotaDir}/pi_xai.json`));
});

for (const bucket of ['codex', 'pi_codex', 'pi_xai'] as const) {
  for (const changed of [false, true]) {
    test(`expired ${bucket} makes zero requests and ${changed ? 'invalidates changed' : 'preserves same'} identity`, async () => {
      const { io, files, operations, requests } = refreshIO();
      const identity = bucket === 'pi_xai' ? 'principal' : 'acct';
      const dest = `${quotaDir}/${bucket}.json`;
      const previous = storedSnapshot(bucket, changed ? 'previous-login' : identity);
      files.set(dest, previous);
      const access = jwt({ ...accountClaim, principal_id: 'principal', exp: 1 });
      files.set(
        bucket === 'codex' ? '/home/.codex/auth.json' : '/home/.pi/agent/auth.json',
        bucket === 'codex' ? codexAuth(access) : piAuth(bucket === 'pi_codex' ? 'openai-codex' : 'xai', access),
      );
      assert.deepEqual(await refreshQuota(refreshConfig([bucket]), io), { buckets: [{ bucket, status: 'auth' }] });
      assert.deepEqual(requests, []);
      assert.equal(files.get(dest), changed ? undefined : previous);
      assert.deepEqual(
        operations.filter(([op]) => op !== 'read'),
        changed ? [['unlink', dest]] : [],
      );
    });
  }
}

const failureResponses: [string, QuotaHttpGet, 'fetch' | 'malformed'][] = [
  ...[401, 403, 302, 500].map((status): [string, QuotaHttpGet, 'fetch'] => [
    String(status),
    async () => ({ status, body: 'private failure body' }),
    'fetch',
  ]),
  [
    'timeout',
    async () => {
      throw new Error('private timeout');
    },
    'fetch',
  ],
  [
    'off-host redirect',
    async () => {
      throw new Error('redirect refused');
    },
    'fetch',
  ],
  ['oversize', async () => ({ status: 200, body: ' '.repeat(1_048_577) }), 'fetch'],
  ['invalid JSON', async () => ({ status: 200, body: 'private malformed body' }), 'malformed'],
  [
    'invalid windows',
    async () => ({ status: 200, body: JSON.stringify(codexUsage(measured({ used_percent: 101 }))) }),
    'malformed',
  ],
  ['excess depth', async () => ({ status: 200, body: '['.repeat(65) + '0' + ']'.repeat(65) }), 'malformed'],
];
for (const [label, httpGet, status] of failureResponses) {
  for (const changed of [false, true]) {
    test(`${label} ${changed ? 'deletes different-identity' : 'preserves same-identity'} snapshot without retry`, async () => {
      const { io, files, operations, requests } = refreshIO(httpGet);
      const dest = `${quotaDir}/codex.json`;
      const previous = storedSnapshot('codex', changed ? 'previous-login' : 'acct');
      files.set(dest, previous);
      assert.deepEqual(await refreshQuota(refreshConfig(['codex']), io), { buckets: [{ bucket: 'codex', status }] });
      assert.equal(files.get(dest), changed ? undefined : previous);
      assert.equal(requests.length, 1);
      assert.deepEqual(
        operations.filter(([op]) => op !== 'read'),
        changed ? [['unlink', dest]] : [],
      );
    });
  }
}

for (const bucket of ['codex', 'pi_codex'] as const) {
  for (const [label, id] of [
    ['access token', nativeAccess],
    ['embedded access token', `reserve-${nativeAccess}-weekly`],
    ['recognizable credential', `password =\n${'A'.repeat(20)}`],
    ['account identity', 'acct'],
    ['embedded account identity', 'reserve-acct-weekly'],
    ['email', 'private@example.com'],
    ['embedded email', 'reserve-private@example.com-weekly'],
  ]) {
    for (const changed of [false, true]) {
      test(`${bucket} rejects ${label} in window IDs and ${changed ? 'invalidates changed' : 'preserves same'} identity`, async () => {
        const { io, files, operations } = refreshIO(async () => ({
          status: 200,
          body: JSON.stringify({
            ...codexUsage(measured()),
            additional_rate_limits: [{ limit_name: id, rate_limit: { primary_window: measured() } }],
          }),
        }));
        const dest = `${quotaDir}/${bucket}.json`;
        const previous = storedSnapshot(bucket, changed ? 'previous-login' : 'acct');
        files.set(dest, previous);
        assert.deepEqual(await refreshQuota(refreshConfig([bucket]), io), {
          buckets: [{ bucket, status: 'malformed' }],
        });
        assert.equal(files.get(dest), changed ? undefined : previous);
        assert.deepEqual(
          operations.filter(([op]) => op !== 'read'),
          changed ? [['unlink', dest]] : [],
        );
        assert.deepEqual(
          [...files.keys()].filter((path) => path.startsWith(`${dest}.`)),
          [],
        );
      });
    }
  }
}

for (const bucket of ['codex', 'pi_codex'] as const) {
  for (const [label, id] of [
    ['account identity', 'acct'],
    ['embedded account identity', 'reserve-acct-weekly'],
    ['email', 'private@example.com'],
    ['embedded email', 'reserve-private@example.com-weekly'],
  ] as const) {
    test(`${bucket} keeps ${label} out of snapshots, loaded quota, route output, and Jev bodies`, async () => {
      const { io, files } = refreshIO(async () => ({
        status: 200,
        body: JSON.stringify({
          ...codexUsage(measured()),
          additional_rate_limits: [{ limit_name: id, rate_limit: { primary_window: measured() } }],
        }),
      }));
      const configuration = refreshConfig([bucket]);
      const refreshed = await refreshQuota(configuration, io);
      const quota = await loadQuota(configuration, { ...io, now, diagnostic: () => {} });
      const { post, requests } = recordingPost(evaluation({ pair: choice({ 'candidate-0': 1 }) }));
      const selected = await route({
        task: 'Review the parser',
        requestId: 'privacy-regression',
        config: configuration,
        quota,
        evaluate: makeEvaluator({ model: 'jev-1.13.0', apiKey: 'unit-key-not-live', post }),
      });
      assert.equal(requests.length, 1);
      for (const [boundary, text] of [
        ['snapshot', files.get(`${quotaDir}/${bucket}.json`) ?? ''],
        ['loaded quota', JSON.stringify([...quota.values()])],
        ['route output', JSON.stringify(selected)],
        ['Jev body', requests[0]!.body],
      ] as const) {
        assert.equal(text.includes(id), false, `${boundary} exposed ${label}`);
      }
      assert.deepEqual(refreshed, { buckets: [{ bucket, status: 'malformed' }] });
      assert.equal(files.has(`${quotaDir}/${bucket}.json`), false);
      assert.equal(selected.quota.snapshot_status, 'missing');
      assert.equal(selected.quota.account_status, 'unknown');
    });
  }
}

for (const oversized of [false, true]) {
  for (const changed of [false, true]) {
    test(`mapped snapshot ${oversized ? 'one byte over' : 'at'} reader limit with ${changed ? 'changed' : 'same'} identity`, async () => {
      // Two windows repeat this 523,917-byte ID. With primary remaining=0 the
      // snapshot is exactly 1 MiB; remaining=10 adds one byte. UTF-8, not length.
      const id = 'é'.repeat(261_958) + 'x';
      const body = JSON.stringify({
        ...codexUsage(measured({ used_percent: oversized ? 90 : 100 })),
        additional_rate_limits: [
          { limit_name: id, rate_limit: { primary_window: measured(), secondary_window: measured() } },
        ],
      });
      assert.ok(Buffer.byteLength(body, 'utf8') < 1_048_576);
      const { io, files, operations } = refreshIO(async () => ({ status: 200, body }));
      const dest = `${quotaDir}/codex.json`;
      const previous = storedSnapshot('codex', changed ? 'previous-login' : 'acct');
      files.set(dest, previous);
      const configuration = refreshConfig(['codex']);
      assert.deepEqual(await refreshQuota(configuration, io), {
        buckets: [{ bucket: 'codex', status: oversized ? 'malformed' : 'written' }],
      });
      if (oversized) {
        assert.equal(files.get(dest), changed ? undefined : previous);
        assert.deepEqual(
          operations.filter(([op]) => op !== 'read'),
          changed ? [['unlink', dest]] : [],
        );
      } else {
        assert.equal(Buffer.byteLength(files.get(dest)!, 'utf8'), 1_048_576);
        const diagnostics: string[] = [];
        const loaded = await loadQuota(configuration, {
          env: io.env,
          readText: io.readText,
          now,
          diagnostic: (code) => diagnostics.push(code),
        });
        const facts = loaded.get('candidate-0')!;
        assert.equal(facts.snapshot_status, 'loaded');
        assert.deepEqual(
          facts.windows.map((window) => window.id),
          ['primary', id, id],
        );
        assert.deepEqual(diagnostics, []);
      }
      assert.deepEqual(
        [...files.keys()].filter((path) => path.startsWith(`${dest}.`)),
        [],
      );
    });
  }
}

test('missing or undecodable credentials preserve the snapshot when identity is unknown', async () => {
  for (const auth of [undefined, 'invalid json', codexAuth('invalid token')]) {
    const { io, files, operations, requests } = refreshIO();
    const previous = storedSnapshot('codex');
    files.set(`${quotaDir}/codex.json`, previous);
    if (auth === undefined) files.delete('/home/.codex/auth.json');
    else files.set('/home/.codex/auth.json', auth);
    assert.deepEqual(await refreshQuota(refreshConfig(['codex']), io), {
      buckets: [{ bucket: 'codex', status: 'auth' }],
    });
    assert.equal(files.get(`${quotaDir}/codex.json`), previous);
    assert.deepEqual(requests, []);
    assert.deepEqual(
      operations.filter(([op]) => op !== 'read'),
      [],
    );
  }
});

test('successful changed identity replaces the previous snapshot', async () => {
  const { io, files } = refreshIO();
  const dest = `${quotaDir}/codex.json`;
  const previous = storedSnapshot('codex', 'previous-login');
  files.set(dest, previous);
  assert.deepEqual(await refreshQuota(refreshConfig(['codex']), io), {
    buckets: [{ bucket: 'codex', status: 'written' }],
  });
  assert.notEqual(files.get(dest), previous);
  assert.equal(
    JSON.parse(files.get(dest)!).identity_fingerprint,
    createHash('sha256').update('codex:acct').digest('hex'),
  );
});

test('overlapping refreshes publish independently with exclusive temporary-file creation', async () => {
  const { io, files, operations } = refreshIO();
  let signalFirstCreated!: () => void;
  const firstCreated = new Promise<void>((resolve) => {
    signalFirstCreated = resolve;
  });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const writeText = io.writeText;
  let writes = 0;
  io.writeText = async (...args) => {
    await writeText(...args);
    if (++writes === 1) {
      signalFirstCreated();
      await firstReleased;
    }
  };
  const configuration = refreshConfig(['codex']);
  const first = Promise.allSettled([refreshQuota(configuration, io)]);
  await firstCreated;
  const second = await Promise.allSettled([refreshQuota(configuration, io)]);
  releaseFirst();
  const expected = [{ status: 'fulfilled', value: { buckets: [{ bucket: 'codex', status: 'written' }] } }];
  assert.deepEqual(await first, expected);
  assert.deepEqual(second, expected);
  const temps = operations.filter(([op]) => op === 'write').map(([, path]) => path);
  assert.equal(new Set(temps).size, 2);
  for (const temp of temps) assert.equal(files.has(temp as string), false);
  assert.equal(
    SnapshotSchema.parse(JSON.parse(files.get(`${quotaDir}/codex.json`)!)).windows[0]?.remaining_percent,
    75,
  );
  assert.deepEqual(
    operations.filter(([op]) => op === 'unlink'),
    [],
  );
});

test("failed exclusive creation never unlinks another writer's temporary file", async () => {
  const { io, files, operations } = refreshIO();
  let foreignTemp = '';
  io.writeText = async (path) => {
    foreignTemp = path;
    files.set(path, 'another writer owns these bytes');
    throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  };
  await assert.rejects(refreshQuota(refreshConfig(['codex']), io), { code: 'EEXIST' });
  assert.equal(files.get(foreignTemp), 'another writer owns these bytes');
  assert.deepEqual(
    operations.filter(([op]) => op === 'unlink'),
    [],
  );
});

for (const phase of ['mkdirp', 'chmod'] as const) {
  test(`${phase} failure before temporary-file creation does not unlink anything`, async () => {
    const { io, operations } = refreshIO();
    io[phase] = async () => {
      throw new Error('permission denied');
    };
    await assert.rejects(refreshQuota(refreshConfig(['codex']), io), /permission denied/);
    assert.deepEqual(
      operations.filter(([op]) => op === 'unlink' || op === 'write'),
      [],
    );
  });
}

test('failed atomic rename cleans up its temporary file and does not claim written', async () => {
  const { io, files, operations } = refreshIO();
  const dest = `${quotaDir}/codex.json`;
  const previous = storedSnapshot('codex');
  files.set(dest, previous);
  io.rename = async () => {
    throw new Error('rename failed');
  };
  await assert.rejects(refreshQuota(refreshConfig(['codex']), io));
  const temp = operations.find(([op]) => op === 'write')?.[1];
  assert.ok(typeof temp === 'string');
  assert.equal(files.has(temp), false);
  assert.deepEqual(
    operations.filter(([op]) => op === 'unlink'),
    [['unlink', temp]],
  );
  assert.equal(files.get(dest), previous);
});

test('invalid input paths and clock reject before HTTP or writes', async () => {
  for (const env of [
    { HOME: 'relative' },
    { HOME: '/home', CODEX_HOME: '' },
    { HOME: '/home', XDG_STATE_HOME: 'relative' },
  ]) {
    const { io, operations, requests } = refreshIO();
    io.env = env;
    await assert.rejects(
      refreshQuota(refreshConfig(['codex']), io),
      (error: unknown) => error instanceof StewardError && error.code === 'invalid_input',
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(
      operations.filter(([op]) => op !== 'read'),
      [],
    );
  }
  const { io, requests } = refreshIO();
  io.now = () => new Date(NaN);
  await assert.rejects(
    refreshQuota(refreshConfig(['codex']), io),
    (error: unknown) => error instanceof StewardError && error.code === 'invalid_input',
  );
  assert.deepEqual(requests, []);
});

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
