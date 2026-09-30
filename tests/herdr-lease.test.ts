import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaseStateError, SchedulerLeaseStore, type LeaseIO, type LeaseOptions } from '../src/herdr-adapter/lease.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { deferred, leaseFixture, within } from './herdr-lease-helpers.ts';

const temporaryDirectories: string[] = [];
const trackedFixture = async () => {
  const fixture = await leaseFixture();
  temporaryDirectories.push(fixture.directory);
  return fixture;
};
const trackedTempdir = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function publishReplacement(f: Awaited<ReturnType<typeof leaseFixture>>): Promise<void> {
  const identity = { ...f.identity, token: randomUUID() };
  const generation = join(f.root, 'generations', identity.token);
  await mkdir(generation, { mode: 0o700 });
  await writeFile(join(generation, 'owner.json'), JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  await writeFile(
    join(generation, 'heartbeat.json'),
    JSON.stringify({ protocol: 2, token: identity.token, heartbeat: 10_000 }),
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(join(f.root, 'active.json'), JSON.stringify(identity), { mode: 0o600 });
}

async function snapshot(path: string): Promise<unknown> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    throw error;
  }
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    target: info.isSymbolicLink() ? await readlink(path) : null,
    contents: await readFile(path).catch(() => null),
    entries: await readdir(path).catch(() => null),
  };
}

async function replaceGuardPath(path: string, kind: 'file' | 'directory'): Promise<Stats> {
  const replacement = `${path}.replacement`;
  if (kind === 'file') {
    await writeFile(replacement, 'private replacement', { mode: 0o600, flag: 'wx' });
    await chmod(replacement, 0o600);
  } else {
    await mkdir(replacement, { mode: 0o700 });
    await chmod(replacement, 0o700);
  }
  const identity = await lstat(replacement);
  if (kind === 'file') await unlink(path);
  else await rmdir(path);
  await rename(replacement, path);
  return identity;
}

type GuardTestIO = Partial<LeaseIO> & { unlink: (path: string) => Promise<void> };
type GuardHandleFailure = 'chmod' | 'stat';

