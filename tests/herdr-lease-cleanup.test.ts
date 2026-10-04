import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { LeaseStateError, SchedulerLeaseStore, type LeaseOptions, type LeaseIO } from '../src/herdr-adapter/lease.ts';
import { deferred, leaseFixture, within } from './herdr-lease-helpers.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const f = await leaseFixture();
  roots.push(f.directory);
  await mkdir(join(f.generation, 'released'), { mode: 0o700 });
  const token = randomUUID();
  const path = join(f.root, 'generations', token);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'owner.json'), JSON.stringify({ ...f.identity, token, pid: 4242 }), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(path, 'heartbeat.json'), 'truncated heartbeat', { mode: 0o600, flag: 'wx' });
  return { ...f, candidate: path, candidateToken: token };
}
function storeFor(f: Awaited<ReturnType<typeof fixture>>, options: LeaseOptions = {}) {
  return new SchedulerLeaseStore(
    f.directory,
    async () => {},
    () => 20_000,
    {
      alive: (pid) => pid !== 4242,
      ...options,
    },
  );
}

test('acquisition reclaims dead unselected generations but preserves selected and living released owners', async () => {
  const f = await fixture();
  const store = storeFor(f);
  const token = await store.acquire('server-1');
  assert.ok(token);
  await assert.rejects(lstat(f.candidate), { code: 'ENOENT' });
  await lstat(f.generation);
  assert.equal(await store.leaseMatches(token, 'server-1'), true);
  await store.release(token);
  await lstat(join(f.root, 'generations', token, 'released'));
});

