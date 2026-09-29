import { z } from 'zod';
import { compareRfc3339Timestamps } from './timestamps.js';

const text = z.string().min(1).refine(value => value.trim().length > 0);
const probability = z.number().finite().min(0).max(1);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const ProbabilityRecordSchema = z.custom<Record<string, unknown>>(isRecord)
  .superRefine((record, context) => {
    for (const [key, value] of Object.entries(record)) {
      if (!probability.safeParse(value).success) context.addIssue({ code: 'custom', path: [key], message: 'Invalid probability' });
    }
  })
  .transform(record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, probability.parse(value)])) as Record<string, number>);

const ToolSchema = z.enum(['codex', 'pi', 'agy']);
const QuotaSourceSchema = z.enum(['codex', 'antigravity']);
const ApprovalContextObjectSchema = z.custom<Record<string, unknown>>(value =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
);
const ThinkingLevelSchema = z.strictObject({ id: text, description: text });
const AccountSchema = z.strictObject({
  id: text,
  source: QuotaSourceSchema,
  snapshot: text.optional(),
});
const CandidateSchema = z.strictObject({
  id: text,
  tool: ToolSchema,
  provider: text,
  model: text,
  account_id: text,
  quota_pool: text,
  capabilities: text,
  thinking_levels: z.array(ThinkingLevelSchema).min(1).max(255).superRefine((levels, context) => {
    const ids = new Set<string>();
    levels.forEach((level, index) => {
      if (ids.has(level.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate level ID' });
      ids.add(level.id);
    });
  }),
});

export const ConfigSchema = z.strictObject({
  tools: z.array(ToolSchema).refine(tools => new Set(tools).size === tools.length),
  accounts: z.array(AccountSchema),
  candidates: z.array(CandidateSchema),
  jev: z.strictObject({
    model: text.default('jev-1.13.0'),
  }).default({ model: 'jev-1.13.0' }),
  thresholds: z.strictObject({
    risky: probability.default(0.60),
    choiceConfidence: probability.default(0.45),
  }).default({ risky: 0.60, choiceConfidence: 0.45 }),
}).superRefine((config, context) => {
  const accountIds = new Set<string>();
  config.accounts.forEach((account, index) => {
    if (accountIds.has(account.id)) context.addIssue({ code: 'custom', path: ['accounts', index, 'id'], message: 'Duplicate account ID' });
    accountIds.add(account.id);
  });

  const candidateIds = new Set<string>();
  config.candidates.forEach((candidate, index) => {
    if (candidateIds.has(candidate.id)) context.addIssue({ code: 'custom', path: ['candidates', index, 'id'], message: 'Duplicate candidate ID' });
    candidateIds.add(candidate.id);
    if (!accountIds.has(candidate.account_id)) context.addIssue({ code: 'custom', path: ['candidates', index, 'account_id'], message: 'Unknown account ID' });
  });
});

const AccountScopeSchema = z.strictObject({ type: z.literal('account') });
const PoolScopeSchema = z.strictObject({ type: z.literal('pool'), pool_id: text });
const ScopeSchema = z.union([AccountScopeSchema, PoolScopeSchema]);
const dateTime = z.iso.datetime({ offset: true });
const QuotaWindowSchema = z.strictObject({
  scope: ScopeSchema,
  remaining_percent: z.number().finite().min(0).max(100),
  reset_at: dateTime,
  observed_at: dateTime,
  valid_until: dateTime,
}).superRefine((window, context) => {
  const resetOrder = compareRfc3339Timestamps(window.observed_at, window.reset_at);
  if (!Number.isFinite(resetOrder) || resetOrder >= 0) {
    context.addIssue({ code: 'custom', path: ['reset_at'], message: 'Reset must follow observation' });
  }
  const validityOrder = compareRfc3339Timestamps(window.observed_at, window.valid_until);
  if (!Number.isFinite(validityOrder) || validityOrder >= 0) {
    context.addIssue({ code: 'custom', path: ['valid_until'], message: 'Validity must follow observation' });
  }
});

export const SnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  source: QuotaSourceSchema,
  account_id: text,
  windows: z.array(QuotaWindowSchema),
});

