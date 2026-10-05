import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { SnapshotSchema, StewardError } from './contracts.ts';
import type { Config, QuotaBucket, QuotaWindow, ReadText, SnapshotSource } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';
import { assertNoCredentials } from './privacy.ts';
import { quotaFile } from './quota.ts';
import { compareRfc3339Timestamps } from './timestamps.ts';
import { agyPaths } from './agy-setup.ts';
import type { AgyPaths } from './agy-setup.ts';
import { readAgyIdentity } from './agy-auth.ts';
import { mapAgyQuota } from './agy-quota.ts';
import type { NativeAgyResult } from './agy-runtime.ts';

type HttpSnapshotSource = Exclude<SnapshotSource, 'antigravity'>;

type AuthFailure = { status: 'auth' };
type MappedWindows = { windows: QuotaWindow[] } | { status: 'malformed' };
type AuthEnv = { CODEX_HOME?: string; PI_CODING_AGENT_DIR?: string; HOME?: string };

const windowSchema = SnapshotSchema.shape.windows.element;
const timestampSchema = windowSchema.shape.reset_at;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function decodeClaims(access: string): Record<string, unknown> | null {
  const parts = access.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !parts[0] || !parts[2] || !payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  return parseRecord(Buffer.from(payload, 'base64url').toString('utf8'));
}

function tokenClaims(access: string, now: Date, requireExpiry: boolean): Record<string, unknown> | null {
  const claims = decodeClaims(access);
  if (claims === null || !Number.isFinite(now.getTime())) return null;
  if (requireExpiry || claims.exp !== undefined) {
    if (!finite(claims.exp) || claims.exp <= now.getTime() / 1000) return null;
  }
  return claims;
}

function codexIdentity(claims: Record<string, unknown>): unknown {
  return record(claims['https://api.openai.com/auth'])?.chatgpt_account_id;
}

export function fingerprint(bucket: SnapshotSource, identity: string): string {
  return createHash('sha256').update(`${bucket}:${identity}`).digest('hex');
}

export function readCodexAuth(
  text: string,
  now: Date,
): { access: string; accountId: string; fingerprint: string } | AuthFailure {
  const auth = parseRecord(text);
  if (auth?.auth_mode !== 'chatgpt') return { status: 'auth' };
  const access = record(auth.tokens)?.access_token;
  if (!nonempty(access)) return { status: 'auth' };
  const claims = tokenClaims(access, now, true);
  const accountId = claims === null ? null : codexIdentity(claims);
  if (!nonempty(accountId)) return { status: 'auth' };
  return { access, accountId, fingerprint: fingerprint('codex', accountId) };
}

export function readPiAuth(
  text: string,
  provider: 'openai-codex' | 'xai',
  now: Date,
): { access: string; fingerprint: string } | AuthFailure {
  const auth = record(parseRecord(text)?.[provider]);
  if (auth?.type !== 'oauth' || !nonempty(auth.access) || !finite(auth.expires) || auth.expires <= now.getTime())
    return { status: 'auth' };
  const claims = tokenClaims(auth.access, now, false);
  if (claims === null) return { status: 'auth' };
  const identity =
    provider === 'openai-codex'
      ? codexIdentity(claims)
      : nonempty(claims.principal_id)
        ? claims.principal_id
        : claims.sub;
  if (!nonempty(identity)) return { status: 'auth' };
  return {
    access: auth.access,
    fingerprint: fingerprint(provider === 'openai-codex' ? 'pi_codex' : 'pi_xai', identity),
  };
}

export function authPath(kind: 'codex' | 'pi', env: AuthEnv): string {
  const root = kind === 'codex' ? env.CODEX_HOME : env.PI_CODING_AGENT_DIR;
  if (root !== undefined) {
    if (!isAbsolute(root)) throw new StewardError('invalid_input');
    return join(root, 'auth.json');
  }
  if (env.HOME === undefined || !isAbsolute(env.HOME)) throw new StewardError('invalid_input');
  return kind === 'codex' ? join(env.HOME, '.codex', 'auth.json') : join(env.HOME, '.pi', 'agent', 'auth.json');
}

