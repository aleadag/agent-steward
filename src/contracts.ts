import { z } from 'zod';
import { compareRfc3339Timestamps } from './timestamps.ts';

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const probability = z.number().finite().min(0).max(1);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const ProbabilityRecordSchema = z
  .custom<Record<string, unknown>>(isRecord)
  .superRefine((record, context) => {
    for (const [key, value] of Object.entries(record)) {
      if (!probability.safeParse(value).success)
        context.addIssue({ code: 'custom', path: [key], message: 'Invalid probability' });
    }
  })
  .transform(
    (record) =>
      Object.fromEntries(Object.entries(record).map(([key, value]) => [key, probability.parse(value)])) as Record<
        string,
        number
      >,
  );

const ToolSchema = z.enum(['codex', 'pi', 'agy']);
export const QuotaBucketSchema = z.enum(['codex', 'pi_codex', 'pi_xai', 'antigravity']);
export const SnapshotSourceSchema = z.enum(['codex', 'pi_codex', 'pi_xai', 'antigravity']);
const QuotaSourceSchema = SnapshotSourceSchema;
const ApprovalContextObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
);
const ThinkingLevelSchema = z.strictObject({ id: text, description: text });
const CandidateSchema = z.strictObject({
  id: text,
  tool: ToolSchema,
  provider: text,
  model: text,
  quota_bucket: QuotaBucketSchema,
  quota_pool: text,
  cost: z.number().finite().positive(),
  capabilities: text,
  thinking_levels: z
    .array(ThinkingLevelSchema)
    .min(1)
    .max(255)
    .superRefine((levels, context) => {
      const ids = new Set<string>();
      levels.forEach((level, index) => {
        if (ids.has(level.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate level ID' });
        ids.add(level.id);
      });
    }),
});

export const EvaluatorConfigSchema = z
  .strictObject({
    type: z.literal('jev'),
    provider: z.enum(['typesafe', 'openrouter']),
    model: text.optional(),
  })
  .transform((value) => ({
    ...value,
    model: value.model ?? (value.provider === 'openrouter' ? '~typesafe/jev-latest' : 'jev-1.13.0'),
  }));

export const ConfigSchema = z
  .strictObject({
    tools: z.array(ToolSchema).refine((tools) => new Set(tools).size === tools.length),
    candidates: z.array(CandidateSchema),
    jev: z
      .strictObject({
        model: text.default('jev-1.13.0'),
      })
      .optional(),
    evaluator: EvaluatorConfigSchema.optional(),
    thresholds: z
      .strictObject({
        risky: probability.default(0.6),
        choiceConfidence: probability.default(0.45),
      })
      .default({ risky: 0.6, choiceConfidence: 0.45 }),
  })
  .superRefine((config, context) => {
    if (config.jev !== undefined && config.evaluator !== undefined)
      context.addIssue({ code: 'custom', path: ['evaluator'], message: 'Use evaluator or legacy jev, not both' });
    const candidateIds = new Set<string>();
    config.candidates.forEach((candidate, index) => {
      if (candidateIds.has(candidate.id))
        context.addIssue({ code: 'custom', path: ['candidates', index, 'id'], message: 'Duplicate candidate ID' });
      candidateIds.add(candidate.id);
      const paired =
        candidate.tool === 'codex'
          ? candidate.quota_bucket === 'codex'
          : candidate.tool === 'pi'
            ? candidate.quota_bucket === 'pi_codex' || candidate.quota_bucket === 'pi_xai'
            : candidate.quota_bucket === 'antigravity';
      if (!paired)
        context.addIssue({
          code: 'custom',
          path: ['candidates', index, 'quota_bucket'],
          message: 'Invalid tool/bucket pairing',
        });
    });
  })
  .transform(({ jev, evaluator, ...config }) => ({
    ...config,
    evaluator: evaluator ?? { type: 'jev' as const, provider: 'typesafe' as const, model: jev?.model ?? 'jev-1.13.0' },
  }));

const AccountScopeSchema = z.strictObject({ type: z.literal('account') });
const PoolScopeSchema = z.strictObject({ type: z.literal('pool'), pool_id: text });
const ScopeSchema = z.union([AccountScopeSchema, PoolScopeSchema]);
const dateTime = z.iso.datetime({ offset: true });
const QuotaWindowSchema = z
  .strictObject({
    scope: ScopeSchema,
    id: text.optional(),
    cadence: z.enum(['weekly', 'other']).optional(),
    remaining_percent: z.number().finite().min(0).max(100),
    reset_at: dateTime,
    observed_at: dateTime,
    valid_until: dateTime,
  })
  .superRefine((window, context) => {
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
  source: SnapshotSourceSchema,
  identity_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  windows: z.array(QuotaWindowSchema),
});

const StopAgentSchema = z.strictObject({
  id: text,
  tool: text,
  pane_id: text,
  session_id: z.string().nullable(),
});
const PendingActionSchema = z.union([
  z.null(),
  z.strictObject({
    action: z.union([z.string(), z.null()]).optional(),
    target: z.union([z.string(), z.null()]).optional(),
    permissions: z.union([z.string(), z.null()]).optional(),
    user_intent: z.union([z.string(), z.null()]).optional(),
    environment: z.union([z.string(), z.null()]).optional(),
  }),
]);
const RetrySchema = z.strictObject({
  failure_episode_id: text,
  first_observed_at: dateTime,
  attempt_count: z.number().int().finite().min(0),
  last_attempt_at: z.union([z.null(), dateTime]),
  quota_check_count: z.number().int().finite().min(0),
  last_quota_check_at: z.union([z.null(), dateTime]),
});
// This validates the asserted snapshot shape only; it does not authenticate its source or freshness.
const ResetSchema = z.strictObject({
  reset_at: dateTime,
  observed_at: dateTime,
  valid_until: dateTime,
  source: z.enum(['codex', 'antigravity']),
  account_id: text,
  pool_id: text,
  scope: ScopeSchema,
});
export const StopInputSchema = z.strictObject({
  schema_version: z.literal(2),
  request_id: text,
  agent: StopAgentSchema,
  status: z.enum(['blocked', 'idle', 'done', 'unknown']),
  current_episode_id: text,
  context: z.union([z.null(), z.string(), ApprovalContextObjectSchema]).optional(),
  pending_action: PendingActionSchema.optional(),
  automatic_approval_forbidden: z.boolean().default(false),
  retry: RetrySchema,
  reset: ResetSchema.optional(),
});

export const ChoiceAnswerSchema = z.strictObject({
  type: z.literal('choice'),
  choice: text,
  probabilities: ProbabilityRecordSchema,
  confidence: probability,
});
export const NoulAnswerSchema = z.strictObject({ type: z.literal('noul'), noul: probability });
const AnswerSchema = z.union([ChoiceAnswerSchema, NoulAnswerSchema]);
const AnswerRecordSchema = z
  .custom<Record<string, unknown>>(isRecord)
  .superRefine((record, context) => {
    for (const [key, value] of Object.entries(record)) {
      if (!AnswerSchema.safeParse(value).success)
        context.addIssue({ code: 'custom', path: [key], message: 'Invalid answer' });
    }
  })
  .transform(
    (record) =>
      Object.fromEntries(Object.entries(record).map(([key, value]) => [key, AnswerSchema.parse(value)])) as Record<
        string,
        z.infer<typeof AnswerSchema>
      >,
  );

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
  id: text.optional(),
  cadence: z.enum(['weekly', 'other']).optional(),
  remaining_percent: z.union([z.null(), z.number().finite().min(0).max(100)]),
  reset_at: dateTime,
  observed_at: dateTime,
  valid_until: dateTime,
});
const QuotaFactsSchema = z.strictObject({
  source: QuotaBucketSchema,
  quota_bucket: QuotaBucketSchema,
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
    quota_bucket: QuotaBucketSchema,
    quota_pool: text,
  }),
  quota: QuotaFactsSchema,
  planned_command: PlannedCommandSchema,
  evaluations: z.strictObject({
    pair: EvaluationSchema,
    effort: z.union([EvaluationSchema, z.strictObject({ kind: z.literal('fixed'), level: text })]),
  }),
});
export const FailureDiagnosticsSchema = z.strictObject({
  stage: z.enum(['input', 'config', 'preflight', 'quota', 'credentials', 'evaluation', 'response', 'launch']),
  kind: z
    .enum([
      'read',
      'json',
      'schema',
      'http',
      'network',
      'timeout',
      'size_limit',
      'depth_limit',
      'answer_ids',
      'answer_type',
      'choice_options',
      'probability_sum',
      'choice_mismatch',
    ])
    .optional(),
  details: z
    .custom<Record<string, unknown>>(isRecord)
    .refine(
      (details) =>
        Object.keys(details).length <= 16 && Object.keys(details).every((key) => /^[a-z][a-z0-9_]{0,63}$/.test(key)),
      'Invalid diagnostic metric names or count',
    )
    .pipe(z.record(z.string(), z.union([z.number().finite(), z.boolean(), z.null()])))
    .optional(),
  config_fields: z.array(z.string().min(1).max(256)).max(16).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type FailureDiagnostics = z.infer<typeof FailureDiagnosticsSchema>;

export const ErrorResultSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: z.union([z.string(), z.null()]),
  decision: z.literal('error'),
  reason_code: z.enum([
    'invalid_input',
    'invalid_config',
    'missing_credentials',
    'credential_detected',
    'invalid_response',
    'evaluation_failed',
    'interactive_terminal_required',
    'launch_failed',
  ]),
  message: z.string(),
  diagnostics: FailureDiagnosticsSchema.optional(),
});
const StopRecoveryInstructionSchema = z.literal(
  'Continue the interrupted task from the last unfinished step. Before repeating the preceding operation, check whether it succeeded; do not repeat completed actions. If the same failure is still current, retry the operation once. If the task is already complete, report that.',
);
const StopProposedActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approve_request') }),
  z.strictObject({
    kind: z.literal('send_recovery_instruction'),
    not_before: dateTime,
    instruction: StopRecoveryInstructionSchema,
  }),
  z.strictObject({ kind: z.literal('wait_for_quota'), not_before: dateTime }),
  z.strictObject({ kind: z.literal('manual_review') }),
  z.strictObject({ kind: z.literal('no_action') }),
]);
const StopDecisionResultSchema = z
  .strictObject({
    schema_version: z.literal(2),
    request_id: text,
    decision: z.literal('stop_decision'),
    proposed_action: StopProposedActionSchema,
    reason_code: z.enum([
      'low_risk',
      'high_risk',
      'explicit_restriction',
      'unclear_waiting_state',
      'insufficient_context',
      'ordinary_question',
      'credentials',
      'permanent_error',
      'retry_exhausted',
      'recoverable_api_error',
      'quota_limit',
      'completed',
    ]),
    waiting_for: z.enum([
      'approve_command',
      'approve_edit',
      'answer_question',
      'credentials',
      'recoverable_api_error',
      'quota_limit',
      'permanent_error',
      'completed',
      'other',
    ]),
    waiting_confidence: z.union([z.null(), probability]),
    risk_probability: z.union([z.null(), probability]),
    evaluation: z.union([z.null(), EvaluationSchema]),
  })
  .superRefine((result, context) => {
    const hasEvaluation = result.evaluation !== null;
    const hasConfidence = result.waiting_confidence !== null;
    const evaluated = hasEvaluation && hasConfidence;
    const metricsConsistent = hasEvaluation === hasConfidence && (hasEvaluation || result.risk_probability === null);
    if (!metricsConsistent) {
      context.addIssue({
        code: 'custom',
        path: ['evaluation'],
        message: 'Evaluation and confidence must be present together; local results have null metrics',
      });
    }
    if (result.evaluation !== null) {
      const waitingAnswer = result.evaluation.answers.waiting_for;
      if (waitingAnswer?.type !== 'choice' || waitingAnswer.confidence !== result.waiting_confidence) {
        context.addIssue({
          code: 'custom',
          path: ['waiting_confidence'],
          message: 'Confidence must match the waiting-for evaluation',
        });
      } else {
        const maximum = Math.max(...Object.values(waitingAnswer.probabilities));
        const maximumChoices = Object.entries(waitingAnswer.probabilities).filter(([, value]) => value === maximum);
        const tied = maximumChoices.length > 1;
        const ambiguousTie =
          tied && result.proposed_action.kind === 'manual_review' && result.reason_code === 'unclear_waiting_state';
        const choiceMatches = waitingAnswer.choice === result.waiting_for;
        if (!choiceMatches || (tied && !ambiguousTie)) {
          context.addIssue({
            code: 'custom',
            path: ['waiting_for'],
            message: 'Waiting state must match the evaluated choice; ties require unclear manual review',
          });
        }
      }
      const riskAnswer = result.evaluation.answers.risky;
      if (
        result.risk_probability !== null &&
        (riskAnswer?.type !== 'noul' || riskAnswer.noul !== result.risk_probability)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['risk_probability'],
          message: 'Risk probability must match the risk evaluation',
        });
      }
    }

    const approvalRequest = result.waiting_for === 'approve_command' || result.waiting_for === 'approve_edit';
    let matches = false;
    switch (result.proposed_action.kind) {
      case 'approve_request':
        matches = result.reason_code === 'low_risk' && approvalRequest && evaluated && result.risk_probability !== null;
        break;
      case 'send_recovery_instruction':
        matches =
          result.reason_code === 'recoverable_api_error' && result.waiting_for === 'recoverable_api_error' && evaluated;
        break;
      case 'wait_for_quota':
        matches = result.reason_code === 'quota_limit' && result.waiting_for === 'quota_limit' && evaluated;
        break;
      case 'no_action':
        matches = result.reason_code === 'completed' && result.waiting_for === 'completed';
        break;
      case 'manual_review':
        switch (result.reason_code) {
          case 'insufficient_context':
            matches =
              result.waiting_for === 'other' && !hasEvaluation && !hasConfidence && result.risk_probability === null;
            break;
          case 'high_risk':
          case 'explicit_restriction':
            matches = approvalRequest && evaluated && result.risk_probability !== null;
            break;
          case 'unclear_waiting_state':
            matches = evaluated;
            break;
          case 'ordinary_question':
            matches = result.waiting_for === 'answer_question' && evaluated;
            break;
          case 'credentials':
            matches = result.waiting_for === 'credentials' && evaluated;
            break;
          case 'permanent_error':
            matches = result.waiting_for === 'permanent_error' && evaluated;
            break;
          case 'retry_exhausted':
            matches =
              (result.waiting_for === 'recoverable_api_error' || result.waiting_for === 'quota_limit') && evaluated;
            break;
          default:
            matches = false;
        }
        break;
    }
    if (!matches) {
      context.addIssue({
        code: 'custom',
        path: ['proposed_action'],
        message: 'Proposed action, reason, waiting state, and evidence do not agree',
      });
    }
  });
