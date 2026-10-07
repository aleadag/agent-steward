import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { compareRfc3339Timestamps } from '../timestamps.ts';
import type { StopInput } from '../contracts.ts';
import { SchedulerLeaseStore, type LeaseAttempt, type LeaseOptions } from './lease.ts';
import { assertNoCredentials, configuredApiKeys } from '../privacy.ts';
import { readPrivateJson, withPrivateGuard, writePrivateJson } from './private-files.ts';

type Retry = StopInput['retry'];
export type Episode = Retry & {
  pane_id: string;
  session_id: string;
  error_evidence_digest: string;
  next_check_at: string | null;
  last_delivery_state: 'none' | 'uncertain' | 'delivered' | 'human';
  lifecycle_handoff_sent?: boolean;
  workflow_episode_id?: string;
  completion_observation_id?: string;
};
export const workflowEpisodeId = (episode: Episode): string =>
  episode.workflow_episode_id ?? episode.failure_episode_id;
const retryHeadSchema = z
  .strictObject({
    protocol: z.literal(1),
    agent: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    recordId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    completedObservationId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    bindingEpisodeId: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine((head) => head.recordId !== null || head.completedObservationId !== null);
type RetryHead = z.infer<typeof retryHeadSchema>;
type Owner = { pid: number; token: string; session: string; heartbeat: number };
const ttl = 15_000;
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim());
const timestamp = z.iso.datetime({ offset: true });
const episodeSchema = z
  .strictObject({
    pane_id: z.string().regex(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/),
    session_id: identifier,
    failure_episode_id: identifier,
    error_evidence_digest: identifier,
    first_observed_at: timestamp,
    attempt_count: z.number().int().nonnegative(),
    last_attempt_at: timestamp.nullable(),
    quota_check_count: z.number().int().nonnegative(),
    last_quota_check_at: timestamp.nullable(),
    next_check_at: timestamp.nullable(),
    last_delivery_state: z.enum(['none', 'uncertain', 'delivered', 'human']),
    lifecycle_handoff_sent: z.boolean().optional(),
    workflow_episode_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    completion_observation_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((episode, issues) => {
    for (const [count, last] of [
      [episode.attempt_count, episode.last_attempt_at],
      [episode.quota_check_count, episode.last_quota_check_at],
    ] as const) {
      if (
        (count === 0) !== (last === null) ||
        (last !== null && compareRfc3339Timestamps(episode.first_observed_at, last) > 0)
      ) {
        issues.addIssue({ code: 'custom', message: 'Invalid episode history' });
      }
    }
    if (episode.lifecycle_handoff_sent && episode.next_check_at !== null) {
      issues.addIssue({ code: 'custom', message: 'Invalid lifecycle handoff schedule' });
    }
    if (
      episode.next_check_at !== null &&
      [episode.first_observed_at, episode.last_attempt_at, episode.last_quota_check_at].some(
        (previous) => previous !== null && compareRfc3339Timestamps(previous, episode.next_check_at!) > 0,
      )
    ) {
      issues.addIssue({ code: 'custom', message: 'Invalid episode schedule' });
    }
  });
export type ApprovalAttempt = {
  pane_id: string;
  agent: string;
  session_id: string;
  digest: string;
  state: 'human' | 'uncertain' | 'delivered' | 'not_sent';
  not_sent_reason?: 'observation_changed' | 'delivery_not_started';
  attempt_id?: string;
  recorded_at: string;
};
const approvalSchema = z
  .strictObject({
    pane_id: z.string().regex(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/),
    agent: identifier,
    session_id: identifier,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(['human', 'uncertain', 'delivered', 'not_sent']),
    not_sent_reason: z.enum(['observation_changed', 'delivery_not_started']).optional(),
    attempt_id: z.uuid().optional(),
    recorded_at: timestamp,
  })
  .refine((attempt) => (attempt.state === 'not_sent') === (attempt.not_sent_reason !== undefined));

export function parseEpisode(value: unknown): Episode {
  return episodeSchema.parse(value);
}

export class CorruptEpisodeError extends Error {
  constructor() {
    super('invalid episode metadata');
  }
}
const fields = [
  'pane_id',
  'session_id',
  'failure_episode_id',
  'workflow_episode_id',
  'completion_observation_id',
  'error_evidence_digest',
  'first_observed_at',
  'attempt_count',
  'last_attempt_at',
  'quota_check_count',
  'last_quota_check_at',
  'next_check_at',
  'last_delivery_state',
  'lifecycle_handoff_sent',
] as const;

function alive(pid: number): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;
  }
}
export async function readEpisodeLockOwner(
  path: string,
): Promise<{ pid: number; token: string; session: string; heartbeat: number } | null> {
  return owner(path);
}
async function owner(path: string): Promise<Owner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Owner;
    return Number.isSafeInteger(record.pid) &&
      typeof record.token === 'string' &&
      typeof record.session === 'string' &&
      Number.isFinite(record.heartbeat)
      ? record
      : null;
  } catch {
    return null;
  }
}
function filename(pane: string): string {
  return createHash('sha256').update(pane).digest('hex') + '.json';
}

