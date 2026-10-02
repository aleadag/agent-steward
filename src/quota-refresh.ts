import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { SnapshotSchema, StewardError } from './contracts.ts';
import type { QuotaWindow, SnapshotSource } from './contracts.ts';
import { compareRfc3339Timestamps } from './timestamps.ts';

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

function tokenClaims(access: string, now: Date, requireExpiry: boolean): Record<string, unknown> | null {
  const parts = access.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !parts[0] || !parts[2] || !payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const claims = parseRecord(Buffer.from(payload, 'base64url').toString('utf8'));
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

export function mapGrokBilling(payload: unknown, observedAt: string): MappedWindows {
  const config = record(record(payload)?.config);
  const period = record(config?.currentPeriod);
  const reset = timestampSchema.safeParse(period?.end).success ? period?.end : config?.billingPeriodEnd;
  const start = timestampSchema.safeParse(period?.start);
  const end = timestampSchema.safeParse(reset);
  const weekly = start.success && end.success && Date.parse(end.data) - Date.parse(start.data) === 168 * 3600_000;
  const window = mapWindow(config?.creditUsagePercent, reset, observedAt, 'credits', weekly ? 'weekly' : 'other');
  return window === null ? { status: 'malformed' } : { windows: [window] };
}
