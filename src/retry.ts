import type { StopInput, StopResult } from './contracts.ts';
import { compareRfc3339Timestamps } from './timestamps.ts';

type Proposal = Extract<StopResult, { decision: 'stop_decision' }>['proposed_action'];
type RetryKind = 'recoverable_api_error' | 'quota_limit';

const recoveryInstruction =
  'Continue the interrupted task from the last unfinished step. Before repeating the preceding operation, check whether it succeeded; do not repeat completed actions. If the same failure is still current, retry the operation once. If the task is already complete, report that.';
const minute = 60_000;

function addMilliseconds(timestamp: string, delay: number): string | null {
  const fraction = timestamp.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/)?.[1];
  const wholeSecond = timestamp.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, '');
  const instant = Date.parse(wholeSecond);
  if (!Number.isFinite(instant)) return null;
  const result = new Date(instant + delay);
  if (!Number.isFinite(result.getTime())) return null;
  const utc = result.toISOString();
  return fraction === undefined ? utc : `${utc.slice(0, -5)}.${fraction}Z`;
}

function validHistory(first: string, count: number, last: string | null, now: string): boolean {
  const firstToNow = compareRfc3339Timestamps(first, now);
  if (!Number.isFinite(firstToNow) || firstToNow > 0) return false;
  if (count === 0) return last === null;
  if (last === null) return false;
  const firstToLast = compareRfc3339Timestamps(first, last);
  const lastToNow = compareRfc3339Timestamps(last, now);
  return Number.isFinite(firstToLast) && Number.isFinite(lastToNow) && firstToLast <= 0 && lastToNow <= 0;
}

function contextPresent(input: StopInput): boolean {
  const context = input.context;
  if (typeof context === 'string') return context.trim().length > 0;
  return context !== undefined && context !== null && typeof context === 'object' && Object.keys(context).length > 0;
}

function manual(): Proposal {
  return { kind: 'manual_review' };
}

function recovery(input: StopInput, now: string): Proposal {
  const retry = input.retry;
  if (!contextPresent(input) || retry.failure_episode_id !== input.current_episode_id) return manual();
  if (input.status !== 'blocked' && input.status !== 'idle' && input.status !== 'done') return manual();
  if (!validHistory(retry.first_observed_at, retry.attempt_count, retry.last_attempt_at, now)) return manual();
  const delays = [30_000, 2 * minute, 8 * minute];
  const delay = delays[retry.attempt_count];
  if (delay === undefined) return manual();
  const anchor = retry.attempt_count === 0 ? retry.first_observed_at : retry.last_attempt_at;
  if (anchor === null) return manual();
  const notBefore = addMilliseconds(anchor, delay);
  if (notBefore === null) return manual();
  return { kind: 'send_recovery_instruction', not_before: notBefore, instruction: recoveryInstruction };
}

function quota(input: StopInput, now: string): Proposal {
  const retry = input.retry;
  if (
    !contextPresent(input) ||
    retry.failure_episode_id !== input.current_episode_id ||
    (input.status !== 'blocked' && input.status !== 'idle' && input.status !== 'done')
  )
    return manual();
  if (!validHistory(retry.first_observed_at, retry.quota_check_count, retry.last_quota_check_at, now)) return manual();
  const deadline = addMilliseconds(retry.first_observed_at, 24 * 60 * minute);
  if (deadline === null || compareRfc3339Timestamps(now, deadline) >= 0) return manual();

  // StopInput.reset is only asserted snapshot data; without an independent live binding and all-window set, use fallback.
  const base = retry.last_quota_check_at ?? retry.first_observed_at;
  const delay = ([5, 15, 45, 120][retry.quota_check_count] ?? 360) * minute;
  const scheduled = addMilliseconds(base, delay);
  if (scheduled === null || compareRfc3339Timestamps(scheduled, now) <= 0) return manual();
  const notBefore = compareRfc3339Timestamps(scheduled, deadline) > 0 ? deadline : scheduled;
  return { kind: 'wait_for_quota', not_before: notBefore };
}

export function retryProposal(input: StopInput, kind: RetryKind, now: Date): Proposal {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return manual();
  const nowInstant = now.toISOString();
  if (kind === 'recoverable_api_error') return recovery(input, nowInstant);
  if (kind === 'quota_limit') return quota(input, nowInstant);
  return manual();
}