function faultingGuardHandle(
  handle: FileHandle,
  options: {
    failure?: GuardHandleFailure;
    onChmod?: (mode: number) => void;
    onStat?: () => void;
    onClose?: () => void;
  },
): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'chmod') {
        return async (mode: number) => {
          options.onChmod?.(mode);
          if (options.failure === 'chmod') {
            throw Object.assign(new Error('injected fd chmod failure'), { code: 'EIO' });
          }
          return target.chmod(mode);
        };
      }
      if (property === 'stat') {
        return async () => {
          options.onStat?.();
          if (options.failure === 'stat') {
            throw Object.assign(new Error('injected fd stat failure'), { code: 'EIO' });
          }
          return target.stat();
        };
      }
      if (property === 'close') {
        return async () => {
          options.onClose?.();
          return target.close();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FileHandle;
}

const validOwner = (f: Awaited<ReturnType<typeof leaseFixture>>) => f.identity;
const unsafeCases: {
  name: string;
  mutate: (f: Awaited<ReturnType<typeof leaseFixture>>) => Promise<LeaseOptions | void>;
}[] = [
  {
    name: 'selector protocol 1',
    mutate: async (f) => writeFile(join(f.root, 'active.json'), JSON.stringify({ ...f.identity, protocol: 1 })),
  },
  {
    name: 'selector PID zero',
    mutate: async (f) => writeFile(join(f.root, 'active.json'), JSON.stringify({ ...f.identity, pid: 0 })),
  },
  {
    name: 'selector noninteger PID',
    mutate: async (f) => writeFile(join(f.root, 'active.json'), JSON.stringify({ ...f.identity, pid: 1.5 })),
  },
  {
    name: 'selector empty session',
    mutate: async (f) => writeFile(join(f.root, 'active.json'), JSON.stringify({ ...f.identity, session: '' })),
  },
  {
    name: 'selector traversal token',
    mutate: async (f) =>
      writeFile(join(f.root, 'active.json'), JSON.stringify({ ...f.identity, token: '../../outside' })),
  },
  {
    name: 'owner token mismatch',
    mutate: async (f) =>
      writeFile(join(f.generation, 'owner.json'), JSON.stringify({ ...f.identity, token: randomUUID() })),
  },
  {
    name: 'owner session mismatch',
    mutate: async (f) =>
      writeFile(join(f.generation, 'owner.json'), JSON.stringify({ ...f.identity, session: 'other' })),
  },
  {
    name: 'owner PID mismatch',
    mutate: async (f) =>
      writeFile(join(f.generation, 'owner.json'), JSON.stringify({ ...f.identity, pid: f.identity.pid + 1 })),
  },
  {
    name: 'missing owner',
    mutate: async (f) => rm(join(f.generation, 'owner.json')),
  },
  {
    name: 'missing heartbeat',
    mutate: async (f) => rm(join(f.generation, 'heartbeat.json')),
  },
  {
    name: 'heartbeat token mismatch',
    mutate: async (f) =>
      writeFile(join(f.generation, 'heartbeat.json'), JSON.stringify({ ...f.heartbeat, token: randomUUID() })),
  },
  {
    name: 'null heartbeat renewal',
    mutate: async (f) =>
      writeFile(join(f.generation, 'heartbeat.json'), JSON.stringify({ ...f.heartbeat, heartbeat: null })),
  },
  {
    name: 'string heartbeat renewal',
    mutate: async (f) =>
      writeFile(join(f.generation, 'heartbeat.json'), JSON.stringify({ ...f.heartbeat, heartbeat: '10000' })),
  },
  {
    name: 'non-finite heartbeat renewal',
    mutate: async (f) =>
      writeFile(join(f.generation, 'heartbeat.json'), `{"protocol":2,"token":"${f.identity.token}","heartbeat":1e999}`),
  },
  {
    name: 'regular file at released marker',
    mutate: async (f) => writeFile(join(f.generation, 'released'), 'not a directory'),
  },
  {
    name: 'released marker symlink',
    mutate: async (f) => {
      const target = join(f.directory, 'marker-target');
      await writeFile(target, 'keep marker target');
      await symlink(target, join(f.generation, 'released'));
    },
  },
  ...(['active.json', 'owner.json', 'heartbeat.json'] as const).map((record) => ({
    name: `${record} symlink`,
    mutate: async (f: Awaited<ReturnType<typeof leaseFixture>>) => {
      const path = record === 'active.json' ? join(f.root, record) : join(f.generation, record);
      const target = join(f.directory, `target-${record}`);
      await writeFile(target, JSON.stringify(record === 'heartbeat.json' ? f.heartbeat : validOwner(f)), {
        mode: 0o600,
      });
      await rm(path);
      await symlink(target, path);
    },
  })),
  {
    name: 'generation directory symlink',
    mutate: async (f) => {
      const target = join(f.directory, 'generation-target');
      await rename(f.generation, target);
      await symlink(target, f.generation);
    },
  },
  {
    name: 'lease directory symlink',
    mutate: async (f) => {
      const target = join(f.directory, 'lease-target');
      await rename(f.root, target);
      await symlink(target, f.root);
    },
  },
  {
    name: 'generations directory symlink',
    mutate: async (f) => {
      const target = join(f.directory, 'generations-target');
      await rename(join(f.root, 'generations'), target);
      await symlink(target, join(f.root, 'generations'));
    },
  },
  {
    name: 'group/world-writable lease parent',
    mutate: async (f) => chmod(f.root, 0o777),
  },
  {
    name: 'group/world-writable state root',
    mutate: async (f) => chmod(f.directory, 0o777),
  },
  {
    name: '0644 record',
    mutate: async (f) => chmod(join(f.generation, 'owner.json'), 0o644),
  },
  {
    name: 'unreadable EACCES record',
    mutate: async (f) => {
      const heartbeatPath = join(f.generation, 'heartbeat.json');
      return {
        io: {
          open: async (path, flags, mode) => {
            if (path === heartbeatPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            return open(path, flags, mode);
          },
        },
      };
    },
  },
  {
    name: 'wrong UID from lstat',
    mutate: async (f) => {
      const ownerPath = join(f.generation, 'owner.json');
      return {
        io: {
          lstat: async (path) => {
            const info = await lstat(path);
            if (path !== ownerPath) return info;
            const wrongUid = Object.create(info) as Stats;
            Object.defineProperty(wrongUid, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
            return wrongUid;
          },
        },
      };
    },
  },
  {
    name: 'wrong state-root UID from lstat',
    mutate: async (f) => {
      return {
        io: {
          lstat: async (path) => {
            const info = await lstat(path);
            if (path !== f.directory) return info;
            const wrongUid = Object.create(info) as Stats;
            Object.defineProperty(wrongUid, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
            return wrongUid;
          },
        },
      };
    },
  },
];

test('fresh authorization after release always denies G', async () => {
  const f = await trackedFixture();
  const lease = new SchedulerLeaseStore(
    f.directory,
    async () => {},
    () => 10_000,
  );
  assert.equal(await lease.activeToken('server-1'), f.identity.token);
  assert.equal(await lease.leaseMatches(f.identity.token, 'other-server'), false);
  await mkdir(join(f.generation, 'released'), { mode: 0o700 });
  for (let i = 0; i < 3; i++) {
    await writeFile(join(f.generation, 'heartbeat.json'), JSON.stringify({ ...f.heartbeat, heartbeat: 10_001 + i }));
    assert.equal(await lease.active(), false);
    assert.equal(await lease.activeToken('server-1'), null);
    assert.equal(await lease.leaseMatches(f.identity.token, 'server-1'), false);
  }
});

test('atomic lease records are 0600 under a restrictive umask', async () => {
  const f = await trackedFixture();
  const lease = new SchedulerLeaseStore(
    f.directory,
    async () => {},
    () => 10_000,
  );
  const atomicJson = (lease as unknown as { atomicJson(path: string, value: unknown): Promise<void> }).atomicJson.bind(
    lease,
  );
  const originalUmask = process.umask(0o777);
  try {
    await atomicJson(join(f.generation, 'heartbeat.json'), f.heartbeat);
    assert.equal((await stat(join(f.generation, 'heartbeat.json'))).mode & 0o777, 0o600);
    assert.equal(await lease.active('server-1'), true);
  } finally {
    process.umask(originalUmask);
  }
});

test('absent selector is not corrupt selector', async () => {
  const directory = await trackedTempdir('steward-empty-');
  const lease = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  assert.deepEqual(await lease.inspect(), { kind: 'absent' });
  await mkdir(join(directory, 'scheduler-lease'), { mode: 0o700 });
  await mkdir(join(directory, 'scheduler-lease', 'generations'), { mode: 0o700 });
  const path = join(directory, 'scheduler-lease', 'active.json');
  await writeFile(path, '{broken', { mode: 0o600 });
  await assert.rejects(lease.inspect(), LeaseStateError);
  assert.equal(await lease.active(), false);
});

test('unsafe lease objects deny authority and publication', async () => {
  for (const scenario of unsafeCases) {
    const f = await trackedFixture();
    const options = (await scenario.mutate(f)) ?? {};
    const paths = [
      f.directory,
      f.root,
      join(f.root, 'generations'),
      f.generation,
      join(f.root, 'active.json'),
      join(f.generation, 'owner.json'),
      join(f.generation, 'heartbeat.json'),
      join(f.generation, 'released'),
      join(f.directory, 'outside'),
    ];
    const before = await Promise.all(paths.map(snapshot));
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
      options,
    );
    assert.equal(await lease.activeToken('server-1'), null, scenario.name);
    await assert.rejects(lease.inspect(), LeaseStateError, scenario.name);
    await assert.rejects(lease.acquire('server-1'), LeaseStateError, `${scenario.name} acquisition`);
    assert.deepEqual(await Promise.all(paths.map(snapshot)), before, `${scenario.name} was rewritten`);
  }
});

test('reader brackets reject mixed generation and revoked snapshots', async () => {
  {
    const f = await trackedFixture();
    const entered = deferred<void>();
    const resume = deferred<void>();
    let activeOpens = 0;
    const io: Partial<LeaseIO> = {
      open: async (path, flags, mode) => {
        if (path === join(f.root, 'active.json') && ++activeOpens === 2) {
          entered.resolve();
          await resume.promise;
        }
        return open(path, flags, mode);
      },
    };
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const result = lease.active();
    await within(entered.promise);
    await publishReplacement(f);
    resume.resolve();
    assert.equal(await within(result), false, 'second selector read must reject replacement generation');
  }
  {
    const f = await trackedFixture();
    const entered = deferred<void>();
    const resume = deferred<void>();
    let markerChecks = 0;
    const markerPath = join(f.generation, 'released');
    const io: Partial<LeaseIO> = {
      lstat: async (path) => {
        if (path === markerPath && ++markerChecks === 2) {
          entered.resolve();
          await resume.promise;
        }
        return lstat(path);
      },
    };
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const result = lease.active();
    await within(entered.promise);
    await mkdir(markerPath, { mode: 0o700 });
    resume.resolve();
    assert.equal(await within(result), false, 'second marker check must observe revocation');
  }
  {
    const f = await trackedFixture();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const ownerPath = join(f.generation, 'owner.json');
    const io: Partial<LeaseIO> = {
      open: async (path, flags, mode) => {
        if (path === ownerPath) {
          entered.resolve();
          await resume.promise;
        }
        return open(path, flags, mode);
      },
    };
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const result = lease.active();
    await within(entered.promise);
    await publishReplacement(f);
    resume.resolve();
    assert.equal(await within(result), false, 'owner read must remain bound to its first selector');
  }
  {
    const f = await trackedFixture();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const heartbeatPath = join(f.generation, 'heartbeat.json');
    const io: Partial<LeaseIO> = {
      open: async (path, flags, mode) => {
        if (path === heartbeatPath) {
          entered.resolve();
          await resume.promise;
        }
        return open(path, flags, mode);
      },
    };
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const result = lease.active();
    await within(entered.promise);
    await mkdir(join(f.generation, 'released'), { mode: 0o700 });
    resume.resolve();
    assert.equal(await within(result), false, 'heartbeat read must not cross revocation');
  }
});

test('authorization requires a fresh heartbeat and positively live PID', async () => {
  const f = await trackedFixture();
  const lease = (now: number, alive: LeaseOptions['alive']) =>
    new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => now,
      { alive },
    );
  assert.equal(await lease(24_999, () => true).active('server-1'), true);
  assert.equal(await lease(25_000, () => true).active('server-1'), false);
  assert.equal(await lease(10_000, () => false).active('server-1'), false);
  assert.equal(await lease(10_000, () => null).active('server-1'), false);
  assert.equal(await lease(Number.NaN, () => true).active('server-1'), false);
  assert.equal(await lease(Number.POSITIVE_INFINITY, () => true).active('server-1'), false);
  assert.equal(await lease(10_000, () => true).active('other-server'), false);
  assert.equal(await lease(10_000, () => true).activeToken('other-server'), null);
});

test('preparation failures do not expose filesystem details', async () => {
  const directory = await trackedTempdir('steward-prepare-failure-');
  const store = new SchedulerLeaseStore(
    directory,
    async () => {
      throw new Error('/private/state/path is unavailable');
    },
    () => 10_000,
  );
  await assert.rejects(store.acquire('server-1'), LeaseStateError);
  assert.deepEqual(await readdir(directory), []);
});

test('invalid session is rejected before lease layout creation', async () => {
  const directory = await trackedTempdir('steward-invalid-session-');
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  await assert.rejects(store.acquire(''), LeaseStateError);
  assert.deepEqual(await readdir(directory), []);
});

test('legacy state and incomplete generation layouts require offline review', async () => {
  {
    const f = await trackedFixture();
    const legacyPath = join(f.root, 'owner.json');
    await writeFile(legacyPath, '{old lease format', { mode: 0o600 });
    const legacyBefore = await readFile(legacyPath, 'utf8');
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
    );
    assert.equal(await lease.activeToken('server-1'), null);
    await assert.rejects(lease.inspect(), LeaseStateError);
    await assert.rejects(lease.acquire('server-1'), LeaseStateError);
    assert.equal(await readFile(legacyPath, 'utf8'), legacyBefore);
  }
  {
    const f = await trackedFixture();
    await rm(join(f.root, 'active.json'));
    const lease = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 10_000,
    );
    assert.equal(await lease.activeToken('server-1'), null);
    await assert.rejects(lease.inspect(), LeaseStateError);
    await assert.rejects(lease.acquire('server-1'), LeaseStateError);
  }
});

