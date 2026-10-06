import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, rename, lstat, symlink } from 'node:fs/promises';
import { deferred, within } from './herdr-lease-helpers.ts';
import { beginWorkflow, reserveJobSlot } from '../src/herdr-adapter/authority.ts';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowState, type WorkflowScope, type WorkflowBinding } from '../src/herdr-adapter/workflow-state.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import type { ObservedStop } from '../src/herdr-adapter/observe.ts';

const scope: WorkflowScope = {
  serverId: '47:1',
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
const observation: ObservedStop = {
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  session_id: 's1',
  session_kind: 'id',
  session_source: 'herdr:antigravity_cli',
  status: 'idle',
  revision: 1,
  state_change_seq: 1,
  context: 'API error',
  current_episode_id: '7ca205b861f654d3059f2f229190326e60ea741005a40143de6c9c171cf4f3bf',
  error_evidence_digest: 'b2ff3a8f3697a0e48b8881e54682f5ed91b1af21bb770fd09dcfe8e65e77e789',
};
const episode: Episode = {
  pane_id: 'w1:p1',
  session_id: 's1',
  failure_episode_id: '7ca205b861f654d3059f2f229190326e60ea741005a40143de6c9c171cf4f3bf',
  error_evidence_digest: 'b2ff3a8f3697a0e48b8881e54682f5ed91b1af21bb770fd09dcfe8e65e77e789',
  first_observed_at: '2026-10-05T00:00:00Z',
  attempt_count: 1,
  last_attempt_at: '2026-10-05T00:01:00Z',
  quota_check_count: 0,
  last_quota_check_at: null,
  next_check_at: '2026-10-05T00:05:00Z',
  last_delivery_state: 'none',
};
const legacyName = createHash('sha256').update('w1:p1').digest('hex') + '.json';

test('scope key ignores source/kind but rejects conflicting identity; lookup cannot invent scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-state-'));
  const a = new WorkflowState(root),
    b = new WorkflowState(root);
  let token: string | null = null;
  try {
    assert.equal(await a.locate('47:1', 'w1:p1'), null);
    const ticket = await a.capture('47:1', true);
    assert.ok(ticket);
    const lease = a.lease(scope);
    token = await lease.acquire(JSON.stringify(['47:1', 'agy', 's1']));
    assert.ok(token);
    const binding: WorkflowBinding = {
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
    };
    await a.recordBinding(binding);
    assert.deepEqual(await b.binding(scope), binding);
    assert.deepEqual(await b.locate('47:1', 'w1:p1'), scope);
    await assert.rejects(b.binding({ ...scope, sessionKind: 'opaque' }));
    await assert.rejects(b.recordBinding({ ...binding, scope: { ...scope, sessionSource: 'integration:agy' } }));
    assert.deepEqual(await b.binding(scope), binding);
    assert.equal(await b.locate('47:2', 'w1:p1'), null);
  } finally {
    if (token) await a.lease(scope).release(token);
    await rm(root, { recursive: true, force: true });
  }
});

