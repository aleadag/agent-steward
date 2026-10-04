import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { quotaResetHint } from '../src/herdr-adapter/quota-hint.ts';
import type { ObservedStop } from '../src/herdr-adapter/observe.ts';

const now = new Date('2026-10-04T10:00:00Z');
const candidate = {
  id: 'one',
  tool: 'pi',
  provider: 'openai-codex',
  model: 'model-one',
  quota_bucket: 'pi_codex',
  quota_pool: 'primary',
  cost: 1,
  capabilities: 'test',
  thinking_levels: [{ id: 'default', description: 'test' }],
};
const observed: ObservedStop = {
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'pi',
  session_id: 's1',
  session_kind: 'id',
  session_source: 'integration:pi',
  status: 'idle',
  revision: 1,
  state_change_seq: 1,
  context: 'Model: model-one\nQuota exhausted',
  current_episode_id: 'a'.repeat(64),
  error_evidence_digest: 'b'.repeat(64),
};
const window = {
  scope: { type: 'account' },
  remaining_percent: 0,
  observed_at: '2026-10-04T09:59:00Z',
  valid_until: '2026-10-04T10:10:00Z',
  reset_at: '2026-10-04T10:12:00Z',
};
function fixture(
  options: {
    candidates?: (typeof candidate)[];
    tools?: string[];
    windows?: unknown[];
    configText?: string;
    snapshotText?: string;
    missing?: boolean;
    xdg?: boolean;
  } = {},
) {
  const reads: string[] = [];
  const env = options.xdg
    ? { HOME: '/fixture', XDG_CONFIG_HOME: '/config', XDG_STATE_HOME: '/state' }
    : { HOME: '/fixture' };
  const configPath = options.xdg ? '/config/agent-steward/config.json' : '/fixture/.config/agent-steward/config.json';
  const snapshotPath = options.xdg
    ? '/state/agent-steward/quota/pi_codex.json'
    : '/fixture/.local/state/agent-steward/quota/pi_codex.json';
  const files = new Map([
    [
      configPath,
      options.configText ??
        JSON.stringify({ tools: options.tools ?? ['pi'], candidates: options.candidates ?? [candidate] }),
    ],
    [
      snapshotPath,
      options.snapshotText ??
        JSON.stringify({
          schema_version: 1,
          source: 'pi_codex',
          identity_fingerprint: 'a'.repeat(64),
          windows: options.windows ?? [window],
        }),
    ],
  ]);
  return {
    reads,
    env,
    cwd: '/fixture/work',
    now,
    readText: async (path: string) => {
      reads.push(path);
      if (options.missing || !files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    },
  };
}

test('fresh exhausted account windows use latest reset plus one minute', async () => {
  const io = fixture({
    windows: [
      window,
      { ...window, reset_at: '2026-10-04T10:15:00Z' },
      { ...window, remaining_percent: 50, reset_at: '2026-10-04T11:00:00Z' },
    ],
  });
  assert.equal(await quotaResetHint(observed, io), '2026-10-04T10:16:00.000Z');
  assert.equal(io.reads.length, 2);
});
for (const [context, expected] of [
  ['(model-one)', '2026-10-04T10:13:00.000Z'],
  ['model-one-plus', null],
  ['prefix-model-one', null],
  ['model-one:variant', null],
  ['MODEL-ONE', null],
  ['Quota exhausted', null],
] as const) {
  test(`literal identifier boundaries: ${context}`, async () => {
    assert.equal(await quotaResetHint({ ...observed, context }, fixture()), expected);
  });
}
test('model regex punctuation is literal', async () => {
  const c = { ...candidate, model: 'model[one]+' };
  assert.equal(
    await quotaResetHint({ ...observed, context: '(model[one]+)' }, fixture({ candidates: [c] })),
    '2026-10-04T10:13:00.000Z',
  );
});
test('duplicates may differ in effort but must agree on mapping', async () => {
  assert.equal(
    await quotaResetHint(
      observed,
      fixture({
        candidates: [candidate, { ...candidate, id: 'two', thinking_levels: [{ id: 'low', description: 'low' }] }],
      }),
    ),
    '2026-10-04T10:13:00.000Z',
  );
  for (const change of [{ quota_pool: 'other' }, { quota_bucket: 'pi_xai' }, { provider: 'other' }]) {
    const io = fixture({ candidates: [candidate, { ...candidate, id: 'two', ...change }] });
    assert.equal(await quotaResetHint(observed, io), null);
    assert.equal(io.reads.length, 1);
  }
});
test('multiple distinct model identifiers do not produce a hint', async () => {
  assert.equal(
    await quotaResetHint(
      { ...observed, context: 'model-one model-two' },
      fixture({ candidates: [candidate, { ...candidate, id: 'two', model: 'model-two' }] }),
    ),
    null,
  );
});
test('disabled candidates and other tools do not select a bucket', async () => {
  for (const io of [
    fixture({ tools: [] }),
    fixture({ candidates: [{ ...candidate, tool: 'codex', quota_bucket: 'codex' }] }),
  ]) {
    assert.equal(await quotaResetHint(observed, io), null);
    assert.equal(io.reads.length, 1);
  }
  assert.equal(await quotaResetHint({ ...observed, agent: 'claude' }, fixture()), null);
});
for (const [label, windows] of [
  ['nonzero', [{ ...window, remaining_percent: 1 }]],
  ['no windows', []],
  ['unmatched pool', [{ ...window, scope: { type: 'pool', pool_id: 'other' } }]],
  ['expired', [{ ...window, valid_until: '2026-10-04T10:00:00Z' }]],
  ['future observation', [{ ...window, observed_at: '2026-10-04T10:01:00Z' }]],
  [
    'reset passed',
    [
      {
        ...window,
        reset_at: '2026-10-04T09:59:00Z',
        valid_until: '2026-10-04T09:59:00Z',
        observed_at: '2026-10-04T09:58:00Z',
      },
    ],
  ],
  ['one unknown applicable window', [window, { ...window, valid_until: '2026-10-04T10:00:00Z' }]],
] as const) {
  test(`no hint for ${label}`, async () => {
    assert.equal(await quotaResetHint(observed, fixture({ windows: [...windows] })), null);
  });
}
test('unrelated pool windows and buckets are not consulted', async () => {
  const io = fixture({
    candidates: [candidate, { ...candidate, id: 'other', model: 'other-model', quota_bucket: 'pi_xai' }],
    windows: [window, { ...window, scope: { type: 'pool', pool_id: 'other' }, valid_until: '2026-10-04T10:00:00Z' }],
  });
  assert.equal(await quotaResetHint(observed, io), '2026-10-04T10:13:00.000Z');
  assert.equal(
    io.reads.some((p) => p.endsWith('pi_xai.json')),
    false,
  );
});
for (const options of [
  { configText: '{' },
  { configText: '{}' },
  { configText: ' '.repeat(1_048_577) },
  { snapshotText: '{' },
  { snapshotText: '{}' },
  { snapshotText: ' '.repeat(1_048_577) },
  { missing: true },
]) {
  test(`optional lookup fails locally: ${Object.keys(options)[0]}`, async () => {
    assert.equal(await quotaResetHint(observed, fixture(options)), null);
  });
}
test('explicit XDG directories are used for bounded config and snapshot reads', async () => {
  const io = fixture({ xdg: true });
  assert.equal(await quotaResetHint(observed, io), '2026-10-04T10:13:00.000Z');
  assert.deepEqual(io.reads, ['/config/agent-steward/config.json', '/state/agent-steward/quota/pi_codex.json']);
});