test('private lease directories retain exact modes under restrictive umask', async () => {
  const directory = await trackedTempdir('steward-lease-umask-');
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  const originalUmask = process.umask(0o177);
  try {
    const token = await store.acquire('server-1');
    assert.ok(token);
    const lease = join(directory, 'scheduler-lease');
    const generation = join(lease, 'generations', token);
    assert.equal((await stat(lease)).mode & 0o777, 0o700);
    assert.equal((await stat(join(lease, 'generations'))).mode & 0o777, 0o700);
    assert.equal((await stat(generation)).mode & 0o777, 0o700);
    await store.release(token);
    assert.equal((await stat(join(generation, 'released'))).mode & 0o777, 0o700);
  } finally {
    process.umask(originalUmask);
    await chmod(join(directory, 'scheduler-lease'), 0o700).catch(() => {});
    await chmod(join(directory, 'scheduler-lease', 'generations'), 0o700).catch(() => {});
  }
});

test('a separate lease store can read G but cannot claim local ownership', async () => {
  const directory = await trackedTempdir('steward-local-handle-');
  const first = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  const token = await first.acquire('server-1');
  assert.ok(token);
  const second = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  assert.equal(await second.leaseMatches(token, 'server-1'), true);
  assert.equal(await second.owned(token, 'server-1'), false);
  await first.release(token);
});

