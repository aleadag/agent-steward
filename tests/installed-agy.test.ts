import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const pkg = process.env.AGENT_STEWARD_PACKAGE;
const fakeSource = process.env.AGENT_STEWARD_FAKE_AGY;
function fixture(
  run: (f: {
    root: string;
    home: string;
    state: string;
    settings: string;
    manifest: string;
    dest: string;
    observer: string;
    command: (args: string[], input?: string, scenario?: string) => SpawnSyncReturns<string>;
  }) => void,
) {
  assert.ok(pkg && fakeSource);
  const root = mkdtempSync(join(tmpdir(), 'installed-agy-'));
  const home = join(root, 'home'),
    state = join(root, 'state'),
    bin = join(root, 'bin');
  try {
    for (const path of [home, state, bin, join(home, '.gemini/antigravity-cli'), join(home, '.config/agent-steward')])
      mkdirSync(path, { recursive: true });
    const bun = join(pkg, 'lib/agent-steward/bun/bin/bun'),
      steward = join(pkg, 'bin/agent-steward'),
      observer = join(root, 'observer.json');
    writeFileSync(join(bin, 'agy'), `#!${bun}\nawait import(${JSON.stringify(pathToFileURL(fakeSource).href)});\n`, {
      mode: 0o755,
    });
    const claims = Buffer.from(
      JSON.stringify({ iss: 'https://accounts.google.com', sub: 'synthetic-subject' }),
    ).toString('base64url');
    writeFileSync(
      join(home, '.gemini/antigravity-cli/antigravity-oauth-token'),
      JSON.stringify({
        auth_method: 'consumer',
        id_token: `header.${claims}.signature`,
        token: {
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          token_type: 'Bearer',
          expiry: '2050-01-01T00:00:00Z',
        },
      }),
    );
    const renderer = join(root, 'renderer.ts'),
      spy = join(root, 'renderer-input');
    writeFileSync(
      renderer,
      `await Bun.write(${JSON.stringify(spy)},await Bun.stdin.text());console.error('private renderer error');console.log('old display');`,
    );
    const settings = join(home, '.gemini/antigravity-cli/settings.json');
    writeFileSync(
      settings,
      JSON.stringify({
        statusLine: { type: 'command', command: `'${bun}' '${renderer}'`, padding: 1 },
        unrelated: 'keep',
      }),
    );
    writeFileSync(
      join(home, '.config/agent-steward/config.json'),
      JSON.stringify({
        tools: ['agy'],
        candidates: [
          {
            id: 'gemini',
            tool: 'agy',
            provider: 'google',
            model: 'gemini-3.8-flash',
            capabilities: 'test',
            quota_bucket: 'antigravity',
            quota_pool: 'gemini',
            cost: 1,
            thinking_levels: [{ id: 'medium', description: 'test' }],
          },
        ],
      }),
    );
    const command = (args: string[], input?: string, scenario = 'success') =>
      spawnSync(steward, args, {
        cwd: root,
        input,
        encoding: 'utf8',
        timeout: 55000,
        env: {
          HOME: home,
          XDG_STATE_HOME: state,
          PATH: bin,
          STEWARD_FAKE_AGY_PACKAGE: pkg,
          STEWARD_FAKE_AGY_CASE: scenario,
          STEWARD_FAKE_AGY_OBSERVER: observer,
          STEWARD_FAKE_AGY_HOOK: JSON.stringify([steward]),
        },
      });
    run({
      root,
      home,
      state,
      settings,
      manifest: join(state, 'agent-steward/agy/statusline.json'),
      dest: join(state, 'agent-steward/quota/antigravity.json'),
      observer,
      command,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test.skipIf(!pkg)('installed setup, preserving hook and non-TTY refresh use only package-local runtimes', () =>
  fixture((f) => {
    const setup = f.command(['quota', 'setup', 'agy']);
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /trust/i);
    const settings = JSON.parse(readFileSync(f.settings, 'utf8'));
    assert.equal(settings.unrelated, 'keep');
    assert.ok(settings.statusLine.command.includes(join(pkg!, 'bin/agent-steward')));
    const ordinary = '  { malformed ordinary bytes\n';
    const hook = f.command(['quota', 'hook', 'agy'], ordinary);
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout, 'old display\n');
    assert.equal(readFileSync(join(f.root, 'renderer-input'), 'utf8'), ordinary);
    assert.equal(existsSync(f.dest), false);
    const refreshed = f.command(['quota', 'refresh', '--json']);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(refreshed.stdout).buckets, [{ bucket: 'antigravity', status: 'written' }]);
    const snapshot = JSON.parse(readFileSync(f.dest, 'utf8'));
    assert.equal(snapshot.source, 'antigravity');
    assert.equal(snapshot.windows.length, 4);
    assert.ok(snapshot.windows.every((w: { remaining_percent: number }) => w.remaining_percent === 50));
    assert.doesNotMatch(
      refreshed.stdout + refreshed.stderr + JSON.stringify(snapshot),
      /old display|private renderer|synthetic-access|synthetic-subject|synthetic-native-secret|Models & Quota/,
    );
    const observer = JSON.parse(readFileSync(f.observer, 'utf8'));
    assert.equal(observer.cwd, realpathSync(join(f.state, 'agent-steward/agy-quota-workdir')));
    assert.equal(existsSync(observer.socketPath), false);
    assert.throws(() => process.kill(observer.pid, 0));
  }),
);
test.skipIf(!pkg)('installed native refusals fail without prompts and preserve the previous snapshot', () =>
  fixture((f) => {
    assert.equal(f.command(['quota', 'setup', 'agy']).status, 0);
    assert.equal(f.command(['quota', 'refresh', '--json']).status, 0);
    const original = readFileSync(f.dest, 'utf8');
    for (const scenario of ['trust', 'auth', 'unknown', 'error']) {
      const result = f.command(['quota', 'refresh', '--json'], undefined, scenario);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).buckets[0].status, scenario === 'auth' ? 'auth' : 'fetch');
      assert.equal(readFileSync(f.dest, 'utf8'), original);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-|Models & Quota|old display/);
    }
    const settings = JSON.parse(readFileSync(f.settings, 'utf8'));
    settings.statusLine.command = 'user-owned replacement';
    writeFileSync(f.settings, JSON.stringify(settings));
    const before = readFileSync(f.settings, 'utf8');
    const refused = f.command(['quota', 'setup', 'agy']);
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(f.settings, 'utf8'), before);
    assert.equal(refused.stderr, 'agent-steward: quota_agy_setup\n');
  }),
);
test.skipIf(!pkg)(
  'installed service deadline terminates its owned native session',
  () =>
    fixture((f) => {
      assert.equal(f.command(['quota', 'setup', 'agy']).status, 0);
      const start = performance.now();
      const result = f.command(['quota', 'refresh', '--json'], undefined, 'timeout');
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stdout).buckets, [{ bucket: 'antigravity', status: 'fetch' }]);
      assert.ok(performance.now() - start >= 44000 && performance.now() - start < 51000);
      const observer = JSON.parse(readFileSync(f.observer, 'utf8'));
      assert.equal(existsSync(observer.socketPath), false);
      assert.throws(() => process.kill(observer.pid, 0));
      assert.equal(existsSync(f.dest), false);
    }),
  60000,
);

