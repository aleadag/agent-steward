import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { Stats } from 'node:fs';
import { z } from 'zod';
import { agyAuthPath } from './agy-auth.ts';
import { shellQuote } from './commands.ts';
import { StewardError } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';

export type AgyPaths = { auth: string; settings: string; state: string; workdir: string; manifest: string };
const statusLineSchema = z
  .object({ type: z.literal('command'), command: z.string().min(1), enabled: z.boolean().optional() })
  .passthrough();
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  previousStatusLine: statusLineSchema.nullable(),
  installedCommand: z.string().min(1),
});
export type AgySetupManifest = z.infer<typeof manifestSchema>;
export type AgySetupIO = {
  readText: (p: string) => Promise<string>;
  lstat: (p: string) => Promise<Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'mode'>>;
  writeText: (p: string, t: string, m: number) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
  mkdirp: (p: string, m: number) => Promise<void>;
  chmod: (p: string, m: number) => Promise<void>;
  withLock: <T>(p: string, f: () => Promise<T>) => Promise<T>;
};
export function agyPaths(env: { HOME?: string; XDG_STATE_HOME?: string }): AgyPaths {
  const auth = agyAuthPath(env);
  const base = env.XDG_STATE_HOME || join(env.HOME!, '.local', 'state');
  if (!isAbsolute(base)) throw new StewardError('invalid_input');
  const state = join(base, 'agent-steward', 'agy');
  return {
    auth,
    settings: join(dirname(auth), 'settings.json'),
    state,
    workdir: join(base, 'agent-steward', 'agy-quota-workdir'),
    manifest: join(state, 'statusline.json'),
  };
}
function parse(text: string): Record<string, unknown> {
  assertByteLength(text);
  const value: unknown = JSON.parse(text);
  assertJsonDepth(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agy_setup');
  return value as Record<string, unknown>;
}
function isAgyHookCommand(command: string): boolean {
  return /(?:^|\s)['"]?quota['"]?\s+['"]?hook['"]?\s+['"]?agy['"]?\s*$/.test(command);
}
export function parseAgyManifest(text: string): AgySetupManifest | null {
  try {
    const manifest = manifestSchema.parse(parse(text));
    if (manifest.previousStatusLine && isAgyHookCommand(manifest.previousStatusLine.command)) return null;
    return manifest;
  } catch {
    return null;
  }
}
function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
async function readOptional(p: string, io: Pick<AgySetupIO, 'readText'>): Promise<string | null> {
  try {
    return await io.readText(p);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function ensurePath(p: string, directory: boolean, io: AgySetupIO): Promise<void> {
  try {
    const stat = await io.lstat(p);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('agy_setup');
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
async function atomic(p: string, text: string, io: AgySetupIO): Promise<void> {
  assertByteLength(text);
  const temporary = `${p}.${randomUUID()}.tmp`;
  await io.writeText(temporary, text, 0o600);
  try {
    await io.rename(temporary, p);
  } catch (error) {
    try {
      await io.unlink(temporary);
    } catch (cleanup) {
      if (!missing(cleanup)) throw cleanup;
    }
    throw error;
  }
}
export async function verifyAgySetup(
  paths: AgyPaths,
  io: Pick<AgySetupIO, 'readText'>,
): Promise<AgySetupManifest | null> {
  try {
    const manifest = parseAgyManifest(await io.readText(paths.manifest));
    const settings = parse(await io.readText(paths.settings));
    const line = statusLineSchema.safeParse(settings.statusLine);
    return manifest && line.success && line.data.command === manifest.installedCommand && line.data.enabled !== false
      ? manifest
      : null;
  } catch {
    return null;
  }
}
export async function setupAgy(paths: AgyPaths, stewardCommand: readonly string[], io: AgySetupIO): Promise<void> {
  if (
    !stewardCommand.length ||
    !isAbsolute(stewardCommand[0]!) ||
    // eslint-disable-next-line no-control-regex -- Executable argv must not contain terminal controls.
    stewardCommand.some((p) => !p || /[\x00-\x1f\x7f]/.test(p))
  )
    throw new StewardError('invalid_input');
  await ensurePath(paths.state, true, io);
  await io.mkdirp(paths.state, 0o700);
  await io.chmod(paths.state, 0o700);
  await io.withLock(paths.manifest, async () => {
    await ensurePath(paths.settings, false, io);
    await ensurePath(paths.manifest, false, io);
    await ensurePath(paths.workdir, true, io);
    const original = await readOptional(paths.settings, io);
    const settings = original === null ? {} : parse(original);
    const savedText = await readOptional(paths.manifest, io);
    const saved = savedText === null ? null : parseAgyManifest(savedText);
    if (savedText !== null && !saved) throw new Error('agy_setup');
    const current = settings.statusLine === undefined ? null : statusLineSchema.parse(settings.statusLine);
    const command = [...stewardCommand, 'quota', 'hook', 'agy'].map(shellQuote).join(' ');
    if (saved && current?.command !== saved.installedCommand) throw new Error('agy_setup');
    if (!saved && current && isAgyHookCommand(current.command)) throw new Error('agy_setup');
    const manifest: AgySetupManifest = {
      schema_version: 1,
      previousStatusLine: saved ? saved.previousStatusLine : current,
      installedCommand: command,
    };
    settings.statusLine = { ...current, type: 'command', command, enabled: true };
    const replacement = JSON.stringify(settings, null, 2) + '\n';
    await io.mkdirp(paths.workdir, 0o700);
    await io.chmod(paths.workdir, 0o700);
    await io.mkdirp(dirname(paths.settings), 0o700);
    if ((await readOptional(paths.settings, io)) !== original) throw new Error('agy_setup');
    // Save the renderer first so the newly installed hook never loses its display.
    await atomic(paths.manifest, JSON.stringify(manifest), io);
    try {
      await atomic(paths.settings, replacement, io);
    } catch (error) {
      if (savedText !== null) await atomic(paths.manifest, savedText, io);
      else await io.unlink(paths.manifest);
      throw error;
    }
  });
}
