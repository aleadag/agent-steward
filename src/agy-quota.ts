import { SnapshotSchema } from './contracts.ts';
import type { QuotaWindow } from './contracts.ts';
import { compareRfc3339Timestamps } from './timestamps.ts';

const windowSchema = SnapshotSchema.shape.windows.element;
export const AGY_POOL_PREFIXES = [
  ['gemini', 'gemini'],
  ['3p', 'third_party'],
] as const;
export function completeAgyPools(windows: QuotaWindow[]): QuotaWindow[] {
  return AGY_POOL_PREFIXES.flatMap(([prefix, pool]) => {
    const limits = windows.filter(
      (window) =>
        window.scope.type === 'pool' &&
        window.scope.pool_id === pool &&
        (window.id === `${prefix}-5h` || window.id === `${prefix}-weekly`),
    );
    return limits.some((window) => window.id === `${prefix}-5h`) &&
      limits.some((window) => window.id === `${prefix}-weekly`)
      ? limits
      : [];
  });
}
export function mapAgyQuota(quota: unknown, observedAt: string): { windows: QuotaWindow[] } | { status: 'malformed' } {
  const malformed = { status: 'malformed' } as const;
  if (
    !quota ||
    typeof quota !== 'object' ||
    Array.isArray(quota) ||
    !windowSchema.shape.observed_at.safeParse(observedAt).success
  )
    return malformed;
  const buckets = quota as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  for (const [prefix, pool] of AGY_POOL_PREFIXES) {
    const mapped: QuotaWindow[] = [];
    for (const [suffix, cadence] of [
      ['5h', 'other'],
      ['weekly', 'weekly'],
    ] as const) {
      const id = `${prefix}-${suffix}`;
      if (!(id in buckets)) continue;
      const value = buckets[id];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed;
      const bucket = value as Record<string, unknown>;
      const fraction = bucket.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return malformed;
      const absolute = windowSchema.shape.reset_at.safeParse(bucket.reset_time);
      let reset: string;
      if (absolute.success) reset = absolute.data;
      else {
        const seconds = bucket.reset_in_seconds;
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return malformed;
        const time = Date.parse(observedAt) + seconds * 1000;
        if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) return malformed;
        reset = new Date(time).toISOString();
      }
      const hour = new Date(Date.parse(observedAt) + 3600_000).toISOString();
      const validUntil = compareRfc3339Timestamps(reset, hour) < 0 ? reset : hour;
      const parsed = windowSchema.safeParse({
        id,
        cadence,
        scope: { type: 'pool', pool_id: pool },
        remaining_percent: fraction * 100,
        observed_at: observedAt,
        reset_at: reset,
        valid_until: validUntil,
      });
      if (!parsed.success) return malformed;
      mapped.push(parsed.data);
    }
    if (mapped.length === 2) windows.push(...mapped);
  }
  return windows.length ? { windows } : malformed;
}