export const ApprovalInputSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: text,
  agent: z.strictObject({ id: text, tool: text }),
  status: z.literal('stopped'),
  context: z.union([z.null(), z.string(), ApprovalContextObjectSchema]).optional(),
  pending_action: z.union([z.null(), z.strictObject({
    action: z.union([z.string(), z.null()]).optional(),
    target: z.union([z.string(), z.null()]).optional(),
    permissions: z.union([z.string(), z.null()]).optional(),
    user_intent: z.union([z.string(), z.null()]).optional(),
    environment: z.union([z.string(), z.null()]).optional(),
  })]).optional(),
  automatic_approval_forbidden: z.boolean().default(false),
});

export const ChoiceAnswerSchema = z.strictObject({
  type: z.literal('choice'),
  choice: text,
  probabilities: ProbabilityRecordSchema,
  confidence: probability,
});
export const NoulAnswerSchema = z.strictObject({ type: z.literal('noul'), noul: probability });
const AnswerSchema = z.union([ChoiceAnswerSchema, NoulAnswerSchema]);
const AnswerRecordSchema = z.custom<Record<string, unknown>>(isRecord)
  .superRefine((record, context) => {
    for (const [key, value] of Object.entries(record)) {
      if (!AnswerSchema.safeParse(value).success) context.addIssue({ code: 'custom', path: [key], message: 'Invalid answer' });
    }
  })
  .transform(record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, AnswerSchema.parse(value)])) as Record<string, z.infer<typeof AnswerSchema>>);

export const EvaluationSchema = z.strictObject({
  model: text,
  answers: AnswerRecordSchema,
  usage: z.strictObject({
    input_tokens: z.number().int().finite().min(0).optional(),
    output_tokens: z.number().int().finite().min(0).optional(),
  }),
});

const QuotaWindowFactSchema = z.strictObject({
  status: z.enum(['known', 'unknown']),
  reason: z.union([z.null(), z.enum(['expired', 'reset_passed', 'future_observation'])]),
  scope: ScopeSchema,
  remaining_percent: z.union([z.null(), z.number().finite().min(0).max(100)]),
  reset_at: dateTime,
  observed_at: dateTime,
  valid_until: dateTime,
});
const QuotaFactsSchema = z.strictObject({
  source: QuotaSourceSchema,
  account_id: text,
  pool_id: text,
  snapshot_status: z.enum(['loaded', 'missing', 'unreadable', 'malformed', 'identity_mismatch']),
  account_status: z.enum(['known', 'unknown']),
  pool_status: z.enum(['known', 'unknown']),
  windows: z.array(QuotaWindowFactSchema),
});
const PlannedCommandSchema = z.strictObject({
  executable: ToolSchema,
  args: z.array(z.string()),
  display: z.string(),
  syntax_validated: z.literal(true),
  runtime_selection: z.literal('unverified'),
  authentication: z.literal('unverified'),
  provider_selection: z.enum(['explicit_flag', 'existing_settings']),
});
const SelectedResultSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: text,
  decision: z.literal('selected'),
  selected: z.strictObject({
    candidate_id: text,
    tool: ToolSchema,
    provider: text,
    model: text,
    thinking_level: text,
    account_id: text,
    quota_pool: text,
  }),
  quota: QuotaFactsSchema,
  planned_command: PlannedCommandSchema,
  evaluations: z.strictObject({
    pair: EvaluationSchema,
    effort: z.union([EvaluationSchema, z.strictObject({ kind: z.literal('fixed'), level: text })]),
  }),
});
const EvaluatedApprovalResultSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: text,
  decision: z.enum(['approve', 'manual_review', 'no_action']),
  reason_code: z.enum(['low_risk', 'high_risk', 'unclear_waiting_state', 'not_approval', 'explicit_restriction']),
  waiting_for: z.enum(['approve_command', 'approve_edit', 'answer_question', 'credentials', 'error_help', 'other']),
  waiting_confidence: probability,
  risk_probability: probability,
  evaluation: EvaluationSchema,
}).superRefine((result, context) => {
  const approvalRequest = result.waiting_for === 'approve_command' || result.waiting_for === 'approve_edit';
  const nonApproval = result.waiting_for === 'answer_question' || result.waiting_for === 'credentials' || result.waiting_for === 'error_help';
  const consistent = result.reason_code === 'low_risk'
    ? result.decision === 'approve' && approvalRequest
    : result.reason_code === 'high_risk'
      ? result.decision === 'manual_review' && approvalRequest
      : result.reason_code === 'unclear_waiting_state'
        ? result.decision === 'manual_review'
        : result.reason_code === 'not_approval'
          ? result.decision === 'no_action' && nonApproval
          : result.decision === 'manual_review' && approvalRequest;
  if (!consistent) context.addIssue({ code: 'custom', path: ['decision'], message: 'Decision and reason do not match' });
});
const LocalApprovalResultSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: text,
  decision: z.literal('manual_review'),
  reason_code: z.literal('insufficient_context'),
  waiting_for: z.null(),
  waiting_confidence: z.null(),
  risk_probability: z.null(),
  evaluation: z.null(),
});
const ErrorResultSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: z.union([z.string(), z.null()]),
  decision: z.literal('error'),
  reason_code: z.enum(['invalid_input', 'invalid_config', 'missing_credentials', 'credential_detected', 'invalid_response', 'evaluation_failed', 'execution_unavailable']),
  message: z.string(),
});

