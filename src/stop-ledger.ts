import path from 'node:path';
import { z } from 'zod';
import { ErrorResultSchema, FailureDiagnosticsSchema, StewardError, StopResultSchema } from './contracts.ts';
import type { LedgerRuntime } from './ledger.ts';
import { assertNoCredentials, configuredApiKeys } from './privacy.ts';

const ToolSchema = z.enum(['codex', 'pi', 'agy']);
const decisionFields = StopResultSchema.options[0].shape;
const ActionSchema = z.enum([
  'approve_request',
  'send_recovery_instruction',
  'wait_for_quota',
  'manual_review',
  'no_action',
]);
const AssessmentSchema = z.strictObject({
  request_id: z.uuid(),
  action: ActionSchema.optional(),
  reason_code: z.union([decisionFields.reason_code, ErrorResultSchema.shape.reason_code]),
  waiting_for: decisionFields.waiting_for.optional(),
  waiting_confidence: decisionFields.waiting_confidence.optional(),
  risk_probability: decisionFields.risk_probability.optional(),
  diagnostics: FailureDiagnosticsSchema.optional(),
});
export const ApprovalDiagnosticSchema = z.strictObject({
  attempt_id: z.uuid(),
  recorded_at: z.iso.datetime({ offset: true }).optional(),
  no_send_cleanup: z
    .strictObject({
      reason: z.enum(['observation_changed', 'delivery_not_started']),
      outcome: z.enum(['recorded', 'record_failed', 'ownership_lost', 'observation_unavailable']),
    })
    .optional(),
  gate: z.enum([
    'delivered',
    'uncertain_delivery',
    'observation_changed',
    'observation_unavailable',
    'ownership_lost',
    'evaluator_failed',
    'assessment_rejected',
    'classification_mismatch',
    'request_mismatch',
    'state_unavailable',
    'control_unavailable',
    'delivery_not_started',
    'record_failed',
    'clock_invalid',
  ]),
  transport_started: z.boolean(),
  checkpoint: z
    .enum([
      'initial',
      'assessment_1',
      'after_assessment_1',
      'assessment_2',
      'after_assessment_2',
      'prewrite',
      'before_delivery',
      'delivery',
      'delivery_record',
    ])
    .optional(),
  assessments: z.array(AssessmentSchema).max(2),
});
export type ApprovalDiagnostic = z.infer<typeof ApprovalDiagnosticSchema>;

const StopEventSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: z.string().min(1).nullable(),
    recorded_at: z.string(),
    event: z.enum(['assessed', 'failed', 'approval', 'approval_skipped']),
    tool: ToolSchema.optional(),
    action: ActionSchema.optional(),
    reason_code: z.string().min(1),
    waiting_for: decisionFields.waiting_for.optional(),
    waiting_confidence: decisionFields.waiting_confidence.optional(),
    risk_probability: decisionFields.risk_probability.optional(),
    diagnostics: FailureDiagnosticsSchema.optional(),
    approval: ApprovalDiagnosticSchema.optional(),
    approval_skip: z.enum(['previous_human', 'previous_delivered', 'uncertain_session']).optional(),
    approval_diagnostics_missing: z.boolean().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type StopLedgerEvent = z.infer<typeof StopEventSchema>;
const MAX_LEDGER_BYTES = 5 * 1024 * 1024;

export function stopLedgerFile(env: { XDG_STATE_HOME?: string; HOME?: string }): string {
  const state = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, '.local/state') : null);
  if (state === null) throw new StewardError('invalid_input');
  return path.join(state, 'agent-steward/stop.jsonl');
}

