import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, rm, readdir, rename, lstat, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginWorkflow, reserveJobSlot, type WorkflowAttempt } from '../src/herdr-adapter/authority.ts';
import { WorkflowState, type WorkflowScope, type RuntimePermission } from '../src/herdr-adapter/workflow-state.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { deferred, withinWorkflow as within } from './herdr-lease-helpers.ts';

const scope: WorkflowScope = {
  serverId: '47:1',
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
const permission = async (): Promise<RuntimePermission> => ({
  serverId: '47:1',
  enabled: true,
  targets: 'all',
  autoApprove: false,
});
const episode: Episode = {
  pane_id: 'w1:p1',
  session_id: 's1',
  failure_episode_id: 'a'.repeat(64),
  error_evidence_digest: 'b'.repeat(64),
  first_observed_at: '2026-10-05T00:00:00Z',
  attempt_count: 0,
  last_attempt_at: null,
  quota_check_count: 0,
  last_quota_check_at: null,
  next_check_at: '2026-10-05T00:05:00Z',
  last_delivery_state: 'none',
};
const start = (state: WorkflowState, selected = scope, read = permission) =>
  beginWorkflow({
    state,
    scope: selected,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: read,
    signal: new AbortController().signal,
  });
const serverHash = createHash('sha256')
  .update(JSON.stringify(['47:1']))
  .digest('hex');
const scopeHash = createHash('sha256')
  .update(JSON.stringify(['47:1', 'agy', 's1']))
  .digest('hex');
async function pending(
  state: WorkflowState,
  selected: WorkflowScope,
  auth: NonNullable<Awaited<WorkflowAttempt['ready']>>,
) {
  await new EpisodeStore(state.directory).recordSessionRetry(selected.agent, selected.sessionId, {
    ...episode,
    session_id: selected.sessionId,
  });
  const binding = await state.binding(selected);
  assert.ok(binding);
  await state.recordBinding({
    ...binding,
    epoch: auth.ticket.epoch,
    generation: auth.generation,
    phase: 'pending',
    failureEpisodeId: episode.failure_episode_id,
  });
}

test('owner renews generation and occupied slot single-flight; closure bypasses held heartbeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-renewal-'));
  let clock = 10000,
    hold = false,
    beat = () => {};
  const generationRenewed = deferred<void>(),
    slotRenewed = deferred<void>(),
    entered = deferred<void>(),
    resume = deferred<void>();
  let competingDuringHold = 0,
    heldTickStarted = false;
  const state = new WorkflowState(root, () => clock, {
    io: {
      rename: async (from, to) => {
        if (hold && to.includes('/workflows/') && to.endsWith('/heartbeat.json')) {
          heldTickStarted = true;
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
        if (to.endsWith('/heartbeat.json') && JSON.parse(await readFile(to, 'utf8')).heartbeat === 20000) {
          if (to.includes('/workflows/')) generationRenewed.resolve();
          if (to.includes('/capacity/')) slotRenewed.resolve();
        }
      },
    },
  });
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission,
    signal: new AbortController().signal,
    scheduleHeartbeat: (tick) => {
      beat = () => {
        if (hold) competingDuringHold++;
        tick();
      };
      return () => {
        beat = () => {};
      };
    },
  });
  let slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    slot = reserveJobSlot(state, auth);
    const job = await slot.ready;
    assert.ok(job);
    clock = 20000;
    beat();
    await within(Promise.all([generationRenewed.promise, slotRenewed.promise]));
    const generationPath = join(root, 'workflows', scopeHash, 'scheduler-lease', 'generations', auth.generation);
    assert.equal(JSON.parse(await readFile(join(generationPath, 'heartbeat.json'), 'utf8')).heartbeat, 20000);
    const capacity = state.capacity('47:1', 0),
      selected = await capacity.inspect();
    assert.equal(selected.kind, 'selected');
    if (selected.kind === 'selected') assert.equal(selected.heartbeat.heartbeat, 20000);
    hold = true;
    await within(
      (async () => {
        while (!heldTickStarted) {
          beat();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await entered.promise;
      })(),
    );
    const heldHeartbeat = JSON.parse(await readFile(join(generationPath, 'heartbeat.json'), 'utf8')).heartbeat;
    const invoked = competingDuringHold;
    beat();
    beat();
    assert.equal(competingDuringHold, invoked + 2);
    assert.equal(JSON.parse(await readFile(join(generationPath, 'heartbeat.json'), 'utf8')).heartbeat, heldHeartbeat);
    attempt.close();
    assert.equal(await within(attempt.finish()), 'stopped');
    assert.equal(await job.valid(), false);
    assert.equal(await auth.valid(), false);
    resume.resolve();
    assert.equal(await state.lease(scope).leaseMatches(auth.generation, JSON.stringify(['47:1', 'agy', 's1'])), false);
  } finally {
    resume.resolve();
    slot?.close();
    await slot?.finish();
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const change of [{ serverId: '47:2' }, { enabled: false }, { targets: [] }, { autoApprove: true }]) {
  test(`captured permission snapshot rejects ${Object.keys(change)[0]} changes irreversibly`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-permission-'));
    let current: RuntimePermission = await permission();
    const attempt = start(new WorkflowState(root), scope, async () => current);
    try {
      const auth = await attempt.ready;
      assert.ok(auth);
      current = { ...current, ...change };
      assert.equal(await auth.valid(), false);
      current = await permission();
      assert.equal(await auth.valid(), false);
      assert.equal(auth.signal.aborted, true);
    } finally {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [index, selected] of [
  { ...scope, serverId: ' 47:1' },
  { ...scope, sessionId: 's\u0000x' },
  { ...scope, sessionId: 'x'.repeat(257) },
  { ...scope, agent: 'other' },
  { ...scope, sessionSource: 'integration:agy' },
  { ...scope, sessionKind: 'path' },
].entries()) {
  test(`unsafe/non-native scope case ${index} is denied before any metadata`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-scope-'));
    const attempt = start(new WorkflowState(root), selected);
    try {
      assert.equal(await attempt.ready, null);
      assert.deepEqual(await readdir(root), []);
    } finally {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('abort queued after final generation confirmation cannot publish a closed ready authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-final-admission-'));
  const ctrl = new AbortController();
  let queued = false;
  const lookup = join(
    root,
    'automation',
    serverHash,
    'panes',
    createHash('sha256')
      .update(JSON.stringify(['w1:p1']))
      .digest('hex') + '.json',
  );
  const state = new WorkflowState(root, undefined, {
    alive: (pid) => {
      if (!queued && existsSync(lookup)) {
        queued = true;
        // Queue the external abort between proof completion and its caller's
        // continuation, rather than substituting a mocked authorization result.
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => ctrl.abort())));
      }
      return pid === process.pid;
    },
  });
  const attempt = beginWorkflow({ state, scope, paneId: 'w1:p1', workspaceId: 'w1', permission, signal: ctrl.signal });
  try {
    assert.equal(await attempt.ready, null);
    assert.equal(ctrl.signal.aborted, true);
    assert.equal(await attempt.finish(), 'stopped');
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('close before permission resolves prevents late generation publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-authority-'));
  const pending = deferred<RuntimePermission | null>();
  const state = new WorkflowState(root);
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: () => pending.promise,
    signal: new AbortController().signal,
  });
  try {
    attempt.close();
    pending.resolve(await permission());
    assert.equal(await within(attempt.ready), null);
    assert.equal(await within(attempt.finish()), 'stopped');
    assert.equal(await state.binding(scope), null);
    assert.deepEqual(await readdir(root), []);
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('same-scope reader captures G once; different session owns independently; reader never adopts H', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-authority-'));
  const a = new WorkflowState(root),
    b = new WorkflowState(root);
  const attempts: WorkflowAttempt[] = [];
  try {
    const first = start(a);
    attempts.push(first);
    const g = await within(first.ready);
    assert.ok(g);
    assert.equal(g.ownsGeneration, true);
    const duplicate = start(b);
    attempts.push(duplicate);
    const reader = await within(duplicate.ready);
    assert.ok(reader);
    assert.equal(reader.ownsGeneration, false);
    assert.equal(reader.generation, g.generation);
    const other = start(b, { ...scope, sessionId: 's2' });
    attempts.push(other);
    assert.equal((await within(other.ready))?.ownsGeneration, true);
    assert.equal(await first.finish(), 'finished');
    const successor = start(a);
    attempts.push(successor);
    const h = await within(successor.ready);
    assert.ok(h);
    assert.notEqual(h.generation, g.generation);
    assert.equal(await reader.valid(), false);
    assert.equal(reader.signal.aborted, true);
    assert.equal(await reader.valid(), false);
    assert.equal(await h.valid(), true);
  } finally {
    for (const attempt of attempts) {
      attempt.close();
      await attempt.finish();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a duplicate observing view indexes its pane without replacing the originating owner binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-observing-reader-'));
  const a = new WorkflowState(root),
    b = new WorkflowState(root);
  const owner = start(a);
  let duplicate: WorkflowAttempt | undefined;
  try {
    const auth = await owner.ready;
    assert.ok(auth);
    const before = await a.binding(scope);
    assert.ok(before);
    duplicate = beginWorkflow({
      state: b,
      scope,
      paneId: 'w2:p2',
      workspaceId: 'w2',
      permission,
      signal: new AbortController().signal,
    });
    assert.equal((await duplicate.ready)?.ownsGeneration, false);
    assert.deepEqual(await a.binding(scope), before);
    assert.deepEqual(await b.locate('47:1', 'w2:p2'), scope);
    await pending(a, scope, auth);
    const slot = reserveJobSlot(a, auth);
    assert.ok(await slot.ready);
    await slot.finish();
  } finally {
    duplicate?.close();
    await duplicate?.finish();
    owner.close();
    await owner.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed current permission is monotonic even when reenabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-authority-'));
  let enabled = true;
  const attempt = start(new WorkflowState(root), scope, async () => ({ ...(await permission()), enabled }));
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    enabled = false;
    assert.equal(await auth.valid(), false);
    enabled = true;
    assert.equal(await auth.valid(), false);
    assert.equal(auth.admissionOpen(), false);
    assert.equal(await attempt.finish(), 'stopped');
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('synthetic credential identifiers create no binding or input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-authority-'));
  const attempt = start(new WorkflowState(root), { ...scope, sessionId: 'sk-' + 'x'.repeat(30) });
  try {
    assert.equal(await attempt.ready, null);
    assert.equal(await attempt.finish(), 'not_admitted');
    assert.deepEqual(await readdir(root), []);
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('eight server capacity leases refuse ninth; reader consumes none; released slot is reusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-capacity-'));
  const a = new WorkflowState(root),
    b = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const attempts: WorkflowAttempt[] = [];
  const slots: ReturnType<typeof reserveJobSlot>[] = [];
  try {
    for (let i = 0; i < 9; i++) {
      const selected = { ...scope, sessionId: `s${i}` };
      const attempt = start(i % 2 ? a : b, selected);
      attempts.push(attempt);
      const auth = await within(attempt.ready);
      assert.ok(auth);
      await episodes.recordSessionRetry('agy', selected.sessionId, { ...episode, session_id: selected.sessionId });
      const binding = await a.binding(selected);
      assert.ok(binding);
      await a.recordBinding({ ...binding, phase: 'pending', failureEpisodeId: episode.failure_episode_id });
      const slot = reserveJobSlot(i % 2 ? a : b, auth);
      slots.push(slot);
      const admitted = await within(slot.ready, 3000);
      if (i < 8) {
        assert.ok(admitted);
        assert.equal(await admitted.valid(), true);
      } else assert.equal(admitted, null);
    }
    const duplicate = start(b, { ...scope, sessionId: 's0' });
    attempts.push(duplicate);
    const reader = await duplicate.ready;
    assert.ok(reader);
    assert.equal(reader.ownsGeneration, false);
    const denied = reserveJobSlot(b, reader);
    slots.push(denied);
    assert.equal(await denied.ready, null);
    assert.equal(await slots[0]!.finish(), 'finished');
    const auth = await attempts[8]!.ready;
    assert.ok(auth);
    const wrongState = reserveJobSlot(a, auth);
    slots.push(wrongState);
    assert.equal(await wrongState.ready, null);
    const replacement = reserveJobSlot(b, auth);
    slots.push(replacement);
    assert.ok(await replacement.ready);
  } finally {
    for (const slot of slots) {
      slot.close();
      await slot.finish();
    }
    for (const attempt of attempts) {
      attempt.close();
      await attempt.finish();
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test('one generation cannot reserve duplicate capacity while its first acquisition is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-duplicate-slot-'));
  const entered = deferred<void>(),
    release = deferred<void>();
  let hold = true;
  const state = new WorkflowState(root, undefined, {
    io: {
      rename: async (from, to) => {
        if (hold && to.includes('/capacity/') && to.endsWith('/active.json')) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        await rename(from, to);
      },
    },
  });
  const attempt = start(state);
  let first: ReturnType<typeof reserveJobSlot> | undefined, duplicate: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    first = reserveJobSlot(state, auth);
    await within(entered.promise);
    duplicate = reserveJobSlot(state, auth);
    assert.equal(await within(duplicate.ready), null);
    release.resolve();
    assert.ok(await within(first.ready));
  } finally {
    release.resolve();
    if (first) {
      first.close();
      await first.finish();
      await first.ready;
    }
    if (duplicate) {
      duplicate.close();
      await duplicate.finish();
    }
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ['generation', 'capacity'] as const) {
  test(`close revokes held ${kind} publication without joining ready or starting another slot`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-held-'));
    const entered = deferred<void>(),
      resume = deferred<void>();
    let hold = true;
    const state = new WorkflowState(root, undefined, {
      io: {
        rename: async (from, to) => {
          if (
            hold &&
            to.endsWith('/active.json') &&
            to.includes(kind === 'generation' ? '/workflows/' : '/capacity/')
          ) {
            hold = false;
            entered.resolve();
            await resume.promise;
          }
          await rename(from, to);
        },
      },
    });
    const other = new WorkflowState(root);
    const attempt = start(state);
    let slot: ReturnType<typeof reserveJobSlot> | undefined;
    try {
      if (kind === 'capacity') {
        const auth = await attempt.ready;
        assert.ok(auth);
        await pending(state, scope, auth);
        slot = reserveJobSlot(state, auth);
      }
      await within(entered.promise);
      attempt.close();
      assert.equal(attempt.signal.aborted, true);
      assert.equal(await within(attempt.finish()), 'stopped');
      if (slot) assert.equal(await within(slot.finish()), 'stopped');
      const dir =
        kind === 'generation'
          ? join(root, 'workflows', scopeHash)
          : join(root, 'automation', serverHash, 'capacity', '0');
      const generations = await readdir(join(dir, 'scheduler-lease', 'generations'));
      assert.equal(generations.length, 1);
      assert.equal(
        (await lstat(join(dir, 'scheduler-lease', 'generations', generations[0]!, 'released'))).isDirectory(),
        true,
      );
      assert.equal((await lstat(join(dir, 'takeover-guard'))).isFile(), true);
      if (kind === 'capacity') assert.deepEqual(await readdir(join(root, 'automation', serverHash, 'capacity')), ['0']);
      resume.resolve();
      assert.equal(slot ? await within(slot.ready) : await within(attempt.ready), null);
      if (kind === 'generation')
        assert.equal(await other.lease(scope).activeToken(JSON.stringify(['47:1', 'agy', 's1'])), null);
      else
        assert.equal(
          await other.capacity('47:1', 0).activeToken(JSON.stringify([scopeHash, (await attempt.ready)!.generation])),
          null,
        );
    } finally {
      resume.resolve();
      await attempt.ready;
      if (slot) {
        slot.close();
        await slot.finish();
        await slot.ready;
      }
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('closing starts one five-second budget for held generation and capacity release before finish is awaited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-budget-'));
  const held = deferred<void>(),
    resume = deferred<void>();
  const expired: (() => void)[] = [];
  let hold = false;
  const state = new WorkflowState(root, undefined, {
    io: {
      mkdir: async (path, options) => {
        if (hold && path.endsWith('/released')) {
          held.resolve();
          await resume.promise;
        }
        await mkdir(path, options);
      },
    },
  });
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission,
    signal: new AbortController().signal,
    shutdownDeadline: (ms, expire) => {
      assert.equal(ms, 5000);
      expired.push(expire);
      return () => {};
    },
  });
  let slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    slot = reserveJobSlot(state, auth);
    assert.ok(await slot.ready);
    hold = true;
    attempt.close();
    await within(held.promise);
    assert.equal(auth.admissionOpen(), false);
    assert.ok(expired.length > 0);
    expired[0]!();
    assert.equal(await within(attempt.finish()), 'shutdown_incomplete');
    assert.equal(await auth.valid(), false);
    resume.resolve();
    await slot.finish();
    assert.equal(await attempt.finish(), 'shutdown_incomplete');
  } finally {
    resume.resolve();
    if (slot) {
      slot.close();
      await slot.finish();
    }
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const variant of ['expired-dead', 'released-live', 'expired-live', 'unknown', 'corrupt', 'guard'] as const) {
  test(`scoped takeover ${variant} retains the lease protocol`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-takeover-'));
    let clock = 10000;
    const state = new WorkflowState(root, () => clock);
    const lease = state.lease(scope);
    const token = await lease.acquire(JSON.stringify(['47:1', 'agy', 's1']));
    assert.ok(token);
    const dir = join(root, 'workflows', scopeHash),
      generation = join(dir, 'scheduler-lease', 'generations', token);
    try {
      const ticket = await state.capture('47:1', true);
      assert.ok(ticket);
      await state.recordBinding({
        protocol: 1,
        scope,
        epoch: ticket.epoch,
        generation: token,
        paneId: 'w1:p1',
        workspaceId: 'w1',
        historyPaneId: 'w1:p1',
        failureEpisodeId: null,
        phase: 'observing',
        reason: null,
      });
      if (variant === 'released-live') await lease.release(token);
      if (variant === 'guard') await writeFile(join(dir, 'takeover-guard'), '', { mode: 0o600 });
      if (variant === 'corrupt') await writeFile(join(dir, 'scheduler-lease', 'active.json'), '{}', { mode: 0o600 });
      if (variant.startsWith('expired') || variant === 'unknown') clock = 30000;
      if (variant === 'expired-dead' || variant === 'unknown') {
        const identity = JSON.parse(await readFile(join(generation, 'owner.json'), 'utf8')) as { pid: number };
        identity.pid = 4242;
        await writeFile(join(generation, 'owner.json'), JSON.stringify(identity), { mode: 0o600 });
        await writeFile(join(dir, 'scheduler-lease', 'active.json'), JSON.stringify(identity), { mode: 0o600 });
      }
      const challenger = new WorkflowState(root, () => clock, {
        alive: (pid) => (pid === 4242 ? (variant === 'expired-dead' ? false : null) : true),
      });
      const attempt = start(challenger);
      try {
        const auth = await attempt.ready;
        if (variant === 'expired-dead' || variant === 'released-live') {
          assert.ok(auth);
          assert.equal(auth.ownsGeneration, true);
          assert.notEqual(auth.generation, token);
        } else if (variant === 'guard') {
          assert.ok(auth);
          assert.equal(auth.ownsGeneration, false);
          assert.equal(auth.generation, token);
        } else assert.equal(auth, null);
      } finally {
        attempt.close();
        await attempt.finish();
      }
      if (variant === 'expired-dead') {
        // The unchanged bounded collector may remove a proven-dead generation.
        assert.equal(await challenger.lease(scope).leaseMatches(token, JSON.stringify(['47:1', 'agy', 's1'])), false);
      } else if (variant === 'released-live')
        assert.equal((await lstat(join(generation, 'released'))).isDirectory(), true);
      else assert.equal((await readFile(join(generation, 'owner.json'), 'utf8')).includes(token), true);
    } finally {
      await lease.release(token).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const variant of ['live', 'corrupt', 'guard'] as const) {
  test(`old global ${variant} owner blocks new scoped orchestration`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-old-global-'));
    const old = new EpisodeStore(root);
    const token = await old.acquire('old-server');
    assert.ok(token);
    let attempt: WorkflowAttempt | undefined;
    try {
      if (variant === 'corrupt') await writeFile(join(root, 'scheduler-lease', 'active.json'), '{}', { mode: 0o600 });
      if (variant === 'guard') {
        await old.release(token);
        await writeFile(join(root, 'takeover-guard'), '', { mode: 0o600 });
      }
      attempt = start(new WorkflowState(root));
      assert.equal(await attempt.ready, null);
      assert.equal(await new WorkflowState(root).binding(scope), null);
    } finally {
      attempt?.close();
      await attempt?.finish();
      await old.release(token).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a linked capacity ancestor cannot validate or confirm slot release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-capacity-layout-'));
  const state = new WorkflowState(root),
    attempt = start(state);
  let slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    slot = reserveJobSlot(state, auth);
    const job = await slot.ready;
    assert.ok(job);
    const capacity = join(root, 'automation', serverHash, 'capacity');
    await rename(capacity, capacity + '-original');
    await symlink(capacity + '-original', capacity);
    assert.equal(await job.valid(), false);
    assert.equal(await slot.finish(), 'shutdown_incomplete');
  } finally {
    slot?.close();
    await slot?.finish();
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('eight expired live/stranded capacity slots refuse admission without changing any owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-stranded-capacity-'));
  let clock = 10000;
  const state = new WorkflowState(root, () => clock);
  const owned: { index: number; token: string; selector: string }[] = [];
  let attempt: WorkflowAttempt | undefined, slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    assert.ok(await state.capture('47:1', true));
    for (let index = 0; index < 8; index++) {
      const capacity = state.capacity('47:1', index);
      const token = await capacity.acquire(JSON.stringify([scopeHash, '11111111-1111-4111-8111-111111111111']));
      assert.ok(token);
      owned.push({
        index,
        token,
        selector: await readFile(join(capacity.directory, 'scheduler-lease', 'active.json'), 'utf8'),
      });
    }
    const guard = join(state.capacity('47:1', 0).directory, 'takeover-guard');
    await writeFile(guard, '', { mode: 0o600 });
    clock = 30000;
    attempt = start(state);
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    slot = reserveJobSlot(state, auth);
    assert.equal(await slot.ready, null);
    assert.equal(await slot.finish(), 'not_admitted');
    for (const owner of owned)
      assert.equal(
        await readFile(join(state.capacity('47:1', owner.index).directory, 'scheduler-lease', 'active.json'), 'utf8'),
        owner.selector,
      );
    assert.equal((await lstat(guard)).isFile(), true);
  } finally {
    slot?.close();
    await slot?.finish();
    attempt?.close();
    await attempt?.finish();
    for (const owner of owned) await state.capacity('47:1', owner.index).release(owner.token);
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown occupied capacity session is not reclaimed even when expired and proven dead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-unknown-slot-'));
  let clock = 10000;
  const state = new WorkflowState(root, () => clock, { alive: (pid) => (pid === 4242 ? false : true) });
  assert.ok(await state.capture('47:1', true));
  const capacity = state.capacity('47:1', 0);
  const token = await capacity.acquire('unrecognized-layout');
  assert.ok(token);
  const dir = join(root, 'automation', serverHash, 'capacity', '0', 'scheduler-lease');
  const ownerPath = join(dir, 'generations', token, 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };
  owner.pid = 4242;
  await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  await writeFile(join(dir, 'active.json'), JSON.stringify(owner), { mode: 0o600 });
  clock = 30000;
  const attempt = start(state);
  let slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    slot = reserveJobSlot(state, auth);
    assert.equal(await slot.ready, null);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'active.json'), 'utf8')), owner);
    assert.equal(await lstat(join(dir, 'generations', token, 'owner.json')).then(() => true), true);
  } finally {
    slot?.close();
    await slot?.finish();
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const role of ['owner', 'reader'] as const) {
  test(`removing an established binding fails closed for ${role} and cannot revive`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-missing-binding-'));
    const a = new WorkflowState(root),
      b = new WorkflowState(root);
    const owner = start(a);
    const attempts: WorkflowAttempt[] = [owner];
    try {
      const first = await owner.ready;
      assert.ok(first);
      let auth = first;
      if (role === 'reader') {
        const duplicate = start(b);
        attempts.push(duplicate);
        const reader = await duplicate.ready;
        assert.ok(reader);
        assert.equal(reader.ownsGeneration, false);
        auth = reader;
      }
      const path = join(root, 'workflows', scopeHash, 'binding.json');
      const saved = await readFile(path, 'utf8');
      assert.equal(await auth.valid(), true);
      await rm(path);
      assert.equal(await auth.valid(), false);
      assert.equal(auth.signal.aborted, true);
      await writeFile(path, saved, { mode: 0o600 });
      assert.equal(await auth.valid(), false);
      assert.equal(auth.admissionOpen(), false);
    } finally {
      for (const attempt of attempts) {
        attempt.close();
        await attempt.finish();
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('late held binding publication cannot replace a newer session pane lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-late-lookup-'));
  const entered = deferred<void>(),
    resume = deferred<void>();
  let hold = true;
  const held = new WorkflowState(root, undefined, {
    io: {
      rename: async (from, to) => {
        if (hold && to.includes(`/workflows/${scopeHash}/`) && to.endsWith('/binding.json')) {
          hold = false;
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
      },
    },
  });
  const live = new WorkflowState(root);
  const first = start(held);
  const replacement = { ...scope, sessionId: 's2' };
  let second: WorkflowAttempt | undefined;
  try {
    await within(entered.promise);
    first.close();
    assert.equal(await within(first.finish()), 'stopped');
    const generations = await readdir(join(root, 'workflows', scopeHash, 'scheduler-lease', 'generations'));
    assert.equal(generations.length, 1);
    assert.equal(
      (
        await lstat(join(root, 'workflows', scopeHash, 'scheduler-lease', 'generations', generations[0]!, 'released'))
      ).isDirectory(),
      true,
    );
    second = start(live, replacement);
    const successor = await within(second.ready);
    assert.ok(successor);
    assert.equal(successor.ownsGeneration, true);
    assert.deepEqual(await live.locate('47:1', 'w1:p1'), replacement);
    resume.resolve();
    assert.equal(await within(first.ready), null);
    assert.deepEqual(await live.locate('47:1', 'w1:p1'), replacement);
  } finally {
    resume.resolve();
    await first.ready;
    second?.close();
    await second?.finish();
    first.close();
    await first.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal reconciliation while slot publication is held cannot promote a job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-terminal-slot-'));
  const entered = deferred<void>(),
    resume = deferred<void>();
  let hold = true;
  const state = new WorkflowState(root, undefined, {
    io: {
      rename: async (from, to) => {
        if (hold && to.includes('/capacity/') && to.endsWith('/active.json')) {
          hold = false;
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
      },
    },
  });
  const attempt = start(state);
  let slot: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    await pending(state, scope, auth);
    slot = reserveJobSlot(state, auth);
    await within(entered.promise);
    const binding = await state.binding(scope);
    assert.ok(binding);
    await state.recordBinding({ ...binding, phase: 'terminal', reason: 'human' });
    resume.resolve();
    assert.equal(await slot.ready, null);
  } finally {
    resume.resolve();
    slot?.close();
    await slot?.finish();
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});
