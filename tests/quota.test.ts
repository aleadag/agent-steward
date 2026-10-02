import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileText } from '../src/io.ts';
import { loadQuota as loadQuotaSource } from '../src/quota.ts';
import type { Config, QuotaFacts, QuotaWindowFact } from '../src/contracts.ts';
import { config, candidate, snapshot, windowFact } from './helpers.ts';

const now = new Date('2026-09-28T10:30:00Z');

type QuotaTestIO = Omit<Parameters<typeof loadQuotaSource>[1], 'env'> & {
  env?: { HOME?: string; XDG_STATE_HOME?: string };
};

async function loadQuota(config: Config, io: QuotaTestIO) {
  const input = { env: { HOME: '/isolated/home' }, ...io };
  const loaded = await loadQuotaSource(config, input);
  return {
    size: loaded.size,
    get(candidateId: string): QuotaFacts {
      const facts = loaded.get(candidateId);
      assert.ok(facts, `expected quota facts for ${candidateId}`);
      return facts;
    },
  };
}

function windowAt(facts: QuotaFacts, index: number): QuotaWindowFact {
  const window = facts.windows[index];
  assert.ok(window, `expected quota window at index ${index}`);
  return window;
}

function assertFactsUnknown(facts: QuotaFacts, status: QuotaFacts['snapshot_status']): void {
  assert.equal(facts.snapshot_status, status);
  assert.equal(facts.account_status, 'unknown');
  assert.equal(facts.pool_status, 'unknown');
  assert.deepEqual(facts.windows, []);
}

