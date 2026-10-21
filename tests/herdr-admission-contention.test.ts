import assert from 'node:assert/strict';
import { afterEach, setDefaultTimeout, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginWorkflow, type WorkflowAttempt } from '../src/herdr-adapter/authority.ts';
import { withPrivateGuard, writePrivateJson } from '../src/herdr-adapter/private-files.ts';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';
import { deferred, withinWorkflow as within } from './herdr-lease-helpers.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
const attempts: WorkflowAttempt[] = [];
const holders: { release(): void; done: Promise<unknown> }[] = [];
const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
afterEach(async () => {
  for (const holder of holders) holder.release();
  await Promise.all(holders.splice(0).map((holder) => holder.done));
  await Promise.all(attempts.splice(0).map((attempt) => attempt.finish()));
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(children.splice(0).map(({ closed }) => closed));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'steward-admission-contention-'));
  roots.push(root);
  const state = new WorkflowState(root);
  const ticket = await state.capture('47:1', true);
  assert.ok(ticket);
  const directory = join(root, 'automation', createHash('sha256').update('["47:1"]').digest('hex'));
  return { root, state, ticket, directory };
}
async function hold(directory: string) {
  const entered = deferred<void>();
  const released = deferred<void>();
  const done = withPrivateGuard(directory, 'control-guard', async () => {
    entered.resolve();
    await released.promise;
    return true;
  });
  const holder = { release: () => released.resolve(), done };
  holders.push(holder);
  await within(entered.promise);
  return holder;
}
function observedState(root: string, retryGate?: Promise<void>) {
  const contended = deferred<void>();
  let conflicts = 0;
  const state = new WorkflowState(root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        if (conflicts > 0 && path.endsWith('control-guard')) await retryGate;
        try {
          return await open(path, flags, mode);
        } catch (error) {
          if (path.endsWith('control-guard') && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            conflicts++;
            contended.resolve();
          }
          throw error;
        }
      },
    },
  });
  return { state, contended: contended.promise, conflicts: () => conflicts };
}
function start(state: WorkflowState, signal = new AbortController().signal, enabled = () => true) {
  const attempt = beginWorkflow({
    state,
    scope: {
      serverId: '47:1',
      agent: 'pi',
      sessionId: '/tmp/admission.jsonl',
      sessionKind: 'path',
      sessionSource: 'herdr:pi',
    },
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: async () => ({ serverId: '47:1', enabled: enabled(), targets: 'all', autoApprove: true }),
    signal,
  });
  attempts.push(attempt);
  return attempt;
}
function worker(root: string, pane: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./herdr-admission-worker.ts', import.meta.url))], {
    env: { ...process.env, ADMISSION_TEST_ROOT: root, ADMISSION_TEST_PANE: pane },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const contended = deferred<void>();
  let stdout = '',
    stderr = '';
  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk);
    if (stdout.includes('contended\n')) contended.resolve();
  });
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`admission worker exited ${code}: ${stderr}`));
      else resolve();
    });
  });
  void closed.catch(() => {});
  children.push({ child, closed: closed.catch(() => {}) });
  return { contended: contended.promise, closed, stdout: () => stdout };
}

test('simultaneous stop processes for distinct panes both reach one admitted effect', async () => {
  const { root, directory } = await fixture();
  const held = await hold(directory);
  const a = worker(root, 'w27'),
    b = worker(root, 'w1M');
  await within(Promise.all([a.contended, b.contended]));
  held.release();
  await within(Promise.all([held.done, a.closed, b.closed]));
  for (const child of [a, b]) {
    const result = JSON.parse(child.stdout().trim().split('\n').at(-1)!);
    assert.equal(result.admitted, true, child.stdout());
    assert.equal(result.result, 'finished');
  }
  assert.deepEqual((await readFile(join(root, 'effects'), 'utf8')).trim().split('\n').sort(), ['w1M', 'w27']);
});