test('ENOSPC denies acquisition renewal and release', async () => {
  {
    const directory = await trackedTempdir('steward-enospc-select-');
    const io: Partial<LeaseIO> = {
      open: async (path, flags, mode) => {
        if (path.includes('/active.json.') && path.endsWith('.tmp')) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return open(path, flags, mode);
      },
    };
    const store = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
      { io },
    );
    await assert.rejects(store.acquire('server-1'), LeaseStateError);
    assert.equal(await store.activeToken('server-1'), null);
  }
  for (const point of ['open', 'rename'] as const) {
    const directory = await trackedTempdir(`steward-enospc-heartbeat-${point}-`);
    let fail = false;
    let heartbeatTemp: string | undefined;
    let cleaned: string | undefined;
    const io: Partial<LeaseIO> = {
      open: async (path, flags, mode) => {
        if (fail && path.includes('/heartbeat.json.') && path.endsWith('.tmp')) {
          if (point === 'open') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          heartbeatTemp = path;
        }
        return open(path, flags, mode);
      },
      rename: async (from, to) => {
        if (fail && point === 'rename' && String(to).endsWith('/heartbeat.json')) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return rename(from, to);
      },
      rm: async (path, options) => {
        if (heartbeatTemp && path === heartbeatTemp) cleaned = path;
        return rm(path, options);
      },
    };
    const store = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const token = await store.acquire('server-1');
    assert.ok(token);
    fail = true;
    assert.equal(await store.heartbeat(token, 'server-1'), false, point);
    if (point === 'rename') assert.equal(cleaned, heartbeatTemp);
    await store.release(token);
  }
  {
    const directory = await trackedTempdir('steward-enospc-release-');
    let fail = false;
    const io: Partial<LeaseIO> = {
      mkdir: async (path, options) => {
        if (fail && String(path).endsWith('/released')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return mkdir(path, options);
      },
    };
    const first = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const token = await first.acquire('server-1');
    assert.ok(token);
    fail = true;
    await assert.rejects(first.release(token), LeaseStateError);
    assert.equal(await first.owned(token, 'server-1'), false);
    const second = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
    );
    assert.equal(await second.active('server-1'), true, 'failed release marker is not falsely confirmed');
  }
});

test('heartbeat and release never recreate a missing generation', async () => {
  const directory = await trackedTempdir('steward-missing-generation-');
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  const token = await store.acquire('server-1');
  assert.ok(token);
  const generation = join(directory, 'scheduler-lease', 'generations', token);
  await rm(generation, { recursive: true });
  assert.equal(await store.heartbeat(token, 'server-1'), false);
  await assert.rejects(store.release(token), LeaseStateError);
  await assert.rejects(lstat(generation), { code: 'ENOENT' });
});

test('safe readers preserve an owned 0755 state root', async () => {
  const f = await trackedFixture();
  await chmod(f.directory, 0o755);
  const lease = new SchedulerLeaseStore(
    f.directory,
    async () => {},
    () => 10_000,
  );
  assert.equal(await lease.activeToken('server-1'), f.identity.token);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o755);
});

test('scheduler acquisition publishes an isolated generation layout', async () => {
  const directory = await trackedTempdir('steward-generation-layout-');
  const episodes = new EpisodeStore(directory, () => 10_000);
  const token = await episodes.acquire('server-1');
  assert.ok(token);
  try {
    const root = join(directory, 'scheduler-lease');
    const generation = join(root, 'generations', token);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'active.json'), 'utf8')), {
      protocol: 2,
      token,
      pid: process.pid,
      session: 'server-1',
    });
    assert.equal((await lstat(join(generation, 'owner.json'))).isFile(), true);
    assert.equal((await lstat(join(generation, 'heartbeat.json'))).isFile(), true);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'generations'))).mode & 0o777, 0o700);
    assert.equal((await stat(generation)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'active.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(generation, 'owner.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(generation, 'heartbeat.json'))).mode & 0o777, 0o600);
    await assert.rejects(lstat(join(root, 'owner.json')), { code: 'ENOENT' });
  } finally {
    await episodes.release(token);
  }
});

