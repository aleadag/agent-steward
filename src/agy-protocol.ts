import type { AgyCapture } from './agy-hook.ts';
import { SnapshotSchema } from './contracts.ts';

export type AgyPhase = 'starting' | 'recognizing' | 'refreshing' | 'complete' | 'failed';
export type AgyAction = { kind: 'write'; text: '/usage' | '\r' | '\x1b' } | { kind: 'stop' };
export type AgyEvent =
  | { kind: 'terminal'; bytes: Uint8Array }
  | { kind: 'capture'; observation: AgyCapture }
  | { kind: 'deadline' }
  | { kind: 'exit'; code: number };
type Failure = { status: 'auth' | 'fetch'; diagnostic?: 'quota_agy_trust' };
export type AgyProtocol = {
  accept: (event: AgyEvent) => AgyAction[];
  result: () => { observation: AgyCapture } | Failure | null;
};
export function createAgyProtocol(requestId: string, now: () => Date): AgyProtocol {
  let phase: AgyPhase = 'starting';
  let output = '',
    bytes = 0,
    refreshAt = 0,
    panelSeen = false;
  let captured: AgyCapture | null = null,
    failure: Failure | null = null;
  const decoder = new TextDecoder();
  const fail = (status: 'auth' | 'fetch', diagnostic?: 'quota_agy_trust'): AgyAction[] => {
    phase = 'failed';
    failure = { status, ...(diagnostic ? { diagnostic } : {}) };
    output = '';
    captured = null;
    return [{ kind: 'stop' }];
  };
  return {
    result: () => failure ?? (phase === 'complete' && captured ? { observation: captured } : null),
    accept(event) {
      if (phase === 'complete' || phase === 'failed') return [];
      if (event.kind === 'deadline' || event.kind === 'exit') return fail('fetch');
      if (event.kind === 'capture') {
        const value = event.observation;
        const timestamp = SnapshotSchema.shape.windows.element.shape.observed_at.safeParse(value.observedAt);
        if (
          phase !== 'refreshing' ||
          value.requestId !== requestId ||
          !timestamp.success ||
          Date.parse(timestamp.data) <= refreshAt ||
          Date.parse(timestamp.data) > now().getTime()
        )
          return [];
        if (
          !value.quota ||
          typeof value.quota !== 'object' ||
          Array.isArray(value.quota) ||
          Object.keys(value.quota).length === 0
        )
          return [];
        captured = value;
      } else {
        bytes += event.bytes.byteLength;
        if (bytes > 1048576) return fail('fetch');
        output += decoder.decode(event.bytes, { stream: true });
        // Decode only completed control sequences; the retained suffix handles split chunks.
        const visible = output
          // eslint-disable-next-line no-control-regex -- Native OSC framing.
          .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
          // eslint-disable-next-line no-control-regex -- Native CSI framing.
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .toLowerCase();
        if (/do you trust|trust this folder|trust the contents/.test(visible)) return fail('fetch', 'quota_agy_trust');
        if (/select login method|authorization code|click here to authenticate/.test(visible)) return fail('auth');
        if (
          /settings error|unknown command|(?:failed|error|unable|could not)[^\n]{0,120}(?:quota|usage)|(?:quota|usage)[^\n]{0,120}(?:failed|error)/.test(
            visible,
          )
        )
          return fail('fetch');
        if (phase === 'starting' && />\s*(?:accept-edits|plan|normal) mode:/.test(visible)) {
          phase = 'recognizing';
          output = '';
          return [{ kind: 'write', text: '/usage' }];
        }
        if (phase === 'recognizing' && /(?:^|[>\r\n])\s*\/usage\s+view model quota usage/.test(visible)) {
          phase = 'refreshing';
          refreshAt = now().getTime();
          output = '';
          return [{ kind: 'write', text: '\r' }];
        }
        if (phase === 'refreshing' && /models & quota/.test(visible) && /esc\s+close/.test(visible)) panelSeen = true;
      }
      if (panelSeen && captured) {
        phase = 'complete';
        output = '';
        return [{ kind: 'write', text: '\x1b' }, { kind: 'stop' }];
      }
      return [];
    },
  };
}
