import { createHash } from 'node:crypto';
import { assertNoCredentials } from '../privacy.ts';

export type AgentSnapshot = {
  pane_id: string;
  workspace_id: string;
  agent?: string | null;
  agent_status: string;
  agent_session?: { agent: string; source: string; kind: string; value: string } | null;
  revision: number;
  state_change_seq: number;
};
export type ReadSnapshot = {
  pane_id: string;
  source: string;
  revision: number;
  text: string;
  truncated: boolean;
  context_restricted?: true;
  capture_lines?: number;
};
export type HerdrReader = {
  list?: () => Promise<AgentSnapshot[]>;
  get: (paneId: string) => Promise<AgentSnapshot | null>;
  read: (paneId: string) => Promise<ReadSnapshot | null>;
  readFixed?: (paneId: string, lines: number) => Promise<ReadSnapshot | null>;
};
export type ObservedStop = {
  pane_id: string;
  workspace_id: string;
  agent: string;
  session_id: string;
  session_kind: string;
  session_source: string;
  status: 'blocked' | 'idle' | 'done';
  revision: number;
  state_change_seq: number;
  context: string;
  current_episode_id: string;
  error_evidence_digest: string;
  context_restricted?: true;
  capture_lines?: number;
};

export type ObservedWorking = Pick<
  ObservedStop,
  | 'pane_id'
  | 'workspace_id'
  | 'agent'
  | 'session_id'
  | 'session_kind'
  | 'session_source'
  | 'revision'
  | 'state_change_seq'
> & { status: 'working' };

export const observationPhases = ['request', 'before', 'read', 'after'] as const;
export const observationReasons = [
  'pane_invalid',
  'capture_size_invalid',
  'fixed_reader_missing',
  'missing',
  'failed',
  'pane_mismatch',
  'status_ineligible',
  'revision_invalid',
  'sequence_invalid',
  'workspace_mismatch',
  'agent_invalid',
  'session_invalid',
  'session_agent_mismatch',
  'session_kind_invalid',
  'session_source_invalid',
  'session_value_invalid',
  'session_changed',
  'workspace_changed',
  'agent_changed',
  'status_changed',
  'session_kind_changed',
  'session_source_changed',
  'revision_changed',
  'sequence_changed',
  'source_invalid',
  'truncated_invalid',
  'text_invalid',
  'restriction_invalid',
  'text_blank',
  'line_limit',
  'credentials',
  'byte_limit',
  'capture_size_mismatch',
] as const;
export type ObservationRejection = {
  phase: (typeof observationPhases)[number];
  reason: (typeof observationReasons)[number];
};
type RejectionSink = (failure: ObservationRejection) => void | Promise<void>;

function reportRejection(
  sink: RejectionSink | undefined,
  phase: ObservationRejection['phase'],
  reason: ObservationRejection['reason'],
): void {
  if (!sink) return;
  try {
    void Promise.resolve(sink({ phase, reason })).catch(() => {});
  } catch {
    // Reporting must not change observation or transport behavior.
  }
}

function hasControls(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject ASCII controls in session fields.
  return /[\x00-\x1f\x7f]/.test(value);
}

function field(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || hasControls(value)) return null;
  return value;
}

function identity(
  pane: AgentSnapshot,
  paneId: string,
  reject: (reason: ObservationRejection['reason']) => null,
  working = false,
): string | null {
  const session = pane.agent_session;
  if (pane.pane_id !== paneId) return reject('pane_mismatch');
  if (
    working
      ? pane.agent_status !== 'working'
      : pane.agent_status !== 'blocked' && pane.agent_status !== 'idle' && pane.agent_status !== 'done'
  )
    return reject('status_ineligible');
  if (!Number.isSafeInteger(pane.revision)) return reject('revision_invalid');
  if (!Number.isSafeInteger(pane.state_change_seq)) return reject('sequence_invalid');
  if (pane.workspace_id !== paneId.split(':')[0]) return reject('workspace_mismatch');
  const agent = field(pane.agent ?? undefined);
  const kind = field(session?.kind);
  const source = field(session?.source);
  const value = field(session?.value);
  if (!session) return reject('session_invalid');
  if (!agent) return reject('agent_invalid');
  if (session.agent !== agent) return reject('session_agent_mismatch');
  if (!kind) return reject('session_kind_invalid');
  if (!source) return reject('session_source_invalid');
  if (!value) return reject('session_value_invalid');
  if (hasControls(session.agent)) return reject('agent_invalid');
  return value;
}

// Oversized probes are never classification evidence. Scan their entire text
// before letting a caller retain a separately captured, bounded excerpt.
export function checkDetectionRead(
  read: ReadSnapshot | null,
  paneId: string,
  onRejected?: RejectionSink,
): 'valid' | 'oversized' | 'invalid' {
  const reject = (reason: ObservationRejection['reason'], result: 'invalid' | 'oversized' = 'invalid') => {
    reportRejection(onRejected, 'read', reason);
    return result;
  };
  if (!read) return reject('missing');
  if (read.pane_id !== paneId) return reject('pane_mismatch');
  if (read.source !== 'detection') return reject('source_invalid');
  if (!Number.isSafeInteger(read.revision) || read.revision < 0) return reject('revision_invalid');
  if (typeof read.truncated !== 'boolean') return reject('truncated_invalid');
  if (typeof read.text !== 'string') return reject('text_invalid');
  if (read.context_restricted !== undefined && read.context_restricted !== true) return reject('restriction_invalid');
  if (
    read.capture_lines !== undefined &&
    (!Number.isSafeInteger(read.capture_lines) || read.capture_lines < 1 || read.capture_lines > 48)
  )
    return reject('capture_size_invalid');
  const lines = read.text.split('\n');
  const lineCount = lines.length - (read.text.endsWith('\n') ? 1 : 0);
  if (!read.text.trim()) return reject('text_blank');
  if (lineCount > 48) return reject('line_limit');
  try {
    assertNoCredentials({ text: read.text }, process.env.TYPESAFE_API_KEY ?? '');
  } catch {
    return reject('credentials');
  }
  return Buffer.byteLength(read.text, 'utf8') > 2048 ? reject('byte_limit', 'oversized') : 'valid';
}