test('late heartbeat rename cannot resurrect G or modify H', async () => {
  const directory = await trackedTempdir('steward-late-rename-');
  const entered = deferred<void>();
  const resume = deferred<void>();
  let held = false;
  const io: Partial<LeaseIO> = {
    rename: async (from, to) => {
      if (held && String(to).endsWith('/heartbeat.json')) {
        held = false;
        entered.resolve();
        await resume.promise;
      }
      await rename(from, to);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const g = await store.acquire('server-1');
  assert.ok(g);
  held = true;
  const renewal = store.heartbeat(g, 'server-1');
  try {
    await within(entered.promise);
    await within(store.release(g));
    const h = await store.acquire('server-1');
    assert.ok(h);
    assert.notEqual(h, g);
    const selected = join(directory, 'scheduler-lease', 'active.json');
    const ownerH = join(directory, 'scheduler-lease', 'generations', h, 'owner.json');
    const heartbeatH = join(directory, 'scheduler-lease', 'generations', h, 'heartbeat.json');
    const before = await Promise.all([selected, ownerH, heartbeatH].map((path) => readFile(path, 'utf8')));
    resume.resolve();
    assert.equal(await within(renewal), false);
    assert.deepEqual(await Promise.all([selected, ownerH, heartbeatH].map((path) => readFile(path, 'utf8'))), before);
    assert.equal(await store.leaseMatches(g, 'server-1'), false);
    assert.equal(await store.owned(h, 'server-1'), true);
    const released = join(directory, 'scheduler-lease', 'generations', g, 'released');
    assert.equal((await lstat(released)).isDirectory(), true);
    assert.equal((await stat(released)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(directory, 'scheduler-lease', 'generations', g))).isDirectory(), true);
    await store.release(h);
  } finally {
    resume.resolve();
    await renewal.catch(() => false);
  }
});

test('attempt token cannot renew before readiness is confirmed', async () => {
  const directory = await trackedTempdir('steward-unready-handle-');
  const entered = deferred<void>();
  const resume = deferred<void>();
  const selector = join(directory, 'scheduler-lease', 'active.json');
  let hold = true;
  const io: Partial<LeaseIO> = {
    open: async (path, flags, mode) => {
      if (hold && path === selector) {
        hold = false;
        entered.resolve();
        await resume.promise;
      }
      return open(path, flags, mode);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const attempt = store.beginAcquire('server-1');
  try {
    await within(entered.promise);
    assert.equal(await store.heartbeat(attempt.token, 'server-1'), false);
  } finally {
    resume.resolve();
    const token = await attempt.ready.catch(() => null);
    if (token) await store.release(token).catch(() => {});
  }
});

test('early abort completes owner setup and confirms G without publishing selector', async () => {
  const directory = await trackedTempdir('steward-early-abort-');
  const entered = deferred<void>();
  const resume = deferred<void>();
  const store = new SchedulerLeaseStore(
    directory,
    async () => {
      entered.resolve();
      await resume.promise;
    },
    () => 10_000,
  );
  const attempt = store.beginAcquire('server-1');
  await within(entered.promise);
  const release = attempt.release();
  assert.equal(attempt.isOpen(), false);
  resume.resolve();
  await within(release);
  assert.equal(await within(attempt.ready), null);
  const generation = join(directory, 'scheduler-lease', 'generations', attempt.token);
  assert.equal((await lstat(join(generation, 'owner.json'))).isFile(), true);
  assert.equal((await lstat(join(generation, 'released'))).isDirectory(), true);
  await assert.rejects(lstat(join(directory, 'scheduler-lease', 'active.json')), { code: 'ENOENT' });
});

test('publication guard survives pending first and takeover renames', async () => {
  for (const mode of ['first', 'takeover'] as const) {
    const directory = await trackedTempdir(`steward-publish-${mode}-`);
    let old: Awaited<ReturnType<typeof leaseFixture>> | undefined;
    let clock = 10_000;
    let entered = deferred<void>();
    let resume = deferred<void>();
    let held = true;
    let actualDirectory = directory;
    if (mode === 'takeover') {
      old = await leaseFixture();
      temporaryDirectories.push(old.directory);
      actualDirectory = old.directory;
      const expiredOwner = { ...old.identity, pid: 4242 };
      await writeFile(join(old.root, 'active.json'), JSON.stringify(expiredOwner), { mode: 0o600 });
      await writeFile(join(old.generation, 'owner.json'), JSON.stringify(expiredOwner), { mode: 0o600 });
      await writeFile(join(old.generation, 'heartbeat.json'), JSON.stringify({ ...old.heartbeat, heartbeat: 1 }), {
        mode: 0o600,
      });
      clock = 20_000;
    }
    const guardPath = join(actualDirectory, 'takeover-guard');
    let guardHandle: FileHandle | undefined;
    const io: Partial<LeaseIO> = {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path === guardPath) guardHandle = handle;
        return handle;
      },
      rename: async (from, to) => {
        if (held && String(to).endsWith('/active.json')) {
          held = false;
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
      },
    };
    const store = new SchedulerLeaseStore(
      actualDirectory,
      async () => {},
      () => clock,
      {
        io,
        alive: (pid) => (pid === 4242 ? false : true),
      },
    );
    const attempt = store.beginAcquire('server-1');
    try {
      await within(entered.promise);
      const heldHandle = guardHandle;
      assert.ok(heldHandle, 'exclusive file guard remains open during selector rename');
      const heldGuard = await heldHandle.stat();
      assert.equal(heldGuard.isFile(), true);
      assert.equal(heldGuard.mode & 0o777, 0o600);
      const generation = join(actualDirectory, 'scheduler-lease', 'generations', attempt.token);
      assert.equal((await lstat(join(generation, 'owner.json'))).isFile(), true);
      assert.equal((await lstat(join(generation, 'heartbeat.json'))).isFile(), true);
      const release = attempt.release();
      assert.equal(attempt.isOpen(), false);
      await within(release);
      assert.equal((await lstat(guardPath)).isFile(), true);
      assert.equal((await lstat(guardPath)).mode & 0o777, 0o600);
      assert.equal(await store.acquire('server-1'), null);
      if (old) {
        assert.equal(
          (await lstat(join(old.generation, 'released'))).isDirectory(),
          true,
          'dead G is marked before H selector rename starts',
        );
      }
      resume.resolve();
      assert.equal(await within(attempt.ready), null);
      assert.equal(await store.active('server-1'), false);
      await assert.rejects(lstat(guardPath), { code: 'ENOENT' });
      await assert.rejects(heldHandle.stat(), { code: 'EBADF' });
    } finally {
      resume.resolve();
      await attempt.ready.catch(() => null);
    }
  }
});

test('takeover requires release or expired heartbeat and proven death', async () => {
  const cases = [
    { name: 'expired/live', now: 20_000, pid: 4242, heartbeat: 1, released: false, alive: true, take: false },
    { name: 'fresh/dead', now: 10_000, pid: 4242, heartbeat: 9_999, released: false, alive: false, take: false },
    { name: 'expired/unknown', now: 20_000, pid: 4242, heartbeat: 1, released: false, alive: null, take: false },
    { name: 'expired/dead', now: 20_000, pid: 4242, heartbeat: 1, released: false, alive: false, take: true },
    { name: 'released/live', now: 10_000, pid: 4242, heartbeat: 9_999, released: true, alive: true, take: true },
  ] as const;
  for (const row of cases) {
    const f = await trackedFixture();
    const owner = { ...f.identity, pid: row.pid };
    await writeFile(join(f.root, 'active.json'), JSON.stringify(owner), { mode: 0o600 });
    await writeFile(join(f.generation, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    await writeFile(
      join(f.generation, 'heartbeat.json'),
      JSON.stringify({ ...f.heartbeat, heartbeat: row.heartbeat }),
      { mode: 0o600 },
    );
    if (row.released) await mkdir(join(f.generation, 'released'), { mode: 0o700 });
    const store = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => row.now,
      {
        alive: (pid) => (pid === 4242 ? row.alive : true),
      },
    );
    const next = await store.acquire('server-1');
    assert.equal(next === null, !row.take, row.name);
    if (row.take) {
      assert.ok(next, row.name);
      assert.notEqual(next, f.identity.token, row.name);
      if (!row.released) assert.equal((await lstat(join(f.generation, 'released'))).isDirectory(), true, row.name);
      await store.release(next);
    }
  }
});

test('renewals are single-flight and close defeats a pending rename', async () => {
  const directory = await trackedTempdir('steward-single-flight-');
  let clock = 10_000;
  let entered = deferred<void>();
  let resume = deferred<void>();
  let held = false;
  let writes = 0;
  const io: Partial<LeaseIO> = {
    rename: async (from, to) => {
      if (String(to).endsWith('/heartbeat.json')) {
        writes++;
        if (held) {
          held = false;
          entered.resolve();
          await resume.promise;
        }
      }
      await rename(from, to);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => clock,
    { io },
  );
  const token = await store.acquire('server-1');
  assert.ok(token);
  writes = 0;
  held = true;
  const first = store.heartbeat(token, 'server-1');
  try {
    await within(entered.promise);
    const joined = Array.from({ length: 20 }, (_, index) => {
      clock = 10_001 + index;
      return store.heartbeat(token, 'server-1');
    });
    assert.equal(await store.heartbeat(token, 'wrong-session'), false);
    assert.equal(writes, 1);
    resume.resolve();
    assert.deepEqual(await Promise.all([first, ...joined]), Array(21).fill(true));
    assert.equal(
      JSON.parse(await readFile(join(directory, 'scheduler-lease', 'generations', token, 'heartbeat.json'), 'utf8'))
        .heartbeat,
      10_000,
    );
    clock = 10_100;
    assert.equal(await store.heartbeat(token, 'server-1'), true);
    assert.equal(
      JSON.parse(await readFile(join(directory, 'scheduler-lease', 'generations', token, 'heartbeat.json'), 'utf8'))
        .heartbeat,
      10_100,
    );
    entered = deferred<void>();
    resume = deferred<void>();
    held = true;
    const pending = store.heartbeat(token, 'server-1');
    await within(entered.promise);
    const joinedDuringClose = Array.from({ length: 5 }, () => store.heartbeat(token, 'server-1'));
    const closed = store.release(token);
    resume.resolve();
    assert.equal(await pending, false);
    assert.deepEqual(await Promise.all(joinedDuringClose), Array(5).fill(false));
    await within(closed);
    assert.equal(await store.heartbeat(token, 'server-1'), false);
  } finally {
    resume.resolve();
    await store.release(token).catch(() => {});
  }
});

test('failed guard path read never unlinks a replacement inode', async () => {
  const directory = await trackedTempdir('steward-guard-replace-failed-');
  const guard = join(directory, 'takeover-guard');
  const entered = deferred<void>();
  const resume = deferred<void>();
  let guardKind: 'file' | 'directory' | undefined;
  let guardHandle: FileHandle | undefined;
  let failFirstGuardRead = true;
  let guardUnlinks = 0;
  const io: GuardTestIO = {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      if (path === guard) guardKind = 'directory';
    },
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === guard) {
        guardKind = 'file';
        guardHandle = handle;
      }
      return handle;
    },
    lstat: async (path) => {
      if (path === guard && guardKind !== undefined && failFirstGuardRead) {
        failFirstGuardRead = false;
        entered.resolve();
        await resume.promise;
        throw Object.assign(new Error('injected first guard path-stat failure'), { code: 'EIO' });
      }
      return lstat(path);
    },
    unlink: async (path) => {
      if (path === guard) guardUnlinks++;
      return unlink(path);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const attempt = store.beginAcquire('server-1');
  try {
    await within(entered.promise);
    const kind = guardKind;
    assert.ok(kind);
    const original = guardHandle ? await guardHandle.stat() : await lstat(guard);
    const replacement = await replaceGuardPath(guard, kind);
    assert.notEqual(replacement.ino, original.ino);
    if (guardHandle) {
      const stillHeld = await guardHandle.stat();
      assert.equal(stillHeld.dev, original.dev);
      assert.equal(stillHeld.ino, original.ino);
    }
    resume.resolve();
    await assert.rejects(attempt.ready, LeaseStateError);
    const retained = await lstat(guard);
    assert.equal(retained.dev, replacement.dev);
    assert.equal(retained.ino, replacement.ino);
    assert.equal(retained.isFile(), kind === 'file');
    assert.equal(retained.uid, process.getuid?.());
    assert.equal(retained.mode & 0o777, kind === 'file' ? 0o600 : 0o700);
    assert.equal(guardUnlinks, 0);
    if (guardHandle) await assert.rejects(guardHandle.stat(), { code: 'EBADF' });
  } finally {
    resume.resolve();
    await attempt.ready.catch(() => null);
  }
});

test('guard cleanup detects replacement after a successful path read', async () => {
  const directory = await trackedTempdir('steward-guard-replace-after-read-');
  const guard = join(directory, 'takeover-guard');
  const selector = join(directory, 'scheduler-lease', 'active.json');
  const entered = deferred<void>();
  const resume = deferred<void>();
  let guardKind: 'file' | 'directory' | undefined;
  let guardHandle: FileHandle | undefined;
  let selectorCommitted = false;
  let pausedPathRead = false;
  let observedPathInfo: Stats | undefined;
  let guardUnlinks = 0;
  const io: GuardTestIO = {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      if (path === guard) guardKind = 'directory';
    },
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === guard) {
        guardKind = 'file';
        guardHandle = handle;
      }
      return handle;
    },
    lstat: async (path) => {
      if (path === guard && selectorCommitted && guardKind !== undefined && !pausedPathRead) {
        pausedPathRead = true;
        observedPathInfo = await lstat(path);
        entered.resolve();
        await resume.promise;
        return observedPathInfo;
      }
      return lstat(path);
    },
    rename: async (from, to) => {
      await rename(from, to);
      if (to === selector) selectorCommitted = true;
    },
    unlink: async (path) => {
      if (path === guard) guardUnlinks++;
      return unlink(path);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const attempt = store.beginAcquire('server-1');
  try {
    await within(entered.promise);
    const kind = guardKind;
    assert.ok(kind);
    const original = guardHandle ? await guardHandle.stat() : await lstat(guard);
    assert.equal(observedPathInfo?.ino, original.ino);
    const replacement = await replaceGuardPath(guard, kind);
    assert.notEqual(replacement.ino, original.ino);
    resume.resolve();
    let rejected = false;
    await attempt.ready.then(
      () => {},
      () => {
        rejected = true;
      },
    );
    const retained = await lstat(guard).catch(() => undefined);
    assert.ok(retained, 'cleanup must not unlink a replacement after the successful path read');
    assert.equal(retained.dev, replacement.dev);
    assert.equal(retained.ino, replacement.ino);
    assert.equal(retained.isFile(), kind === 'file');
    assert.equal(guardUnlinks, 0);
    assert.equal(rejected, true);
    if (guardHandle) await assert.rejects(guardHandle.stat(), { code: 'EBADF' });
  } finally {
    resume.resolve();
    await attempt.ready.catch(() => null);
  }
});

test('transient guard path failure retries only against the opened fd identity', async () => {
  const directory = await trackedTempdir('steward-guard-transient-stat-');
  const guard = join(directory, 'takeover-guard');
  let guardKind: 'file' | 'directory' | undefined;
  let guardHandle: FileHandle | undefined;
  let fdIdentity: Stats | undefined;
  let failFirstGuardRead = true;
  let guardUnlinks = 0;
  const pathStats: Stats[] = [];
  const io: GuardTestIO = {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      if (path === guard) guardKind = 'directory';
    },
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === guard) {
        guardKind = 'file';
        guardHandle = handle;
        fdIdentity = await handle.stat();
      }
      return handle;
    },
    lstat: async (path) => {
      if (path === guard && guardKind !== undefined && failFirstGuardRead) {
        failFirstGuardRead = false;
        throw Object.assign(new Error('injected transient guard path-stat failure'), { code: 'EIO' });
      }
      const info = await lstat(path);
      if (path === guard && guardKind !== undefined) pathStats.push(info);
      return info;
    },
    unlink: async (path) => {
      if (path === guard) guardUnlinks++;
      return unlink(path);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const attempt = store.beginAcquire('server-1');
  const token = await attempt.ready;
  assert.ok(token);
  assert.ok(guardHandle);
  assert.ok(fdIdentity);
  assert.equal(pathStats.length, 2);
  assert.equal(pathStats[0]?.dev, fdIdentity.dev);
  assert.equal(pathStats[0]?.ino, fdIdentity.ino);
  assert.equal(pathStats[1]?.dev, fdIdentity.dev);
  assert.equal(pathStats[1]?.ino, fdIdentity.ino);
  assert.equal(guardUnlinks, 1);
  await assert.rejects(lstat(guard), { code: 'ENOENT' });
  await assert.rejects(guardHandle.stat(), { code: 'EBADF' });
  await store.release(token);
});

test('persistent guard path failure retains the file and closes its handle', async () => {
  const directory = await trackedTempdir('steward-guard-persistent-stat-');
  const guard = join(directory, 'takeover-guard');
  let guardKind: 'file' | 'directory' | undefined;
  let guardHandle: FileHandle | undefined;
  let guardUnlinks = 0;
  const io: GuardTestIO = {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      if (path === guard) guardKind = 'directory';
    },
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === guard) {
        guardKind = 'file';
        guardHandle = handle;
      }
      return handle;
    },
    lstat: async (path) => {
      if (path === guard && guardKind !== undefined) {
        throw Object.assign(new Error('persistent guard path-stat failure'), { code: 'EIO' });
      }
      return lstat(path);
    },
    unlink: async (path) => {
      if (path === guard) guardUnlinks++;
      return unlink(path);
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  await assert.rejects(store.acquire('server-1'), LeaseStateError);
  assert.ok(guardHandle);
  assert.equal(guardUnlinks, 0);
  const retained = await lstat(guard);
  assert.equal(retained.isFile(), true);
  assert.equal(retained.mode & 0o777, 0o600);
  await assert.rejects(guardHandle.stat(), { code: 'EBADF' });
  const contender = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
  );
  assert.equal(await contender.acquire('server-1'), null);
});

