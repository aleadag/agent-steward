import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { assertNoCredentials, configuredApiKeys } from '../privacy.ts';
import type { LeaseOptions } from './lease.ts';
import { withPrivateGuard, writePrivateContents } from './private-files.ts';

export type DiagnosticEvent = {
  at: string;
  scopeHash: string;
  outcome: 'created' | 'finished' | 'handoff' | 'shutdown_incomplete';
  reason: 'completed' | 'human' | 'canceled' | 'lost' | 'capacity' | 'release_unconfirmed' | null;
};

const MAX_LOG_BYTES = 1_048_576;
const MAX_LINE_BYTES = 1024;
const LOG = 'workflow.log';
const BACKUP = 'workflow.log.1';
const GUARD = 'workflow-log-guard';
const DiagnosticEventSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  scopeHash: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(['created', 'finished', 'handoff', 'shutdown_incomplete']),
  reason: z.enum(['completed', 'human', 'canceled', 'lost', 'capacity', 'release_unconfirmed']).nullable(),
});
const ioFor = (options: LeaseOptions) => ({ lstat, open, ...options.io });
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const unsafe = (): Error => new Error('unsafe private workflow metadata');
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const tails = new Map<string, Promise<void>>();

function privateFile(info: Stats): Stats {
  const uid = process.getuid?.();
  if (uid === undefined || !info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1)
    throw unsafe();
  return info;
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(buffer);
  } catch {
    throw unsafe();
  }
}

function validateLogText(text: string): void {
  if (text.length === 0) return;
  if (!text.endsWith('\n')) throw unsafe();
  for (const line of text.slice(0, -1).split('\n')) {
    if (Buffer.byteLength(`${line}\n`) > MAX_LINE_BYTES) throw unsafe();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw unsafe();
    }
    try {
      serialize(parsed as DiagnosticEvent);
    } catch {
      throw unsafe();
    }
  }
}

function serialize(event: DiagnosticEvent): string {
  const parsed = DiagnosticEventSchema.parse(event);
  const recorded: DiagnosticEvent = {
    at: parsed.at,
    scopeHash: parsed.scopeHash,
    outcome: parsed.outcome,
    reason: parsed.reason,
  };
  assertNoCredentials(
    recorded,
    configuredApiKeys({
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    }),
  );
  const line = `${JSON.stringify(recorded)}\n`;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw unsafe();
  return line;
}

async function readLog(path: string, options: LeaseOptions): Promise<string> {
  const io = ioFor(options);
  let before: Stats;
  try {
    before = privateFile(await io.lstat(path));
  } catch (error) {
    if (isMissing(error)) return '';
    throw error;
  }
  if (before.size > MAX_LOG_BYTES) throw unsafe();
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw unsafe();
  });
  try {
    const opened = privateFile(await handle.stat());
    if (!same(before, opened) || opened.size > MAX_LOG_BYTES) throw unsafe();
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
    let length = 0;
    while (length <= MAX_LOG_BYTES) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_LOG_BYTES) throw unsafe();
    if (!same(privateFile(await io.lstat(path)), opened)) throw unsafe();
    const text = decodeUtf8(buffer.subarray(0, length));
    validateLogText(text);
    return text;
  } catch (error) {
    if (error instanceof Error && error.message === unsafe().message) throw error;
    throw unsafe();
  } finally {
    await handle.close().catch(() => {
      throw unsafe();
    });
  }
}

function enqueue(directory: string, action: () => Promise<void>): Promise<void> {
  const next = (tails.get(directory) ?? Promise.resolve()).then(action, action);
  tails.set(
    directory,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export async function appendDiagnostic(
  directory: string,
  event: DiagnosticEvent,
  options: LeaseOptions = {},
): Promise<void> {
  const line = serialize(event);
  await enqueue(directory, async () => {
    // Event hooks are independent processes. The local queue alone cannot
    // serialize them; retry only a validated busy guard, never unlink by age.
    const deadlineAt = performance.now() + 2000;
    do {
      const written = await withPrivateGuard(
        directory,
        GUARD,
        async () => {
          const log = join(directory, LOG);
          const backup = join(directory, BACKUP);
          const current = await readLog(log, options);
          await readLog(backup, options);
          if (Buffer.byteLength(current) + Buffer.byteLength(line) > MAX_LOG_BYTES) {
            await writePrivateContents(backup, current, options);
            await writePrivateContents(log, line, options);
          } else {
            await writePrivateContents(log, current + line, options);
          }
        },
        options,
      );
      if (written !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() < deadlineAt);
    throw unsafe();
  });
}