test.skipIf(!pkg)('installed native renewal and incomplete pools feed an offline injected route', async () => {
  let context: { home: string; state: string; snapshot: string; config: string } | undefined;
  fixture((f) => {
    assert.equal(f.command(['quota', 'setup', 'agy']).status, 0);
    const auth = join(f.home, '.gemini/antigravity-cli/antigravity-oauth-token'),
      before = JSON.parse(readFileSync(auth, 'utf8'));
    before.token.expiry = '2000-01-01T00:00:00Z';
    writeFileSync(auth, JSON.stringify(before));
    const renewed = f.command(['quota', 'refresh', '--json'], undefined, 'renew');
    assert.equal(renewed.status, 0, renewed.stderr);
    assert.notEqual(JSON.parse(readFileSync(auth, 'utf8')).token.expiry, before.token.expiry);
    const incomplete = f.command(['quota', 'refresh', '--json'], undefined, 'incomplete');
    assert.equal(incomplete.status, 0, incomplete.stderr);
    context = {
      home: f.home,
      state: f.state,
      snapshot: readFileSync(f.dest, 'utf8'),
      config: readFileSync(join(f.home, '.config/agent-steward/config.json'), 'utf8'),
    };
  });
  assert.ok(context && pkg);
  const { loadQuota } = await import(pathToFileURL(join(pkg, 'lib/agent-steward/dist/src/quota.js')).href);
  const { ConfigSchema } = await import(pathToFileURL(join(pkg, 'lib/agent-steward/dist/src/contracts.js')).href);
  const { route } = await import(pathToFileURL(join(pkg, 'lib/agent-steward/dist/src/routing.js')).href);
  const raw = JSON.parse(context.config);
  raw.candidates.push({ ...raw.candidates[0], id: 'third', quota_pool: 'third_party' });
  const cfg = ConfigSchema.parse(raw);
  let reads = 0;
  const facts = await loadQuota(cfg, {
    env: { HOME: context.home, XDG_STATE_HOME: context.state },
    now: new Date(),
    readText: async (path: string) => {
      reads++;
      assert.ok(path.endsWith('/quota/antigravity.json'));
      return context!.snapshot;
    },
    diagnostic: () => {},
  });
  assert.equal(reads, 1);
  assert.equal(facts.get('gemini').pool_status, 'known');
  assert.equal(facts.get('third').pool_status, 'unknown');
  const routed = await route({
    task: 'offline fixture',
    requestId: 'offline-request',
    now: new Date(),
    config: cfg,
    quota: facts,
    evaluate: async () => ({
      model: 'fixture',
      answers: { pair: { type: 'choice', choice: 'gemini', confidence: 1, probabilities: { gemini: 1, third: 0 } } },
      usage: {},
    }),
  });
  assert.equal(routed.selected.candidate_id, 'gemini');
  assert.equal(routed.quota.pool_status, 'known');
  assert.equal(reads, 1);
});