for (const variant of [
  'exact',
  'other-pane',
  'other-episode',
  'other-evidence',
  'corrupt',
  'duplicate',
  'uncertain',
] as const) {
  test(`legacy association ${variant} preserves history or quarantines, never resets budgets`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-adoption-'));
    const state = new WorkflowState(root),
      episodes = new EpisodeStore(root);
    try {
      await episodes.record('w1:p1', {
        ...episode,
        ...(variant === 'uncertain' ? { last_delivery_state: 'uncertain' } : {}),
      });
      if (variant === 'duplicate') await episodes.record('w2:p2', { ...episode, pane_id: 'w2:p2' });
      if (variant === 'corrupt') await writeFile(join(root, legacyName), '{', { mode: 0o600 });
      const before = await readFile(join(root, legacyName), 'utf8');
      const observed = {
        ...observation,
        ...(variant === 'other-pane'
          ? {
              pane_id: 'w2:p2',
              workspace_id: 'w2',
              current_episode_id: 'dbb517d9433856139cd58ef8a8c1590a212ac781ddbfa1101d5d4db7f3461a79',
            }
          : {}),
        ...(variant === 'other-episode'
          ? { revision: 2, current_episode_id: '459cada4dd0426d33c635ee27e6c5c630e5dd81f3006db1612151a7ee1ee5a78' }
          : {}),
        ...(variant === 'other-evidence'
          ? {
              context: 'API failure',
              error_evidence_digest: '782557dd4f452b175dbfb3ec464cae40d79ebc7b351f82a859c4b07f29479914',
              current_episode_id: '66ab8e3495a3dc7a81c28790b477aa16e386e0a4de0c407d496933cb3a0ea02a',
            }
          : {}),
      };
      assert.equal(
        await state.adoptLegacyRetry(episodes, scope, observed),
        variant === 'exact' ? 'adopted' : 'quarantined',
      );
      if (variant === 'exact') {
        assert.deepEqual(await episodes.sessionRetry('agy', 's1'), episode);
        await episodes.record('w1:p1', { ...episode, attempt_count: 2, last_attempt_at: '2026-10-05T00:02:00Z' });
        assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'adopted');
        assert.equal((await episodes.sessionRetry('agy', 's1'))?.attempt_count, 1);
      } else {
        assert.equal(await episodes.sessionRetry('agy', 's1'), null);
        assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'quarantined');
      }
      if (variant !== 'exact') assert.equal(await readFile(join(root, legacyName), 'utf8'), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('canonical session history is shared across servers, panes and strict on read/write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-history-'));
  const episodes = new EpisodeStore(root);
  try {
    assert.equal(await episodes.sessionRetry('agy', 's1'), null);
    await episodes.recordSessionRetry('agy', 's1', episode);
    assert.deepEqual(await new EpisodeStore(root).sessionRetry('agy', 's1'), episode);
    assert.equal(await episodes.sessionRetry('codex', 's1'), null);
    await assert.rejects(episodes.recordSessionRetry('agy', 's2', episode));
    await assert.rejects(episodes.recordSessionRetry('agy', 's1', { ...episode, attempt_count: -1 }));
    const name = (await readdir(root)).find((name) => name.startsWith('retry-session-'));
    assert.ok(name);
    await writeFile(join(root, name), JSON.stringify({ ...episode, extra: true }), { mode: 0o600 });
    await assert.rejects(episodes.sessionRetry('agy', 's1'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const boundary of ['scan', 'canonical-publication'] as const) {
  test(`two-second legacy ${boundary} timeout never becomes absence or grants late adoption`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-adoption-timeout-'));
    const entered = deferred<void>(),
      resume = deferred<void>(),
      quarantined = deferred<void>();
    let expire: (() => void) | undefined,
      hold = true;
    const state = new WorkflowState(root, undefined, {
      shutdownDeadline: (ms, callback) => {
        assert.equal(ms, 2000);
        expire = callback;
        return () => {};
      },
      io: {
        readdir: async (path) => {
          if (boundary === 'scan' && hold && path === root) {
            hold = false;
            entered.resolve();
            await resume.promise;
          }
          return readdir(path);
        },
        rename: async (from, to) => {
          if (
            boundary === 'canonical-publication' &&
            hold &&
            to.includes('/retry-session-') &&
            !to.includes('quarantine')
          ) {
            hold = false;
            entered.resolve();
            await resume.promise;
          }
          await rename(from, to);
          if (to.endsWith('.quarantine.json')) quarantined.resolve();
        },
      },
    });
    const episodes = new EpisodeStore(
      root,
      undefined,
      boundary === 'canonical-publication'
        ? {
            io: {
              rename: async (from, to) => {
                if (hold && to.includes('/retry-session-') && !to.includes('quarantine')) {
                  hold = false;
                  entered.resolve();
                  await resume.promise;
                }
                await rename(from, to);
              },
            },
          }
        : {},
    );
    try {
      await episodes.record('w1:p1', episode);
      const adoption = state.adoptLegacyRetry(episodes, scope, observation);
      await within(entered.promise);
      assert.ok(expire);
      expire();
      assert.equal(await within(adoption), 'quarantined');
      assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'quarantined');
      resume.resolve();
      await within(quarantined.promise);
      await within(
        (async () => {
          while ((await readdir(root)).some((name) => name.endsWith('.lock')))
            await new Promise((resolve) => setTimeout(resolve, 1));
        })(),
      );
      assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'quarantined');
    } finally {
      resume.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('paused pending binding retains epoch and original history across duplicate view, resume and pane reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-binding-history-'));
  const state = new WorkflowState(root),
    other = new WorkflowState(root);
  const attempts: ReturnType<typeof beginWorkflow>[] = [];
  const begin = (selected: WorkflowScope, paneId = 'w1:p1') => {
    const attempt = beginWorkflow({
      state: other,
      scope: selected,
      paneId,
      workspaceId: paneId.split(':')[0]!,
      signal: new AbortController().signal,
      permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
    });
    attempts.push(attempt);
    return attempt;
  };
  try {
    const first = begin(scope),
      auth = await first.ready;
    assert.ok(auth);
    await new EpisodeStore(root).recordSessionRetry('agy', 's1', episode);
    const original = await state.binding(scope);
    assert.ok(original);
    await state.recordBinding({ ...original, phase: 'pending', failureEpisodeId: episode.failure_episode_id });
    const pending = await state.binding(scope);
    assert.ok(pending);
    const duplicate = begin(scope, 'w2:p2');
    assert.equal((await duplicate.ready)?.ownsGeneration, false);
    assert.deepEqual(await state.binding(scope), pending);
    assert.deepEqual(await state.locate('47:1', 'w2:p2'), scope);
    await assert.rejects(state.recordBinding({ ...pending, paneId: 'w2:p2', workspaceId: 'w2' }));
    assert.equal(await state.pause('47:1'), 'paused');
    assert.equal(await auth.valid(), false);
    await first.finish();
    await duplicate.finish();
    assert.equal(await state.resume('47:1', true), 'resumed');
    const resumed = begin(scope),
      successor = await resumed.ready;
    assert.ok(successor);
    assert.deepEqual(await state.binding(scope), pending);
    await assert.rejects(
      state.recordBinding({ ...pending, epoch: successor.ticket.epoch, generation: successor.generation }),
    );
    const replacement = begin({ ...scope, sessionId: 's2' });
    assert.ok(await replacement.ready);
    assert.deepEqual(await state.locate('47:1', 'w1:p1'), { ...scope, sessionId: 's2' });
    assert.deepEqual(await state.binding(scope), pending);
    assert.deepEqual(await new EpisodeStore(root).sessionRetry('agy', 's1'), episode);
  } finally {
    for (const attempt of attempts) {
      attempt.close();
      await attempt.finish();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('linked workflow ancestor denies authority and lifecycle lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-unsafe-layout-'));
  const state = new WorkflowState(root);
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    signal: new AbortController().signal,
    permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
  });
  try {
    const auth = await attempt.ready;
    assert.ok(auth);
    const workflows = join(root, 'workflows');
    await rename(workflows, workflows + '-original');
    await symlink(workflows + '-original', workflows);
    assert.equal(await auth.valid(), false);
    assert.equal(await state.locate('47:1', 'w1:p1'), null);
    assert.equal((await lstat(workflows)).isSymbolicLink(), true);
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const variant of ['corrupt-canonical', 'uncertain', 'quarantine'] as const) {
  test(`recovery ${variant} does not reject independent permission assessment`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-independent-'));
    const state = new WorkflowState(root),
      episodes = new EpisodeStore(root);
    let attempt: ReturnType<typeof beginWorkflow> | undefined;
    try {
      if (variant === 'quarantine') {
        await episodes.record('w1:p1', { ...episode, last_delivery_state: 'uncertain' });
        assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'quarantined');
      } else {
        await episodes.recordSessionRetry('agy', 's1', { ...episode, last_delivery_state: 'uncertain' });
        if (variant === 'corrupt-canonical') {
          const name = (await readdir(root)).find((name) => /^retry-session-[a-f0-9]{64}\.json$/.test(name));
          assert.ok(name);
          await writeFile(join(root, name), '{', { mode: 0o600 });
        }
      }
      attempt = beginWorkflow({
        state,
        scope,
        paneId: 'w1:p1',
        workspaceId: 'w1',
        signal: new AbortController().signal,
        permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
      });
      const auth = await attempt.ready;
      assert.ok(auth);
      assert.equal(await auth.valid(), true);
      const slot = reserveJobSlot(state, auth);
      assert.equal(await slot.ready, null);
      await slot.finish();
      const binding = await state.binding(scope);
      assert.ok(binding);
      await assert.rejects(
        state.recordBinding({ ...binding, phase: 'pending', failureEpisodeId: episode.failure_episode_id }),
      );
    } finally {
      attempt?.close();
      await attempt?.finish();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const variant of ['temp', 'unreadable', 'linked', 'oversized'] as const) {
  test(`incomplete or unsafe legacy scan ${variant} is not absence`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-incomplete-scan-'));
    const state = new WorkflowState(root),
      episodes = new EpisodeStore(root);
    try {
      await episodes.prepare();
      if (variant === 'temp') await writeFile(join(root, legacyName + '.held.tmp'), '{}', { mode: 0o600 });
      if (variant === 'unreadable') await writeFile(join(root, legacyName), '{}', { mode: 0o000 });
      if (variant === 'linked') {
        await writeFile(join(root, 'untrusted'), JSON.stringify(episode), { mode: 0o600 });
        await symlink(join(root, 'untrusted'), join(root, legacyName));
      }
      if (variant === 'oversized') await writeFile(join(root, legacyName), ' '.repeat(8193), { mode: 0o600 });
      assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'quarantined');
      assert.equal(await episodes.sessionRetry('agy', 's1'), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const selected of [
  { ...scope, agent: 'claude', sessionKind: 'id', sessionSource: 'herdr:claude' },
  { ...scope, agent: 'pi', sessionKind: 'id', sessionSource: 'herdr:pi' },
  { ...scope, agent: 'pi', sessionKind: 'path', sessionSource: 'herdr:pi' },
  { ...scope, agent: 'omp', sessionKind: 'path', sessionSource: 'herdr:omp' },
  { ...scope, agent: 'letta', sessionKind: 'id', sessionSource: 'herdr:letta' },
]) {
  test(`pinned native ${selected.agent}/${selected.sessionKind} can own a bounded scope`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-native-'));
    const state = new WorkflowState(root);
    const attempt = beginWorkflow({
      state,
      scope: selected,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      signal: new AbortController().signal,
      permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
    });
    try {
      assert.equal((await attempt.ready)?.ownsGeneration, true);
    } finally {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('legacy session-value equality cannot substitute a full native observation digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-native-digest-'));
  const episodes = new EpisodeStore(root),
    state = new WorkflowState(root);
  try {
    await episodes.record('w1:p1', episode);
    // Simulate a different native agent with the same opaque session value and forged old digest.
    const codex = { ...scope, agent: 'codex', sessionSource: 'herdr:codex' };
    const forged = { ...observation, agent: 'codex', session_source: 'herdr:codex' };
    assert.equal(await state.adoptLegacyRetry(episodes, codex, forged), 'quarantined');
    assert.equal(await episodes.sessionRetry('codex', 's1'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stranded legacy association guard never grants recovery from a late canonical record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-stranded-association-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  let attempt: ReturnType<typeof beginWorkflow> | undefined;
  try {
    await episodes.recordSessionRetry('agy', 's1', episode);
    const name = `retry-session-${createHash('sha256')
      .update(JSON.stringify(['agy', 's1']))
      .digest('hex')}.association-guard`;
    await writeFile(join(root, name), '', { mode: 0o600 });
    assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'quarantined');
    attempt = beginWorkflow({
      state,
      scope,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      signal: new AbortController().signal,
      permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
    });
    assert.ok(await attempt.ready);
    const binding = await state.binding(scope);
    assert.ok(binding);
    await assert.rejects(state.recordBinding({ ...binding, phase: 'pending' }));
    assert.equal((await lstat(join(root, name))).isFile(), true);
  } finally {
    attempt?.close();
    await attempt?.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('safe explicit pending promotion can change released generation without changing epoch or history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-safe-promotion-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const start = () =>
    beginWorkflow({
      state,
      scope,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      signal: new AbortController().signal,
      permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
    });
  const first = start();
  let next: ReturnType<typeof start> | undefined;
  try {
    assert.ok(await first.ready);
    await episodes.recordSessionRetry('agy', 's1', episode);
    const binding = await state.binding(scope);
    assert.ok(binding);
    await state.recordBinding({ ...binding, phase: 'pending', failureEpisodeId: episode.failure_episode_id });
    const original = await state.binding(scope);
    assert.ok(original);
    await first.finish();
    next = start();
    const auth = await next.ready;
    assert.ok(auth);
    assert.deepEqual(await state.binding(scope), original);
    assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'adopted');
    await state.recordBinding({ ...original, generation: auth.generation });
    const promoted = await state.binding(scope);
    assert.ok(promoted);
    assert.equal(promoted.epoch, original.epoch);
    assert.equal(promoted.historyPaneId, 'w1:p1');
    assert.equal(promoted.failureEpisodeId, episode.failure_episode_id);
    assert.deepEqual(await episodes.sessionRetry('agy', 's1'), episode);
    const slot = reserveJobSlot(state, auth);
    assert.ok(await slot.ready);
    await slot.finish();
  } finally {
    first.close();
    await first.finish();
    next?.close();
    await next?.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('native kind change keeps the same key and cannot overwrite older uncertainty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-kind-isolation-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const old = { ...scope, agent: 'pi', sessionKind: 'id', sessionSource: 'herdr:pi' };
  const begin = (selected: WorkflowScope) =>
    beginWorkflow({
      state,
      scope: selected,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      signal: new AbortController().signal,
      permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
    });
  const first = begin(old);
  let replacement: ReturnType<typeof begin> | undefined;
  try {
    assert.ok(await first.ready);
    await episodes.recordSessionRetry('pi', 's1', { ...episode, last_delivery_state: 'uncertain' });
    const before = await state.binding(old);
    assert.ok(before);
    await first.finish();
    replacement = begin({ ...old, sessionKind: 'path' });
    assert.equal(await replacement.ready, null);
    assert.deepEqual(await state.binding(old), before);
    assert.deepEqual(await episodes.sessionRetry('pi', 's1'), { ...episode, last_delivery_state: 'uncertain' });
    assert.equal((await readdir(join(root, 'workflows'))).length, 1);
  } finally {
    first.close();
    await first.finish();
    replacement?.close();
    await replacement?.finish();
    await rm(root, { recursive: true, force: true });
  }
});

for (const variant of ['paused', 'terminal', 'live', 'released'] as const) {
  test(`server replacement retains ${variant} canonical binding provenance`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-server-provenance-'));
    const state = new WorkflowState(root),
      episodes = new EpisodeStore(root);
    const start = (selected: WorkflowScope) =>
      beginWorkflow({
        state,
        scope: selected,
        paneId: 'w1:p1',
        workspaceId: 'w1',
        signal: new AbortController().signal,
        permission: async () => ({ serverId: selected.serverId, enabled: true, targets: 'all', autoApprove: false }),
      });
    const original = start(scope);
    let replacement: ReturnType<typeof start> | undefined;
    try {
      assert.ok(await original.ready);
      await episodes.recordSessionRetry('agy', 's1', episode);
      const binding = await state.binding(scope);
      assert.ok(binding);
      await state.recordBinding({ ...binding, phase: 'pending', failureEpisodeId: episode.failure_episode_id });
      if (variant === 'paused') await state.pause('47:1');
      if (variant === 'terminal')
        await state.recordBinding({
          ...binding,
          failureEpisodeId: episode.failure_episode_id,
          phase: 'terminal',
          reason: 'human',
        });
      if (variant !== 'live') await original.finish();
      const newScope = { ...scope, serverId: '47:2' };
      replacement = start(newScope);
      const auth = await replacement.ready;
      assert.ok(auth);
      assert.equal(
        await state.adoptLegacyRetry(episodes, newScope, observation),
        variant === 'released' ? 'adopted' : 'quarantined',
      );
      const nextBinding = await state.binding(newScope);
      assert.ok(nextBinding);
      if (variant === 'released') {
        await state.recordBinding({ ...nextBinding, phase: 'pending' });
        const slot = reserveJobSlot(state, auth);
        assert.ok(await slot.ready);
        await slot.finish();
      } else await assert.rejects(state.recordBinding({ ...nextBinding, phase: 'pending' }));
      assert.deepEqual(await episodes.sessionRetry('agy', 's1'), episode);
    } finally {
      original.close();
      await original.finish();
      replacement?.close();
      await replacement?.finish();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('forged direct pane lookup cannot invent an absent scope or bypass its full binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-forged-lookup-'));
  const state = new WorkflowState(root);
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    signal: new AbortController().signal,
    permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
  });
  try {
    assert.ok(await attempt.ready);
    const binding = await state.binding(scope);
    assert.ok(binding);
    const path = join(
      root,
      'automation',
      createHash('sha256')
        .update(JSON.stringify(['47:1']))
        .digest('hex'),
      'panes',
      createHash('sha256')
        .update(JSON.stringify(['w1:p1']))
        .digest('hex') + '.json',
    );
    await writeFile(
      path,
      JSON.stringify({ protocol: 1, paneId: 'w1:p1', binding: { ...binding, scope: { ...scope, sessionId: 's2' } } }),
      { mode: 0o600 },
    );
    assert.equal(await state.locate('47:1', 'w1:p1'), null);
    await writeFile(path, JSON.stringify({ protocol: 1, paneId: 'w1:p1', binding: { ...binding, extra: true } }), {
      mode: 0o600,
    });
    assert.equal(await state.locate('47:1', 'w1:p1'), null);
    assert.deepEqual(await state.binding(scope), binding);
  } finally {
    attempt.close();
    await attempt.finish();
    await rm(root, { recursive: true, force: true });
  }
});

test('adoption under the originating pane lock is not permanent ambiguous-history quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-pane-lock-adoption-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const entered = deferred<void>(),
    resume = deferred<void>();
  const holding = episodes.withEpisodeLock('w1:p1', async () => {
    entered.resolve();
    await resume.promise;
  });
  try {
    await within(entered.promise);
    assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'absent');
    assert.equal(await episodes.sessionRetry('agy', 's1'), null);
    assert.equal(await state.recoveryQuarantined(scope), false);
    resume.resolve();
    await holding;
    assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'absent');
    assert.equal(await new WorkflowState(root).recoveryQuarantined(scope), false);
  } finally {
    resume.resolve();
    await holding;
    await rm(root, { recursive: true, force: true });
  }
});

test('adoption alongside a different session canonical lock is not permanent ambiguous-history quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-session-lock-adoption-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const entered = deferred<void>(),
    resume = deferred<void>();
  const holding = episodes.withEpisodeLock('retry-session:' + JSON.stringify(['agy', 's2']), async () => {
    entered.resolve();
    await resume.promise;
  });
  try {
    await episodes.record('w1:p1', episode);
    await within(entered.promise);
    assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'adopted');
    assert.deepEqual(await episodes.sessionRetry('agy', 's1'), episode);
    assert.equal(await state.recoveryQuarantined(scope), false);
    resume.resolve();
    await holding;
    assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'adopted');
    assert.equal(await new WorkflowState(root).recoveryQuarantined(scope), false);
  } finally {
    resume.resolve();
    await holding;
    await rm(root, { recursive: true, force: true });
  }
});

for (const variant of ['empty-lock', 'empty-takeover', 'corrupt-owner', 'unreadable-owner'] as const) {
  test(`unidentified lock ${variant} is not absence or a fresh recovery budget`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-unidentified-lock-'));
    const state = new WorkflowState(root),
      episodes = new EpisodeStore(root);
    try {
      await episodes.prepare();
      const lock = join(root, legacyName + '.lock');
      if (variant === 'empty-lock') await mkdir(lock, { mode: 0o700 });
      if (variant === 'empty-takeover') await mkdir(lock + '.takeover', { mode: 0o700 });
      if (variant === 'corrupt-owner') {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, 'owner.json'), '{', { mode: 0o600 });
      }
      if (variant === 'unreadable-owner') {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, 'owner.json'), '{}', { mode: 0o000 });
      }
      assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'quarantined');
      assert.equal(await episodes.sessionRetry('agy', 's1'), null);
      assert.equal(await state.recoveryQuarantined(scope), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('takeover of a positively identified new-session lock is not permanent ambiguous-history quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-session-lock-takeover-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const entered = deferred<void>(),
    resume = deferred<void>();
  const key = 'retry-session:' + JSON.stringify(['agy', 's2']);
  const holding = episodes.withEpisodeLock(key, async () => {
    entered.resolve();
    await resume.promise;
  });
  try {
    await episodes.record('w1:p1', episode);
    await within(entered.promise);
    await mkdir(join(root, createHash('sha256').update(key).digest('hex') + '.json.lock.takeover'), { mode: 0o700 });
    assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'adopted');
    assert.deepEqual(await episodes.sessionRetry('agy', 's1'), episode);
    assert.equal(await state.recoveryQuarantined(scope), false);
    resume.resolve();
    await holding;
    assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'adopted');
    assert.equal(await new WorkflowState(root).recoveryQuarantined(scope), false);
  } finally {
    resume.resolve();
    await holding;
    await rm(root, { recursive: true, force: true });
  }
});

