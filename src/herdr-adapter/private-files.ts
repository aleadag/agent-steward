import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LeaseOptions } from './lease.ts';

// Carry each opened guard's fixed identity to publishers across held awaits, without changing the action ABI.
const publicationGuards = new AsyncLocalStorage<(() => Promise<void>)[]>();
const ioFor = (options: LeaseOptions) => ({ lstat, open, rename, unlink, ...options.io });
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const unsafe = (): Error => new Error('unsafe private workflow metadata');
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

function privateFile(info: Stats): Stats {
  const uid = process.getuid?.();
  if (uid === undefined || !info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1)
    throw unsafe();
  return info;
}

async function privateDirectory(path: string, options: LeaseOptions): Promise<Stats> {
  const info = await ioFor(options).lstat(path);
  const uid = process.getuid?.();
  if (uid === undefined || !info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) throw unsafe();
  return info;
}

async function checkParent(path: string, original: Stats, options: LeaseOptions): Promise<void> {
  if (!same(await privateDirectory(path, options), original)) throw unsafe();
}

async function checkFile(path: string, original: Stats, options: LeaseOptions): Promise<void> {
  if (!same(privateFile(await ioFor(options).lstat(path)), original)) throw unsafe();
}

export async function withPrivateGuard<T>(
  directory: string,
  name: string,
  action: (assertGuard: () => Promise<void>) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T | null> {
  if (name === '' || name === '.' || name === '..' || basename(name) !== name) throw unsafe();
  const io = ioFor(options);
  const parent = await privateDirectory(directory, options);
  const path = join(directory, name);
  let handle: FileHandle;
  try {
    handle = await io.open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await checkParent(directory, parent, options);
    try {
      privateFile(await io.lstat(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
      // The competing holder may just have removed its guard. Only this
      // disappearance is contention; a missing/replaced parent is still unsafe.
      await checkParent(directory, parent, options);
    }
    return null;
  }
  let original: Stats | undefined;
  let result: T | undefined;
  let failure: unknown;
  try {
    await handle.chmod(0o600);
    original = privateFile(await handle.stat());
    const identity = original;
    const assertGuard = async () => {
      await checkParent(directory, parent, options);
      await checkFile(path, identity, options);
    };
    await assertGuard();
    result = await publicationGuards.run([...(publicationGuards.getStore() ?? []), assertGuard], () =>
      action(assertGuard),
    );
  } catch (error) {
    failure = error;
  }
  try {
    if (!original) throw unsafe();
    await checkParent(directory, parent, options);
    // A failed pathname read never becomes the new identity baseline.
    try {
      await checkFile(path, original, options);
    } catch {
      await checkFile(path, original, options);
    }
    await checkParent(directory, parent, options);
    await checkFile(path, original, options);
    await io.unlink(path);
  } catch (error) {
    failure ??= error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return result!;
}

export async function readPrivateJson(path: string, maxBytes: number, options: LeaseOptions = {}): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw unsafe();
  const io = ioFor(options);
  const parent = await privateDirectory(dirname(path), options);
  let before: Stats;
  try {
    before = privateFile(await io.lstat(path));
  } catch (error) {
    await checkParent(dirname(path), parent, options);
    throw error;
  }
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw unsafe();
  });
  try {
    const opened = privateFile(await handle.stat());
    if (!same(before, opened) || opened.size > maxBytes) throw unsafe();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw unsafe();
    await checkFile(path, opened, options);
    await checkParent(dirname(path), parent, options);
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } catch {
    // Only the initial lstat may report genuine absence, never a vanished opened file.
    throw unsafe();
  } finally {
    await handle.close().catch(() => {
      throw unsafe();
    });
  }
}

export async function writePrivateJson(path: string, data: unknown, options: LeaseOptions = {}): Promise<void> {
  await writePrivateContents(path, JSON.stringify(data), options);
}

export async function writePrivateContents(path: string, contents: string, options: LeaseOptions = {}): Promise<void> {
  const io = ioFor(options);
  const guards = publicationGuards.getStore() ?? [];
  const directory = dirname(path);
  const parent = await privateDirectory(directory, options);
  const checkDestination = async () => {
    try {
      privateFile(await io.lstat(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await checkParent(directory, parent, options);
  };
  await checkDestination();
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let original: Stats | undefined;
  let published = false;
  let failure: unknown;
  try {
    handle = await io.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    original = privateFile(await handle.stat());
    await handle.writeFile(contents);
    await handle.sync();
    await checkDestination();
    await checkFile(temp, original, options);
    for (const assertGuard of guards) await assertGuard();
    await io.rename(temp, path);
    published = true;
    await checkFile(path, original, options);
    await checkParent(directory, parent, options);
    const parentHandle = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!same(await parentHandle.stat(), parent)) throw unsafe();
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    failure = error;
  }
  // Keep submitted writes and their fd observed until they settle; callers may time out independently.
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (original && !published) {
    try {
      await checkParent(directory, parent, options);
      await checkFile(temp, original, options);
      await io.unlink(temp);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
