import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeaseHeartbeat, LeaseIdentity } from '../src/herdr-adapter/lease.ts';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('test watchdog expired')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function leaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'steward-generation-'));
  const root = join(directory, 'scheduler-lease');
  const generations = join(root, 'generations');
  await mkdir(generations, { recursive: true, mode: 0o700 });
  const identity: LeaseIdentity = {
    protocol: 2,
    token: randomUUID(),
    pid: process.pid,
    session: 'server-1',
  };
  const generation = join(generations, identity.token);
  await mkdir(generation, { mode: 0o700 });
  const heartbeat: LeaseHeartbeat = { protocol: 2, token: identity.token, heartbeat: 10_000 };
  for (const [path, value] of [
    [join(root, 'active.json'), identity],
    [join(generation, 'owner.json'), identity],
    [join(generation, 'heartbeat.json'), heartbeat],
  ] as const) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  }
  return { directory, root, generation, identity, heartbeat };
}
