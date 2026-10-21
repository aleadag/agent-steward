import type { PlannedCommand, Tool } from './contracts.ts';

const PI_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function isPiThinkingLevel(level: string): boolean {
  return PI_EFFORTS.has(level);
}

export function nativeRoute(candidate: { tool: Tool; provider: string; model: string }): {
  identity: string;
  model_key: string;
  provider_selection: PlannedCommand['provider_selection'];
} {
  const providerSelection = candidate.tool === 'agy' ? 'existing_settings' : 'explicit_flag';
  let provider = candidate.provider;
  let model = candidate.model;
  if (candidate.tool === 'pi') {
    provider = provider.toLowerCase();
    model = model.trim().toLowerCase();
    // A collision key, not a registry lookup: literal IDs and native argv stay untouched.
    // Strip possible aliases conservatively without materializing an unbounded alias list.
    let start = 0;
    let end = model.length;
    while (start < end) {
      const slash = model.indexOf('/', start);
      if (slash === -1 || model.slice(start, slash).trim() !== provider.trim()) break;
      start = slash + 1;
    }
    while (end > start) {
      while (end > start && /\s/u.test(model[end - 1]!)) end--;
      const colon = model.lastIndexOf(':', end - 1);
      if (colon < start || !isPiThinkingLevel(model.slice(colon + 1, end))) break;
      end = colon;
    }
    model = model.slice(start, end).trim();
  }
  return {
    identity: JSON.stringify([candidate.tool, providerSelection === 'explicit_flag' ? provider : null, model]),
    model_key: model,
    provider_selection: providerSelection,
  };
}
