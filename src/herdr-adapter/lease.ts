import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, mkdir, rename, rm, readdir, chmod, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';

export type LeaseIdentity = { protocol: 2; token: string; pid: number; session: string };
export type LeaseHeartbeat = { protocol: 2; token: string; heartbeat: number };
export type LeaseState =
  | { kind: 'absent' }
  | { kind: 'selected'; identity: LeaseIdentity; heartbeat: LeaseHeartbeat; released: boolean };
export type LeaseIO = {
  lstat: (path: string) => Promise<Stats>;
  open: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
  mkdir: (path: string, options: { mode: number }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options: { force?: boolean; recursive?: boolean }) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  chmod: (path: string, mode: number) => Promise<void>;
};
export type LeaseOptions = { io?: Partial<LeaseIO>; alive?: (pid: number) => boolean | null };
export type LeaseAttempt = {
  readonly token: string;
  readonly ready: Promise<string | null>;
  isOpen(): boolean;
  close(): void;
  release(): Promise<void>;
};
type LocalGeneration = {
  readonly identity: LeaseIdentity;
  closing: boolean;
  authorized: boolean;
  ownerReady: Promise<void>;
  ready: Promise<string | null>;
  settleOwnerReady(error?: unknown): void;
  ownerSettled: boolean;
  renewal?: Promise<boolean>;
  revocation?: Promise<void>;
};
class PublicationCancelled extends Error {}

const ttl = 15_000;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const identitySchema = z.strictObject({
  protocol: z.literal(2),
  token: uuid,
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  session: z.string().min(1),
});
const heartbeatSchema = z.strictObject({
  protocol: z.literal(2),
  token: uuid,
  heartbeat: z.number().finite(),
});
const sameIdentity = (a: LeaseIdentity, b: LeaseIdentity): boolean =>
  a.protocol === b.protocol && a.token === b.token && a.pid === b.pid && a.session === b.session;
const isCode = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException | null)?.code === code;
const errorForState = (): LeaseStateError => new LeaseStateError();

function aliveByDefault(pid: number): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, 'ESRCH') ? false : null;
  }
}

export class LeaseStateError extends Error {
  constructor() {
    super('scheduler lease requires offline review');
  }
}

export class SchedulerLeaseStore {
  private readonly io: LeaseIO;
  private readonly alive: (pid: number) => boolean | null;
  private readonly local = new Map<string, LocalGeneration>();

  constructor(
    readonly directory: string,
    private readonly prepare: () => Promise<void>,
    private readonly now: () => number,
    options: LeaseOptions = {},
  ) {
    this.io = { lstat, open, mkdir, rename, rm, unlink, readdir, chmod, ...options.io };
    this.alive = options.alive ?? aliveByDefault;
  }

  async inspect(): Promise<LeaseState> {
    try {
      const identity = await this.selector();
      if (identity === null) return { kind: 'absent' };

      await this.generationDirectoriesSafe(identity.token);
      const generation = this.generationPath(identity.token);
      const owner = identitySchema.parse(await this.readJson(join(generation, 'owner.json')));
      const heartbeat = heartbeatSchema.parse(await this.readJson(join(generation, 'heartbeat.json')));
      if (!sameIdentity(identity, owner) || heartbeat.token !== identity.token) throw errorForState();

      const releasedBefore = await this.marker(identity);
      const selectedAgain = await this.selector();
      if (selectedAgain === null || !sameIdentity(identity, selectedAgain)) throw errorForState();
      const releasedAfter = await this.marker(identity);

      return { kind: 'selected', identity, heartbeat, released: releasedBefore || releasedAfter };
    } catch (error) {
      if (error instanceof LeaseStateError) throw error;
      throw errorForState();
    }
  }

  async active(session?: string): Promise<boolean> {
    return this.authorized(session);
  }

  beginAcquire(session: string): LeaseAttempt {
    if (typeof session !== 'string' || session.length === 0) throw errorForState();
    const identity: LeaseIdentity = { protocol: 2, token: randomUUID(), pid: process.pid, session };
    let resolveOwner!: () => void;
    let rejectOwner!: (error: unknown) => void;
    const ownerReady = new Promise<void>((resolve, reject) => {
      resolveOwner = resolve;
      rejectOwner = reject;
    });
    void ownerReady.catch(() => {});
    const local: LocalGeneration = {
      identity,
      closing: false,
      authorized: false,
      ownerReady,
      ready: Promise.resolve(null),
      ownerSettled: false,
      settleOwnerReady: (error?: unknown) => {
        if (local.ownerSettled) return;
        local.ownerSettled = true;
        if (error === undefined) resolveOwner();
        else rejectOwner(errorForState());
      },
    } satisfies LocalGeneration;
    this.local.set(identity.token, local);
    local.ready = this.initialize(local);
    void local.ready.catch(() => {});
    return {
      token: identity.token,
      ready: local.ready,
      isOpen: () => !local.closing,
      close: () => {
        local.closing = true;
      },
      release: () => this.release(identity.token),
    };
  }

