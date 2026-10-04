import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { StewardError } from '../src/contracts.ts';
import type { ConfigEnv, ReadText } from '../src/contracts.ts';
import { config } from './helpers.ts';

const cwd = '/work';
const jsonReader =
  (raw: unknown): ReadText =>
  async (_path: string) =>
    JSON.stringify(raw) ?? '';

async function rejectsConfig(
  readText: ReadText,
  env: ConfigEnv = { HOME: '/isolated/home' },
  override: string | undefined = undefined,
) {
  await assert.rejects(
    loadConfig(override, { env, cwd, readText }),
    (error) => error instanceof StewardError && error.code === 'invalid_config',
  );
}

test('XDG config and nested defaults without snapshot path configuration', async () => {
  const { evaluator: _evaluator, ...rawWithoutJev } = config();
  const raw = {
    ...rawWithoutJev,
    thresholds: { risky: 0.7 },
  };
  const reads: string[] = [];
  const result = await loadConfig(undefined, {
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
    cwd: '/work',
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(raw);
    },
  });
  assert.deepEqual(reads, ['/isolated/xdg/agent-steward/config.json']);
  assert.deepEqual(result.candidates, raw.candidates);
  assert.equal('accounts' in result, false);
  assert.equal(result.evaluator.model, 'jev-1.13.0');
  assert.deepEqual(result.thresholds, { risky: 0.7, choiceConfidence: 0.45 });
});

test('HOME fallback and relative explicit config resolve the config path', async () => {
  const raw = config();
  const reads: string[] = [];
  const result = await loadConfig('settings/config.json', {
    env: { HOME: '/isolated/home' },
    cwd,
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(raw);
    },
  });
  assert.deepEqual(reads, ['/work/settings/config.json']);
  assert.deepEqual(result, raw);

  const homeReads: string[] = [];
  await loadConfig(undefined, {
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '' },
    cwd,
    readText: async (path) => {
      homeReads.push(path);
      return JSON.stringify(config());
    },
  });
  assert.deepEqual(homeReads, ['/isolated/home/.config/agent-steward/config.json']);
});

test('absolute override is used as-is and parsed config is unchanged', async () => {
  const raw = config();
  const reads: string[] = [];
  const result = await loadConfig('/isolated/custom.json', {
    env: {},
    cwd,
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(raw);
    },
  });
  assert.deepEqual(reads, ['/isolated/custom.json']);
  assert.deepEqual(result, raw);
});

test('rejects relative XDG paths and missing HOME without fallback reads', async () => {
  let reads = 0;
  await rejectsConfig(
    async () => {
      reads++;
      return JSON.stringify(config());
    },
    { HOME: '/home', XDG_CONFIG_HOME: 'relative' },
  );
  await rejectsConfig(async () => {
    reads++;
    return JSON.stringify(config());
  }, {});
  assert.equal(reads, 0);
});

test('missing and unreadable config files become safe invalid_config errors', async () => {
  for (const failure of [
    new Error('/private/path/settings.json missing'),
    Object.assign(new Error('EACCES /private/config'), { code: 'EACCES' }),
  ]) {
    await assert.rejects(
      loadConfig(undefined, {
        env: { HOME: '/private/home' },
        cwd,
        readText: async () => {
          throw failure;
        },
      }),
      (error) =>
        error instanceof StewardError && error.code === 'invalid_config' && !error.message.includes('/private'),
    );
  }
});

test('malformed or oversized JSON is rejected without echoing its contents', async () => {
  for (const content of ['{secret-token: bad}', 'x'.repeat(1_048_577)]) {
    await assert.rejects(
      loadConfig(undefined, {
        env: { HOME: '/isolated/home' },
        cwd,
        readText: async () => content,
      }),
      (error) =>
        error instanceof StewardError &&
        error.code === 'invalid_config' &&
        !error.message.includes(content.slice(0, 40)),
    );
  }
});

test('config diagnostics distinguish read, JSON and nested schema failures without values', async () => {
  for (const [kind, readText, fields] of [
    [
      'read',
      async () => {
        throw new Error('private-file-path');
      },
      undefined,
    ],
    ['json', async () => '{private-content', undefined],
    [
      'schema',
      jsonReader(config({ candidates: [{ ...config().candidates[0], cost: 'private-value' }] })),
      ['candidates.0.cost'],
    ],
  ] as const) {
    await assert.rejects(loadConfig(undefined, { env: { HOME: '/isolated/home' }, cwd, readText }), (error) => {
      if (!(error instanceof StewardError)) return false;
      assert.equal(error.code, 'invalid_config');
      assert.equal(error.diagnostics?.stage, 'config');
      assert.equal(error.diagnostics?.kind, kind);
      assert.deepEqual(error.diagnostics?.config_fields, fields);
      assert.doesNotMatch(JSON.stringify(error), /private-/);
      return true;
    });
  }
});

test('unknown fields, credential fields, and prototype keys fail without mutation', async () => {
  const raw: Record<string, unknown> = { ...config(), api_key: 'not-a-real-secret' };
  await rejectsConfig(jsonReader(raw));

  const parsed: unknown = JSON.parse(
    '{"tools":["codex"],"accounts":[],"candidates":[],"__proto__":{"polluted":true},"constructor":{"polluted":true}}',
  );
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
  await rejectsConfig(jsonReader(parsed));
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'), before);
});

test('invalid references and duplicate identities fail before returning config', async () => {
  const configuredCandidate = config().candidates[0];
  assert.ok(configuredCandidate);
  const cases = [
    config({
      accounts: [
        { id: 'shared', source: 'codex' },
        { id: 'shared', source: 'antigravity' },
      ],
    }),
    config({ candidates: [configuredCandidate, configuredCandidate] }),
    config({ candidates: [configuredCandidate, { ...configuredCandidate, id: 'other', account_id: 'missing' }] }),
    config({ candidates: [configuredCandidate, { ...configuredCandidate, id: 'other', tool: 'unknown' }] }),
    config({
      candidates: [
        {
          ...config().candidates[0],
          thinking_levels: [
            { id: 'same', description: 'one' },
            { id: 'same', description: 'two' },
          ],
        },
      ],
    }),
    config({ tools: ['codex', 'codex'] }),
  ];
  for (const raw of cases) await rejectsConfig(jsonReader(raw));
});

test('disabled candidates remain configured and empty inventory is valid for approval', async () => {
  const configuredCandidate = config().candidates[0];
  assert.ok(configuredCandidate);
  const raw = config({ tools: ['pi'], candidates: [configuredCandidate] });
  const result = await loadConfig(undefined, {
    env: { HOME: '/isolated/home' },
    cwd,
    readText: jsonReader(raw),
  });
  assert.equal(result.candidates.length, 1);
  const [retainedCandidate] = result.candidates;
  assert.ok(retainedCandidate);
  assert.equal(retainedCandidate.tool, 'codex');

  const empty = await loadConfig(undefined, {
    env: { HOME: '/isolated/home' },
    cwd,
    readText: jsonReader(config({ tools: [], candidates: [] })),
  });
  assert.deepEqual(empty.candidates, []);
});

test('all config errors use safe constant messages', async () => {
  const text = 'private-supplied-content';
  await assert.rejects(
    loadConfig(undefined, {
      env: { HOME: '/isolated/home' },
      cwd,
      readText: async () => JSON.stringify({ ...config(), extra: text }),
    }),
    (error) => error instanceof StewardError && error.code === 'invalid_config' && !error.message.includes(text),
  );
});
