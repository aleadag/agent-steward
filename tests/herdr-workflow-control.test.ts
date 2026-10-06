import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';
import { readPrivateJson, withPrivateGuard, writePrivateJson } from '../src/herdr-adapter/private-files.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'steward-control-'));
  roots.push(root);
  const state = new WorkflowState(root);
  const path = join(root, 'automation', createHash('sha256').update('["47:1"]').digest('hex'), 'control.json');
  return { root, state, path };
}

test('resume never revives an old ticket', async () => {
  const { root, state: a } = await fixture();
  const old = await a.capture('47:1', true);
  assert.ok(old);
  assert.equal(await a.pause('47:1'), 'paused');
  assert.equal(await a.matches(old), false);
  assert.equal(await a.capture('47:1', true), null);
  assert.equal(await a.resume('47:1', true), 'resumed');
  const fresh = await new WorkflowState(root).capture('47:1', true);
  assert.ok(fresh);
  assert.notEqual(fresh.epoch, old.epoch);
  assert.equal(await a.matches(old), false);
});

test('pause before the first enabled event creates a durable closed installation', async () => {
  const { root, state } = await fixture();
  assert.equal(await state.pause('47:1'), 'paused');
  assert.equal(await new WorkflowState(root).capture('47:1', true), null);
  assert.equal(await state.resume('47:1', false), 'denied');
  assert.equal(await state.resume('47:1', true), 'resumed');
  assert.ok(await new WorkflowState(root).capture('47:1', true));
});

test('an unsafe shared root cannot grant admission or be chmod-repaired', async () => {
  const { root, state } = await fixture();
  await chmod(root, 0o777);
  assert.equal(await state.capture('47:1', true), null);
  assert.equal(await state.resume('47:1', true), 'denied');
  assert.equal((await lstat(root)).mode & 0o777, 0o777);
});

test('enablement is explicit; open resume and repeated pause do not revoke unrelated history', async () => {
  const { root, state, path } = await fixture();
  assert.equal(await state.capture('47:1', false), null);
  assert.equal(await state.resume('47:1', false), 'denied');
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  const before = await readFile(path, 'utf8');
  assert.equal(await state.resume('47:1', true), 'resumed');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await state.matches(ticket), true);
  assert.equal(await state.matches({ ...ticket, serverId: 'other' }), false);
  await writeFile(join(root, 'history'), 'retain', { mode: 0o600 });
  assert.equal(await state.pause('47:1'), 'paused');
  assert.equal(await new WorkflowState(root).pause('47:1'), 'paused');
  assert.equal(await new WorkflowState(root).capture('47:1', true), null);
  assert.equal(await readFile(join(root, 'history'), 'utf8'), 'retain');
});

const unsafe = [
  ['malformed JSON', async (path: string) => writeFile(path, '{')],
  [
    'extra schema field',
    async (path: string) =>
      writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), extra: true })),
  ],
  ['invalid UUID', async (path: string) => writeFile(path, '{"protocol":1,"epoch":"bad","mode":"open"}')],
  [
    'wrong protocol',
    async (path: string) =>
      writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), protocol: 2 })),
  ],
  [
    'unknown mode',
    async (path: string) =>
      writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), mode: 'enabled' })),
  ],
  ['oversized JSON', async (path: string) => writeFile(path, ' '.repeat(8193))],
  ['writable file', async (path: string) => chmod(path, 0o622)],
  [
    'symlink',
    async (path: string) => {
      await rename(path, `${path}.saved`);
      await symlink(`${path}.saved`, path);
    },
  ],
  ['hard link', async (path: string) => link(path, `${path}.saved`)],
  ['unsafe directory', async (path: string) => chmod(join(path, '..'), 0o755)],
  [
    'symlinked directory',
    async (path: string) => {
      const directory = join(path, '..');
      await rename(directory, `${directory}.saved`);
      await symlink(`${directory}.saved`, directory);
    },
  ],
] as const;
for (const [name, mutate] of unsafe) {
  test(`${name} cannot grant admission or be silently repaired by resume`, async () => {
    const { state, path } = await fixture();
    const ticket = await state.capture('47:1', true);
    assert.ok(ticket);
    await mutate(path);
    assert.equal(await state.matches(ticket), false);
    assert.equal(await state.capture('47:1', true), null);
    assert.equal(await state.resume('47:1', true), 'denied');
    assert.equal(await state.pause('47:1'), 'denied');
  });
}

test('unreadable control is not absence and filesystem options reach reads', async () => {
  const { root, state, path } = await fixture();
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  const denied = new WorkflowState(root, undefined, {
    io: {
      open: async (p, flags, mode) => {
        if (p === path) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
        return open(p, flags, mode);
      },
    },
  });
  assert.equal(await denied.capture('47:1', true), null);
  assert.equal(await denied.matches(ticket), false);
  assert.equal(await denied.resume('47:1', true), 'denied');
});