  async acquire(session: string): Promise<string | null> {
    return this.beginAcquire(session).ready;
  }

  async activeToken(session: string): Promise<string | null> {
    try {
      const state = await this.inspect();
      if (state.kind !== 'selected' || state.released || state.identity.session !== session) return null;
      return (await this.freshAndLive(state)) ? state.identity.token : null;
    } catch (error) {
      if (error instanceof LeaseStateError) return null;
      throw error;
    }
  }

  async leaseMatches(token: string, session: string): Promise<boolean> {
    if (!uuid.safeParse(token).success || typeof session !== 'string' || session.length === 0) return false;
    try {
      const state = await this.inspect();
      return (
        state.kind === 'selected' &&
        !state.released &&
        state.identity.token === token &&
        state.identity.session === session &&
        (await this.freshAndLive(state))
      );
    } catch (error) {
      if (error instanceof LeaseStateError) return false;
      throw error;
    }
  }

  async owned(token: string, session: string): Promise<boolean> {
    const local = this.local.get(token);
    if (
      !local ||
      !local.authorized ||
      local.closing ||
      local.identity.token !== token ||
      local.identity.session !== session ||
      local.identity.pid !== process.pid
    ) {
      return false;
    }
    const matches = await this.leaseMatches(token, session);
    return matches && !local.closing && local.identity.pid === process.pid;
  }

  heartbeat(token: string, session: string): Promise<boolean> {
    const local = this.local.get(token);
    if (
      !local ||
      !local.authorized ||
      local.closing ||
      local.identity.token !== token ||
      local.identity.session !== session ||
      local.identity.pid !== process.pid
    ) {
      return Promise.resolve(false);
    }
    let captured: number;
    try {
      captured = this.now();
      if (!Number.isFinite(captured)) return Promise.resolve(false);
    } catch {
      return Promise.resolve(false);
    }
    if (local.renewal) return local.renewal;
    const renewal = this.renew(local, captured);
    local.renewal = renewal;
    void renewal.then(
      () => {
        if (local.renewal === renewal) local.renewal = undefined;
      },
      () => {
        if (local.renewal === renewal) local.renewal = undefined;
      },
    );
    return renewal;
  }

  release(token: string): Promise<void> {
    if (!uuid.safeParse(token).success) return Promise.reject(errorForState());
    const local = this.local.get(token);
    if (!local || local.identity.token !== token) return Promise.reject(errorForState());
    local.closing = true;
    if (local.revocation) return local.revocation;
    const revocation = this.revoke(local);
    local.revocation = revocation;
    void revocation.catch(() => {});
    return revocation;
  }

  private async authorized(session?: string): Promise<boolean> {
    try {
      const state = await this.inspect();
      if (state.kind !== 'selected' || state.released) return false;
      if (session !== undefined && state.identity.session !== session) return false;
      return this.freshAndLive(state);
    } catch (error) {
      if (error instanceof LeaseStateError) return false;
      throw error;
    }
  }

  private async freshAndLive(state: Extract<LeaseState, { kind: 'selected' }>): Promise<boolean> {
    let now: number;
    try {
      now = this.now();
    } catch {
      return false;
    }
    if (!Number.isFinite(now) || state.heartbeat.heartbeat + ttl <= now) return false;
    try {
      return this.alive(state.identity.pid) === true;
    } catch {
      return false;
    }
  }

