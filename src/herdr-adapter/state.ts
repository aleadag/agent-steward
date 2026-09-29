import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { compareRfc3339Timestamps } from '../timestamps.js';
import type { StopInput } from '../contracts.js';

type Retry = StopInput['retry'];
export type Episode = Retry & { pane_id: string; session_id: string; error_evidence_digest: string;
  next_check_at: string | null; last_delivery_state: 'none' | 'uncertain' | 'delivered' | 'human';
  lifecycle_handoff_sent?: boolean };
type Owner = { pid: number; token: string; session: string; heartbeat: number };
const ttl = 15_000;
const identifier = z.string().min(1).max(256).refine(value => value === value.trim());
const timestamp = z.iso.datetime({ offset: true });
const episodeSchema = z.strictObject({
  pane_id: z.string().regex(/^w[0-9]+:p[0-9]+$/), session_id: identifier,
  failure_episode_id: identifier, error_evidence_digest: identifier,
  first_observed_at: timestamp, attempt_count: z.number().int().nonnegative(),
  last_attempt_at: timestamp.nullable(), quota_check_count: z.number().int().nonnegative(),
  last_quota_check_at: timestamp.nullable(), next_check_at: timestamp.nullable(),
  last_delivery_state: z.enum(['none', 'uncertain', 'delivered', 'human']),
  lifecycle_handoff_sent: z.boolean().optional(),
}).superRefine((episode, issues) => {
  for (const [count, last] of [[episode.attempt_count, episode.last_attempt_at],
    [episode.quota_check_count, episode.last_quota_check_at]] as const) {
    if ((count === 0) !== (last === null) ||
        (last !== null && compareRfc3339Timestamps(episode.first_observed_at, last) > 0)) {
      issues.addIssue({ code: 'custom', message: 'Invalid episode history' });
    }
  }
  if (episode.lifecycle_handoff_sent && episode.next_check_at !== null) {
    issues.addIssue({ code: 'custom', message: 'Invalid lifecycle handoff schedule' });
  }
  if (episode.next_check_at !== null &&
      [episode.first_observed_at, episode.last_attempt_at, episode.last_quota_check_at].some(
        previous => previous !== null && compareRfc3339Timestamps(previous, episode.next_check_at!) > 0)) {
    issues.addIssue({ code: 'custom', message: 'Invalid episode schedule' });
  }
});
export class CorruptEpisodeError extends Error {
  constructor() { super('invalid episode metadata'); }
}
const fields = ['pane_id', 'session_id', 'failure_episode_id', 'error_evidence_digest', 'first_observed_at',
  'attempt_count', 'last_attempt_at', 'quota_check_count', 'last_quota_check_at', 'next_check_at', 'last_delivery_state',
  'lifecycle_handoff_sent'] as const;

function alive(pid: number): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}
async function owner(path: string): Promise<Owner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Owner;
    return Number.isSafeInteger(record.pid) && typeof record.token === 'string' &&
      typeof record.session === 'string' && Number.isFinite(record.heartbeat) ? record : null;
  } catch { return null; }
}
function filename(pane: string): string { return createHash('sha256').update(pane).digest('hex') + '.json'; }

