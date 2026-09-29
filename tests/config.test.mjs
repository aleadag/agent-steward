import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/src/config.js';
import { StewardError } from '../dist/src/contracts.js';
import { config } from './helpers.mjs';

const cwd = '/work';
const jsonReader = (raw) => async (path) => JSON.stringify(raw);

async function rejectsConfig(readText, env = { HOME: '/isolated/home' }, override) {
  await assert.rejects(
    loadConfig(override, { env, cwd, readText }),
    (error) => error instanceof StewardError && error.code === 'invalid_config',
  );
}

test('XDG config, relative quota path, and nested defaults', async () => {
  const raw = config();
  raw.accounts[0].snapshot = 'quota.json';
  delete raw.jev;
  raw.thresholds = { risky: 0.7 };
  const reads = [];
  const result = await loadConfig(undefined, {
    env: { HOME: '/isolated/home', XDG_CONFIG_HOME: '/isolated/xdg' },
    cwd: '/work',
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(raw);
    },
  });
  assert.deepEqual(reads, ['/isolated/xdg/agent-steward/config.json']);
  assert.equal(result.accounts[0].snapshot, '/isolated/xdg/agent-steward/quota.json');
  assert.equal(result.jev.model, 'jev-1.13.0');
  assert.deepEqual(result.thresholds, { risky: 0.7, choiceConfidence: 0.45 });
});

test('HOME fallback and relative explicit config resolve snapshots from its directory', async () => {
  const raw = config();
  raw.accounts[0].snapshot = '../quota.json';
  const reads = [];
  const result = await loadConfig('settings/config.json', {
    env: { HOME: '/isolated/home' },
    cwd,
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(raw);
    },
  });
  assert.deepEqual(reads, ['/work/settings/config.json']);
  assert.equal(result.accounts[0].snapshot, '/work/quota.json');

  const homeReads = [];
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

test('absolute override is used as-is and absolute snapshot remains absolute', async () => {
  const raw = config();
  raw.accounts[0].snapshot = '/snapshots/quota.json';
  const reads = [];
  const result = await loadConfig('/isolated/custom.json', {
    env: {},
    cwd,
    readText: async (path) => {
      reads.push(path);
      return JSON.stringify(raw);
    },
  });
  assert.deepEqual(reads, ['/isolated/custom.json']);
  assert.equal(result.accounts[0].snapshot, '/snapshots/quota.json');
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
      (error) => error.code === 'invalid_config' && !error.message.includes('/private'),
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
      (error) => error.code === 'invalid_config' && !error.message.includes(content.slice(0, 40)),
    );
  }
});

test('unknown fields, credential fields, and prototype keys fail without mutation', async () => {
  const raw = config();
  raw.api_key = 'not-a-real-secret';
  await rejectsConfig(jsonReader(raw));

  const parsed = JSON.parse(
    '{"tools":["codex"],"accounts":[],"candidates":[],"__proto__":{"polluted":true},"constructor":{"polluted":true}}',
  );
  const before = Object.prototype.polluted;
  await rejectsConfig(jsonReader(parsed));
  assert.equal(Object.prototype.polluted, before);
});

test('invalid references and duplicate identities fail before returning config', async () => {
  const cases = [
    config({
      accounts: [
        { id: 'shared', source: 'codex' },
        { id: 'shared', source: 'antigravity' },
      ],
    }),
    config({ candidates: [config().candidates[0], config().candidates[0]] }),
    config({ candidates: [config().candidates[0], { ...config().candidates[0], id: 'other', account_id: 'missing' }] }),
    config({ candidates: [config().candidates[0], { ...config().candidates[0], id: 'other', tool: 'unknown' }] }),
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
  const raw = config({ tools: ['pi'], candidates: [config().candidates[0]] });
  const result = await loadConfig(undefined, {
    env: { HOME: '/isolated/home' },
    cwd,
    readText: jsonReader(raw),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].tool, 'codex');

  const empty = await loadConfig(undefined, {
    env: { HOME: '/isolated/home' },
    cwd,
    readText: jsonReader(config({ tools: [], accounts: [], candidates: [] })),
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
    (error) => error.code === 'invalid_config' && !error.message.includes(text),
  );
});