  private async initialize(local: LocalGeneration): Promise<string | null> {
    const guardPath = join(this.directory, 'takeover-guard');
    let guardHandle: FileHandle | undefined;
    let guardIdentity: Stats | undefined;
    let heldGuard = false;
    let result: string | null = null;
    let failure: unknown;
    try {
      await this.prepare();
    } catch (error) {
      local.closing = true;
      local.settleOwnerReady(errorForState());
      if (error instanceof Error && error.message === 'unsafe plugin state directory') throw error;
      throw errorForState();
    }
    try {
      await this.rootSafe();
      await this.rejectLegacyLayout();
      await this.ensureDirectory(this.leasePath());
      await this.ensureDirectory(this.generationsPath());
      guardHandle = await this.acquirePublicationGuard(local, guardPath);
      if (guardHandle) {
        heldGuard = true;
        await guardHandle.chmod(0o600);
        guardIdentity = this.guardFileIdentity(await guardHandle.stat());
        result = await this.publishUnderGuard(local);
      }
    } catch (error) {
      failure = error;
    }
    if (heldGuard) {
      if (guardIdentity) {
        try {
          await this.removeGuard(guardPath, guardIdentity);
        } catch (error) {
          failure ??= error;
        }
      } else {
        failure ??= errorForState();
      }
    }
    if (guardHandle !== undefined) {
      try {
        await guardHandle.close();
      } catch {
        failure ??= errorForState();
      }
    }
    if (failure !== undefined) {
      local.closing = true;
      local.settleOwnerReady(errorForState());
      if (local.ownerSettled) await this.release(local.identity.token).catch(() => {});
      throw errorForState();
    }
    if (result !== null) {
      if (local.closing) {
        await this.release(local.identity.token);
        return null;
      }
      local.authorized = true;
    }
    return result;
  }

  private async publishUnderGuard(local: LocalGeneration): Promise<string | null> {
    const previous = await this.inspect();
    if (previous.kind === 'selected' && !previous.released) {
      let now: number;
      try {
        now = this.now();
      } catch {
        throw errorForState();
      }
      let dead = false;
      try {
        dead = this.alive(previous.identity.pid) === false;
      } catch {
        dead = false;
      }
      if (!Number.isFinite(now) || previous.heartbeat.heartbeat + ttl > now || !dead) {
        local.settleOwnerReady(errorForState());
        return null;
      }
      await this.publishMarker(previous.identity);
    }
    const generation = this.generationPath(local.identity.token);
    await this.io.mkdir(generation, { mode: 0o700 });
    await this.io.chmod(generation, 0o700);
    await this.directorySafe(generation);
    await this.exclusiveJson(join(generation, 'owner.json'), local.identity);
    const writtenOwner = identitySchema.parse(await this.readJson(join(generation, 'owner.json')));
    if (!sameIdentity(local.identity, writtenOwner)) throw errorForState();
    local.settleOwnerReady();
    if (local.closing) {
      await this.release(local.identity.token);
      return null;
    }
    const initialHeartbeat = this.now();
    if (!Number.isFinite(initialHeartbeat)) throw errorForState();
    await this.atomicJson(join(generation, 'heartbeat.json'), {
      protocol: 2,
      token: local.identity.token,
      heartbeat: initialHeartbeat,
    });
    if (local.closing) {
      await this.release(local.identity.token);
      return null;
    }
    try {
      await this.atomicJson(join(this.leasePath(), 'active.json'), local.identity, () => !local.closing);
    } catch (error) {
      if (error instanceof PublicationCancelled && local.closing) {
        await this.release(local.identity.token);
        return null;
      }
      throw error;
    }
    if (local.closing) {
      await this.release(local.identity.token);
      return null;
    }
    const selected = await this.leaseMatches(local.identity.token, local.identity.session);
    if (local.closing) {
      await this.release(local.identity.token);
      return null;
    }
    if (selected) return local.identity.token;
    throw errorForState();
  }

  private async acquirePublicationGuard(local: LocalGeneration, path: string): Promise<FileHandle | undefined> {
    if (await this.guardPresent(path)) {
      local.settleOwnerReady(errorForState());
      return undefined;
    }
    try {
      await this.inspect();
    } catch (error) {
      if (await this.guardPresent(path)) {
        local.settleOwnerReady(errorForState());
        return undefined;
      }
      throw error;
    }
    try {
      return await this.io.open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      if (await this.guardPresent(path)) {
        local.settleOwnerReady(errorForState());
        return undefined;
      }
      throw errorForState();
    }
  }