test('owned 0755 root is prepared privately even under restricted umask', async () => {
  const { root, state, path } = await fixture();
  await chmod(root, 0o755);
  const oldMask = process.umask(0o777);
  try {
    assert.ok(await state.capture('47:1', true));
  } finally {
    process.umask(oldMask);
  }
  for (const p of [root, join(root, 'automation'), join(path, '..')])
    assert.equal((await lstat(p)).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test('ENOSPC fails closed and a later explicit capture can bootstrap after clean failure', async () => {
  const { root, path } = await fixture();
  const state = new WorkflowState(root, undefined, {
    io: {
      open: async (p, flags, mode) => {
        if (p.endsWith('.tmp')) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        return open(p, flags, mode);
      },
    },
  });
  assert.equal(await state.capture('47:1', true), null);
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.ok(await new WorkflowState(root).capture('47:1', true));
});

test('duplicate first captures publish just one epoch', async () => {
  const { root, path } = await fixture();
  const tickets = await Promise.all(Array.from({ length: 8 }, () => new WorkflowState(root).capture('47:1', true)));
  const admitted = tickets.filter((ticket) => ticket !== null);
  assert.ok(admitted.length > 0);
  assert.equal(new Set(admitted.map((ticket) => ticket.epoch)).size, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).epoch, admitted[0]!.epoch);
});

test('held pause rename times out truthfully and retains its guard against simultaneous resume', async () => {
  const { root, state, path } = await fixture();
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  const held = deferred<void>();
  const entered = deferred<void>();
  const cleaned = deferred<void>();
  let expire!: () => void;
  const control = new WorkflowState(root, undefined, {
    shutdownDeadline: (ms, callback) => {
      assert.equal(ms, 5000);
      expire = callback;
      return () => {};
    },
    io: {
      rename: async (from, to) => {
        if (to === path) {
          entered.resolve();
          await held.promise;
        }
        await rename(from, to);
      },
      unlink: async (p) => {
        await unlink(p);
        if (p.endsWith('control-guard')) cleaned.resolve();
      },
    },
  });
  assert.equal(await control.matches(ticket), true);
  const paused = control.pause('47:1');
  await within(entered.promise);
  expire();
  assert.equal(await within(paused), 'shutdown_incomplete');
  assert.equal(await control.matches(ticket), false);
  assert.equal(await new WorkflowState(root).resume('47:1', true), 'shutdown_incomplete');
  assert.ok((await readdir(join(path, '..'))).some((name) => name.endsWith('guard')));
  held.resolve();
  await within(cleaned.promise);
  assert.equal(await new WorkflowState(root).matches(ticket), false);
  assert.equal(await new WorkflowState(root).resume('47:1', true), 'resumed');
  assert.equal(await new WorkflowState(root).matches(ticket), false);
});

test('late failing rename remains observed and never turns incomplete shutdown into success', async () => {
  const { root, state, path } = await fixture();
  assert.ok(await state.capture('47:1', true));
  const held = deferred<void>();
  const entered = deferred<void>();
  const cleaned = deferred<void>();
  let expire!: () => void;
  const control = new WorkflowState(root, undefined, {
    shutdownDeadline: (_ms, cb) => {
      expire = cb;
      return () => {};
    },
    io: {
      rename: async (_from, to) => {
        if (to === path) {
          entered.resolve();
          await held.promise;
          throw Object.assign(new Error('late disk failure'), { code: 'EIO' });
        }
        await rename(_from, to);
      },
      unlink: async (p) => {
        await unlink(p);
        if (p.endsWith('control-guard')) cleaned.resolve();
      },
    },
  });
  const result = control.pause('47:1');
  await within(entered.promise);
  expire();
  assert.equal(await within(result), 'shutdown_incomplete');
  held.resolve();
  await within(cleaned.promise);
  assert.equal(await within(result), 'shutdown_incomplete');
});

test('guard cleanup keeps the original fd identity after a failed pathname read', async () => {
  const { root } = await fixture();
  const guard = join(root, 'test-guard');
  const entered = deferred<void>();
  const held = deferred<void>();
  let cleaning = false;
  let first = true;
  const operation = withPrivateGuard(
    root,
    'test-guard',
    async () => {
      cleaning = true;
      return 'finished';
    },
    {
      io: {
        lstat: async (p) => {
          if (p === guard && cleaning && first) {
            first = false;
            entered.resolve();
            await held.promise;
            throw Object.assign(new Error('first read failed'), { code: 'EIO' });
          }
          return lstat(p);
        },
      },
    },
  );
  await within(entered.promise);
  await rename(guard, `${guard}.original`);
  await writeFile(guard, 'replacement', { mode: 0o600, flag: 'wx' });
  held.resolve();
  await assert.rejects(operation);
  assert.equal(await readFile(guard, 'utf8'), 'replacement');
});

test('a replacement guard during a held write cannot authorize publication', async () => {
  const { root } = await fixture();
  const path = join(root, 'data.json');
  const guard = join(root, 'writer-guard');
  await writePrivateJson(path, { mode: 'open' });
  const held = deferred<void>();
  const entered = deferred<void>();
  const options = {
    io: {
      open: async (p: string, flags: number, mode?: number) => {
        const handle = await open(p, flags, mode);
        if (!p.endsWith('.tmp')) return handle;
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'writeFile')
              return async (...args: Parameters<typeof handle.writeFile>) => {
                entered.resolve();
                await held.promise;
                return target.writeFile(...args);
              };
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
  const publishing = withPrivateGuard(
    root,
    'writer-guard',
    () => writePrivateJson(path, { mode: 'paused' }, options),
    options,
  );
  await within(entered.promise);
  await rename(guard, `${guard}.original`);
  await writeFile(guard, 'replacement', { mode: 0o600, flag: 'wx' });
  held.resolve();
  await assert.rejects(publishing);
  assert.deepEqual(await readPrivateJson(path, 8192), { mode: 'open' });
  assert.equal(await readFile(guard, 'utf8'), 'replacement');
});

test('a vanished file after pathname validation is unsafe, not initial absence', async () => {
  const { root, state, path } = await fixture();
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  let vanished = false;
  const control = new WorkflowState(root, undefined, {
    io: {
      open: async (p, flags, mode) => {
        if (p === path && !vanished) {
          vanished = true;
          await unlink(path);
          throw Object.assign(new Error('vanished after lstat'), { code: 'ENOENT' });
        }
        return open(p, flags, mode);
      },
    },
  });
  assert.equal(await control.capture('47:1', true), null);
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('an older held resume cannot clear a newer local pause', async () => {
  const { root, state, path } = await fixture();
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  const held = deferred<void>();
  const entered = deferred<void>();
  let hold = false;
  const control = new WorkflowState(root, undefined, {
    io: {
      open: async (p, flags, mode) => {
        if (p === path && hold) {
          hold = false;
          entered.resolve();
          await held.promise;
        }
        return open(p, flags, mode);
      },
    },
  });
  assert.equal(await control.matches(ticket), true);
  hold = true;
  const resumed = control.resume('47:1', true);
  await within(entered.promise);
  assert.equal(await control.pause('47:1'), 'shutdown_incomplete');
  held.resolve();
  assert.equal(await within(resumed), 'shutdown_incomplete');
  assert.equal(await control.capture('47:1', true), null);
  assert.equal(await control.matches(ticket), false);
});

test('a held first capture cannot adopt permission after an intervening pause and resume', async () => {
  const { root } = await fixture();
  const held = deferred<void>();
  const entered = deferred<void>();
  let first = true;
  const control = new WorkflowState(root, undefined, {
    io: {
      open: async (p, flags, mode) => {
        const handle = await open(p, flags, mode);
        if (!p.endsWith('control-guard') || !first) return handle;
        first = false;
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'close')
              return async () => {
                entered.resolve();
                await held.promise;
                await target.close();
              };
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  });
  const captured = control.capture('47:1', true);
  await within(entered.promise);
  assert.equal(await control.pause('47:1'), 'paused');
  assert.equal(await control.resume('47:1', true), 'resumed');
  held.resolve();
  assert.equal(await within(captured), null);
  assert.ok(await control.capture('47:1', true));
});

test('a held matching snapshot cannot regain authorization after pause and resume', async () => {
  const { root, state } = await fixture();
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  const held = deferred<void>();
  const entered = deferred<void>();
  let armed = false;
  let rootsSeen = 0;
  const control = new WorkflowState(root, undefined, {
    io: {
      lstat: async (p) => {
        if (p === root && armed && ++rootsSeen === 2) {
          armed = false;
          entered.resolve();
          await held.promise;
        }
        return lstat(p);
      },
    },
  });
  assert.equal(await control.matches(ticket), true);
  armed = true;
  const matching = control.matches(ticket);
  await within(entered.promise);
  assert.equal(await control.pause('47:1'), 'paused');
  assert.equal(await control.resume('47:1', true), 'resumed');
  held.resolve();
  assert.equal(await within(matching), false);
});

test('missing control in a nonempty administrative directory is not a new installation', async () => {
  const { state, path } = await fixture();
  assert.ok(await state.capture('47:1', true));
  await unlink(path);
  await writeFile(join(path, '..', 'control.json.orphan.tmp'), 'keep', { mode: 0o600 });
  assert.equal(await state.capture('47:1', true), null);
  assert.equal(await state.resume('47:1', true), 'denied');
  assert.equal(await state.pause('47:1'), 'denied');
});

test('private JSON helpers reject unsafe files and bound actual reads', async () => {
  const { root } = await fixture();
  const path = join(root, 'data.json');
  await writePrivateJson(path, { value: 1 });
  assert.deepEqual(await readPrivateJson(path, 8192), { value: 1 });
  await assert.rejects(readPrivateJson(path, 2));
  await link(path, `${path}.linked`);
  await assert.rejects(writePrivateJson(path, { value: 2 }));
  await unlink(`${path}.linked`);
  assert.deepEqual(await readPrivateJson(path, 8192), { value: 1 });
});
