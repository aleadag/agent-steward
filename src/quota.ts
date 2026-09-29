import { SnapshotSchema, StewardError } from './contracts.js';
import type {
  Account,
  Config,
  Diagnostic,
  QuotaFacts,
  QuotaWindow,
  QuotaWindowFact,
  ReadText,
  Snapshot,
} from './contracts.js';
import { assertByteLength, assertJsonDepth } from './limits.js';
import { compareRfc3339Timestamps } from './timestamps.js';

type SnapshotLoad =
  | { status: 'loaded'; snapshot: Snapshot }
  | { status: 'missing' | 'unreadable' | 'malformed' | 'identity_mismatch' };

const applies = (window: QuotaWindow, pool: string): boolean =>
  window.scope.type === 'account' || window.scope.pool_id === pool;

async function readSnapshot(account: Account, readText: ReadText, diagnostic: Diagnostic): Promise<SnapshotLoad> {
  if (account.snapshot === undefined) {
    diagnostic('quota_missing');
    return { status: 'missing' };
  }

  let text: string;
  try {
    text = await readText(account.snapshot);
  } catch {
    diagnostic('quota_unreadable');
    return { status: 'unreadable' };
  }

  let snapshot: Snapshot;
  try {
    assertByteLength(text);
    const parsed: unknown = JSON.parse(text);
    assertJsonDepth(parsed);
    snapshot = SnapshotSchema.parse(parsed);
  } catch {
    diagnostic('quota_malformed');
    return { status: 'malformed' };
  }

  if (snapshot.source !== account.source || snapshot.account_id !== account.id) {
    diagnostic('quota_identity_mismatch');
    return { status: 'identity_mismatch' };
  }
  return { status: 'loaded', snapshot };
}

function classifyWindow(window: QuotaWindow, now: string): QuotaWindowFact {
  const reason =
    compareRfc3339Timestamps(window.observed_at, now) > 0
      ? 'future_observation'
      : compareRfc3339Timestamps(window.reset_at, now) <= 0
        ? 'reset_passed'
        : compareRfc3339Timestamps(window.valid_until, now) <= 0
          ? 'expired'
          : null;

  return {
    status: reason === null ? 'known' : 'unknown',
    reason,
    scope: window.scope,
    remaining_percent: reason === null ? window.remaining_percent : null,
    reset_at: window.reset_at,
    observed_at: window.observed_at,
    valid_until: window.valid_until,
  };
}

function summaryStatus(windows: readonly QuotaWindowFact[]): 'known' | 'unknown' {
  return windows.length > 0 && windows.every((window) => window.status === 'known') ? 'known' : 'unknown';
}

export async function loadQuota(
  config: Config,
  io: {
    readText: ReadText;
    now: Date;
    diagnostic: Diagnostic;
  },
): Promise<Map<string, QuotaFacts>> {
  const nowMilliseconds = io.now.getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new StewardError('invalid_input');
  const now = io.now.toISOString();

  const enabled = new Set(config.tools);
  const accounts = new Map(config.accounts.map((account) => [account.id, account]));
  const cache = new Map<string, Promise<SnapshotLoad>>();
  const result = new Map<string, QuotaFacts>();

  for (const candidate of config.candidates) {
    if (!enabled.has(candidate.tool)) continue;

    const account = accounts.get(candidate.account_id);
    if (account === undefined) throw new StewardError('invalid_config');

    let loaded = cache.get(account.id);
    if (loaded === undefined) {
      loaded = readSnapshot(account, io.readText, io.diagnostic);
      cache.set(account.id, loaded);
    }
    const snapshotLoad = await loaded;

    let windows: QuotaWindowFact[] = [];
    let accountStatus: 'known' | 'unknown' = 'unknown';
    let poolStatus: 'known' | 'unknown' = 'unknown';
    if (snapshotLoad.status === 'loaded') {
      const relevant = snapshotLoad.snapshot.windows.filter((window) => applies(window, candidate.quota_pool));
      windows = relevant.map((window) => classifyWindow(window, now));
      const accountWindows = windows.filter((window) => window.scope.type === 'account');
      const poolWindows = windows.filter((window) => window.scope.type === 'pool');
      accountStatus = summaryStatus(accountWindows);
      poolStatus = poolWindows.length > 0 ? summaryStatus(windows) : 'unknown';
      if (windows.some((window) => window.status === 'unknown')) io.diagnostic('quota_stale');
    }

    result.set(candidate.id, {
      source: account.source,
      account_id: account.id,
      pool_id: candidate.quota_pool,
      snapshot_status: snapshotLoad.status,
      account_status: accountStatus,
      pool_status: poolStatus,
      windows,
    });
  }

  return result;
}
