import { createHash, randomUUID } from 'node:crypto';
import { StopInputSchema, StopResultSchema } from '../contracts.ts';
import { observeStop, type ObservedStop } from './observe.ts';
import type { EventDeps } from './events.ts';
import type { ApprovalAttempt } from './state.ts';

// Recognize an explicit one-time control, not a bare "1", yes/no question,
// persistent grant, trust or setup prompt. Text is best-effort evidence only.
export function approvalMenu(context: string): { action: string; kind: 'approve_command' | 'approve_edit' } | null {
  const lines = context.split('\n').map((line) => line.trim());
  const headers = context.match(/Requesting permission for:/g) ?? [];
  const questions = lines.filter((line) => line === 'Run this command?' || line === 'Apply this edit?');
  const ones = lines.filter((line) => /^(?:>\s*)?1\./.test(line));
  if (headers.length !== 1 || questions.length !== 1 || ones.length !== 1) return null;
  const header = lines.indexOf('Requesting permission for:');
  if (header < 0 || lines.slice(0, header).some((line) => line !== '')) return null;
  const question = lines.indexOf(questions[0]!);
  const command = questions[0] === 'Run this command?';
  const control = command ? '1. Yes, run command' : '1. Yes, apply edit';
  if (ones[0]!.replace(/^>\s*/, '') !== control || question <= header + 1) return null;
  const one = lines.findIndex((line) => line.replace(/^>\s*/, '') === control);
  if (one <= question || lines.slice(question + 1, one).some((line) => line !== '')) return null;
  let choice = 1;
  let cancelled = false;
  for (const line of lines.slice(one)) {
    if (!line) continue;
    if (cancelled) {
      // Unknown suffixes may be another dialog owning the keyboard. Only the
      // recognized navigation/status footer may follow the complete menu.
      if (!/^↑\/↓ Navigate(?: · [^?]*)?$/.test(line) && !/^(?:🔧 )?TOOL(?:[ ·╱][^?]*)?$/.test(line)) return null;
      continue;
    }
    const row = /^(?:>\s*)?(\d+)\. (Yes, .+|No, cancel)$/.exec(line);
    if (!row || Number(row[1]) !== choice++) return null;
    cancelled = row[2] === 'No, cancel';
  }
  if (!cancelled) return null;
  const action = lines
    .slice(header + 1, question)
    .join('\n')
    .trim();
  return action ? { action, kind: command ? 'approve_command' : 'approve_edit' } : null;
}

export async function handleBestEffortApproval(
  observed: ObservedStop,
  deps: EventDeps,
  stillOwner: () => Promise<boolean>,
): Promise<boolean> {
  if (!deps.autoApprove) return false;
  if (deps.observationAllowed && !deps.observationAllowed(observed)) return true;
  const menu = approvalMenu(observed.context);
  if (!menu) return false;
  const admissionOpen = deps.admissionOpen ?? (() => true);
  const owns = async () => admissionOpen() && (await stillOwner()) && admissionOpen();
  const human = async () => {
    if (admissionOpen()) await deps.handoff('human_review_required');
  };
  // All callers must hold the same per-pane lock, with persistent write metadata.
  if (!deps.store.withEpisodeLock || !deps.store.approval || !deps.store.recordApproval || !deps.herdr.sendKeys) {
    await human();
    return true;
  }
  return (
    (await deps.store.withEpisodeLock(`approval:${JSON.stringify([observed.agent, observed.session_id])}`, async () => {
      if (!(await owns())) return true;
      let previous;
      try {
        previous = await deps.store.approval!(observed.agent, observed.session_id);
      } catch {
        await human();
        return true;
      }
      if (!admissionOpen()) return true;
      const digest = createHash('sha256')
        .update(JSON.stringify([observed.agent, menu]))
        .digest('hex');
      if (previous?.session_id === observed.session_id) {
        if (previous.state === 'uncertain') {
          await human();
          return true;
        }
        // Footer/revision/sequence changes alone are not a fresh permission menu.
        if (previous.digest === digest) return true;
      }
      const now = deps.clock.now();
      if (!Number.isFinite(now.getTime())) return true;
      const record: ApprovalAttempt = {
        pane_id: observed.pane_id,
        agent: observed.agent,
        session_id: observed.session_id,
        digest,
        state: 'human',
        recorded_at: now.toISOString(),
      };
      const matchingObservation = async () => {
        if (!(await owns())) return false;
        const fresh = await observeStop(deps.herdr, observed.pane_id);
        return (
          admissionOpen() &&
          fresh?.current_episode_id === observed.current_episode_id &&
          (!deps.observationAllowed || deps.observationAllowed(fresh))
        );
      };
      const input = () =>
        StopInputSchema.parse({
          schema_version: 2,
          request_id: randomUUID(),
          agent: {
            id: observed.session_id,
            tool: observed.agent,
            pane_id: observed.pane_id,
            session_id: observed.session_id,
          },
          // An explicit permission menu is logically blocked even when Herdr reports idle.
          // Raw Herdr status remains part of the unchanged-observation delivery checks.
          status: 'blocked',
          context: observed.context,
          pending_action: { action: menu.action },
          current_episode_id: observed.current_episode_id,
          automatic_approval_forbidden: false,
          retry: {
            failure_episode_id: observed.current_episode_id,
            first_observed_at: now.toISOString(),
            attempt_count: 0,
            last_attempt_at: null,
            quota_check_count: 0,
            last_quota_check_at: null,
          },
        });
      const approved = async () => {
        const request = input();
        if (!admissionOpen()) return false;
        const result = StopResultSchema.parse(await deps.decide(request));
        return (
          admissionOpen() &&
          result.decision === 'stop_decision' &&
          result.request_id === request.request_id &&
          result.proposed_action.kind === 'approve_request' &&
          result.waiting_for === menu.kind
        );
      };
      try {
        if (
          !(await matchingObservation()) ||
          !(await approved()) ||
          !(await matchingObservation()) ||
          !(await approved()) ||
          !(await matchingObservation())
        ) {
          if (await owns()) await deps.store.recordApproval!(observed.pane_id, record);
          await human();
          return true;
        }
        if (!(await owns())) return true;
        // Commit ambiguity before the key. Never replay after timeout or a lost ack,
        // including across changed prompts and supervisor restarts in this session.
        record.state = 'uncertain';
        await deps.store.recordApproval!(observed.pane_id, record);
        if (!(await matchingObservation()) || !(await owns())) {
          await human();
          return true;
        }
        // Herdr cannot make the last observation and keypress atomic. Global enablement
        // explicitly accepts that race; do not label this native request-binding proof.
        const send = () => deps.herdr.sendKeys!(observed.pane_id, ['1']);
        if (deps.dispatchEffect) await deps.dispatchEffect('approval', send);
        else await send();
        if (!(await owns())) return true;
        await deps.store.recordApproval!(observed.pane_id, { ...record, state: 'delivered' });
      } catch {
        await human();
      }
      return true;
    })) ?? true
  );
}