export const ResultSchema = z.union([
  SelectedResultSchema,
  EvaluatedApprovalResultSchema,
  LocalApprovalResultSchema,
  ErrorResultSchema,
]);

export type Config = z.infer<typeof ConfigSchema>;
export type Account = Config['accounts'][number];
export type Candidate = Config['candidates'][number];
export type ThinkingLevel = Candidate['thinking_levels'][number];
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type QuotaWindow = Snapshot['windows'][number];
export type ApprovalInput = z.infer<typeof ApprovalInputSchema>;
export type QuotaFacts = z.infer<typeof QuotaFactsSchema>;
export type QuotaWindowFact = z.infer<typeof QuotaWindowFactSchema>;
export type PlannedCommand = z.infer<typeof PlannedCommandSchema>;
export type SelectedResult = z.infer<typeof SelectedResultSchema>;
export type EvaluatedApprovalResult = z.infer<typeof EvaluatedApprovalResultSchema>;
export type LocalApprovalResult = z.infer<typeof LocalApprovalResultSchema>;
export type ApprovalResult = EvaluatedApprovalResult | LocalApprovalResult;
export type ErrorResult = z.infer<typeof ErrorResultSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;

export type ReadText = (path: string) => Promise<string>;
export type Diagnostic = (code: string) => void;
export type ConfigEnv = { HOME?: string; XDG_CONFIG_HOME?: string };
export type ErrorCode = ErrorResult['reason_code'];

export class StewardError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = 'StewardError';
  }
}

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalid_input: 'Input is invalid.',
  invalid_config: 'Configuration is invalid.',
  missing_credentials: 'Required credentials are missing.',
  credential_detected: 'Recognizable credential material was found.',
  invalid_response: 'Evaluator response is invalid.',
  evaluation_failed: 'Evaluation failed.',
  execution_unavailable: 'Execution is unavailable in this release.',
};

export function errorResult(error: unknown, requestId: string | null): ErrorResult {
  const code = error instanceof StewardError && Object.hasOwn(ERROR_MESSAGES, error.code)
    ? error.code
    : 'evaluation_failed';
  return {
    schema_version: 1,
    request_id: requestId,
    decision: 'error',
    reason_code: code,
    message: ERROR_MESSAGES[code],
  };
}