test('fd chmod and stat failures leave the guard for offline repair and close the handle', async () => {
  for (const failure of ['chmod', 'stat'] as const) {
    const directory = await trackedTempdir(`steward-guard-fd-${failure}-`);
    const guard = join(directory, 'takeover-guard');
    const active = join(directory, 'scheduler-lease', 'active.json');
    let guardHandle: FileHandle | undefined;
    let closeCalls = 0;
    let guardUnlinks = 0;
    const io: GuardTestIO = {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path !== guard) return handle;
        guardHandle = handle;
        return faultingGuardHandle(handle, { failure, onClose: () => closeCalls++ });
      },
      unlink: async (path) => {
        if (path === guard) guardUnlinks++;
        return unlink(path);
      },
    };
    const store = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const attempt = store.beginAcquire('server-1');
    await assert.rejects(attempt.ready, LeaseStateError);
    assert.ok(guardHandle);
    assert.equal(closeCalls, 1);
    assert.equal(guardUnlinks, 0);
    assert.equal((await lstat(guard)).isFile(), true);
    if (failure === 'stat') assert.equal((await lstat(guard)).mode & 0o777, 0o600);
    await assert.rejects(lstat(active), { code: 'ENOENT' });
    await assert.rejects(guardHandle.stat(), { code: 'EBADF' });
  }
});