const StopErrorResultSchema = ErrorResultSchema.extend({ schema_version: z.literal(2) });
export const StopResultSchema = z.union([StopDecisionResultSchema, StopErrorResultSchema]);

export const ResultSchema = z.union([SelectedResultSchema, ErrorResultSchema]);

export type Config = z.infer<typeof ConfigSchema>;
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>;
export type Candidate = Config['candidates'][number];
export type ThinkingLevel = Candidate['thinking_levels'][number];
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type QuotaWindow = Snapshot['windows'][number];
export type StopInput = z.infer<typeof StopInputSchema>;
export type QuotaFacts = z.infer<typeof QuotaFactsSchema>;
export type QuotaWindowFact = z.infer<typeof QuotaWindowFactSchema>;
export type PlannedCommand = z.infer<typeof PlannedCommandSchema>;
export type SelectedResult = z.infer<typeof SelectedResultSchema>;
export type ErrorResult = z.infer<typeof ErrorResultSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type StopResult = z.infer<typeof StopResultSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;

export type ReadText = (path: string) => Promise<string>;
export type Diagnostic = (code: string) => void;
export type ConfigEnv = {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  TYPESAFE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
};
export type ErrorCode = ErrorResult['reason_code'];

export class StewardError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly diagnostics?: FailureDiagnostics,
  ) {
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
  interactive_terminal_required: 'Interactive terminal input and output are required.',
  launch_failed: 'Agent launch failed or its outcome is uncertain.',
};

export function errorResult(error: unknown, requestId: string | null): ErrorResult {
  const code =
    error instanceof StewardError && Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : 'evaluation_failed';
  return {
    schema_version: 1,
    request_id: requestId,
    decision: 'error',
    reason_code: code,
    message: ERROR_MESSAGES[code],
    ...(error instanceof StewardError && error.diagnostics !== undefined ? { diagnostics: error.diagnostics } : {}),
  };
}
