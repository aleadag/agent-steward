import type { StopResult } from '../contracts.js';
import type { HerdrControl } from './deliver.js';
import type { ObservedStop } from './observe.js';

// A future proof must bind the native request ID, action, occupant and exact
// accepting UI control. Neither Herdr's lifecycle status nor detection text
// exposes that binding for Pi or Codex in the installed integration.
export type VerifiedRequest = {
  readonly request_id: string;
  readonly action: string;
  readonly pane_id: string;
  readonly session_id: string;
  readonly agent: 'pi' | 'codex';
  readonly acceptance_control: string;
};

export async function verifyPendingApproval(
  _herdr: HerdrControl,
  _observation: ObservedStop,
  _proposal: StopResult,
): Promise<VerifiedRequest | null> {
  return null;
}