// Status is best-effort activity evidence, not proof that an operation succeeded.
export async function observeWorking(herdr: HerdrReader, paneId: string): Promise<ObservedWorking | null> {
  const before = await herdr.get(paneId);
  if (!before) return null;
  const sessionId = identity(before, paneId, () => null, true);
  if (!sessionId || before.state_change_seq < 0) return null;
  return {
    pane_id: paneId,
    workspace_id: before.workspace_id,
    agent: before.agent!,
    session_id: sessionId,
    session_kind: before.agent_session!.kind,
    session_source: before.agent_session!.source,
    status: 'working',
    revision: before.revision,
    state_change_seq: before.state_change_seq,
  };
}

export async function observeStop(
  herdr: HerdrReader,
  paneId: string,
  captureLines?: number,
  onRejected?: RejectionSink,
): Promise<ObservedStop | null> {
  const reject = (phase: ObservationRejection['phase'], reason: ObservationRejection['reason']): null => {
    reportRejection(onRejected, phase, reason);
    return null;
  };
  if (!/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(paneId)) return reject('request', 'pane_invalid');
  if (captureLines !== undefined && (!Number.isSafeInteger(captureLines) || captureLines < 1 || captureLines > 48))
    return reject('request', 'capture_size_invalid');
  if (captureLines !== undefined && !herdr.readFixed) return reject('request', 'fixed_reader_missing');
  let before: AgentSnapshot | null;
  try {
    before = await herdr.get(paneId);
  } catch (error) {
    reportRejection(onRejected, 'before', 'failed');
    throw error;
  }
  if (!before) return reject('before', 'missing');
  const sessionId = identity(before, paneId, (reason) => reject('before', reason));
  if (!sessionId) return null;
  const sessionKind = before.agent_session!.kind;
  const sessionSource = before.agent_session!.source;
  let read: ReadSnapshot | null;
  try {
    read = captureLines === undefined ? await herdr.read(paneId) : await herdr.readFixed!(paneId, captureLines);
  } catch (error) {
    reportRejection(onRejected, 'read', 'failed');
    throw error;
  }
  let after: AgentSnapshot | null;
  try {
    after = await herdr.get(paneId);
  } catch (error) {
    reportRejection(onRejected, 'after', 'failed');
    throw error;
  }
  if (!after) return reject('after', 'missing');
  const afterSession = identity(after, paneId, (reason) => reject('after', reason));
  if (!afterSession) return null;
  if (afterSession !== sessionId) return reject('after', 'session_changed');
  if (after.workspace_id !== before.workspace_id) return reject('after', 'workspace_changed');
  if (after.agent !== before.agent) return reject('after', 'agent_changed');
  if (after.agent_status !== before.agent_status) return reject('after', 'status_changed');
  if (after.agent_session?.kind !== sessionKind) return reject('after', 'session_kind_changed');
  if (after.agent_session?.source !== sessionSource) return reject('after', 'session_source_changed');
  if (after.revision !== before.revision) return reject('after', 'revision_changed');
  if (after.state_change_seq !== before.state_change_seq) return reject('after', 'sequence_changed');
  if (checkDetectionRead(read, paneId, onRejected) !== 'valid' || !read) return null;
  if (captureLines !== undefined && read.capture_lines !== captureLines) return reject('read', 'capture_size_mismatch');
  // Herdr's detection-read revision is independent of agent.get revision, and
  // truncated means older lines may be omitted. This excerpt is only untrusted
  // classification evidence, never proof of the current error or request.
  // Never clip an oversized read: doing so might omit a credential.
  try {
    assertNoCredentials({ text: read.text, sessionId }, process.env.TYPESAFE_API_KEY ?? '');
  } catch {
    return reject('after', 'credentials');
  }
  const errorDigest = createHash('sha256').update(read.text).digest('hex');
  const episodeId = createHash('sha256')
    .update(
      JSON.stringify([
        paneId,
        before.workspace_id,
        before.agent,
        sessionKind,
        sessionSource,
        sessionId,
        before.revision,
        before.state_change_seq,
        before.agent_status,
        errorDigest,
      ]),
    )
    .digest('hex');
  return {
    pane_id: paneId,
    workspace_id: before.workspace_id,
    agent: before.agent as string,
    session_id: sessionId,
    session_kind: sessionKind,
    session_source: sessionSource,
    status: before.agent_status as 'blocked' | 'idle' | 'done',
    revision: before.revision,
    state_change_seq: before.state_change_seq,
    context: read.text,
    ...(read.context_restricted ? { context_restricted: true as const } : {}),
    ...(read.capture_lines === undefined ? {} : { capture_lines: read.capture_lines }),
    current_episode_id: episodeId,
    error_evidence_digest: errorDigest,
  };
}
