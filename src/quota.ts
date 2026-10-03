import { isAbsolute, join } from 'node:path';
import { SnapshotSchema, StewardError } from './contracts.ts';
import type {
  QuotaBucket,
  Config,
  Diagnostic,
  QuotaFacts,
  QuotaWindow,
  QuotaWindowFact,
  ReadText,
  Snapshot,
} from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';
import { compareRfc3339Timestamps } from './timestamps.ts';
import { completeAgyPools } from './agy-quota.ts';

type QuotaEnv = { XDG_STATE_HOME?: string; HOME?: string };

export function quotaFile(env: QuotaEnv, bucket: QuotaBucket): string {
  const state = env.XDG_STATE_HOME;
  if (state !== undefined && state.length > 0) {
    if (!isAbsolute(state)) throw new StewardError('invalid_input');
    return join(state, 'agent-steward', 'quota', `${bucket}.json`);
  }
  if (env.HOME === undefined || !isAbsolute(env.HOME)) throw new StewardError('invalid_input');
  return join(env.HOME, '.local', 'state', 'agent-steward', 'quota', `${bucket}.json`);
}

type SnapshotLoad =
  | { status: 'loaded'; snapshot: Snapshot }
  | { status: 'missing' | 'unreadable' | 'malformed' | 'identity_mismatch' };

const applies = (window: QuotaWindow, pool: string): boolean =>
  window.scope.type === 'account' || window.scope.pool_id === pool;

async function readSnapshot(
  bucket: QuotaBucket,
  env: QuotaEnv,
  readText: ReadText,
  diagnostic: Diagnostic,
): Promise<SnapshotLoad> {
  const file = quotaFile(env, bucket);
  let text: string;
  try {
    text = await readText(file);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      diagnostic('quota_missing');
      return { status: 'missing' };
    }
    diagnostic('quota_unreadable');
    return { status: 'unreadable' };
  }

  let parsed: unknown;
  try {
    assertByteLength(text);
    parsed = JSON.parse(text);
    assertJsonDepth(parsed);
  } catch {
    diagnostic('quota_malformed');
    return { status: 'malformed' };
  }

  const validated = SnapshotSchema.safeParse(parsed);
  if (!validated.success) {
    if (validated.error.issues.every((issue) => issue.path[0] === 'identity_fingerprint')) {
      diagnostic('quota_identity_mismatch');
      return { status: 'identity_mismatch' };
    }
    diagnostic('quota_malformed');
    return { status: 'malformed' };
  }
  const snapshot = validated.data;
  if (snapshot.source !== bucket) {
    diagnostic('quota_identity_mismatch');
    return { status: 'identity_mismatch' };
  }
  if (snapshot.source === 'antigravity') snapshot.windows = completeAgyPools(snapshot.windows);
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
    ...(window.id === undefined ? {} : { id: window.id }),
    ...(window.cadence === undefined ? {} : { cadence: window.cadence }),
    remaining_percent: reason === null ? window.remaining_percent : null,
    reset_at: window.reset_at,
    observed_at: window.observed_at,
    valid_until: window.valid_until,
  };
}

function summaryStatus(windows: readonly QuotaWindowFact[]): 'known' | 'unknown' {
  return windows.length > 0 && windows.every((window) => window.status === 'known') ? 'known' : 'unknown';
}

export async function inspectQuota(
  config: Config,
  io: { env: QuotaEnv; readText: ReadText; now: Date; diagnostic: Diagnostic },
) {
  if (!Number.isFinite(io.now.getTime())) throw new StewardError('invalid_input');
  const now = io.now.toISOString();
  const enabled = new Set(config.tools);
  const buckets = new Set(
    config.candidates.filter((candidate) => enabled.has(candidate.tool)).map((candidate) => candidate.quota_bucket),
  );
  const result = [];
  for (const bucket of buckets) {
    const loaded = await readSnapshot(bucket, io.env, io.readText, io.diagnostic);
    const windows =
      loaded.status === 'loaded'
        ? loaded.snapshot.windows.map((window) => ({
            ...classifyWindow(window, now),
            captured_remaining_percent: window.remaining_percent,
          }))
        : [];
    result.push({ bucket, status: loaded.status, windows });
  }
  return result;
}

export async function loadQuota(
  config: Config,
  io: {
    env: QuotaEnv;
    readText: ReadText;
    now: Date;
    diagnostic: Diagnostic;
  },
): Promise<Map<string, QuotaFacts>> {
  const nowMilliseconds = io.now.getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new StewardError('invalid_input');
  const now = io.now.toISOString();

  const enabled = new Set(config.tools);
  const cache = new Map<string, Promise<SnapshotLoad>>();
  const result = new Map<string, QuotaFacts>();

  for (const candidate of config.candidates) {
    if (!enabled.has(candidate.tool)) continue;

    const bucket = candidate.quota_bucket;
    let loaded = cache.get(bucket);
    if (loaded === undefined) {
      loaded = readSnapshot(bucket, io.env, io.readText, io.diagnostic);
      cache.set(bucket, loaded);
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
      source: bucket,
      quota_bucket: bucket,
      pool_id: candidate.quota_pool,
      snapshot_status: snapshotLoad.status,
      account_status: accountStatus,
      pool_status: poolStatus,
      windows,
    });
  }

  return result;
}
