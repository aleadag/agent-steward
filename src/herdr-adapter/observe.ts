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

function hasControls(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject ASCII controls in session fields.
  return /[\x00-\x1f\x7f]/.test(value);
}

function field(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || hasControls(value)) return null;
  return value;
}

function identity(pane: AgentSnapshot, paneId: string): string | null {
  const session = pane.agent_session;
  if (
    pane.pane_id !== paneId ||
    (pane.agent_status !== 'blocked' && pane.agent_status !== 'idle' && pane.agent_status !== 'done') ||
    !Number.isSafeInteger(pane.revision) ||
    !Number.isSafeInteger(pane.state_change_seq) ||
    pane.workspace_id !== paneId.split(':')[0]
  )
    return null;
  const agent = field(pane.agent ?? undefined);
  const kind = field(session?.kind);
  const source = field(session?.source);
  const value = field(session?.value);
  if (!session || !agent || session.agent !== agent || !kind || !source || !value) return null;
  if (hasControls(session.agent)) return null;
  return value;
}

// Oversized probes are never classification evidence. Scan their entire text
// before letting a caller retain a separately captured, bounded excerpt.
export function checkDetectionRead(read: ReadSnapshot | null, paneId: string): 'valid' | 'oversized' | 'invalid' {
  if (
    !read ||
    read.pane_id !== paneId ||
    read.source !== 'detection' ||
    !Number.isSafeInteger(read.revision) ||
    read.revision < 0 ||
    typeof read.truncated !== 'boolean' ||
    typeof read.text !== 'string' ||
    (read.context_restricted !== undefined && read.context_restricted !== true) ||
    (read.capture_lines !== undefined &&
      (!Number.isSafeInteger(read.capture_lines) || read.capture_lines < 1 || read.capture_lines > 48))
  )
    return 'invalid';
  const lines = read.text.split('\n');
  const lineCount = lines.length - (read.text.endsWith('\n') ? 1 : 0);
  if (!read.text.trim() || lineCount > 48) return 'invalid';
  try {
    assertNoCredentials({ text: read.text }, process.env.TYPESAFE_API_KEY ?? '');
  } catch {
    return 'invalid';
  }
  return Buffer.byteLength(read.text, 'utf8') > 2048 ? 'oversized' : 'valid';
}

export async function observeStop(
  herdr: HerdrReader,
  paneId: string,
  captureLines?: number,
): Promise<ObservedStop | null> {
  if (!/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(paneId)) return null;
  if (
    captureLines !== undefined &&
    (!Number.isSafeInteger(captureLines) || captureLines < 1 || captureLines > 48 || !herdr.readFixed)
  )
    return null;
  const before = await herdr.get(paneId);
  if (!before) return null;
  const sessionId = identity(before, paneId);
  if (!sessionId) return null;
  const sessionKind = before.agent_session!.kind;
  const sessionSource = before.agent_session!.source;
  const read = captureLines === undefined ? await herdr.read(paneId) : await herdr.readFixed!(paneId, captureLines);
  const after = await herdr.get(paneId);
  if (
    !after ||
    identity(after, paneId) !== sessionId ||
    after.workspace_id !== before.workspace_id ||
    after.agent !== before.agent ||
    after.agent_status !== before.agent_status ||
    after.agent_session?.kind !== sessionKind ||
    after.agent_session?.source !== sessionSource ||
    after.revision !== before.revision ||
    after.state_change_seq !== before.state_change_seq ||
    !read ||
    checkDetectionRead(read, paneId) !== 'valid' ||
    (captureLines !== undefined && read.capture_lines !== captureLines)
  )
    return null;
  // Herdr's detection-read revision is independent of agent.get revision, and
  // truncated means older lines may be omitted. This excerpt is only untrusted
  // classification evidence, never proof of the current error or request.
  // Never clip an oversized read: doing so might omit a credential.
  try {
    assertNoCredentials({ text: read.text, sessionId }, process.env.TYPESAFE_API_KEY ?? '');
  } catch {
    return null;
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
