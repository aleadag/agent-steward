import path from 'node:path';
import { z } from 'zod';
import { FailureDiagnosticsSchema, StewardError } from './contracts.ts';
import { assertNoCredentials, configuredApiKeys } from './privacy.ts';

const EventSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: z.string().min(1),
    recorded_at: z.string(),
    event: z.enum(['dry-run', 'launched', 'launch-failed', 'evaluation_failed', 'exited']),
    selected: z
      .object({
        tool: z.string(),
        provider: z.string(),
        model: z.string(),
        thinking_level: z.string(),
        quota_bucket: z.string(),
      })
      .strict()
      .optional(),
    usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).strict().optional(),
    exit_code: z.number().int().optional(),
    reason_code: z
      .enum([
        'invalid_input',
        'invalid_config',
        'missing_credentials',
        'credential_detected',
        'invalid_response',
        'evaluation_failed',
        'interactive_terminal_required',
        'launch_failed',
      ])
      .optional(),
    diagnostics: FailureDiagnosticsSchema.optional(),
  })
  .strict();

export type LedgerEvent = z.infer<typeof EventSchema>;
export type LedgerEventKind = LedgerEvent['event'];
const MAX_LEDGER_BYTES = 5 * 1024 * 1024;

export type LedgerRuntime = {
  env: { XDG_STATE_HOME?: string; HOME?: string; TYPESAFE_API_KEY?: string; OPENROUTER_API_KEY?: string };
  appendText: (path: string, text: string) => Promise<void>;
  readTextIfPresent: (path: string) => Promise<string | null>;
  mkdirp: (path: string, mode: number) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  fileSize: (path: string) => Promise<number>;
  rename: (from: string, to: string) => Promise<void>;
  withLedgerLock: <T>(path: string, action: () => Promise<T>) => Promise<T>;
};

export function ledgerFile(env: { XDG_STATE_HOME?: string; HOME?: string }): string {
  const state = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, '.local/state') : null);
  if (state === null) throw new StewardError('invalid_input');
  return path.join(state, 'agent-steward/router.jsonl');
}

export async function appendEvent(runtime: LedgerRuntime, event: LedgerEvent): Promise<void> {
  const text = JSON.stringify(event);
  assertNoCredentials(text, configuredApiKeys(runtime.env));
  if (!EventSchema.safeParse(event).success) throw new StewardError('invalid_input');
  const line = `${text}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_LEDGER_BYTES) throw new StewardError('invalid_input');
  const file = ledgerFile(runtime.env);
  await runtime.mkdirp(path.dirname(file), 0o700);
  await runtime.chmod(path.dirname(file), 0o700);
  await runtime.withLedgerLock(file, async () => {
    const size = await runtime.fileSize(file);
    if (size > 0 && size + bytes > MAX_LEDGER_BYTES) {
      await runtime.chmod(file, 0o600);
      await runtime.rename(file, `${file}.1`);
    }
    await runtime.appendText(file, line);
    await runtime.chmod(file, 0o600);
  });
}

const SelectedSchema = EventSchema.shape.selected.unwrap();
const LegacySelectedSchema = SelectedSchema.omit({ quota_bucket: true })
  .extend({ account_id: z.string(), quota_bucket: z.string().optional() })
  .transform(({ account_id: _accountId, quota_bucket, ...selected }) => ({
    ...selected,
    // Legacy account IDs were aliases, not evidence of a credential bucket.
    quota_bucket: quota_bucket ?? null,
  }));
const ReadEventSchema = EventSchema.extend({
  selected: z.union([SelectedSchema, LegacySelectedSchema]).optional(),
});
type LedgerRecord = z.infer<typeof ReadEventSchema>;

export async function readLedger(runtime: LedgerRuntime): Promise<LedgerRecord[]> {
  const file = ledgerFile(runtime.env);
  const texts = await runtime.withLedgerLock(file, async () => [
    await runtime.readTextIfPresent(`${file}.1`),
    await runtime.readTextIfPresent(file),
  ]);
  for (const text of texts) {
    if (text !== null) assertNoCredentials(text, configuredApiKeys(runtime.env));
  }
  const text = texts.filter((text) => text !== null).join('\n');
  const folded = new Map<string, LedgerRecord>();
  for (const line of text.split('\n').filter((line) => line.trim() !== '')) {
    let event: LedgerRecord;
    try {
      event = ReadEventSchema.parse(JSON.parse(line));
    } catch {
      throw new StewardError('invalid_input');
    }
    const previous = folded.get(event.request_id);
    folded.delete(event.request_id);
    folded.set(event.request_id, { ...previous, ...event });
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

export function formatLedgerRecords(records: LedgerRecord[], now: Date): string {
  if (records.length === 0) return '';
  const headers = ['REQUEST ID', 'TIME', 'ROUTE', 'ACCOUNT', 'STATUS'];
  const hasExitCode = records.some((record) => record.exit_code !== undefined);
  if (hasExitCode) headers.push('EXIT CODE');
  const rows = records.map((record) => {
    const selected = record.selected;
    const route = selected ? `${selected.tool}/${selected.model}/${selected.thinking_level}` : '—';
    const time = relativeLedgerTime(record.recorded_at, now);
    const fields = [record.request_id, time, route, selected?.quota_bucket ?? '—', record.event];
    if (hasExitCode) fields.push(record.exit_code === undefined ? '—' : String(record.exit_code));
    return fields.map((field) => JSON.stringify(field).slice(1, -1));
  });
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)));
  return `${[headers, ...rows]
    .map((row) =>
      row.map((field, column) => (column === row.length - 1 ? field : field.padEnd(widths[column]!))).join('  '),
    )
    .join('\n')}\n`;
}