export class EpisodeStore {
  constructor(readonly directory: string, private readonly nowMilliseconds: () => number = () => Date.now()) {}
  async prepare(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('unsafe plugin state directory');
    let info;
    try { info = await lstat(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      info = await lstat(this.directory);
    }
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
      throw new Error('unsafe plugin state directory');
    }
    if ((info.mode & 0o777) !== 0o700) {
      const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (!current.isDirectory() || current.uid !== uid || (current.mode & 0o022) !== 0 ||
            current.dev !== info.dev || current.ino !== info.ino) throw new Error('unsafe plugin state directory');
        await handle.chmod(0o700);
      } finally { await handle.close(); }
      const checked = await lstat(this.directory);
      if (!checked.isDirectory() || checked.uid !== uid ||
          checked.dev !== info.dev || checked.ino !== info.ino || (checked.mode & 0o777) !== 0o700) {
        throw new Error('unsafe plugin state directory');
      }
    }
  }
  private async atomic(path: string, data: unknown): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  async retry(pane: string): Promise<Episode | null> {
    let raw: string;
    try { raw = await readFile(join(this.directory, filename(pane)), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const parsed = episodeSchema.parse(JSON.parse(raw));
      if (parsed.pane_id !== pane) throw new CorruptEpisodeError();
      return parsed;
    } catch { throw new CorruptEpisodeError(); }
  }
  async record(pane: string, episode: Episode): Promise<void> {
    await this.prepare();
    if (episode.pane_id !== pane) throw new Error('episode pane mismatch');
    const metadata = Object.fromEntries(fields.map(field => [field, episode[field]]));
    await this.atomic(join(this.directory, filename(pane)), metadata);
  }
  async clear(pane: string): Promise<void> { await rm(join(this.directory, filename(pane)), { force: true }); }
  async targets(): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const panes: string[] = [];
    for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
      const value: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (!value || typeof value !== 'object' || typeof (value as Episode).pane_id !== 'string' ||
          filename((value as Episode).pane_id) !== name) throw new Error('invalid episode filename');
      panes.push((value as Episode).pane_id);
    }
    return panes;
  }
  async due(targets: readonly string[], now: Date): Promise<string[]> {
    const due: string[] = [];
    for (const target of targets) {
      const record = await this.retry(target);
      if (record?.next_check_at && Date.parse(record.next_check_at) <= now.getTime()) due.push(target);
    }
    return due;
  }
  async next(targets: readonly string[]): Promise<number | null> {
    let next: number | null = null;
    for (const target of targets) {
      const record = await this.retry(target);
      if (record?.next_check_at) {
        const time = Date.parse(record.next_check_at);
        if (Number.isFinite(time)) next = Math.min(next ?? time, time);
      }
    }
    return next;
  }
  private leasePath(): string { return join(this.directory, 'scheduler-lease'); }
  async active(session?: string): Promise<boolean> {
    const lease = await owner(this.leasePath());
    return !!lease && (session === undefined || lease.session === session) &&
      lease.heartbeat + ttl > this.nowMilliseconds() && alive(lease.pid) === true;
  }
  // A separate event-hook process may inspect the scheduler's lease but cannot
  // claim its PID. Bind that hook to the exact token observed at invocation.
  async activeToken(session: string): Promise<string | null> {
    const lease = await owner(this.leasePath());
    return lease && lease.session === session && lease.token &&
      lease.heartbeat + ttl > this.nowMilliseconds() && alive(lease.pid) === true ? lease.token : null;
  }
  async leaseMatches(token: string, session: string): Promise<boolean> {
    return !!token && await this.activeToken(session) === token;
  }
  async acquire(session: string): Promise<string | null> {
    await this.prepare();
    const path = this.leasePath();
    const token = randomUUID();
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A stale timestamp alone is not proof of death. Serialize takeover and re-read owner
      // before deleting it. Unknown ownership never authorizes two runners.
      const guard = join(this.directory, 'takeover-guard');
      try { await mkdir(guard, { mode: 0o700 }); }
      catch { return null; }
      try {
        const previous = await owner(path);
        if (!previous || previous.heartbeat + ttl > this.nowMilliseconds() || alive(previous.pid) !== false) return null;
        await rm(path, { recursive: true });
        await mkdir(path, { mode: 0o700 });
      } finally { await rm(guard, { recursive: true, force: true }); }
    }
    await this.atomic(join(path, 'owner.json'), { pid: process.pid, token, session, heartbeat: this.nowMilliseconds() });
    return token;
  }
  async owned(token: string, session: string): Promise<boolean> {
    const current = await owner(this.leasePath());
    return !!current && current.token === token && current.session === session &&
      current.pid === process.pid && current.heartbeat + ttl > this.nowMilliseconds();
  }
  async heartbeat(token: string, session: string): Promise<boolean> {
    if (!await this.owned(token, session)) return false;
    const current = await owner(this.leasePath());
    if (!current || current.token !== token) return false;
    await this.atomic(join(this.leasePath(), 'owner.json'), { ...current, heartbeat: this.nowMilliseconds() });
    return true;
  }
  async release(token: string): Promise<void> {
    if ((await owner(this.leasePath()))?.token === token) await rm(this.leasePath(), { recursive: true });
  }
  async withEpisodeLock<T>(pane: string, action: () => Promise<T>): Promise<T | null> {
    await this.prepare();
    const path = join(this.directory, `${filename(pane)}.lock`);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const guard = `${path}.takeover`;
      try { await mkdir(guard, { mode: 0o700 }); }
      catch { return null; }
      try {
        const previous = await owner(path);
        if (!previous || previous.heartbeat + ttl > this.nowMilliseconds() || alive(previous.pid) !== false) return null;
        await rm(path, { recursive: true });
        await mkdir(path, { mode: 0o700 });
      } finally { await rm(guard, { recursive: true, force: true }); }
    }
    const token = randomUUID();
    await this.atomic(join(path, 'owner.json'), { pid: process.pid, token, session: '', heartbeat: Date.now() });
    try { return await action(); }
    finally { if ((await owner(path))?.token === token) await rm(path, { recursive: true }); }
  }
}
