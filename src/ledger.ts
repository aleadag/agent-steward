import path from 'node:path';
import { z } from 'zod';
import { StewardError } from './contracts.ts';
import { assertNoCredentials } from './privacy.ts';

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
        account_id: z.string(),
      })
      .strict()
      .optional(),
    usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).strict().optional(),
    exit_code: z.number().int().optional(),
  })
  .strict();

export type LedgerEvent = z.infer<typeof EventSchema>;
export type LedgerEventKind = LedgerEvent['event'];
type LedgerRuntime = {
  env: { XDG_STATE_HOME?: string; HOME?: string; TYPESAFE_API_KEY?: string };
  appendText: (path: string, text: string) => Promise<void>;
  readTextIfPresent: (path: string) => Promise<string | null>;
  mkdirp: (path: string, mode: number) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
};

export function ledgerFile(env: { XDG_STATE_HOME?: string; HOME?: string }): string {
  const state = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, '.local/state') : null);
  if (state === null) throw new StewardError('invalid_input');
  return path.join(state, 'agent-steward/router.jsonl');
}

export async function appendEvent(runtime: LedgerRuntime, event: LedgerEvent): Promise<void> {
  const text = JSON.stringify(event);
  assertNoCredentials(text, runtime.env.TYPESAFE_API_KEY ?? '');
  if (!EventSchema.safeParse(event).success) throw new StewardError('invalid_input');
  const file = ledgerFile(runtime.env);
  await runtime.mkdirp(path.dirname(file), 0o700);
  await runtime.chmod(path.dirname(file), 0o700);
  await runtime.appendText(file, `${text}\n`);
  await runtime.chmod(file, 0o600);
}

export async function readLedger(runtime: LedgerRuntime): Promise<LedgerEvent[]> {
  const text = await runtime.readTextIfPresent(ledgerFile(runtime.env));
  if (text === null) return [];
  assertNoCredentials(text, runtime.env.TYPESAFE_API_KEY ?? '');
  const folded = new Map<string, LedgerEvent>();
  for (const line of text.split('\n').filter((line) => line.trim() !== '')) {
    let event: LedgerEvent;
    try {
      event = EventSchema.parse(JSON.parse(line));
    } catch {
      throw new StewardError('invalid_input');
    }
    const previous = folded.get(event.request_id);
    folded.delete(event.request_id);
    folded.set(event.request_id, { ...previous, ...event });
  }
  return [...folded.values()].reverse();
}

export function formatLedgerRecord(record: LedgerEvent): string {
  const selected = record.selected;
  const route = selected ? `${selected.tool}/${selected.model}/${selected.thinking_level}` : '-';
  const fields = [record.request_id, record.recorded_at, route, selected?.account_id ?? '-', record.event];
  const line = fields.map((field) => JSON.stringify(field).slice(1, -1)).join('  ');
  return `${line}${record.exit_code === undefined ? '' : `  exit_code=${record.exit_code}`}\n`;
}
