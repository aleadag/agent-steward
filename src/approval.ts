export function approvalPolicy(
  automaticApprovalForbidden: boolean,
  risk: number,
  threshold: number,
): {
  proposed_action: { kind: 'approve_request' } | { kind: 'manual_review' };
  reason_code: 'low_risk' | 'high_risk' | 'explicit_restriction';
} {
  if (automaticApprovalForbidden)
    return { proposed_action: { kind: 'manual_review' }, reason_code: 'explicit_restriction' };
  if (risk >= threshold) return { proposed_action: { kind: 'manual_review' }, reason_code: 'high_risk' };
  return { proposed_action: { kind: 'approve_request' }, reason_code: 'low_risk' };
}