test('temporary control contention does not replay an admitted effect', async () => {
  const { root, directory } = await fixture();
  const observed = observedState(root);
  const attempt = start(observed.state);
  const authority = await attempt.ready;
  assert.ok(authority);
  const held = await hold(directory);
  let effects = 0;
  const dispatching = authority.dispatch('recovery', async () => {
    effects++;
  });
  const settled = dispatching.then(
    () => 'sent',
    () => 'refused',
  );
  await within(observed.contended);
  held.release();
  await within(held.done);
  assert.equal(await within(settled), 'sent');
  assert.equal(effects, 1);
});

test('an aborted admission wait stops while the competing guard remains held', async () => {
  const { root, directory } = await fixture();
  const held = await hold(directory);
  const observed = observedState(root);
  const abort = new AbortController();
  const attempt = start(observed.state, abort.signal);
  await within(observed.contended);
  abort.abort();
  assert.equal(await within(attempt.ready, 500), null);
  assert.equal(await within(attempt.finish(), 500), 'stopped');
  held.release();
  await within(held.done);
  assert.equal(
    await observed.state.binding({
      serverId: '47:1',
      agent: 'pi',
      sessionId: '/tmp/admission.jsonl',
      sessionKind: 'path',
      sessionSource: 'herdr:pi',
    }),
    null,
  );
});

test('permission revoked during a contended capture cannot publish a workflow', async () => {
  const { root, directory } = await fixture();
  const held = await hold(directory);
  const observed = observedState(root);
  let enabled = true;
  const attempt = start(observed.state, undefined, () => enabled);
  await within(observed.contended);
  enabled = false;
  held.release();
  await within(held.done);
  assert.equal(await within(attempt.ready), null);
});

test('a missing-control capture cannot gain authority from an independent first pause and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-admission-first-pause-'));
  roots.push(root);
  const entered = deferred<void>();
  const publishPause = deferred<void>();
  const retryGate = deferred<void>();
  let first = true;
  const admin = new WorkflowState(root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (first && path.endsWith('control-guard')) {
          first = false;
          entered.resolve();
          await publishPause.promise;
        }
        return handle;
      },
    },
  });
  const pausing = admin.pause('47:1');
  try {
    await within(entered.promise);
    const observed = observedState(root, retryGate.promise);
    const attempt = start(observed.state);
    await within(observed.contended);
    publishPause.resolve();
    assert.equal(await within(pausing), 'paused');
    assert.equal(await admin.resume('47:1', true), 'resumed');
    retryGate.resolve();
    const authority = await within(attempt.ready);
    let effects = 0;
    if (authority)
      await authority.dispatch('recovery', async () => {
        effects++;
      });
    assert.equal(effects, 0);
    assert.equal(authority, null);
  } finally {
    publishPause.resolve();
    retryGate.resolve();
    await pausing;
  }
});

test('a contended capture cannot adopt a pause/resume successor epoch', async () => {
  const { root, directory } = await fixture();
  const held = await hold(directory);
  const observed = observedState(root);
  const attempt = start(observed.state);
  await within(observed.contended);
  // Model an independent administrator publishing both transitions while it owns the guard.
  await writePrivateJson(join(directory, 'control.json'), { protocol: 1, epoch: randomUUID(), mode: 'paused' });
  await writePrivateJson(join(directory, 'control.json'), { protocol: 1, epoch: randomUUID(), mode: 'open' });
  held.release();
  await within(held.done);
  assert.equal(await within(attempt.ready), null);
});

test('a contended effect loses permission before invocation without replay', async () => {
  const { root, directory } = await fixture();
  const observed = observedState(root);
  let enabled = true;
  const authority = await start(observed.state, undefined, () => enabled).ready;
  assert.ok(authority);
  const held = await hold(directory);
  let effects = 0;
  const settled = authority
    .dispatch('recovery', async () => {
      effects++;
    })
    .then(
      () => 'sent',
      () => 'refused',
    );
  await within(observed.contended);
  enabled = false;
  held.release();
  await within(held.done);
  assert.equal(await within(settled), 'refused');
  assert.equal(effects, 0);
});