test('unidentified other-pane writer lock before its episode is visible is not absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-other-pane-lock-'));
  const state = new WorkflowState(root),
    episodes = new EpisodeStore(root);
  const entered = deferred<void>(),
    resume = deferred<void>();
  const holding = episodes.withEpisodeLock('w2:p2', async () => {
    entered.resolve();
    await resume.promise;
  });
  try {
    await within(entered.promise);
    assert.equal(await state.adoptLegacyRetry(episodes, scope, observation), 'quarantined');
    assert.equal(await episodes.sessionRetry('agy', 's1'), null);
    assert.equal(await state.recoveryQuarantined(scope), true);
    resume.resolve();
    await holding;
    assert.equal(await new WorkflowState(root).adoptLegacyRetry(episodes, scope, observation), 'quarantined');
    assert.equal(await new WorkflowState(root).recoveryQuarantined(scope), true);
  } finally {
    resume.resolve();
    await holding;
    await rm(root, { recursive: true, force: true });
  }
});

// Catches treating a live binding snapshot as permission to write after the epoch is closed.
test('canonical retry write is denied after confirmed pause despite a live binding snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-admitted-retry-'));
  const writer = new WorkflowState(root);
  const observer = new WorkflowState(root);
  const episodes = new EpisodeStore(root);
  let token: string | null = null;
  try {
    const ticket = await writer.capture('47:1', true);
    assert.ok(ticket);
    token = await writer.lease(scope).acquire(JSON.stringify(['47:1', 'agy', 's1']));
    assert.ok(token);
    await episodes.recordSessionRetry('agy', 's1', episode);
    await writer.recordBinding({
      protocol: 1,
      scope,
      epoch: ticket.epoch,
      generation: token,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      historyPaneId: 'w1:p1',
      failureEpisodeId: episode.failure_episode_id,
      phase: 'pending',
      reason: null,
    });
    const before = await episodes.sessionRetry('agy', 's1');
    const binding = await observer.binding(scope);
    assert.ok(binding);
    assert.equal(binding.epoch, ticket.epoch);
    assert.equal(await observer.pause('47:1'), 'paused');
    assert.equal(await writer.matches(ticket), false);
    assert.equal(await observer.matches(ticket), false);
    const snapshot = await writer.binding(scope);
    assert.ok(snapshot);
    assert.equal(snapshot.generation, token);
    assert.equal(
      await writer.recordAdmittedSessionRetry(scope, ticket, {
        ...episode,
        next_check_at: null,
        last_delivery_state: 'human',
      }),
      false,
    );
    assert.deepEqual(await episodes.sessionRetry('agy', 's1'), before);
    assert.equal(before?.attempt_count, 1);
    assert.equal(before?.last_delivery_state, 'none');
    assert.equal(before?.next_check_at, '2026-10-05T00:05:00Z');
  } finally {
    if (token)
      await writer
        .lease(scope)
        .release(token)
        .catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

// Catches denying every canonical retry write, including while the captured epoch is open.
test('canonical retry write proceeds only while the captured epoch is open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-admitted-retry-open-'));
  const state = new WorkflowState(root);
  const episodes = new EpisodeStore(root);
  let token: string | null = null;
  try {
    const ticket = await state.capture('47:1', true);
    assert.ok(ticket);
    token = await state.lease(scope).acquire(JSON.stringify(['47:1', 'agy', 's1']));
    assert.ok(token);
    await episodes.recordSessionRetry('agy', 's1', episode);
    await state.recordBinding({
      protocol: 1,
      scope,
      epoch: ticket.epoch,
      generation: token,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      historyPaneId: 'w1:p1',
      failureEpisodeId: episode.failure_episode_id,
      phase: 'pending',
      reason: null,
    });
    assert.equal(
      await state.recordAdmittedSessionRetry(scope, ticket, {
        ...episode,
        next_check_at: null,
        last_delivery_state: 'human',
      }),
      true,
    );
    const after = await episodes.sessionRetry('agy', 's1');
    assert.equal(after?.last_delivery_state, 'human');
    assert.equal(after?.next_check_at, null);
    assert.equal(after?.attempt_count, 1);
  } finally {
    if (token)
      await state
        .lease(scope)
        .release(token)
        .catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