function approvalFilename(agent: string, session: string): string {
  return `approval-${createHash('sha256')
    .update(JSON.stringify([agent, session]))
    .digest('hex')}.json`;
}

export class EpisodeStore {
  private readonly leases: SchedulerLeaseStore;

  constructor(
    readonly directory: string,
    private readonly nowMilliseconds: () => number = () => Date.now(),
    private readonly options: LeaseOptions = {},
  ) {
    this.leases = new SchedulerLeaseStore(directory, () => this.prepare(), nowMilliseconds, options);
  }
  async prepare(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('unsafe plugin state directory');
    let info;
    try {
      info = await lstat(this.directory);
    } catch (error) {
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
        if (
          !current.isDirectory() ||
          current.uid !== uid ||
          (current.mode & 0o022) !== 0 ||
          current.dev !== info.dev ||
          current.ino !== info.ino
        )
          throw new Error('unsafe plugin state directory');
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
      const checked = await lstat(this.directory);
      if (
        !checked.isDirectory() ||
        checked.uid !== uid ||
        checked.dev !== info.dev ||
        checked.ino !== info.ino ||
        (checked.mode & 0o777) !== 0o700
      ) {
        throw new Error('unsafe plugin state directory');
      }
    }
  }
  private async atomic(path: string, data: unknown): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async retry(pane: string): Promise<Episode | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory, filename(pane)), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = episodeSchema.parse(JSON.parse(raw));
      if (parsed.pane_id !== pane) throw new CorruptEpisodeError();
      return parsed;
    } catch {
      throw new CorruptEpisodeError();
    }
  }
  async record(pane: string, episode: Episode): Promise<void> {
    await this.prepare();
    if (episode.pane_id !== pane) throw new Error('episode pane mismatch');
    const metadata = Object.fromEntries(fields.map((field) => [field, episode[field]]));
    await this.atomic(join(this.directory, filename(pane)), metadata);
  }
  private sessionPath(agent: string, sessionId: string): string {
    for (const value of [agent, sessionId]) {
      identifier.parse(value);
      // eslint-disable-next-line no-control-regex -- Native identifiers cannot contain controls.
      if (/[\x00-\x1f\x7f]/.test(value)) throw new CorruptEpisodeError();
    }
    assertNoCredentials(
      [agent, sessionId],
      configuredApiKeys({
        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      }),
    );
    return join(
      this.directory,
      `retry-session-${createHash('sha256')
        .update(JSON.stringify([agent, sessionId]))
        .digest('hex')}.json`,
    );
  }
  private canonicalEpisode(value: unknown): Episode {
    const parsed = parseEpisode(value);
    for (const value of [parsed.session_id, parsed.failure_episode_id, parsed.error_evidence_digest]) {
      // eslint-disable-next-line no-control-regex -- New canonical identifiers cannot contain ASCII controls.
      if (/[\x00-\x1f\x7f]/.test(value)) throw new CorruptEpisodeError();
    }
    const serialized = assertNoCredentials(
      parsed,
      configuredApiKeys({
        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      }),
    );
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 8192) throw new CorruptEpisodeError();
    return parsed;
  }
  private async retryHead(agent: string, sessionId: string): Promise<RetryHead | null> {
    const path = this.sessionPath(agent, sessionId) + '.head.json';
    try {
      const head = retryHeadSchema.parse(await readPrivateJson(path, 8192, this.options));
      if (head.agent !== agent || head.sessionId !== sessionId) throw new CorruptEpisodeError();
      return head;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CorruptEpisodeError();
    }
  }
  async hasRetryHead(agent: string, sessionId: string): Promise<boolean> {
    await this.prepare();
    return (await this.retryHead(agent, sessionId)) !== null;
  }
  private recordId(episode: Episode): string {
    return createHash('sha256').update(episode.failure_episode_id).digest('hex');
  }
  private async selectedSessionPath(agent: string, sessionId: string): Promise<string | null> {
    const base = this.sessionPath(agent, sessionId);
    const head = await this.retryHead(agent, sessionId);
    return head ? (head.recordId === null ? null : `${base}.episode-${head.recordId}.json`) : base;
  }
  async sessionRetry(agent: string, sessionId: string): Promise<Episode | null> {
    await this.prepare();
    const path = await this.selectedSessionPath(agent, sessionId);
    if (path === null) return null;
    try {
      const episode = this.canonicalEpisode(await readPrivateJson(path, 8192, this.options));
      const head = await this.retryHead(agent, sessionId);
      if (
        episode.session_id !== sessionId ||
        (head &&
          (this.recordId(episode) !== head.recordId ||
            workflowEpisodeId(episode) !== head.bindingEpisodeId ||
            (episode.completion_observation_id ?? null) !== head.completedObservationId))
      )
        throw new CorruptEpisodeError();
      return episode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !(await this.retryHead(agent, sessionId))) return null;
      throw new CorruptEpisodeError();
    }
  }
  async recordSessionRetry(agent: string, sessionId: string, episode: Episode): Promise<void> {
    const base = this.sessionPath(agent, sessionId);
    const parsed = this.canonicalEpisode(episode);
    if (parsed.session_id !== sessionId) throw new CorruptEpisodeError();
    await this.prepare();
    const written = await withPrivateGuard(
      this.directory,
      `${basename(base)}.guard`,
      async () => {
        const path = await this.selectedSessionPath(agent, sessionId);
        if (path === null) throw new CorruptEpisodeError();
        const previous = await this.sessionRetry(agent, sessionId);
        if (
          previous &&
          (previous.pane_id !== parsed.pane_id ||
            previous.failure_episode_id !== parsed.failure_episode_id ||
            previous.error_evidence_digest !== parsed.error_evidence_digest ||
            previous.workflow_episode_id !== parsed.workflow_episode_id ||
            previous.completion_observation_id !== parsed.completion_observation_id ||
            (previous.last_delivery_state === 'uncertain' && parsed.last_delivery_state === 'human') ||
            previous.first_observed_at !== parsed.first_observed_at ||
            previous.attempt_count > parsed.attempt_count ||
            previous.quota_check_count > parsed.quota_check_count ||
            (previous.last_attempt_at !== null &&
              (parsed.last_attempt_at === null ||
                compareRfc3339Timestamps(previous.last_attempt_at, parsed.last_attempt_at) > 0)) ||
            (previous.last_quota_check_at !== null &&
              (parsed.last_quota_check_at === null ||
                compareRfc3339Timestamps(previous.last_quota_check_at, parsed.last_quota_check_at) > 0)) ||
            (previous.last_delivery_state !== 'none' && parsed.last_delivery_state === 'none') ||
            (previous.last_delivery_state === 'human' && parsed.last_delivery_state !== 'human') ||
            (previous.lifecycle_handoff_sent === true && parsed.lifecycle_handoff_sent !== true))
        )
          throw new CorruptEpisodeError();
        await writePrivateJson(path, parsed, this.options);
        return true;
      },
      this.options,
    );
    if (!written) throw new CorruptEpisodeError();
  }
  // Select a newly classified stop without rewriting its predecessor. Counters
  // only reset after explicit completion; lifecycle/screen changes carry them.
  async advanceSessionRetry(
    agent: string,
    sessionId: string,
    episode: Episode,
    previous: Episode | null,
  ): Promise<void> {
    const parsed = this.canonicalEpisode(episode);
    if (parsed.session_id !== sessionId || parsed.last_delivery_state !== 'none') throw new CorruptEpisodeError();
    const base = this.sessionPath(agent, sessionId);
    await this.prepare();
    const written = await withPrivateGuard(
      this.directory,
      `${basename(base)}.guard`,
      async () => {
        const current = await this.sessionRetry(agent, sessionId);
        const head = await this.retryHead(agent, sessionId);
        const selected = this.canonicalEpisode({
          ...parsed,
          workflow_episode_id:
            head?.bindingEpisodeId ?? (current ? workflowEpisodeId(current) : parsed.failure_episode_id),
          ...(head?.completedObservationId ? { completion_observation_id: head.completedObservationId } : {}),
        });
        if (
          !isDeepStrictEqual(current, previous) ||
          (current &&
            (current.failure_episode_id === parsed.failure_episode_id ||
              current.pane_id !== parsed.pane_id ||
              (parsed.workflow_episode_id !== undefined && parsed.workflow_episode_id !== workflowEpisodeId(current)) ||
              (parsed.completion_observation_id ?? null) !== (current.completion_observation_id ?? null) ||
              current.last_delivery_state === 'uncertain' ||
              (current.last_delivery_state === 'human' &&
                current.attempt_count !== 0 &&
                !(await this.retryHead(agent, sessionId))) ||
              current.lifecycle_handoff_sent ||
              current.first_observed_at !== parsed.first_observed_at ||
              current.attempt_count !== parsed.attempt_count ||
              current.last_attempt_at !== parsed.last_attempt_at ||
              parsed.quota_check_count < current.quota_check_count ||
              parsed.quota_check_count > current.quota_check_count + 1 ||
              (parsed.quota_check_count === current.quota_check_count &&
                current.last_quota_check_at !== parsed.last_quota_check_at) ||
              (current.last_quota_check_at !== null &&
                (parsed.last_quota_check_at === null ||
                  compareRfc3339Timestamps(current.last_quota_check_at, parsed.last_quota_check_at) > 0))))
        )
          throw new CorruptEpisodeError();
        if (!current && (parsed.attempt_count !== 0 || parsed.quota_check_count !== 0)) throw new CorruptEpisodeError();
        try {
          const original = this.canonicalEpisode(await readPrivateJson(base, 8192, this.options));
          if (original.failure_episode_id === parsed.failure_episode_id) throw new CorruptEpisodeError();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const recordId = this.recordId(parsed);
        const path = `${base}.episode-${recordId}.json`;
        try {
          await readPrivateJson(path, 8192, this.options);
          throw new CorruptEpisodeError(); // Already selected, attempted, or an interrupted publication.
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await writePrivateJson(path, selected, this.options);
        await writePrivateJson(
          base + '.head.json',
          {
            protocol: 1,
            agent,
            sessionId,
            recordId,
            completedObservationId: selected.completion_observation_id ?? null,
            bindingEpisodeId: workflowEpisodeId(selected),
          },
          this.options,
        );
        return true;
      },
      this.options,
    );
    if (!written) throw new CorruptEpisodeError();
  }
  async completeSessionRetry(
    agent: string,
    sessionId: string,
    observationId: string,
    previous: Episode,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(observationId)) throw new CorruptEpisodeError();
    const base = this.sessionPath(agent, sessionId);
    await this.prepare();
    const written = await withPrivateGuard(
      this.directory,
      `${basename(base)}.guard`,
      async () => {
        const current = await this.sessionRetry(agent, sessionId);
        if (
          !isDeepStrictEqual(current, previous) ||
          !current ||
          current.failure_episode_id === observationId ||
          current.last_delivery_state === 'uncertain' ||
          (current.last_delivery_state === 'human' &&
            current.attempt_count !== 0 &&
            !(await this.retryHead(agent, sessionId))) ||
          current.lifecycle_handoff_sent
        )
          throw new CorruptEpisodeError();
        await writePrivateJson(
          base + '.head.json',
          {
            protocol: 1,
            agent,
            sessionId,
            recordId: null,
            completedObservationId: observationId,
            bindingEpisodeId: workflowEpisodeId(current),
          },
          this.options,
        );
        return true;
      },
      this.options,
    );
    if (!written) throw new CorruptEpisodeError();
  }
  async approval(agent: string, session: string): Promise<ApprovalAttempt | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory, approvalFilename(agent, session)), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = approvalSchema.parse(JSON.parse(raw));
      if (parsed.agent !== agent || parsed.session_id !== session) throw new CorruptEpisodeError();
      return parsed;
    } catch {
      throw new CorruptEpisodeError();
    }
  }
  async recordApproval(pane: string, attempt: ApprovalAttempt): Promise<void> {
    await this.prepare();
    const parsed = approvalSchema.parse(attempt);
    if (parsed.pane_id !== pane) throw new Error('approval pane mismatch');
    await this.atomic(join(this.directory, approvalFilename(parsed.agent, parsed.session_id)), parsed);
  }
  async clear(pane: string): Promise<void> {
    await rm(join(this.directory, filename(pane)), { force: true });
  }
  async targets(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const panes: string[] = [];
    for (const name of names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
      const value: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as Episode).pane_id !== 'string' ||
        filename((value as Episode).pane_id) !== name
      )
        throw new Error('invalid episode filename');
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
  beginAcquire(session: string): LeaseAttempt {
    return this.leases.beginAcquire(session);
  }
  acquire(session: string): Promise<string | null> {
    return this.leases.acquire(session);
  }
  active(session?: string): Promise<boolean> {
    return this.leases.active(session);
  }
  activeToken(session: string): Promise<string | null> {
    return this.leases.activeToken(session);
  }
  leaseMatches(token: string, session: string): Promise<boolean> {
    return this.leases.leaseMatches(token, session);
  }
  owned(token: string, session: string): Promise<boolean> {
    return this.leases.owned(token, session);
  }
  heartbeat(token: string, session: string): Promise<boolean> {
    return this.leases.heartbeat(token, session);
  }
  release(token: string): Promise<void> {
    return this.leases.release(token);
  }
  async withEpisodeLock<T>(pane: string, action: () => Promise<T>): Promise<T | null> {
    await this.prepare();
    const path = join(this.directory, `${filename(pane)}.lock`);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const guard = `${path}.takeover`;
      try {
        await mkdir(guard, { mode: 0o700 });
      } catch {
        return null;
      }
      try {
        const previous = await owner(path);
        if (!previous || previous.heartbeat + ttl > this.nowMilliseconds() || alive(previous.pid) !== false)
          return null;
        await rm(path, { recursive: true });
        await mkdir(path, { mode: 0o700 });
      } finally {
        await rm(guard, { recursive: true, force: true });
      }
    }
    const token = randomUUID();
    await this.atomic(join(path, 'owner.json'), { pid: process.pid, token, session: pane, heartbeat: Date.now() });
    try {
      return await action();
    } finally {
      if ((await owner(path))?.token === token) await rm(path, { recursive: true });
    }
  }
}