test('repository-local bucket files cannot supply known quota facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-quota-boundary-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(
      join(repo, 'codex'),
      JSON.stringify(snapshot([windowFact({ type: 'account' }, { remaining_percent: 100 })])),
    );
    const reads: string[] = [];
    const diagnostics: string[] = [];
    const quota = await loadQuota(config(), {
      env: { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') },
      now,
      readText: async (path) => {
        reads.push(path);
        return readFileText(resolve(repo, path));
      },
      diagnostic: (code) => diagnostics.push(code),
    });
    assertFactsUnknown(quota.get('codex-astra'), 'missing');
    assert.deepEqual(reads, [join(root, 'state/agent-steward/quota/codex.json')]);
    assert.deepEqual(diagnostics, ['quota_missing']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('quota reads use absolute generated-state paths with XDG precedence and HOME fallback', async () => {
  for (const [env, expected] of [
    [{ XDG_STATE_HOME: '/trusted/state', HOME: '/ignored/home' }, '/trusted/state/agent-steward/quota/pi_xai.json'],
    [{ XDG_STATE_HOME: '/trusted/state' }, '/trusted/state/agent-steward/quota/pi_xai.json'],
    [{ HOME: '/trusted/home' }, '/trusted/home/.local/state/agent-steward/quota/pi_xai.json'],
    [{ XDG_STATE_HOME: '', HOME: '/trusted/home' }, '/trusted/home/.local/state/agent-steward/quota/pi_xai.json'],
  ] as const) {
    const reads: string[] = [];
    const quota = await loadQuota(config({ candidates: [candidate({ tool: 'pi', quota_bucket: 'pi_xai' })] }), {
      env,
      now,
      readText: async (path) => {
        reads.push(path);
        return JSON.stringify(snapshot([windowFact({ type: 'account' })], { source: 'pi_xai' }));
      },
      diagnostic: () => {},
    });
    assert.deepEqual(reads, [expected]);
    assert.equal(quota.get('codex-astra').account_status, 'known');
  }
});

test('relative or missing state roots fail closed before reading quota', async () => {
  for (const env of [{ XDG_STATE_HOME: 'relative', HOME: '/trusted/home' }, { HOME: 'relative' }, {}, { HOME: '' }]) {
    let reads = 0;
    await assert.rejects(
      loadQuota(config(), {
        env,
        now,
        readText: async () => {
          reads++;
          return JSON.stringify(snapshot([windowFact({ type: 'account' })]));
        },
        diagnostic: () => {},
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_input',
    );
    assert.equal(reads, 0);
  }
});

test('shared read does not borrow another pool at reset boundary', async () => {
  const cfg = config({ candidates: [candidate(), candidate({ id: 'codex-other', quota_pool: 'absent' })] });
  const data = snapshot([
    windowFact({ type: 'account' }),
    windowFact({ type: 'pool', pool_id: 'primary' }, { reset_at: '2026-09-28T10:30:00Z' }),
    windowFact({ type: 'pool', pool_id: 'unrelated' }, { remaining_percent: 99 }),
  ]);
  let reads = 0;
  const quota = await loadQuota(cfg, {
    now,
    readText: async () => {
      reads++;
      return JSON.stringify(data);
    },
    diagnostic: () => {},
  });
  assert.equal(reads, 1);
  assert.equal(quota.get('codex-astra').account_status, 'known');
  assert.equal(quota.get('codex-astra').pool_status, 'unknown');
  assert.equal(quota.get('codex-other').pool_status, 'unknown');
  assert.deepEqual(
    quota.get('codex-other').windows.map((w) => w.scope),
    [{ type: 'account' }],
  );
  assert.equal(windowAt(quota.get('codex-astra'), 1).remaining_percent, null);
});

test('reads each referenced bucket once and does not mix equal pool IDs across buckets', async () => {
  const cfg = config({
    candidates: [
      candidate({ id: 'codex-first', quota_pool: 'primary' }),
      candidate({ id: 'codex-second', quota_pool: 'primary' }),
      candidate({ id: 'pi-primary', tool: 'pi', quota_bucket: 'pi_codex', quota_pool: 'primary' }),
    ],
  });
  const reads: string[] = [];
  const files: Record<string, string> = {
    '/isolated/home/.local/state/agent-steward/quota/codex.json': JSON.stringify(
      snapshot([windowFact({ type: 'pool', pool_id: 'primary' }, { remaining_percent: 20 })]),
    ),
    '/isolated/home/.local/state/agent-steward/quota/pi_codex.json': JSON.stringify(
      snapshot([windowFact({ type: 'pool', pool_id: 'primary' }, { remaining_percent: 80 })], {
        source: 'pi_codex',
      }),
    ),
  };
  const quota = await loadQuota(cfg, {
    now,
    readText: async (path) => {
      reads.push(path);
      const contents = files[path];
      assert.ok(contents !== undefined, `unexpected quota path: ${path}`);
      return contents;
    },
    diagnostic: () => {},
  });
  assert.deepEqual(reads.sort(), [
    '/isolated/home/.local/state/agent-steward/quota/codex.json',
    '/isolated/home/.local/state/agent-steward/quota/pi_codex.json',
  ]);
  assert.equal(windowAt(quota.get('codex-first'), 0).remaining_percent, 20);
  assert.equal(windowAt(quota.get('codex-second'), 0).remaining_percent, 20);
  assert.equal(windowAt(quota.get('pi-primary'), 0).remaining_percent, 80);
  assert.equal(quota.get('pi-primary').source, 'pi_codex');
  assert.equal(quota.get('pi-primary').quota_bucket, 'pi_codex');
});

test('disabled candidates and empty inventory do not read snapshots', async () => {
  for (const cfg of [config({ tools: ['pi'] }), config({ tools: [], candidates: [] })]) {
    let reads = 0;
    const quota = await loadQuota(cfg, {
      now,
      readText: async () => {
        reads++;
        throw new Error('must not read');
      },
      diagnostic: () => {},
    });
    assert.equal(reads, 0);
    assert.equal(quota.size, 0);
  }
});

test('unsupported bucket produces unknown facts and safe diagnostics without a read', async () => {
  const cfg = config({ candidates: [candidate({ tool: 'agy', quota_bucket: 'antigravity' })] });
  const diagnostics: string[] = [];
  const quota = await loadQuota(cfg, {
    now,
    readText: async () => {
      throw new Error('/private/quota.json');
    },
    diagnostic: (code) => diagnostics.push(code),
  });
  assertFactsUnknown(quota.get('codex-astra'), 'missing');
  assert.deepEqual(diagnostics, ['quota_missing']);
});

test('unreadable snapshots produce unknown facts without exposing read errors', async () => {
  const diagnostics: string[] = [];
  const quota = await loadQuota(config(), {
    now,
    readText: async () => {
      throw new Error('private path /home/user/quota.json');
    },
    diagnostic: (code) => diagnostics.push(code),
  });
  assertFactsUnknown(quota.get('codex-astra'), 'unreadable');
  assert.deepEqual(diagnostics, ['quota_unreadable']);
});

test('bad JSON, invalid dates, oversized text, and excessive depth are malformed unknown snapshots', async () => {
  const invalidDate = snapshot([windowFact({ type: 'account' }, { observed_at: '2026-99-28T10:00:00Z' })]);
  let tooDeep = null;
  for (let i = 0; i < 65; i++) tooDeep = [tooDeep];
  const inputs = ['{invalid json', JSON.stringify(invalidDate), 'x'.repeat(1_048_577), JSON.stringify(tooDeep)];
  for (const text of inputs) {
    const diagnostics: string[] = [];
    const quota = await loadQuota(config(), {
      now,
      readText: async () => text,
      diagnostic: (code) => diagnostics.push(code),
    });
    assertFactsUnknown(quota.get('codex-astra'), 'malformed');
    assert.deepEqual(diagnostics, ['quota_malformed']);
  }
});

test('snapshot source must match configured bucket', async () => {
  for (const data of [
    snapshot([windowFact({ type: 'account' })], { source: 'pi_codex' }),
    snapshot([windowFact({ type: 'account' })], { source: 'pi_xai' }),
  ]) {
    const diagnostics: string[] = [];
    const quota = await loadQuota(config(), {
      now,
      readText: async () => JSON.stringify(data),
      diagnostic: (code) => diagnostics.push(code),
    });
    assertFactsUnknown(quota.get('codex-astra'), 'identity_mismatch');
    assert.deepEqual(diagnostics, ['quota_identity_mismatch']);
  }
});

test('expired, reset, and future-observed windows retain dates but never usable capacity', async () => {
  const cfg = config();
  const data = snapshot([
    windowFact({ type: 'account' }, { valid_until: '2026-09-28T10:30:00Z' }),
    windowFact({ type: 'pool', pool_id: 'primary' }, { reset_at: '2026-09-28T10:30:00Z' }),
    windowFact(
      { type: 'pool', pool_id: 'primary' },
      { observed_at: '2026-09-28T10:31:00Z', valid_until: '2026-09-28T11:00:00Z' },
    ),
  ]);
  const diagnostics: string[] = [];
  const quota = await loadQuota(cfg, {
    now,
    readText: async () => JSON.stringify(data),
    diagnostic: (code) => diagnostics.push(code),
  });
  const facts = quota.get('codex-astra');
  assert.deepEqual(diagnostics, ['quota_stale']);
  assert.equal(facts.snapshot_status, 'loaded');
  assert.deepEqual(
    facts.windows.map((w) => [w.status, w.reason, w.remaining_percent]),
    [
      ['unknown', 'expired', null],
      ['unknown', 'reset_passed', null],
      ['unknown', 'future_observation', null],
    ],
  );
  assert.equal(windowAt(facts, 0).valid_until, '2026-09-28T10:30:00Z');
  assert.equal(facts.account_status, 'unknown');
  assert.equal(facts.pool_status, 'unknown');
});

test('every relevant window is retained in source order and any stale window makes its scope unknown', async () => {
  const data = snapshot([
    windowFact({ type: 'account' }, { remaining_percent: 0 }),
    windowFact({ type: 'account' }, { valid_until: '2026-09-28T10:29:59Z' }),
    windowFact({ type: 'pool', pool_id: 'primary' }, { remaining_percent: 25 }),
    windowFact({ type: 'pool', pool_id: 'other' }, { remaining_percent: 99 }),
  ]);
  const quota = await loadQuota(config(), { now, readText: async () => JSON.stringify(data), diagnostic: () => {} });
  const facts = quota.get('codex-astra');
  assert.deepEqual(
    facts.windows.map((w) => w.scope),
    [{ type: 'account' }, { type: 'account' }, { type: 'pool', pool_id: 'primary' }],
  );
  assert.equal(windowAt(facts, 0).status, 'known');
  assert.equal(windowAt(facts, 0).remaining_percent, 0);
  assert.equal(windowAt(facts, 1).status, 'unknown');
  assert.equal(windowAt(facts, 1).remaining_percent, null);
  assert.equal(facts.account_status, 'unknown');
  assert.equal(facts.pool_status, 'unknown');
});

test('RFC 3339 offsets compare by instant and zero quota remains known', async () => {
  const data = snapshot([
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T12:00:00+02:00',
        reset_at: '2026-09-28T14:00:00+02:00',
        valid_until: '2026-09-28T13:00:00+02:00',
        remaining_percent: 0,
      },
    ),
    windowFact(
      { type: 'pool', pool_id: 'primary' },
      {
        observed_at: '2026-09-28T12:00:00+02:00',
        reset_at: '2026-09-28T14:00:00+02:00',
        valid_until: '2026-09-28T13:00:00+02:00',
      },
    ),
  ]);
  const quota = await loadQuota(config(), { now, readText: async () => JSON.stringify(data), diagnostic: () => {} });
  const facts = quota.get('codex-astra');
  assert.equal(facts.account_status, 'known');
  assert.equal(facts.pool_status, 'known');
  assert.equal(windowAt(facts, 0).remaining_percent, 0);
});

test('schema-valid sub-millisecond snapshots load before clock freshness classification', async () => {
  const data = snapshot([
    windowFact(
      { type: 'account' },
      {
        observed_at: '2026-09-28T10:30:00.0001Z',
        reset_at: '2026-09-28T10:30:00.0002Z',
        valid_until: '2026-09-28T10:30:00.0003Z',
      },
    ),
  ]);
  const diagnostics: string[] = [];
  const quota = await loadQuota(config(), {
    now,
    readText: async () => JSON.stringify(data),
    diagnostic: (code) => diagnostics.push(code),
  });
  const facts = quota.get('codex-astra');
  assert.equal(facts.snapshot_status, 'loaded');
  assert.deepEqual(diagnostics, ['quota_stale']);
  assert.equal(windowAt(facts, 0).status, 'unknown');
  assert.equal(windowAt(facts, 0).reason, 'future_observation');
  assert.equal(windowAt(facts, 0).remaining_percent, null);
});

test('fractional-second RFC 3339 boundaries retain precision beyond Date milliseconds', async () => {
  const data = snapshot([
    windowFact({ type: 'account' }, { valid_until: '2026-09-28T10:30:00.0001Z' }),
    windowFact({ type: 'account' }, { observed_at: '2026-09-28T10:30:00.0001Z' }),
    windowFact({ type: 'pool', pool_id: 'primary' }, { reset_at: '2026-09-28T10:30:00.0001Z' }),
  ]);
  const quota = await loadQuota(config(), { now, readText: async () => JSON.stringify(data), diagnostic: () => {} });
  const facts = quota.get('codex-astra');
  assert.deepEqual(
    facts.windows.map((w) => [w.status, w.reason]),
    [
      ['known', null],
      ['unknown', 'future_observation'],
      ['known', null],
    ],
  );
});

test('no matching pool window remains unknown despite known account-wide measurements', async () => {
  const data = snapshot([windowFact({ type: 'account' })]);
  const quota = await loadQuota(config(), { now, readText: async () => JSON.stringify(data), diagnostic: () => {} });
  assert.equal(quota.get('codex-astra').account_status, 'known');
  assert.equal(quota.get('codex-astra').pool_status, 'unknown');
});
