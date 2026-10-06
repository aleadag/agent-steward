import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPrivateGuard } from '../src/herdr-adapter/private-files.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { WorkflowState, type WorkflowScope } from '../src/herdr-adapter/workflow-state.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

const scope: WorkflowScope = {
  serverId: '47:1',
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
const episode: Episode = {
  pane_id: 'w1:p1',
  session_id: 's1',
  failure_episode_id: 'a'.repeat(64),
  error_evidence_digest: 'b'.repeat(64),
  first_observed_at: '2026-10-05T00:00:00Z',
  attempt_count: 1,
  last_attempt_at: '2026-10-05T00:01:00Z',
  quota_check_count: 2,
  last_quota_check_at: '2026-10-05T00:02:00Z',
  next_check_at: '2099-01-01T00:00:00Z',
  last_delivery_state: 'none',
};
const human: Episode = { ...episode, last_delivery_state: 'human', next_check_at: null };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'steward-epoch-admission-'));
  const state = new WorkflowState(root);
  const ticket = await state.capture(scope.serverId, true);
  assert.ok(ticket);
  await new EpisodeStore(root).recordSessionRetry(scope.agent, scope.sessionId, episode);
  const control = join(root, 'automation', createHash('sha256').update('["47:1"]').digest('hex'), 'control.json');
  const guard = join(control, '..', 'control-guard');
  const canonical = join(root, `retry-session-${createHash('sha256').update('["agy","s1"]').digest('hex')}.json`);
  return { root, ticket, control, guard, canonical };
}

