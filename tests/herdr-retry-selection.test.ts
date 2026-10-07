import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, rename, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';

const previous: Episode = {
  pane_id: 'w1:p1',
  session_id: 's1',
  failure_episode_id: 'a'.repeat(64),
  error_evidence_digest: 'b'.repeat(64),
  first_observed_at: '2026-10-07T00:00:00Z',
  attempt_count: 2,
  last_attempt_at: '2026-10-07T00:02:30Z',
  quota_check_count: 0,
  last_quota_check_at: null,
  next_check_at: null,
  last_delivery_state: 'delivered',
};
const next: Episode = {
  ...previous,
  failure_episode_id: 'c'.repeat(64),
  error_evidence_digest: 'd'.repeat(64),
  next_check_at: '2026-10-07T00:10:30Z',
  last_delivery_state: 'none',
};
const prefix = `retry-session-${createHash('sha256').update('["pi","s1"]').digest('hex')}.json`;

// Actual private files, bounded local syscall faults; no lifecycle or native-agent success is synthesized.
test('failed selector publication preserves old bytes and an orphan cannot grant a retry budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-retry-selector-fault-'));
  let fault = true;
  const store = new EpisodeStore(root, Date.now, {
    io: {
      rename: async (from, to) => {
        if (fault && String(to).endsWith('.head.json'))
          throw Object.assign(new Error('read-only selector'), { code: 'EROFS' });
        await rename(from, to);
      },
    },
  });
  try {
    await store.recordSessionRetry('pi', 's1', previous);
    const before = await readFile(join(root, prefix));
    await assert.rejects(store.advanceSessionRetry('pi', 's1', next, previous));
    fault = false;
    assert.deepEqual(await store.sessionRetry('pi', 's1'), previous);
    assert.deepEqual(await readFile(join(root, prefix)), before);
    await assert.rejects(store.advanceSessionRetry('pi', 's1', next, previous));
    assert.deepEqual(await store.sessionRetry('pi', 's1'), previous);
    assert.equal(await store.hasRetryHead('pi', 's1'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('late captured writers cannot overwrite a newer stop or recreate a settled episode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-retry-selector-late-'));
  const store = new EpisodeStore(root);
  try {
    await store.recordSessionRetry('pi', 's1', previous);
    const before = await readFile(join(root, prefix));
    await store.advanceSessionRetry('pi', 's1', next, previous);
    await assert.rejects(store.recordSessionRetry('pi', 's1', { ...previous, last_delivery_state: 'human' }));
    const selected = { ...next, workflow_episode_id: 'a'.repeat(64) };
    assert.deepEqual(await store.sessionRetry('pi', 's1'), selected);
    await store.completeSessionRetry('pi', 's1', 'e'.repeat(64), selected);
    await assert.rejects(store.recordSessionRetry('pi', 's1', { ...next, last_delivery_state: 'human' }));
    assert.equal(await store.sessionRetry('pi', 's1'), null);
    // Replay of a pre-upgrade/root snapshot remains blocked even with a new first-observed time.
    await assert.rejects(
      store.advanceSessionRetry(
        'pi',
        's1',
        {
          ...previous,
          first_observed_at: '2026-10-07T01:00:00Z',
          attempt_count: 0,
          last_attempt_at: null,
          next_check_at: null,
          last_delivery_state: 'none',
        },
        null,
      ),
    );
    assert.deepEqual(await readFile(join(root, prefix)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completion publication failure retains the unresolved budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-retry-complete-fault-'));
  const store = new EpisodeStore(root, Date.now, {
    io: {
      rename: async (from, to) => {
        if (String(to).endsWith('.head.json')) throw Object.assign(new Error('read-only selector'), { code: 'EROFS' });
        await rename(from, to);
      },
    },
  });
  try {
    await store.recordSessionRetry('pi', 's1', previous);
    await assert.rejects(store.completeSessionRetry('pi', 's1', 'e'.repeat(64), previous));
    assert.deepEqual(await new EpisodeStore(root).sessionRetry('pi', 's1'), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