export function stopTool(value: string): 'codex' | 'pi' | 'agy' | undefined {
  const parsed = ToolSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function appendStopEvent(runtime: LedgerRuntime, event: StopLedgerEvent): Promise<void> {
  const text = JSON.stringify(event);
  assertNoCredentials(text, configuredApiKeys(runtime.env));
  if (!StopEventSchema.safeParse(event).success) throw new StewardError('invalid_input');
  let line = `${text}\n`;
  let bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_LEDGER_BYTES) throw new StewardError('invalid_input');
  const file = stopLedgerFile(runtime.env);
  await runtime.mkdirp(path.dirname(file), 0o700);
  await runtime.chmod(path.dirname(file), 0o700);
  await runtime.withLedgerLock(file, async () => {
    if (event.event === 'approval_skipped' && event.approval === undefined) {
      const previous = foldStopEvents(
        [await runtime.readTextIfPresent(`${file}.1`), await runtime.readTextIfPresent(file)],
        runtime.env,
      ).find((record) => record.request_id === event.request_id);
      const retained = {
        ...event,
        ...(previous?.approval ? { approval: previous.approval } : {}),
        approval_diagnostics_missing: previous?.approval === undefined,
      };
      const retainedText = JSON.stringify(retained);
      assertNoCredentials(retainedText, configuredApiKeys(runtime.env));
      if (!StopEventSchema.safeParse(retained).success) throw new StewardError('invalid_input');
      line = `${retainedText}\n`;
      bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > MAX_LEDGER_BYTES) throw new StewardError('invalid_input');
    }
    const size = await runtime.fileSize(file);
    if (size > 0 && size + bytes > MAX_LEDGER_BYTES) {
      await runtime.chmod(file, 0o600);
      await runtime.rename(file, `${file}.1`);
    }
    await runtime.appendText(file, line);
    await runtime.chmod(file, 0o600);
  });
}

export async function readStopLedger(runtime: LedgerRuntime): Promise<StopLedgerEvent[]> {
  const file = stopLedgerFile(runtime.env);
  const texts = await runtime.withLedgerLock(file, async () => [
    await runtime.readTextIfPresent(`${file}.1`),
    await runtime.readTextIfPresent(file),
  ]);
  return foldStopEvents(texts, runtime.env);
}

function foldStopEvents(texts: (string | null)[], env: LedgerRuntime['env']): StopLedgerEvent[] {
  for (const text of texts) {
    if (text !== null) assertNoCredentials(text, configuredApiKeys(env));
  }
  const text = texts.filter((text) => text !== null).join('\n');
  const folded = new Map<string | symbol, StopLedgerEvent>();
  for (const line of text.split('\n').filter((line) => line.trim() !== '')) {
    let event: StopLedgerEvent;
    try {
      event = StopEventSchema.parse(JSON.parse(line));
    } catch {
      throw new StewardError('invalid_input');
    }
    const key = event.request_id ?? Symbol();
    const previous = folded.get(key);
    folded.delete(key);
    folded.set(key, { ...previous, ...event });
  }
  return [...folded.values()].reverse();
}

function relativeLedgerTime(timestamp: string, now: Date): string {
  const seconds = (Date.parse(timestamp) - now.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return timestamp;
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const) {
    if (Math.abs(seconds) < size) continue;
    const duration = `${Math.floor(Math.abs(seconds) / size)}${unit}`;
    return seconds > 0 ? `in ${duration}` : `${duration} ago`;
  }
  return 'just now';
}

export function formatStopLedgerRecords(records: StopLedgerEvent[], now: Date): string {
  if (records.length === 0) return '';
  const headers = ['REQUEST ID', 'TIME', 'TOOL', 'ACTION', 'STATUS', 'REASON'];
  const rows = records.map((record) => {
    const time = relativeLedgerTime(record.recorded_at, now);
    const fields = [
      record.request_id ?? '—',
      time,
      record.tool ?? '—',
      record.action ?? '—',
      record.event,
      record.reason_code,
    ];
    return fields.map((field) => JSON.stringify(field).slice(1, -1));
  });
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)));
  return `${[headers, ...rows]
    .map((row) =>
      row.map((field, column) => (column === row.length - 1 ? field : field.padEnd(widths[column]!))).join('  '),
    )
    .join('\n')}\n`;
}