// An actual independent process: local closed/revoked sets cannot satisfy this test.
async function pauseProcess(root: string) {
  const stateModule = fileURLToPath(new URL('../src/herdr-adapter/workflow-state.ts', import.meta.url));
  const entryModule = fileURLToPath(new URL('../src/herdr-adapter/entry.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '--eval',
      `import { WorkflowState } from ${JSON.stringify(stateModule)};
       import { reportWorkflowResult } from ${JSON.stringify(entryModule)};
       const result = await new WorkflowState(${JSON.stringify(root)}).pause('47:1');
       reportWorkflowResult(result, { write: text => process.stderr.write(text), fail: () => { process.exitCode = 1; } });
       console.log(result);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    return { code: await within(closed, 2_000), stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
}

// Removing shared exclusion lets pause confirm while real parsed control is still held.
// This is WorkflowState.read's final layout await, NOT a held positive matches result.
test('epoch admission: raw control held across final layout makes cross-process pause truthfully incomplete', async () => {
  const f = await fixture();
  const entered = deferred<void>(),
    resume = deferred<void>();
  let controlRead = false,
    held = false,
    writes = 0;
  const writer = new WorkflowState(f.root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path === f.control) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            controlRead = true;
          };
        }
        if (path.startsWith(`${f.canonical}.`) && path.endsWith('.tmp')) writes++;
        return handle;
      },
      lstat: async (path) => {
        const info = await lstat(path);
        if (path === f.root && controlRead && !held) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
        return info;
      },
    },
  });
  const before = await readFile(f.canonical, 'utf8');
  const beforeControl = await readFile(f.control, 'utf8');
  const running = writer.recordAdmittedSessionRetry(scope, f.ticket, human);
  try {
    await within(entered.promise);
    const paused = await pauseProcess(f.root);
    assert.equal(paused.stdout, 'shutdown_incomplete\n');
    assert.equal(paused.code, 1);
    assert.equal(paused.stderr, 'agent-steward: release unconfirmed; shutdown incomplete. Human review required.\n');
    assert.equal((await lstat(f.guard)).mode & 0o777, 0o600);
    assert.equal(await readFile(f.control, 'utf8'), beforeControl);
    assert.equal(writes, 0);
    assert.equal(await readFile(f.canonical, 'utf8'), before);
    resume.resolve();
    assert.equal(await within(running), true); // Incomplete is NOT durable revocation.
    assert.equal(writes, 1);
    assert.deepEqual(await new EpisodeStore(f.root).sessionRetry('agy', 's1'), human);
    assert.deepEqual(await pauseProcess(f.root), { code: 0, stdout: 'paused\n', stderr: '' });
    const settled = await readFile(f.canonical, 'utf8');
    assert.equal(await writer.recordAdmittedSessionRetry(scope, f.ticket, human), false);
    assert.equal(writes, 1);
    assert.equal(await readFile(f.canonical, 'utf8'), settled);
  } finally {
    resume.resolve();
    await running.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

// Reading before acquisition or trusting a cached epoch would admit after this confirmed pause.
test('epoch admission: confirmed pause before guard acquisition denies the canonical writer', async () => {
  const f = await fixture();
  const entered = deferred<void>(),
    resume = deferred<void>();
  let held = false,
    writes = 0;
  const writer = new WorkflowState(f.root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        if (path === f.guard && !held) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
        if (path.startsWith(`${f.canonical}.`) && path.endsWith('.tmp')) writes++;
        return open(path, flags, mode);
      },
    },
  });
  const before = await readFile(f.canonical, 'utf8');
  const running = writer.recordAdmittedSessionRetry(scope, f.ticket, human);
  try {
    await within(entered.promise);
    assert.deepEqual(await pauseProcess(f.root), { code: 0, stdout: 'paused\n', stderr: '' });
    resume.resolve();
    assert.equal(await within(running), false);
    assert.equal(writes, 0);
    assert.equal(await readFile(f.canonical, 'utf8'), before);
  } finally {
    resume.resolve();
    await running.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

// Holding the reservation across JSON IO would falsely make this pre-admitted settlement busy.
// Dropping only its pathname while leaking its publication context would instead reject the write.
test('epoch admission: pre-admitted held JSON write settles after confirmed pause without retaining control guard', async () => {
  const f = await fixture();
  const state = new WorkflowState(f.root);
  const session = JSON.stringify([scope.serverId, scope.agent, scope.sessionId]);
  const token = await state.lease(scope).acquire(session);
  assert.ok(token);
  await state.recordBinding({
    protocol: 1,
    scope,
    epoch: f.ticket.epoch,
    generation: token,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    historyPaneId: 'w1:p1',
    failureEpisodeId: episode.failure_episode_id,
    phase: 'pending',
    reason: null,
  });
  const bindingGuard = join(f.root, 'workflows', createHash('sha256').update(session).digest('hex'), 'binding-guard');
  const entered = deferred<void>(),
    resume = deferred<void>(),
    released = deferred<void>(),
    bindingReleased = deferred<void>();
  let writes = 0;
  const writer = new WorkflowState(f.root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path.startsWith(`${f.canonical}.`) && path.endsWith('.tmp')) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...args) => {
            writes++;
            entered.resolve();
            await resume.promise;
            return write(...args);
          };
        }
        return handle;
      },
      unlink: async (path) => {
        await unlink(path);
        if (path === f.guard) released.resolve();
        if (path === bindingGuard) bindingReleased.resolve();
      },
    },
  });
  const before = await readFile(f.canonical, 'utf8');
  const running = writer.recordAdmittedSessionRetry(scope, f.ticket, human, async () => {
    const binding = await writer.binding(scope);
    return binding?.generation === token && (await writer.lease(scope).leaseMatches(token, session));
  });
  try {
    await within(entered.promise);
    await within(released.promise);
    await within(bindingReleased.promise);
    assert.equal(writes, 1);
    assert.deepEqual(await pauseProcess(f.root), { code: 0, stdout: 'paused\n', stderr: '' });
    assert.equal(await readFile(f.canonical, 'utf8'), before);
    resume.resolve();
    assert.equal(await within(running), true);
    assert.deepEqual(await new EpisodeStore(f.root).sessionRetry('agy', 's1'), human);
    assert.equal(await writer.recordAdmittedSessionRetry(scope, f.ticket, human), false);
    assert.equal(writes, 1);
  } finally {
    resume.resolve();
    await running.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

// Guard identity must be verified before effect admission, not just at reservation cleanup.
test('epoch admission: replaced reservation guard denies writing even with a held open control', async () => {
  const f = await fixture();
  const entered = deferred<void>(),
    resume = deferred<void>();
  let controlRead = false,
    held = false,
    writes = 0;
  const writer = new WorkflowState(f.root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path === f.control) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            controlRead = true;
          };
        }
        if (path.startsWith(`${f.canonical}.`) && path.endsWith('.tmp')) writes++;
        return handle;
      },
      lstat: async (path) => {
        const info = await lstat(path);
        if (path === f.root && controlRead && !held) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
        return info;
      },
    },
  });
  const before = await readFile(f.canonical, 'utf8');
  const running = writer.recordAdmittedSessionRetry(scope, f.ticket, human);
  void running.catch(() => {});
  try {
    await within(entered.promise);
    await rename(f.guard, `${f.guard}.saved`);
    await writeFile(f.guard, '', { mode: 0o600 });
    resume.resolve();
    await assert.rejects(within(running), /unsafe private workflow metadata/);
    assert.equal(writes, 0);
    assert.equal(await readFile(f.canonical, 'utf8'), before);
    assert.equal((await lstat(f.guard)).mode & 0o777, 0o600);
  } finally {
    resume.resolve();
    await running.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

// The dispatch continuation must not discard pre-existing publication guards.
// A changed enclosing binding guard still prevents the pre-admitted JSON rename.
test('epoch admission: pre-admitted writer retains enclosing publication guard identity', async () => {
  const f = await fixture();
  const entered = deferred<void>(),
    resume = deferred<void>(),
    released = deferred<void>();
  const bindingGuard = join(f.root, 'binding-guard');
  const writer = new WorkflowState(f.root, undefined, {
    io: {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path.startsWith(`${f.canonical}.`) && path.endsWith('.tmp')) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...args) => {
            entered.resolve();
            await resume.promise;
            return write(...args);
          };
        }
        return handle;
      },
      unlink: async (path) => {
        await unlink(path);
        if (path === f.guard) released.resolve();
      },
    },
  });
  const before = await readFile(f.canonical, 'utf8');
  const running = withPrivateGuard(f.root, 'binding-guard', () =>
    writer.recordAdmittedSessionRetry(scope, f.ticket, human),
  );
  void running.catch(() => {});
  try {
    await within(entered.promise);
    await within(released.promise);
    await rename(bindingGuard, `${bindingGuard}.saved`);
    await writeFile(bindingGuard, '', { mode: 0o600 });
    resume.resolve();
    await assert.rejects(within(running), /unsafe private workflow metadata/);
    assert.equal(await readFile(f.canonical, 'utf8'), before);
    assert.equal((await lstat(bindingGuard)).mode & 0o777, 0o600);
  } finally {
    resume.resolve();
    await running.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});