function mapWindow(
  used: unknown,
  reset: unknown,
  observedAt: string,
  id: string,
  cadence: 'weekly' | 'other',
): QuotaWindow | null {
  if (!finite(used) || used < 0 || used > 100) return null;
  const resetTime = timestampSchema.safeParse(reset);
  if (!resetTime.success || !timestampSchema.safeParse(observedAt).success) return null;
  // Preserve RFC 3339 fractional precision when adding the one-hour validity cap.
  const fraction = observedAt.match(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/)?.[0] ?? '.000';
  const hourLater = new Date(Date.parse(observedAt) + 3600_000).toISOString().replace(/\.\d+Z$/, `${fraction}Z`);
  const validUntil = compareRfc3339Timestamps(resetTime.data, hourLater) <= 0 ? resetTime.data : hourLater;
  const mapped = windowSchema.safeParse({
    scope: { type: 'account' },
    id,
    cadence,
    remaining_percent: Math.max(0, Math.min(100, 100 - used)),
    observed_at: observedAt,
    reset_at: resetTime.data,
    valid_until: validUntil,
  });
  return mapped.success ? mapped.data : null;
}

function codexWindow(value: unknown, observedAt: string, id: string): QuotaWindow | null {
  const window = record(value);
  if (window === null || !finite(window.limit_window_seconds) || window.limit_window_seconds <= 0) return null;
  let reset = window.reset_at;
  if (typeof reset === 'number') {
    const date = new Date(reset * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    reset = date.toISOString();
  }
  return mapWindow(
    window.used_percent,
    reset,
    observedAt,
    id,
    window.limit_window_seconds === 604800 ? 'weekly' : 'other',
  );
}

export function mapCodexUsage(payload: unknown, observedAt: string): MappedWindows {
  const data = record(payload);
  const limit = record(data?.rate_limit);
  const primary = codexWindow(limit?.primary_window, observedAt, 'primary');
  if (primary === null) return { status: 'malformed' };
  const windows = [primary];
  if (limit?.secondary_window != null) {
    const secondary = codexWindow(limit.secondary_window, observedAt, 'secondary');
    if (secondary === null) return { status: 'malformed' };
    windows.push(secondary);
  }
  const additional = data?.additional_rate_limits;
  if (additional != null) {
    if (!Array.isArray(additional)) return { status: 'malformed' };
    for (const [index, value] of additional.entries()) {
      const entry = record(value);
      const rate = record(entry?.rate_limit);
      const id = nonempty(entry?.limit_name) ? entry.limit_name : `additional-${index}`;
      for (const value of [rate?.primary_window, rate?.secondary_window]) {
        if (value == null) continue;
        const window = codexWindow(value, observedAt, id);
        if (window === null) return { status: 'malformed' };
        windows.push(window);
      }
    }
  }
  return { windows };
}

export type QuotaHttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export type QuotaRefreshIO = {
  env: AuthEnv & { XDG_STATE_HOME?: string };
  now: () => Date;
  readText: ReadText;
  mkdirp: (path: string, mode: number) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  writeText: (path: string, text: string, mode: number) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  httpGet: QuotaHttpGet;
  collectAgy: (paths: AgyPaths, requestId: string) => Promise<NativeAgyResult>;
  withAgyLock: <T>(file: string, action: () => Promise<T>) => Promise<T>;
  diagnostic?: (code: 'quota_agy_setup' | 'quota_agy_trust') => void;
};

type RefreshStatus = 'written' | 'unsupported' | 'auth' | 'fetch' | 'malformed';

// Identity survives expiry solely to invalidate another login's snapshot. It never
// authorizes a request; the public auth readers still gate every HTTP call.
function credentialIdentity(bucket: HttpSnapshotSource, text: string): string | null {
  const auth = parseRecord(text);
  const access =
    bucket === 'codex'
      ? record(auth?.tokens)?.access_token
      : record(auth?.[bucket === 'pi_codex' ? 'openai-codex' : 'xai'])?.access;
  if (!nonempty(access)) return null;
  const claims = decodeClaims(access);
  if (claims === null) return null;
  const identity =
    bucket === 'pi_xai' ? (nonempty(claims.principal_id) ? claims.principal_id : claims.sub) : codexIdentity(claims);
  return nonempty(identity) ? identity : null;
}

async function unlinkIfPresent(path: string, io: QuotaRefreshIO): Promise<void> {
  try {
    await io.unlink(path);
  } catch (error) {
    if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

async function invalidatePrevious(dest: string, identityFingerprint: string | null, io: QuotaRefreshIO): Promise<void> {
  if (identityFingerprint === null) return;
  let previous;
  try {
    const text = await io.readText(dest);
    assertByteLength(text);
    const parsed: unknown = JSON.parse(text);
    assertJsonDepth(parsed);
    previous = SnapshotSchema.parse(parsed);
  } catch {
    return;
  }
  if (previous.identity_fingerprint !== identityFingerprint) await unlinkIfPresent(dest, io);
}

async function collectWindows(
  bucket: HttpSnapshotSource,
  access: string,
  identity: string,
  observedAt: string,
  httpGet: QuotaHttpGet,
): Promise<MappedWindows | { status: 'fetch' }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    Accept: 'application/json',
    'User-Agent': 'agent-steward-quota-refresh',
  };
  const grok = bucket === 'pi_xai';
  headers[grok ? 'x-xai-token-auth' : 'ChatGPT-Account-Id'] = grok ? 'xai-grok-cli' : identity;
  let body: string;
  try {
    const response = await httpGet(
      grok ? 'https://cli-chat-proxy.grok.com/v1/billing?format=credits' : 'https://chatgpt.com/backend-api/wham/usage',
      headers,
    );
    if (response.status !== 200) return { status: 'fetch' };
    assertByteLength(response.body);
    body = response.body;
  } catch {
    return { status: 'fetch' };
  }
  try {
    const payload: unknown = JSON.parse(body);
    assertJsonDepth(payload);
    return grok ? mapGrokBilling(payload, observedAt) : mapCodexUsage(payload, observedAt);
  } catch {
    return { status: 'malformed' };
  }
}

export async function refreshQuota(
  config: Config,
  io: QuotaRefreshIO,
): Promise<{ buckets: { bucket: QuotaBucket; status: RefreshStatus }[] }> {
  const now = io.now();
  if (!Number.isFinite(now.getTime())) throw new StewardError('invalid_input');
  const enabled = new Set(config.tools);
  const buckets = new Set(
    config.candidates.filter((candidate) => enabled.has(candidate.tool)).map((candidate) => candidate.quota_bucket),
  );
  const result: { bucket: QuotaBucket; status: RefreshStatus }[] = [];
  for (const bucket of buckets) {
    if (bucket === 'antigravity') {
      result.push({ bucket, status: await refreshAgy(io) });
      continue;
    }
    const dest = quotaFile(io.env, bucket);
    const path = authPath(bucket === 'codex' ? 'codex' : 'pi', io.env);
    let text: string;
    try {
      text = await io.readText(path);
    } catch {
      result.push({ bucket, status: 'auth' });
      continue;
    }
    const identity = credentialIdentity(bucket, text);
    const identityFingerprint = identity === null ? null : fingerprint(bucket, identity);
    const auth =
      bucket === 'codex'
        ? readCodexAuth(text, now)
        : readPiAuth(text, bucket === 'pi_codex' ? 'openai-codex' : 'xai', now);
    if ('status' in auth || identity === null) {
      await invalidatePrevious(dest, identityFingerprint, io);
      result.push({ bucket, status: 'auth' });
      continue;
    }
    const mapped = await collectWindows(bucket, auth.access, identity, now.toISOString(), io.httpGet);
    if ('status' in mapped) {
      await invalidatePrevious(dest, identityFingerprint, io);
      result.push({ bucket, status: mapped.status });
      continue;
    }
    let serialized: string;
    try {
      const snapshot = SnapshotSchema.parse({
        schema_version: 1,
        source: bucket,
        identity_fingerprint: identityFingerprint,
        windows: mapped.windows,
      });
      // Provider labels are untrusted: reject identity substrings and any email
      // separator before they can reach disk, routing output, or Jev state.
      if (snapshot.windows.some(({ id }) => id?.includes(identity) || id?.includes('@')))
        throw new StewardError('credential_detected');
      // A schema-validated snapshot always serializes to a string.
      serialized = assertNoCredentials(snapshot, auth.access)!;
      assertByteLength(serialized);
    } catch {
      await invalidatePrevious(dest, identityFingerprint, io);
      result.push({ bucket, status: 'malformed' });
      continue;
    }
    await writeQuotaSnapshot(dest, serialized, identityFingerprint, io);
    result.push({ bucket, status: 'written' });
  }
  return { buckets: result };
}

export async function writeQuotaSnapshot(
  dest: string,
  serialized: string,
  identityFingerprint: string | null,
  io: QuotaRefreshIO,
): Promise<void> {
  assertByteLength(serialized);
  SnapshotSchema.parse(JSON.parse(serialized));
  const temp = `${dest}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await io.mkdirp(dirname(dest), 0o700);
    await io.chmod(dirname(dest), 0o700);
    await io.writeText(temp, serialized, 0o600);
    created = true;
    await io.rename(temp, dest);
  } catch (error) {
    if (created) await unlinkIfPresent(temp, io);
    await invalidatePrevious(dest, identityFingerprint, io);
    throw error;
  }
}
async function refreshAgy(io: QuotaRefreshIO): Promise<RefreshStatus> {
  const paths = agyPaths(io.env),
    dest = quotaFile(io.env, 'antigravity');
  const identity = async () => {
    try {
      return readAgyIdentity(await io.readText(paths.auth));
    } catch {
      return null;
    }
  };
  try {
    return await io.withAgyLock(dest, async () => {
      const before = await identity();
      if (!before) {
        await unlinkIfPresent(dest, io);
        return 'auth';
      }
      await invalidatePrevious(dest, before.identityFingerprint, io);
      if (Date.parse(before.expiresAt) <= io.now().getTime() && !before.renewable) return 'auth';
      let collected: NativeAgyResult;
      try {
        collected = await io.collectAgy(paths, randomUUID());
      } catch {
        collected = { status: 'fetch' };
      }
      const after = await identity();
      if (!after || after.identityFingerprint !== before.identityFingerprint) {
        await unlinkIfPresent(dest, io);
        return 'auth';
      }
      if (Date.parse(after.expiresAt) <= io.now().getTime()) return 'auth';
      if (collected.status !== 'captured') {
        if (collected.diagnostic === 'quota_agy_setup' || collected.diagnostic === 'quota_agy_trust')
          io.diagnostic?.(collected.diagnostic);
        return collected.status;
      }
      const mapped = mapAgyQuota(collected.observation.quota, collected.observation.observedAt);
      if ('status' in mapped) return mapped.status;
      const saved = SnapshotSchema.parse({
        schema_version: 1,
        source: 'antigravity',
        identity_fingerprint: after.identityFingerprint,
        windows: mapped.windows,
      });
      const text = assertNoCredentials(saved, '')!;
      await writeQuotaSnapshot(dest, text, after.identityFingerprint, io);
      return 'written';
    });
  } catch {
    return 'fetch';
  }
}

export function mapGrokBilling(payload: unknown, observedAt: string): MappedWindows {
  const config = record(record(payload)?.config);
  const period = record(config?.currentPeriod);
  const reset = timestampSchema.safeParse(period?.end).success ? period?.end : config?.billingPeriodEnd;
  const start = timestampSchema.safeParse(period?.start);
  const end = timestampSchema.safeParse(reset);
  const weekly = start.success && end.success && Date.parse(end.data) - Date.parse(start.data) === 168 * 3600_000;
  const used = config?.creditUsagePercent === undefined ? 0 : config?.creditUsagePercent;
  const window = mapWindow(used, reset, observedAt, 'credits', weekly ? 'weekly' : 'other');
  return window === null ? { status: 'malformed' } : { windows: [window] };
}