  private async guardPresent(path: string): Promise<boolean> {
    let info: Stats;
    try {
      info = await this.io.lstat(path);
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        await this.rootSafe();
        return false;
      }
      throw errorForState();
    }
    const uid = process.getuid?.();
    if (uid === undefined || !info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
      throw errorForState();
    }
    await this.rootSafe();
    return true;
  }

  private async rejectLegacyLayout(): Promise<void> {
    try {
      await this.io.lstat(this.leasePath());
    } catch (error) {
      if (isCode(error, 'ENOENT')) return;
      throw errorForState();
    }
    await this.directorySafe(this.leasePath());
    try {
      await this.io.lstat(join(this.leasePath(), 'owner.json'));
      throw errorForState();
    } catch (error) {
      if (error instanceof LeaseStateError) throw error;
      if (!isCode(error, 'ENOENT')) throw errorForState();
    }
  }

  private guardFileIdentity(info: Stats): Stats {
    const uid = process.getuid?.();
    if (uid === undefined || !info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
      throw errorForState();
    }
    return info;
  }

  private async checkGuardPath(path: string, original: Stats): Promise<void> {
    await this.rootSafe();
    let current: Stats;
    try {
      current = await this.io.lstat(path);
    } catch {
      current = await this.io.lstat(path);
    }
    await this.rootSafe();
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !current.isFile() ||
      current.uid !== uid ||
      (current.mode & 0o777) !== 0o600 ||
      current.dev !== original.dev ||
      current.ino !== original.ino
    ) {
      throw errorForState();
    }
  }

  private async removeGuard(path: string, original: Stats): Promise<void> {
    await this.checkGuardPath(path, original);
    // Recheck against the fd identity to catch a replacement after the first pathname stat.
    await this.checkGuardPath(path, original);
    await this.io.unlink(path);
  }

  private async publishMarker(identity: LeaseIdentity): Promise<void> {
    if (!identitySchema.safeParse(identity).success) throw errorForState();
    await this.generationDirectoriesSafe(identity.token);
    const owner = identitySchema.parse(await this.readJson(join(this.generationPath(identity.token), 'owner.json')));
    if (!sameIdentity(identity, owner)) throw errorForState();
    const path = join(this.generationPath(identity.token), 'released');
    try {
      await this.io.mkdir(path, { mode: 0o700 });
      await this.io.chmod(path, 0o700);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw errorForState();
      if (!(await this.marker(identity))) throw errorForState();
    }
    if (!(await this.marker(identity))) throw errorForState();
    const confirmedOwner = identitySchema.parse(
      await this.readJson(join(this.generationPath(identity.token), 'owner.json')),
    );
    if (!sameIdentity(identity, confirmedOwner)) throw errorForState();
  }

  private async revoke(local: LocalGeneration): Promise<void> {
    await local.ownerReady;
    if (local.identity.pid !== process.pid) throw errorForState();
    await this.generationDirectoriesSafe(local.identity.token);
    const owner = identitySchema.parse(
      await this.readJson(join(this.generationPath(local.identity.token), 'owner.json')),
    );
    if (!sameIdentity(local.identity, owner)) throw errorForState();
    await this.publishMarker(local.identity);
    if (!(await this.marker(local.identity))) throw errorForState();
  }

  private async renew(local: LocalGeneration, heartbeat: number): Promise<boolean> {
    if (!(await this.owned(local.identity.token, local.identity.session)) || local.closing) return false;
    try {
      await this.atomicJson(join(this.generationPath(local.identity.token), 'heartbeat.json'), {
        protocol: 2,
        token: local.identity.token,
        heartbeat,
      });
    } catch {
      return false;
    }
    if (local.closing) return false;
    return (await this.owned(local.identity.token, local.identity.session)) && !local.closing;
  }

  private async exclusiveJson(path: string, value: unknown): Promise<void> {
    await this.checkedPrivateParent(dirname(path));
    let handle: FileHandle | undefined;
    let created = false;
    let failure: unknown;
    try {
      handle = await this.io.open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      const uid = process.getuid?.();
      if (uid === undefined) throw errorForState();
      await handle.chmod(0o600);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) throw errorForState();
      await handle.writeFile(JSON.stringify(value));
      await handle.close();
      handle = undefined;
    } catch (error) {
      failure = error;
    }
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      if (created) {
        try {
          await this.io.rm(path, { force: true });
        } catch {
          // The orphaned generation remains inert and requires offline review.
        }
      }
      throw failure;
    }
    await this.checkedPrivateParent(dirname(path));
    const final = await this.io.lstat(path);
    const uid = process.getuid?.();
    if (uid === undefined || !final.isFile() || final.uid !== uid || (final.mode & 0o777) !== 0o600) {
      throw errorForState();
    }
  }

  private leasePath(): string {
    return join(this.directory, 'scheduler-lease');
  }

  private generationsPath(): string {
    return join(this.leasePath(), 'generations');
  }

  private generationPath(token: string): string {
    if (!uuid.safeParse(token).success) throw errorForState();
    return join(this.generationsPath(), token);
  }

  private async rootSafe(): Promise<void> {
    try {
      const uid = process.getuid?.();
      if (uid === undefined) throw errorForState();
      const info = await this.io.lstat(this.directory);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw errorForState();
    } catch {
      throw errorForState();
    }
  }

  private async directorySafe(path: string): Promise<void> {
    try {
      const uid = process.getuid?.();
      if (uid === undefined) throw errorForState();
      const info = await this.io.lstat(path);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) throw errorForState();
    } catch {
      throw errorForState();
    }
  }

  private async leaseDirectoriesSafe(): Promise<void> {
    await this.rootSafe();
    await this.directorySafe(this.leasePath());
    await this.directorySafe(this.generationsPath());
  }

  private async generationDirectoriesSafe(token: string): Promise<void> {
    const generation = this.generationPath(token);
    await this.leaseDirectoriesSafe();
    await this.directorySafe(generation);
  }

  private async readJson(path: string): Promise<unknown> {
    let handle: FileHandle | undefined;
    let value: unknown;
    let failed = false;
    try {
      const uid = process.getuid?.();
      if (uid === undefined) throw errorForState();
      const before = await this.io.lstat(path);
      if (!before.isFile() || before.uid !== uid || (before.mode & 0o777) !== 0o600) throw errorForState();
      handle = await this.io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== uid ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        throw errorForState();
      }
      value = JSON.parse(await handle.readFile('utf8')) as unknown;
    } catch {
      failed = true;
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          failed = true;
        }
      }
    }
    if (failed) throw errorForState();
    return value;
  }

  private async marker(identity: LeaseIdentity): Promise<boolean> {
    try {
      const generation = this.generationPath(identity.token);
      await this.generationDirectoriesSafe(identity.token);
      const path = join(generation, 'released');
      let info: Stats;
      try {
        info = await this.io.lstat(path);
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
        await this.generationDirectoriesSafe(identity.token);
        return false;
      }
      const uid = process.getuid?.();
      if (uid === undefined || !info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) {
        throw errorForState();
      }
      await this.generationDirectoriesSafe(identity.token);
      return true;
    } catch {
      throw errorForState();
    }
  }

  private async selector(): Promise<LeaseIdentity | null> {
    try {
      await this.rootSafe();
      const leasePath = this.leasePath();
      try {
        await this.io.lstat(leasePath);
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
        await this.rootSafe();
        return null;
      }
      await this.directorySafe(leasePath);

      const legacyPath = join(leasePath, 'owner.json');
      try {
        await this.io.lstat(legacyPath);
        throw errorForState();
      } catch (error) {
        if (error instanceof LeaseStateError) throw error;
        if (!isCode(error, 'ENOENT')) throw error;
      }

      const generations = this.generationsPath();
      await this.directorySafe(generations);
      const selectorPath = join(leasePath, 'active.json');
      try {
        await this.io.lstat(selectorPath);
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
        const entries = await this.io.readdir(generations);
        await this.leaseDirectoriesSafe();
        if (entries.length !== 0) throw errorForState();
        return null;
      }
      const identity = identitySchema.parse(await this.readJson(selectorPath));
      await this.leaseDirectoriesSafe();
      return identity;
    } catch {
      throw errorForState();
    }
  }

  private async checkedPrivateParent(path: string): Promise<void> {
    const leasePath = this.leasePath();
    const generations = this.generationsPath();
    if (path === leasePath) {
      await this.rootSafe();
      await this.directorySafe(leasePath);
      await this.directorySafe(generations);
      return;
    }
    const token = relative(generations, path);
    if (token === '' || token.includes('/') || !uuid.safeParse(token).success) throw errorForState();
    await this.generationDirectoriesSafe(token);
  }

  private async atomicJson(path: string, value: unknown, beforeRename?: () => boolean): Promise<void> {
    const parent = dirname(path);
    await this.checkedPrivateParent(parent);
    const temp = `${path}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    let created = false;
    let failure: unknown;
    try {
      handle = await this.io.open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      const uid = process.getuid?.();
      if (uid === undefined) throw errorForState();
      await handle.chmod(0o600);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) throw errorForState();
      await handle.writeFile(JSON.stringify(value));
      await handle.close();
      handle = undefined;
      if (beforeRename && !beforeRename()) throw new PublicationCancelled();
      await this.io.rename(temp, path);
    } catch (error) {
      failure = error;
    }
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (created) {
      try {
        await this.io.rm(temp, { force: true });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      await this.io.mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await this.directorySafe(path);
      return;
    }
    await this.io.chmod(path, 0o700);
    await this.directorySafe(path);
  }
}
