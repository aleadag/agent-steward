import { loadConfig } from '../config.ts';
import { loadQuota } from '../quota.ts';
import type { ConfigEnv, ReadText } from '../contracts.ts';
import type { ObservedStop } from './observe.ts';

export type QuotaHint = (observed: ObservedStop, now: Date) => Promise<string | null>;

function mentions(text: string, model: string): boolean {
  const token = /[A-Za-z0-9_./:-]/;
  for (let start = text.indexOf(model); start !== -1; start = text.indexOf(model, start + 1)) {
    const before = text[start - 1];
    const after = text[start + model.length];
    if ((!before || !token.test(before)) && (!after || !token.test(after))) return true;
  }
  return false;
}

export async function quotaResetHint(
  observed: ObservedStop,
  io: { env: ConfigEnv & { XDG_STATE_HOME?: string }; cwd: string; readText: ReadText; now: Date },
): Promise<string | null> {
  try {
    const config = await loadConfig(undefined, io);
    const matches = config.candidates.filter(
      (candidate) =>
        config.tools.includes(candidate.tool) &&
        candidate.tool === observed.agent &&
        mentions(observed.context, candidate.model),
    );
    if (new Set(matches.map((candidate) => candidate.model)).size !== 1) return null;
    const mappings = new Set(
      matches.map((candidate) => JSON.stringify([candidate.provider, candidate.quota_bucket, candidate.quota_pool])),
    );
    if (mappings.size !== 1) return null;
    const candidate = matches[0]!;
    const facts = await loadQuota({ ...config, candidates: [candidate] }, { ...io, diagnostic: () => {} });
    const windows = facts.get(candidate.id)?.windows ?? [];
    if (windows.length === 0 || windows.some((window) => window.status !== 'known')) return null;
    const exhausted = windows.filter((window) => window.remaining_percent === 0);
    if (exhausted.length === 0) return null;
    const reset = Math.max(...exhausted.map((window) => Date.parse(window.reset_at))) + 60_000;
    return Number.isFinite(reset) && reset > io.now.getTime() ? new Date(reset).toISOString() : null;
  } catch {
    // Optional screen hints may only advance polling, never prevent normal checks.
    return null;
  }
}
