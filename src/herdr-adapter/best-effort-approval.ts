import { createHash, randomUUID } from 'node:crypto';
import { StewardError, StopInputSchema, StopResultSchema } from '../contracts.ts';
import { ApprovalDiagnosticSchema, stopTool, type ApprovalDiagnostic } from '../stop-ledger.ts';
import { observeStop, type ObservedStop } from './observe.ts';
import type { EventDeps } from './events.ts';
import type { ApprovalAttempt } from './state.ts';

function isPermissionChrome(line: string): boolean {
  if (!line) return true;
  if (line === 'Command' || line === 'expand)' || /^expand\)$/.test(line)) return true;
  if (/^(?:●\s*)?Bash\(/.test(line)) return true;
  if (/ctrl\+o to expand/i.test(line) || /ctrl\+o to$/i.test(line)) return true;
  if (/^[─━═\-|]+$/.test(line)) return true;
  return false;
}

function isPermissionFooter(line: string): boolean {
  return /^↑\/↓ Navigate(?: · [^?]*)?$/.test(line) || /^(?:🔧 )?TOOL(?:[ ·╱][^?]*)?$/.test(line) || /^ctx\b/.test(line);
}

function foldPermissionRows(lines: string[]): string[] {
  const rows: string[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current) rows.push(current);
    current = null;
  };
  for (const line of lines) {
    if (!line) continue;
    if (/^(?:>\s*)?\d+\. /.test(line)) {
      flush();
      current = line.replace(/^>\s*/, '');
      continue;
    }
    if (current && !current.endsWith('No, cancel') && !isPermissionFooter(line)) {
      current = `${current} ${line}`;
      continue;
    }
    flush();
    rows.push(line);
  }
  flush();
  return rows;
}