test('restrictive umask still publishes an exact-mode fd-owned guard', async () => {
  const directory = await trackedTempdir('steward-guard-umask-');
  const guard = join(directory, 'takeover-guard');
  const selector = join(directory, 'scheduler-lease', 'active.json');
  let guardHandle: FileHandle | undefined;
  let openedFlags: number | undefined;
  let openedMode: number | undefined;
  let chmodMode: number | undefined;
  let statAfterChmod = false;
  let modeAtSelectorRename: number | undefined;
  const io: GuardTestIO = {
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path !== guard) return handle;
      guardHandle = handle;
      openedFlags = flags;
      openedMode = mode;
      return faultingGuardHandle(handle, {
        onChmod: (value) => {
          chmodMode = value;
        },
        onStat: () => {
          statAfterChmod = chmodMode === 0o600;
        },
      });
    },
    rename: async (from, to) => {
      if (to === selector) modeAtSelectorRename = (await lstat(guard)).mode & 0o777;
      await rename(from, to);
    },
    unlink: async (path) => unlink(path),
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const originalUmask = process.umask(0o777);
  try {
    const attempt = store.beginAcquire('server-1');
    const token = await attempt.ready;
    assert.ok(token);
    assert.equal(openedFlags, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
    assert.equal(openedMode, 0o600);
    assert.equal(chmodMode, 0o600);
    assert.equal(statAfterChmod, true);
    assert.equal(modeAtSelectorRename, 0o600);
    await assert.rejects(lstat(guard), { code: 'ENOENT' });
    assert.ok(guardHandle);
    await assert.rejects(guardHandle.stat(), { code: 'EBADF' });
    await store.release(token);
  } finally {
    process.umask(originalUmask);
  }
});

