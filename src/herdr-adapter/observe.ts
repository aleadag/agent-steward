import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
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
};
export type HerdrReader = {
  get: (paneId: string) => Promise<AgentSnapshot | null>;
  read: (paneId: string) => Promise<ReadSnapshot | null>;
};
export type ObservedStop = {
  pane_id: string;
  workspace_id: string;
  agent: 'pi' | 'codex';
  session_id: string;
  status: 'blocked' | 'idle';
  revision: number;
  state_change_seq: number;
  context: string;
  current_episode_id: string;
  error_evidence_digest: string;
};

function identity(pane: AgentSnapshot, paneId: string): string | null {
  if (
    pane.pane_id !== paneId ||
    (pane.agent !== 'pi' && pane.agent !== 'codex') ||
    (pane.agent_status !== 'blocked' && pane.agent_status !== 'idle') ||
    !Number.isSafeInteger(pane.revision) ||
    !Number.isSafeInteger(pane.state_change_seq) ||
    pane.workspace_id !== paneId.split(':')[0] ||
    pane.agent_session?.agent !== pane.agent ||
    !pane.agent_session.value ||
    !pane.agent_session.source
  )
    return null;
  const session = pane.agent_session;
  if (session.kind === 'path') {
    if (
      pane.agent !== 'pi' ||
      session.source !== 'herdr:pi' ||
      !isAbsolute(session.value) ||
      !session.value.endsWith('.jsonl') ||
      /[\x00-\x1f\x7f]/.test(session.value)
    )
      return null;
  } else if (session.kind !== 'id') return null;
  return session.value;
}

export async function observeStop(herdr: HerdrReader, paneId: string): Promise<ObservedStop | null> {
  if (!/^w[0-9]+:p[0-9]+$/.test(paneId)) return null;
  const before = await herdr.get(paneId);
  if (!before) return null;
  const sessionId = identity(before, paneId);
  if (!sessionId) return null;
  const read = await herdr.read(paneId);
  const after = await herdr.get(paneId);
  if (
    !after ||
    identity(after, paneId) !== sessionId ||
    after.workspace_id !== before.workspace_id ||
    after.agent !== before.agent ||
    after.agent_status !== before.agent_status ||
    after.agent_session?.kind !== before.agent_session?.kind ||
    after.agent_session?.source !== before.agent_session?.source ||
    after.revision !== before.revision ||
    after.state_change_seq !== before.state_change_seq ||
    read?.pane_id !== paneId ||
    read.source !== 'detection' ||
    !Number.isSafeInteger(read.revision) ||
    read.revision < 0 ||
    typeof read.truncated !== 'boolean' ||
    typeof read.text !== 'string'
  )
    return null;
  // Herdr's detection-read revision is independent of agent.get revision, and
  // truncated means older lines may be omitted. This excerpt is only untrusted
  // classification evidence, never proof of the current error or request.
  // Never clip an oversized read: doing so might omit a credential.
  const lines = read.text.split('\n');
  const lineCount = lines.length - (read.text.endsWith('\n') ? 1 : 0);
  if (!read.text.trim() || Buffer.byteLength(read.text, 'utf8') > 2048 || lineCount > 12) return null;
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
    agent: before.agent as 'pi' | 'codex',
    session_id: sessionId,
    status: before.agent_status as 'blocked' | 'idle',
    revision: before.revision,
    state_change_seq: before.state_change_seq,
    context: read.text,
    current_episode_id: episodeId,
    error_evidence_digest: errorDigest,
  };
}