// Recognize an explicit one-time control, not a bare "1", yes/no question,
// persistent grant, trust or setup prompt. Text is best-effort evidence only.
export function approvalMenu(context: string): { action: string; kind: 'approve_command' | 'approve_edit' } | null {
  const lines = context.split('\n').map((line) => line.trim());
  const headers = context.match(/Requesting permission for:/g) ?? [];
  const questions = lines.filter((line) => line === 'Run this command?' || line === 'Apply this edit?');
  const ones = lines.filter((line) => /^(?:>\s*)?1\./.test(line));
  if (headers.length !== 1 || questions.length !== 1 || ones.length !== 1) return null;
  const header = lines.indexOf('Requesting permission for:');
  if (header < 0 || lines.slice(0, header).some((line) => !isPermissionChrome(line))) return null;
  const question = lines.indexOf(questions[0]!);
  const command = questions[0] === 'Run this command?';
  const control = command ? '1. Yes, run command' : '1. Yes, apply edit';
  if (ones[0]!.replace(/^>\s*/, '') !== control || question <= header + 1) return null;
  const one = lines.findIndex((line) => line.replace(/^>\s*/, '') === control);
  if (one <= question || lines.slice(question + 1, one).some((line) => line !== '')) return null;
  let choice = 1;
  let cancelled = false;
  for (const line of foldPermissionRows(lines.slice(one))) {
    if (!line) continue;
    if (cancelled) {
      // Unknown suffixes may be another dialog owning the keyboard. Only the
      // recognized navigation/status footer may follow the complete menu.
      if (!isPermissionFooter(line)) return null;
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
  if (!deps.autoApprove || observed.context_restricted) return false;
  if (deps.observationAllowed && !deps.observationAllowed(observed)) return true;
  const menu = approvalMenu(observed.context);
  if (!menu) return false;
  let attemptId: string = randomUUID();
  let gate: ApprovalDiagnostic['gate'] = 'control_unavailable';
  let skip: 'previous_human' | 'previous_delivered' | 'uncertain_session' | undefined;
  let transportStarted = false;
  let checkpoint: NonNullable<ApprovalDiagnostic['checkpoint']> = 'initial';
  let originalRecordedAt: string | undefined;
  let noSendCleanup: ApprovalDiagnostic['no_send_cleanup'];
  const assessments: ApprovalDiagnostic['assessments'] = [];
  const report = async () => {
    if (!deps.approvalDiagnostic) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const approval = skip
        ? undefined
        : ApprovalDiagnosticSchema.parse({
            attempt_id: attemptId,
            recorded_at: originalRecordedAt ?? new Date().toISOString(),
            ...(noSendCleanup ? { no_send_cleanup: noSendCleanup } : {}),
            gate,
            checkpoint,
            transport_started: transportStarted,
            assessments,
          });
      const write = deps.approvalDiagnostic({
        schema_version: 1,
        request_id: attemptId,
        recorded_at: new Date().toISOString(),
        event: skip ? 'approval_skipped' : 'approval',
        reason_code: skip ?? gate,
        ...(stopTool(observed.agent) ? { tool: stopTool(observed.agent) } : {}),
        ...(approval ? { approval } : { approval_skip: skip }),
      });
      await Promise.race([
        write,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } catch {
      // Diagnostics never grant authority, change the outcome, or retry input.
    } finally {
      clearTimeout(timer);
    }
  };
  const admissionOpen = deps.admissionOpen ?? (() => true);
  const owns = async () => {
    const owned = admissionOpen() && (await stillOwner()) && admissionOpen();
    if (!owned) gate = 'ownership_lost';
    return owned;
  };
  const human = async () => {
    if (admissionOpen()) await deps.handoff('human_review_required');
  };
  // All callers must hold the same per-pane lock, with persistent write metadata.
  if (!deps.store.withEpisodeLock || !deps.store.approval || !deps.store.recordApproval || !deps.herdr.sendKeys) {
    await human();
    await report();
    return true;
  }
  return (
    (await deps.store.withEpisodeLock(`approval:${JSON.stringify([observed.agent, observed.session_id])}`, async () => {
      try {
        gate = 'ownership_lost';
        if (!(await owns())) return true;
        let previous;
        try {
          gate = 'state_unavailable';
          previous = await deps.store.approval!(observed.agent, observed.session_id);
        } catch {
          await human();
          return true;
        }
        if (!admissionOpen()) {
          gate = 'ownership_lost';
          return true;
        }
        const digest = createHash('sha256')
          .update(JSON.stringify([observed.agent, menu]))
          .digest('hex');
        if (previous?.session_id === observed.session_id) {
          if (previous.state === 'uncertain') {
            attemptId = previous.attempt_id ?? attemptId;
            skip = 'uncertain_session';
            await human();
            return true;
          }
          // Footer/revision/sequence changes alone are not a fresh permission menu.
          if (previous.digest === digest && previous.state !== 'not_sent') {
            attemptId = previous.attempt_id ?? attemptId;
            skip = previous.state === 'human' ? 'previous_human' : 'previous_delivered';
            return true;
          }
        }
        const now = deps.clock.now();
        if (!Number.isFinite(now.getTime())) {
          gate = 'clock_invalid';
          return true;
        }
        originalRecordedAt = now.toISOString();
        const record: ApprovalAttempt = {
          pane_id: observed.pane_id,
          agent: observed.agent,
          session_id: observed.session_id,
          digest,
          state: 'human',
          attempt_id: attemptId,
          recorded_at: now.toISOString(),
        };
        const assessedLineCount = observed.context.split('\n').length - (observed.context.endsWith('\n') ? 1 : 0);
        let observationCount = 0;
        const matchingObservation = async () => {
          checkpoint =
            (['initial', 'after_assessment_1', 'before_delivery'] as const)[observationCount++] ?? 'before_delivery';
          if (!(await owns())) return false;
          gate = 'observation_unavailable';
          const fresh = await observeStop(deps.herdr, observed.pane_id, observed.capture_lines);
          const matches =
            admissionOpen() &&
            fresh !== null &&
            fresh.workspace_id === observed.workspace_id &&
            fresh.agent === observed.agent &&
            fresh.session_id === observed.session_id &&
            fresh.session_kind === observed.session_kind &&
            fresh.session_source === observed.session_source &&
            fresh.error_evidence_digest === observed.error_evidence_digest &&
            fresh.context.split('\n').length - (fresh.context.endsWith('\n') ? 1 : 0) === assessedLineCount &&
            !fresh.context_restricted &&
            (!deps.observationAllowed || deps.observationAllowed(fresh));
          if (!matches)
            gate = admissionOpen() ? (fresh ? 'observation_changed' : 'observation_unavailable') : 'ownership_lost';
          return matches;
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
            // Delivery binds the exact assessed text and actor/session, not mutable status metadata.
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
          checkpoint = 'assessment_1';
          const request = input();
          if (!admissionOpen()) {
            gate = 'ownership_lost';
            return false;
          }
          let result;
          try {
            result = StopResultSchema.parse(await deps.decide(request));
          } catch (error) {
            gate = 'evaluator_failed';
            assessments.push({
              request_id: request.request_id,
              reason_code: error instanceof StewardError ? error.code : 'evaluation_failed',
              ...(error instanceof StewardError && error.diagnostics ? { diagnostics: error.diagnostics } : {}),
            });
            throw error;
          }
          if (result.decision === 'error') {
            gate = 'evaluator_failed';
            assessments.push({
              request_id: request.request_id,
              reason_code: result.reason_code,
              ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
            });
            return false;
          }
          assessments.push({
            request_id: request.request_id,
            action: result.proposed_action.kind,
            reason_code: result.reason_code,
            waiting_for: result.waiting_for,
            waiting_confidence: result.waiting_confidence,
            risk_probability: result.risk_probability,
          });
          if (!admissionOpen()) {
            gate = 'ownership_lost';
            return false;
          }
          if (result.request_id !== request.request_id) {
            gate = 'request_mismatch';
            return false;
          }
          if (result.proposed_action.kind !== 'approve_request') {
            gate = 'assessment_rejected';
            return false;
          }
          if (result.waiting_for !== menu.kind) {
            gate = 'classification_mismatch';
            return false;
          }
          return true;
        };
        const recordNotSent = async (reason: NonNullable<ApprovalAttempt['not_sent_reason']>) => {
          if (transportStarted || record.state !== 'uncertain') return;
          const stoppingGate = gate;
          let outcome: NonNullable<ApprovalDiagnostic['no_send_cleanup']>['outcome'] = 'observation_unavailable';
          try {
            if (!(await owns())) return;
            const fresh = await observeStop(deps.herdr, observed.pane_id, observed.capture_lines);
            if (
              !fresh ||
              fresh.workspace_id !== observed.workspace_id ||
              fresh.agent !== observed.agent ||
              fresh.session_id !== observed.session_id ||
              fresh.session_kind !== observed.session_kind ||
              fresh.session_source !== observed.session_source ||
              (deps.observationAllowed && !deps.observationAllowed(fresh)) ||
              !(await owns())
            )
              return;
            // Both locks remain held. This invocation knows the transport was
            // never called; crashes or lost authority leave the marker uncertain.
            outcome = 'record_failed';
            await deps.store.recordApproval!(observed.pane_id, {
              ...record,
              state: 'not_sent',
              not_sent_reason: reason,
            });
            outcome = 'recorded';
          } catch {
            // Failure to publish no-send evidence must retain quarantine.
          } finally {
            if (outcome === 'observation_unavailable' && gate === 'ownership_lost') outcome = 'ownership_lost';
            noSendCleanup = { reason, outcome };
            gate = stoppingGate;
          }
        };
        try {
          if (!(await matchingObservation()) || !(await approved()) || !(await matchingObservation())) {
            if (await owns()) {
              const rejectedGate = gate;
              gate = 'record_failed';
              await deps.store.recordApproval!(observed.pane_id, record);
              gate = rejectedGate;
            }
            await human();
            return true;
          }
          if (!(await owns())) return true;
          // Commit ambiguity before the key. Never replay after timeout or a lost ack,
          // including across changed prompts and supervisor restarts in this session.
          record.state = 'uncertain';
          checkpoint = 'prewrite';
          gate = 'record_failed';
          await deps.store.recordApproval!(observed.pane_id, record);
          if (!(await matchingObservation()) || !(await owns())) {
            await recordNotSent('observation_changed');
            await human();
            return true;
          }
          // Herdr cannot make the last observation and keypress atomic. Global enablement
          // explicitly accepts that race; do not label this native request-binding proof.
          gate = 'delivery_not_started';
          const send = () => {
            transportStarted = true;
            checkpoint = 'delivery';
            gate = 'uncertain_delivery';
            return deps.herdr.sendKeys!(observed.pane_id, ['1']);
          };
          if (deps.dispatchEffect) await deps.dispatchEffect('approval', send);
          else await send();
          if (!(await owns())) return true;
          checkpoint = 'delivery_record';
          gate = 'record_failed';
          await deps.store.recordApproval!(observed.pane_id, { ...record, state: 'delivered' });
          gate = 'delivered';
        } catch {
          await recordNotSent('delivery_not_started');
          await human();
        }
        return true;
      } finally {
        await report();
      }
    })) ?? true
  );
}
