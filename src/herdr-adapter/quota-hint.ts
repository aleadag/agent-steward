import { loadConfig } from '../config.ts';
import { loadQuota } from '../quota.ts';
import { nativeRoute } from '../native-route.ts';
import type { ConfigEnv, ReadText, SubscriptionCandidate } from '../contracts.ts';
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
    const enabled = config.candidates.filter(
      (candidate) => config.tools.includes(candidate.tool) && candidate.tool === observed.agent,
    );
    const literalMatches = enabled.filter((candidate) => mentions(observed.context, candidate.model));
    if (new Set(literalMatches.map((candidate) => candidate.model)).size !== 1) return null;
    const modelKeys = new Set(literalMatches.map((candidate) => nativeRoute(candidate).model_key));
    const matches = enabled.filter((candidate) => modelKeys.has(nativeRoute(candidate).model_key));
    const subscriptions = matches.filter(
      (candidate): candidate is SubscriptionCandidate => candidate.billing === 'subscription',
    );
    if (subscriptions.length !== matches.length) return null;
    const mappings = new Set(
      subscriptions.map((candidate) =>
        JSON.stringify([
          candidate.billing,
          nativeRoute(candidate).identity,
          candidate.quota_bucket,
          candidate.quota_pool,
        ]),
      ),
    );
    if (mappings.size !== 1) return null;
    const candidate = subscriptions[0]!;
    const facts = await loadQuota({ ...config, candidates: [candidate] }, { ...io, diagnostic: () => {} });
    const quota = facts.get(candidate.id);
    if (quota === undefined || !('windows' in quota)) return null;
    const windows = quota.windows;
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