const unsafeCandidates: { name: string; mutate: (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown> }[] = [
  {
    name: 'symlinked generation',
    mutate: async (f) => {
      await rename(f.candidate, `${f.candidate}.saved`);
      await symlink(`${f.candidate}.saved`, f.candidate);
    },
  },
  {
    name: 'symlinked owner',
    mutate: async (f) => {
      await rm(join(f.candidate, 'owner.json'));
      await symlink(join(f.generation, 'owner.json'), join(f.candidate, 'owner.json'));
    },
  },
  { name: 'missing owner', mutate: (f) => rm(join(f.candidate, 'owner.json')) },
  { name: 'corrupt owner', mutate: (f) => writeFile(join(f.candidate, 'owner.json'), '{}') },
  {
    name: 'mismatched owner token',
    mutate: (f) => writeFile(join(f.candidate, 'owner.json'), JSON.stringify({ ...f.identity, pid: 4242 })),
  },
  { name: 'unsafe directory mode', mutate: (f) => chmod(f.candidate, 0o755) },
  { name: 'unsafe file mode', mutate: (f) => chmod(join(f.candidate, 'heartbeat.json'), 0o644) },
  { name: 'unknown file', mutate: (f) => writeFile(join(f.candidate, 'unknown'), 'keep', { mode: 0o600 }) },
  {
    name: 'nonempty release marker',
    mutate: async (f) => {
      await mkdir(join(f.candidate, 'released'), { mode: 0o700 });
      await writeFile(join(f.candidate, 'released', 'keep'), 'keep', { mode: 0o600 });
    },
  },
  {
    name: 'symlinked file',
    mutate: async (f) => {
      await rm(join(f.candidate, 'heartbeat.json'));
      await symlink(join(f.generation, 'heartbeat.json'), join(f.candidate, 'heartbeat.json'));
    },
  },
  { name: 'symlinked marker', mutate: (f) => symlink(join(f.generation, 'released'), join(f.candidate, 'released')) },
  {
    name: 'hard-linked file',
    mutate: async (f) => {
      await rm(join(f.candidate, 'heartbeat.json'));
      await link(join(f.generation, 'heartbeat.json'), join(f.candidate, 'heartbeat.json'));
    },
  },
];
for (const row of unsafeCandidates) {
  test(`cleanup preserves ${row.name} without blocking an eligible neighbor`, async () => {
    const f = await fixture();
    await row.mutate(f);
    const before = await readdir(f.candidate);
    const token = randomUUID();
    const eligible = join(f.root, 'generations', token);
    await mkdir(eligible, { mode: 0o700 });
    await writeFile(join(eligible, 'owner.json'), JSON.stringify({ ...f.identity, token, pid: 4242 }), { mode: 0o600 });
    const store = storeFor(f);
    const acquired = await store.acquire('server-1');
    assert.ok(acquired);
    assert.deepEqual(await readdir(f.candidate), before);
    await assert.rejects(lstat(eligible), { code: 'ENOENT' });
    await store.release(acquired);
  });
}
for (const value of [true, null, 'throw'] as const) {
  test(`cleanup preserves ${value} owner liveness`, async () => {
    const f = await fixture();
    const store = storeFor(f, {
      alive: (pid) => {
        if (pid !== 4242) return true;
        if (value === 'throw') throw new Error('unknown');
        return value;
      },
    });
    const token = await store.acquire('server-1');
    assert.ok(token);
    assert.equal(await readFile(join(f.candidate, 'heartbeat.json'), 'utf8'), 'truncated heartbeat');
    await store.release(token);
  });
}

test('refused acquisition never cleans candidate state', async () => {
  const f = await fixture();
  await rm(join(f.generation, 'released'), { recursive: true });
  const token = await storeFor(f).acquire('server-1');
  assert.equal(token, null);
  await lstat(f.candidate);
});

test('cleanup preserves foreign-owned candidates and unrelated private records', async () => {
  const f = await fixture();
  for (const name of ['episode.json', 'approval-attempt.json'])
    await writeFile(join(f.directory, name), 'keep', { mode: 0o600 });
  const store = storeFor(f, {
    io: {
      lstat: async (path) => {
        const info = await lstat(path);
        if (path === f.candidate) info.uid += 1;
        return info;
      },
    },
  });
  const token = await store.acquire('server-1');
  assert.ok(token);
  await lstat(f.candidate);
  for (const name of ['episode.json', 'approval-attempt.json'])
    assert.equal(await readFile(join(f.directory, name), 'utf8'), 'keep');
});

test('cleanup includes dead-owner private heartbeat temps and empty release markers', async () => {
  const f = await fixture();
  await writeFile(join(f.candidate, `heartbeat.json.${randomUUID()}.tmp`), 'incomplete', { mode: 0o600 });
  await mkdir(join(f.candidate, 'released'), { mode: 0o700 });
  const token = await storeFor(f).acquire('server-1');
  assert.ok(token);
  await assert.rejects(lstat(f.candidate), { code: 'ENOENT' });
});

test('slow cleanup cannot report a ready lease whose heartbeat expired during maintenance', async () => {
  const f = await fixture();
  let now = 20_000;
  const store = new SchedulerLeaseStore(
    f.directory,
    async () => {},
    () => now,
    {
      alive: (pid) => pid !== 4242,
      io: {
        unlink: async (path) => {
          if (path.startsWith(f.candidate)) now = 40_000;
          await unlink(path);
        },
      },
    },
  );
  await assert.rejects(store.acquire('server-1'), LeaseStateError);
  assert.equal(await store.active('server-1'), false);
});

async function orderedDirectory(path: string, names: string[]) {
  const directory = await opendir(path);
  const entries = await readdir(path, { withFileTypes: true });
  let index = 0;
  return new Proxy(directory, {
    get(target, key) {
      if (key === 'read') return async () => entries.find((entry) => entry.name === names[index++]) ?? null;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function addDead(f: Awaited<ReturnType<typeof fixture>>) {
  const token = randomUUID();
  const path = join(f.root, 'generations', token);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'owner.json'), JSON.stringify({ ...f.identity, token, pid: 4242 }), { mode: 0o600 });
  return path;
}

test('cleanup deletes at most 32 directories per acquisition', async () => {
  const f = await fixture();
  const candidates = [f.candidate];
  for (let i = 0; i < 32; i++) candidates.push(await addDead(f));
  const token = await storeFor(f).acquire('server-1');
  assert.ok(token);
  const retained = await Promise.all(
    candidates.map(async (path) =>
      lstat(path).then(
        () => true,
        () => false,
      ),
    ),
  );
  assert.equal(retained.filter(Boolean).length, 1);
  assert.equal(await storeFor(f).leaseMatches(token, 'server-1'), true);
});

test('cleanup stops inspection after 128 entries without assuming fair directory order', async () => {
  const f = await fixture();
  const generations = join(f.root, 'generations');
  const names = Array.from({ length: 128 }, (_, i) => `unknown-${i}`);
  for (const name of names) await mkdir(join(generations, name), { mode: 0o700 });
  names.push(f.candidateToken);
  const token = await storeFor(f, {
    io: {
      opendir: async (path, options) => (path === generations ? orderedDirectory(path, names) : opendir(path, options)),
    },
  }).acquire('server-1');
  assert.ok(token);
  await lstat(f.candidate);
});

test('over-budget candidate children are all preserved before deletion begins', async () => {
  const f = await fixture();
  for (let i = 0; i < 63; i++)
    await writeFile(join(f.candidate, `heartbeat.json.${randomUUID()}.tmp`), 'temp', { mode: 0o600 });
  const before = await readdir(f.candidate);
  const token = await storeFor(f).acquire('server-1');
  assert.ok(token);
  assert.deepEqual(await readdir(f.candidate), before);
});

for (const point of ['heartbeat.json', 'released', 'owner.json', 'generation'] as const) {
  for (const code of ['EIO', 'ENOSPC']) {
    test(`cleanup ${code} at ${point} preserves selected authority and never recreates removed parents`, async () => {
      const f = await fixture();
      await mkdir(join(f.candidate, 'released'), { mode: 0o700 });
      const failurePath = point === 'generation' ? f.candidate : join(f.candidate, point);
      const fail = (path: string) => {
        if (path === failurePath) throw Object.assign(new Error('injected cleanup failure'), { code });
      };
      const token = await storeFor(f, {
        io: {
          unlink: async (path) => {
            fail(path);
            await unlink(path);
          },
          rmdir: async (path, options) => {
            fail(String(path));
            await rmdir(path, options);
          },
        },
      }).acquire('server-1');
      assert.ok(token);
      await lstat(f.candidate);
      assert.equal(await storeFor(f).leaseMatches(token, 'server-1'), true);
      if (point === 'generation') await assert.rejects(lstat(join(f.candidate, 'owner.json')), { code: 'ENOENT' });
    });
  }
}

test('cleanup retains a candidate whose PID becomes live on recheck', async () => {
  const f = await fixture();
  let probes = 0;
  const token = await storeFor(f, { alive: (pid) => (pid === 4242 ? ++probes > 1 : true) }).acquire('server-1');
  assert.ok(token);
  assert.equal(await readFile(join(f.candidate, 'heartbeat.json'), 'utf8'), 'truncated heartbeat');
});

for (const kind of ['file', 'directory'] as const) {
  test(`cleanup preserves replacement candidate ${kind} identity`, async () => {
    const f = await fixture();
    let reads = 0;
    const pathToReplace = kind === 'file' ? join(f.candidate, 'heartbeat.json') : f.candidate;
    const token = await storeFor(f, {
      io: {
        lstat: async (path) => {
          if (path === pathToReplace && ++reads === 2) {
            await rename(path, `${path}.saved`);
            if (kind === 'file') await writeFile(path, 'replacement', { mode: 0o600 });
            else {
              await mkdir(path, { mode: 0o700 });
              await writeFile(join(path, 'keep'), 'replacement', { mode: 0o600 });
            }
          }
          return lstat(path);
        },
      },
    }).acquire('server-1');
    assert.ok(token);
    assert.equal(await readFile(kind === 'file' ? pathToReplace : join(pathToReplace, 'keep'), 'utf8'), 'replacement');
  });
}

for (const kind of ['guard', 'selector', 'root', 'selected-owner'] as const) {
  test(`cleanup fails closed when shared ${kind} changes`, async () => {
    const f = await fixture();
    let changed = false;
    const guard = join(f.directory, 'takeover-guard');
    const store = storeFor(f, {
      io: {
        lstat: async (path) => {
          if (path === f.candidate && !changed) {
            changed = true;
            if (kind === 'guard') {
              await rename(guard, `${guard}.saved`);
              await writeFile(guard, 'replacement', { mode: 0o600 });
            }
            if (kind === 'selector') await writeFile(join(f.root, 'active.json'), JSON.stringify(f.identity));
            if (kind === 'root') await chmod(f.root, 0o755);
            if (kind === 'selected-owner') {
              const selected = JSON.parse(await readFile(join(f.root, 'active.json'), 'utf8'));
              await writeFile(join(f.root, 'generations', selected.token, 'owner.json'), '{}');
            }
          }
          return lstat(path);
        },
      },
    });
    await assert.rejects(store.acquire('server-1'), LeaseStateError);
    assert.equal(await store.active('server-1'), false);
    await lstat(f.candidate);
    if (kind === 'guard') assert.equal(await readFile(guard, 'utf8'), 'replacement');
  });
}

test('cleanup serializes competitors and retains its guard until admitted deletion settles after cancellation', async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const resume = deferred<void>();
  const store = storeFor(f, {
    io: {
      unlink: async (path) => {
        if (path === join(f.candidate, 'heartbeat.json')) {
          entered.resolve();
          await resume.promise;
        }
        await unlink(path);
      },
    },
  });
  const attempt = store.beginAcquire('server-1');
  try {
    await within(entered.promise);
    assert.equal(await storeFor(f).acquire('server-1'), null);
    attempt.close();
    await within(attempt.release());
    await lstat(join(f.directory, 'takeover-guard'));
    resume.resolve();
    assert.equal(await within(attempt.ready), null);
    await assert.rejects(lstat(join(f.directory, 'takeover-guard')), { code: 'ENOENT' });
    await lstat(join(f.candidate, 'owner.json'));
    await lstat(join(f.root, 'generations', attempt.token, 'released'));
  } finally {
    resume.resolve();
    await attempt.ready.catch(() => {});
  }
});

test('a reader paused on an old generation fails closed when dead history is collected', async () => {
  const f = await fixture();
  const owner = { ...f.identity, pid: 4242 };
  await writeFile(join(f.root, 'active.json'), JSON.stringify(owner));
  await writeFile(join(f.generation, 'owner.json'), JSON.stringify(owner));
  const entered = deferred<void>();
  const resume = deferred<void>();
  const reader = storeFor(f, {
    io: {
      open: async (path, flags, mode) => {
        if (path === join(f.generation, 'owner.json')) {
          entered.resolve();
          await resume.promise;
        }
        return open(path, flags, mode);
      },
    },
  });
  const observation = reader.inspect();
  try {
    await within(entered.promise);
    const token = await storeFor(f).acquire('server-1');
    assert.ok(token);
    await assert.rejects(lstat(f.generation), { code: 'ENOENT' });
    resume.resolve();
    await assert.rejects(observation, LeaseStateError);
    assert.equal(await storeFor(f).leaseMatches(token, 'server-1'), true);
  } finally {
    resume.resolve();
    await observation.catch(() => {});
  }
});

for (const location of ['root', 'candidate'] as const) {
  for (const failure of ['open', 'read', 'close'] as const) {
    test(`cleanup ${location} iterator ${failure} failure closes acquired handles without granting old authority`, async () => {
      const f = await fixture();
      const handles: Awaited<ReturnType<LeaseIO['opendir']>>[] = [];
      const failurePath = location === 'root' ? join(f.root, 'generations') : f.candidate;
      const token = await storeFor(f, {
        io: {
          opendir: async (path, options) => {
            if (path === failurePath && failure === 'open') throw new Error('injected open');
            const directory = await opendir(path, options);
            handles.push(directory);
            if (path !== failurePath) return directory;
            return new Proxy(directory, {
              get(target, key) {
                if (key === 'read' && failure === 'read')
                  return async () => {
                    throw new Error('injected read');
                  };
                if (key === 'close' && failure === 'close')
                  return async () => {
                    await target.close();
                    throw new Error('injected close');
                  };
                const value = Reflect.get(target, key, target) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          },
        },
      }).acquire('server-1');
      assert.ok(token);
      assert.equal(await storeFor(f).leaseMatches(token, 'server-1'), true);
      if (!(location === 'root' && failure === 'close')) await lstat(f.candidate);
      for (const handle of handles) await assert.rejects(handle.read());
    });
  }
}