test('an aborted effect wait cannot invoke after the competing guard is released', async () => {
  const { root, directory } = await fixture();
  const observed = observedState(root);
  const abort = new AbortController();
  const authority = await start(observed.state, abort.signal).ready;
  assert.ok(authority);
  const held = await hold(directory);
  let effects = 0;
  const settled = authority
    .dispatch('recovery', async () => {
      effects++;
    })
    .then(
      () => 'sent',
      () => 'refused',
    );
  await within(observed.contended);
  abort.abort();
  assert.equal(await within(settled, 500), 'refused');
  held.release();
  await within(held.done);
  assert.equal(effects, 0);
});

test('an effect waiting across pause and resume cannot adopt the successor epoch', async () => {
  const { root, directory } = await fixture();
  const observed = observedState(root);
  const authority = await start(observed.state).ready;
  assert.ok(authority);
  const held = await hold(directory);
  let effects = 0;
  const settled = authority
    .dispatch('recovery', async () => {
      effects++;
    })
    .then(
      () => 'sent',
      () => 'refused',
    );
  await within(observed.contended);
  await writePrivateJson(join(directory, 'control.json'), { protocol: 1, epoch: randomUUID(), mode: 'paused' });
  await writePrivateJson(join(directory, 'control.json'), { protocol: 1, epoch: randomUUID(), mode: 'open' });
  held.release();
  await within(held.done);
  assert.equal(await within(settled), 'refused');
  assert.equal(effects, 0);
});

test('persistent contention is bounded and never removes the competing guard', async () => {
  const { root, directory } = await fixture();
  const held = await hold(directory);
  const guard = join(directory, 'control-guard');
  const original = await lstat(guard);
  const observed = observedState(root);
  const attempt = start(observed.state);
  assert.equal(await within(attempt.ready, 6_000), null);
  assert.equal(await attempt.finish(), 'not_admitted');
  assert.ok(observed.conflicts() > 1);
  const retained = await lstat(guard);
  assert.equal(retained.dev, original.dev);
  assert.equal(retained.ino, original.ino);
  held.release();
  await within(held.done);
});

test('waiting retains the original parent identity across acquisition attempts', async () => {
  const { root } = await fixture();
  const directory = join(root, 'parent');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'guard'), '', { mode: 0o600 });
  const contended = deferred<void>();
  const replaced = deferred<void>();
  let effects = 0;
  const waiting = withPrivateGuard(
    directory,
    'guard',
    async () => {
      effects++;
    },
    {
      io: {
        open: async (path, flags, mode) => {
          try {
            return await open(path, flags, mode);
          } catch (error) {
            contended.resolve();
            await replaced.promise;
            throw error;
          }
        },
      },
    },
    { deadline: performance.now() + 2000, open: () => true },
  );
  const refused = assert.rejects(waiting, /unsafe private workflow metadata/);
  void refused.catch(() => {});
  try {
    await within(contended.promise);
    await rename(directory, `${directory}.original`);
    await mkdir(directory, { mode: 0o700 });
  } finally {
    replaced.resolve();
  }
  await within(refused);
  assert.equal(effects, 0);
  assert.equal(await readFile(join(`${directory}.original`, 'guard'), 'utf8'), '');
});

test('unsafe control guards are refused without retry or deletion', async () => {
  const { root, directory } = await fixture();
  const foreign = join(root, 'foreign');
  await writeFile(foreign, 'retain', { mode: 0o600 });
  await symlink(foreign, join(directory, 'control-guard'));
  const observed = observedState(root);
  assert.equal(await within(start(observed.state).ready), null);
  assert.equal(observed.conflicts(), 1);
  assert.equal(await readFile(foreign, 'utf8'), 'retain');
});