test('safe guard file contends and unsafe or legacy objects remain untouched', async () => {
  {
    const directory = await trackedTempdir('steward-guard-contended-');
    const guard = join(directory, 'takeover-guard');
    await writeFile(guard, 'held', { mode: 0o600, flag: 'wx' });
    await chmod(guard, 0o600);
    const before = await snapshot(guard);
    const store = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
    );
    assert.equal(await store.acquire('server-1'), null);
    assert.deepEqual(await snapshot(guard), before);
  }
  const cases = [
    {
      name: 'legacy directory guard',
      setup: async (guard: string) => mkdir(guard, { mode: 0o700 }),
      options: (_guard: string): Partial<LeaseIO> => ({}),
    },
    {
      name: 'symlink guard',
      setup: async (guard: string, directory: string) => {
        const target = join(directory, 'guard-target');
        await writeFile(target, 'target', { mode: 0o600, flag: 'wx' });
        await symlink(target, guard);
      },
      options: (_guard: string): Partial<LeaseIO> => ({}),
    },
    {
      name: 'wrong-mode guard file',
      setup: async (guard: string) => {
        await writeFile(guard, 'bad', { mode: 0o600, flag: 'wx' });
        await chmod(guard, 0o644);
      },
      options: (_guard: string): Partial<LeaseIO> => ({}),
    },
    {
      name: 'wrong-UID guard file',
      setup: async (guard: string) => writeFile(guard, 'bad', { mode: 0o600, flag: 'wx' }),
      options: (guard: string): Partial<LeaseIO> => ({
        lstat: async (path) => {
          const info = await lstat(path);
          if (path !== guard) return info;
          const wrongUid = Object.create(info) as Stats;
          Object.defineProperty(wrongUid, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
          return wrongUid;
        },
      }),
    },
    {
      name: 'unreadable guard path',
      setup: async (guard: string) => writeFile(guard, 'held', { mode: 0o600, flag: 'wx' }),
      options: (guard: string): Partial<LeaseIO> => ({
        lstat: async (path) => {
          if (path === guard) throw Object.assign(new Error('injected unreadable guard'), { code: 'EACCES' });
          return lstat(path);
        },
      }),
    },
  ];
  for (const scenario of cases) {
    const directory = await trackedTempdir('steward-guard-unsafe-');
    const guard = join(directory, 'takeover-guard');
    await scenario.setup(guard, directory);
    const before = await snapshot(guard);
    const store = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
      { io: scenario.options(guard) },
    );
    await assert.rejects(store.acquire('server-1'), LeaseStateError, scenario.name);
    assert.deepEqual(await snapshot(guard), before, scenario.name);
  }
});

test('partial initialization and stranded guard never authorize', async () => {
  for (const failure of ['generation', 'owner', 'heartbeat'] as const) {
    const directory = await trackedTempdir(`steward-partial-${failure}-`);
    const io: Partial<LeaseIO> = {
      mkdir: async (path, options) => {
        if (failure === 'generation' && path.includes('/generations/') && !path.endsWith('/generations')) {
          await mkdir(path, options);
          throw Object.assign(new Error('injected post-create failure'), { code: 'ENOSPC' });
        }
        return mkdir(path, options);
      },
      open: async (path, flags, mode) => {
        if (
          (failure === 'owner' && path.endsWith('/owner.json')) ||
          (failure === 'heartbeat' && path.endsWith('/heartbeat.json'))
        ) {
          throw Object.assign(new Error('injected initialization failure'), { code: 'ENOSPC' });
        }
        return open(path, flags, mode);
      },
    };
    const store = new SchedulerLeaseStore(
      directory,
      async () => {},
      () => 10_000,
      { io },
    );
    const attempt = store.beginAcquire('server-1');
    await assert.rejects(attempt.ready);
    assert.equal(await store.active('server-1'), false);
    await assert.rejects(store.acquire('server-1'));
    assert.equal(await store.activeToken('server-1'), null);
  }
  {
    const f = await trackedFixture();
    const deadOwner = { ...f.identity, pid: 4242 };
    await writeFile(join(f.generation, 'owner.json'), JSON.stringify(deadOwner), { mode: 0o600 });
    await writeFile(join(f.generation, 'heartbeat.json'), JSON.stringify({ ...f.heartbeat, heartbeat: 1 }), {
      mode: 0o600,
    });
    await writeFile(join(f.root, 'active.json'), JSON.stringify(deadOwner), { mode: 0o600 });
    const guard = join(f.directory, 'takeover-guard');
    await writeFile(guard, 'stranded', { mode: 0o600, flag: 'wx' });
    const before = await snapshot(guard);
    const store = new SchedulerLeaseStore(
      f.directory,
      async () => {},
      () => 20_000,
      { alive: (pid) => (pid === 4242 ? false : true) },
    );
    assert.equal(await store.acquire('server-1'), null);
    assert.deepEqual(await snapshot(guard), before);
  }
});

test('delayed G release after H leaves H byte-for-byte intact', async () => {
  const directory = await trackedTempdir('steward-delayed-release-');
  const entered = deferred<void>();
  const resume = deferred<void>();
  let delay = false;
  const io: Partial<LeaseIO> = {
    mkdir: async (path, options) => {
      await mkdir(path, options);
      if (delay && String(path).endsWith('/released')) {
        delay = false;
        entered.resolve();
        await resume.promise;
      }
    },
  };
  const store = new SchedulerLeaseStore(
    directory,
    async () => {},
    () => 10_000,
    { io },
  );
  const g = await store.acquire('server-1');
  assert.ok(g);
  delay = true;
  const releaseG = store.release(g);
  try {
    await within(entered.promise);
    const h = await store.acquire('server-1');
    assert.ok(h);
    assert.notEqual(h, g);
    const paths = [
      join(directory, 'scheduler-lease', 'active.json'),
      join(directory, 'scheduler-lease', 'generations', h, 'owner.json'),
      join(directory, 'scheduler-lease', 'generations', h, 'heartbeat.json'),
    ];
    const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    resume.resolve();
    await within(releaseG);
    await store.release(g);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, 'utf8'))), before);
    await store.release(h);
  } finally {
    resume.resolve();
    await releaseG.catch(() => {});
  }
});
