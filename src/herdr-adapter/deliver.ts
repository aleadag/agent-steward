import { randomUUID } from 'node:crypto';
import { StopInputSchema, StopResultSchema } from '../contracts.ts';
import type { StopInput, StopResult } from '../contracts.ts';
import { observeStop } from './observe.ts';
import type { HerdrReader, ObservedStop } from './observe.ts';
import type { Episode, EpisodeStore } from './state.ts';

export type HerdrControl = HerdrReader & {
  prompt: (paneId: string, text: string) => Promise<void>;
  sendKeys?: (paneId: string, keys: string[]) => Promise<void>;
};
export type Clock = { now: () => Date };
export type DeliveryOutcome = 'delivered' | 'wait' | 'human' | 'uncertain';

function sameEpisode(observed: ObservedStop, record: Episode): boolean {
  return (
    record.pane_id === observed.pane_id &&
    record.failure_episode_id === observed.current_episode_id &&
    record.error_evidence_digest === observed.error_evidence_digest &&
    record.session_id === observed.session_id
  );
}

// A missing current lease/socket check must never authorize a write. Only fixed,
// validated CLI text reaches prompt, while one episode lock covers the entire gate.
export async function deliverProposal(
  herdr: HerdrControl,
  observation: ObservedStop,
  proposal: StopResult,
  episode: EpisodeStore,
  clock: Clock,
  decide: (input: StopInput) => Promise<StopResult>,
  stillOwner: () => Promise<boolean>,
  alreadyLocked = false,
  admissionOpen: () => boolean = () => true,
): Promise<DeliveryOutcome> {
  if (!admissionOpen()) return 'human';
  if (!alreadyLocked) {
    if (!admissionOpen()) return 'human';
    return (
      (await episode.withEpisodeLock(observation.pane_id, () =>
        deliverProposal(herdr, observation, proposal, episode, clock, decide, stillOwner, true, admissionOpen),
      )) ?? 'human'
    );
  }
  if (!admissionOpen()) return 'human';
  const record = await episode.retry(observation.pane_id);
  if (!admissionOpen()) return 'human';
  if (!record || !sameEpisode(observation, record)) return 'human';
  const ownsEpisode = await stillOwner();
  if (!admissionOpen() || !ownsEpisode) return 'human';
  if (record.last_delivery_state !== 'none')
    return record.last_delivery_state === 'delivered'
      ? 'delivered'
      : record.last_delivery_state === 'uncertain'
        ? 'uncertain'
        : 'human';
  const parsed = StopResultSchema.safeParse(proposal);
  if (!parsed.success || parsed.data.decision !== 'stop_decision') return 'human';
  // Approval has no delivery path. Even a low-risk recommendation cannot bind
  // the current native permission request or its acceptance control.
  if (parsed.data.proposed_action.kind === 'approve_request') return 'human';
  if (parsed.data.proposed_action.kind !== 'send_recovery_instruction') return 'human';
  const action = parsed.data.proposed_action;
  const now = clock.now();
  if (!Number.isFinite(now.getTime())) return 'human';
  if (now.getTime() < Date.parse(action.not_before)) {
    if (!admissionOpen()) return 'human';
    const stillAuthorized = await stillOwner();
    if (!admissionOpen() || !stillAuthorized) return 'human';
    if (!admissionOpen()) return 'human';
    await episode.record(observation.pane_id, { ...record, next_check_at: action.not_before });
    return admissionOpen() ? 'wait' : 'human';
  }
  // A blocked UI may be a permission dialog; neither a classifier nor a
  // screen excerpt proves a non-approval dismissal for Pi or Codex.
  let fresh: ObservedStop | null;
  try {
    fresh = await observeStop(herdr, observation.pane_id);
  } catch {
    return 'human';
  }
  if (!admissionOpen()) return 'human';
  if (
    !fresh ||
    (fresh.status !== 'idle' && fresh.status !== 'done') ||
    !sameEpisode(fresh, record) ||
    fresh.agent !== observation.agent ||
    fresh.session_kind !== observation.session_kind ||
    fresh.session_source !== observation.session_source ||
    fresh.session_id !== observation.session_id ||
    fresh.revision !== observation.revision ||
    fresh.state_change_seq !== observation.state_change_seq
  )
    return 'human';
  const input = StopInputSchema.safeParse({
    schema_version: 2,
    request_id: randomUUID(),
    agent: { id: fresh.session_id, tool: fresh.agent, pane_id: fresh.pane_id, session_id: fresh.session_id },
    status: fresh.status,
    context: fresh.context,
    current_episode_id: fresh.current_episode_id,
    automatic_approval_forbidden: true,
    retry: {
      failure_episode_id: record.failure_episode_id,
      first_observed_at: record.first_observed_at,
      attempt_count: record.attempt_count,
      last_attempt_at: record.last_attempt_at,
      quota_check_count: record.quota_check_count,
      last_quota_check_at: record.last_quota_check_at,
    },
  });
  if (!input.success) return 'human';
  let decision: StopResult;
  if (!admissionOpen()) return 'human';
  try {
    decision = StopResultSchema.parse(await decide(input.data));
  } catch {
    return 'human';
  }
  if (!admissionOpen()) return 'human';
  if (
    decision.decision !== 'stop_decision' ||
    decision.request_id !== input.data.request_id ||
    decision.proposed_action.kind !== 'send_recovery_instruction' ||
    decision.proposed_action.not_before !== action.not_before ||
    decision.proposed_action.instruction !== action.instruction
  )
    return 'human';
  let immediatelyBefore: ObservedStop | null;
  if (!admissionOpen()) return 'human';
  try {
    immediatelyBefore = await observeStop(herdr, observation.pane_id);
  } catch {
    return 'human';
  }
  if (!admissionOpen()) return 'human';
  if (
    !immediatelyBefore ||
    (immediatelyBefore.status !== 'idle' && immediatelyBefore.status !== 'done') ||
    !sameEpisode(immediatelyBefore, record) ||
    immediatelyBefore.agent !== fresh.agent ||
    immediatelyBefore.session_kind !== fresh.session_kind ||
    immediatelyBefore.session_source !== fresh.session_source ||
    immediatelyBefore.session_id !== fresh.session_id ||
    immediatelyBefore.revision !== fresh.revision ||
    immediatelyBefore.state_change_seq !== fresh.state_change_seq
  )
    return 'human';
  if (!admissionOpen()) return 'human';
  const stillAuthorized = await stillOwner();
  if (!admissionOpen() || !stillAuthorized) return 'human';
  // Persist the ambiguous outcome BEFORE submission. A timeout, stalled response,
  // process crash or lost acknowledgment after the write can never trigger a resend.
  if (!admissionOpen()) return 'human';
  await episode.record(observation.pane_id, {
    ...record,
    next_check_at: null,
    attempt_count: record.attempt_count + 1,
    last_attempt_at: now.toISOString(),
    last_delivery_state: 'uncertain',
  });
  if (!admissionOpen()) return 'uncertain';
  const stillAuthorizedBeforePrompt = await stillOwner();
  if (!admissionOpen() || !stillAuthorizedBeforePrompt) return 'uncertain';
  if (!admissionOpen()) return 'uncertain';
  try {
    await herdr.prompt(observation.pane_id, action.instruction);
  } catch {
    return 'uncertain';
  }
  if (!admissionOpen()) return 'uncertain';
  const stillAuthorizedAfterPrompt = await stillOwner();
  if (!admissionOpen() || !stillAuthorizedAfterPrompt) return 'uncertain';
  if (!admissionOpen()) return 'uncertain';
  try {
    await episode.record(observation.pane_id, {
      ...record,
      next_check_at: null,
      attempt_count: record.attempt_count + 1,
      last_attempt_at: now.toISOString(),
      last_delivery_state: 'delivered',
    });
  } catch {
    return 'uncertain';
  }
  return admissionOpen() ? 'delivered' : 'uncertain';
}
