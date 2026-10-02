import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = process.env.AGENT_STEWARD_PACKAGE;
const skillSource = process.env.AGENT_STEWARD_SKILL_SOURCE;
const packagedProcessPath = pkg ? join(pkg, 'lib/agent-steward/dist/src/process.js') : undefined;
const packagedProcess =
  packagedProcessPath && existsSync(packagedProcessPath)
    ? await import(pathToFileURL(packagedProcessPath).href)
    : undefined;

type IsolatedHome = {
  root: string;
  home: string;
  xdg: string;
  run: (args: string[], input?: string) => SpawnSyncReturns<string>;
};
function withIsolatedHome(callback: (context: IsolatedHome) => void): void {
  assert.ok(pkg, 'installed tests require the explicit package path');
  const packagePath = pkg;
  const root = mkdtempSync(join(tmpdir(), 'steward-installed-'));
  try {
    const home = join(root, 'home'),
      xdg = join(root, 'xdg');
    mkdirSync(home);
    mkdirSync(xdg);
    const run = (args: string[], input?: string): SpawnSyncReturns<string> =>
      spawnSync(join(packagePath, 'bin/agent-steward'), args, {
        cwd: root,
        env: { HOME: home, XDG_CONFIG_HOME: xdg, PATH: '' },
        encoding: 'utf8',
        input,
      });
    callback({ root, home, xdg, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(config));
}

function parsed(result: SpawnSyncReturns<string>) {
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 1, result.stderr);
  return JSON.parse(result.stdout);
}

test.skipIf(!pkg)('installed help needs neither checkout nor global runtimes and skill bytes match', () => {
  assert.ok(pkg, 'installed check must receive the explicit package path');
  assert.ok(isAbsolute(pkg), 'package path is absolute');
  assert.ok(skillSource, 'installed check must receive the explicit source skill path');
  withIsolatedHome(({ run }) => {
    for (const command of ['node', 'bun', 'npm']) {
      const unavailable = spawnSync(command, ['--version'], { env: { PATH: '' }, encoding: 'utf8' });
      assert.equal(
        (unavailable.error as NodeJS.ErrnoException | undefined)?.code,
        'ENOENT',
        `${command} must not be available on PATH`,
      );
    }
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /router start/);
    assert.match(result.stdout, /stop check/);
    assert.doesNotMatch(result.stdout, /approval check/);
    const skill = readFileSync(join(pkg, 'share/agent-steward/skills/agent-steward/SKILL.md'), 'utf8');
    assert.ok(skill.includes('name: agent-steward'));
    assert.equal(skill, readFileSync(skillSource, 'utf8'));
  });
});

test.skipIf(!pkg)('installed failures stay local, structured, and credential-free', () => {
  withIsolatedHome(({ root, xdg, run }) => {
    const missing = parsed(run(['router', 'start', 'task', '--dry-run', '--json']));
    assert.equal(missing.reason_code, 'invalid_config');

    const noLaunch = parsed(run(['router', 'start', 'task', '--json']));
    assert.equal(noLaunch.reason_code, 'invalid_input');

    const noTerminal = parsed(run(['router', 'start', 'task']));
    assert.equal(noTerminal.reason_code, 'interactive_terminal_required');

    const badConfig = join(root, 'bad.json');
    writeFileSync(badConfig, '{');
    assert.equal(
      parsed(run(['--config', badConfig, 'router', 'start', 'task', '--dry-run', '--json'])).reason_code,
      'invalid_config',
    );

    const stop = {
      schema_version: 2,
      request_id: 'installed-request',
      agent: { id: 'agent', tool: 'codex', pane_id: 'w1:p1', session_id: null },
      status: 'blocked',
      current_episode_id: 'episode-1',
      context: 'A current stopped task needs an assessment.',
      pending_action: { action: 'Assess the current request' },
      automatic_approval_forbidden: false,
      retry: {
        failure_episode_id: 'episode-1',
        first_observed_at: '2026-09-29T10:00:00Z',
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
      },
    };
    mkdirSync(join(xdg, 'agent-steward'));
    writeConfig(join(xdg, 'agent-steward', 'config.json'), { tools: [], candidates: [] });

    const local = { ...stop, request_id: 'installed-local', context: null };
    const localResult = run(['stop', 'check'], JSON.stringify(local));
    assert.equal(localResult.status, 2);
    assert.equal(parsed(localResult).schema_version, 2);
    assert.equal(parsed(localResult).reason_code, 'insufficient_context');
    assert.equal(parsed(localResult).request_id, 'installed-local');

    const missingKey = parsed(run(['stop', 'check'], JSON.stringify(stop)));
    assert.equal(missingKey.schema_version, 2);
    assert.equal(missingKey.reason_code, 'missing_credentials');
    assert.equal(missingKey.request_id, 'installed-request');

    const malformed = parsed(run(['stop', 'check'], '{'));
    assert.equal(malformed.schema_version, 2);
    assert.equal(malformed.reason_code, 'invalid_input');
    assert.equal(malformed.request_id, null);

    const obsolete = parsed(run(['approval', 'check'], JSON.stringify(stop)));
    assert.equal(obsolete.schema_version, 1);
    assert.equal(obsolete.reason_code, 'invalid_input');
  });
});

test.skipIf(!pkg || !packagedProcess)(
  'packaged foreground adapter launches one offline fake executable with selected task argv',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'steward-fake-native-'));
    const alias = `${root}-alias`;
    try {
      symlinkSync(root, alias, 'dir');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const executable = join(bin, 'pi');
      const capture = join(root, 'capture.jsonl');
      writeFileSync(
        executable,
        `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.STUB_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), hasKey: 'TYPESAFE_API_KEY' in process.env, providerKey: process.env.OPENAI_API_KEY }) + '\\n');\n`,
        { mode: 0o700 },
      );

      const args = ['--model', 'requested-model', '--', 'User task:\nOffline fake only'];
      const status = await packagedProcess.launchForeground(
        { executable: 'pi', args },
        {
          cwd: alias,
          env: {
            PATH: bin,
            STUB_CAPTURE: capture,
            TYPESAFE_API_KEY: 'SyntheticStewardKey-Not-Real',
            OPENAI_API_KEY: 'SyntheticProviderKey-Not-Real',
          },
        },
      );

      assert.equal(status, 0);
      const records = readFileSync(capture, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], {
        argv: args,
        cwd: realpathSync(root),
        hasKey: false,
        providerKey: 'SyntheticProviderKey-Not-Real',
      });
    } finally {
      rmSync(alias, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  12000,
);

test.skipIf(!pkg)('installed routing ignores cwd bucket files and reads trusted state snapshots', () => {
  withIsolatedHome(({ root, home, xdg, run }) => {
    const configDir = join(xdg, 'agent-steward');
    mkdirSync(configDir);
    writeConfig(join(configDir, 'config.json'), {
      tools: ['codex'],
      candidates: [
        {
          id: 'codex-local',
          tool: 'codex',
          provider: 'openai',
          model: 'example-model',
          quota_bucket: 'codex',
          quota_pool: 'primary',
          capabilities: 'test only',
          thinking_levels: [{ id: 'low', description: 'low' }],
        },
      ],
    });
    const snapshot = {
      schema_version: 1,
      source: 'codex',
      identity_fingerprint: 'ab'.repeat(32),
      windows: [],
    };
    writeConfig(join(root, 'codex'), snapshot);
    const missing = run(['router', 'start', 'task', '--dry-run', '--json']);
    assert.equal(missing.status, 1);
    assert.equal(parsed(missing).reason_code, 'missing_credentials');
    assert.match(missing.stderr, /quota_missing/);

    const quotaDir = join(home, '.local/state/agent-steward/quota');
    mkdirSync(quotaDir, { recursive: true });
    writeConfig(join(quotaDir, 'codex.json'), snapshot);
    const result = run(['router', 'start', 'task', '--dry-run', '--json']);
    assert.equal(result.status, 1);
    assert.equal(parsed(result).reason_code, 'missing_credentials');
    assert.equal(result.stderr, '');
  });
});

test.skipIf(!pkg)('installed bundle contains no account, quota, example, or session inputs', () => {
  assert.ok(pkg, 'installed check must receive the explicit package path');
  const root = join(pkg, 'lib/agent-steward');
  assert.ok(existsSync(root), 'application bundle must use the runtime-neutral lib path');
  const entries: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      entries.push(full);
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  visit(join(pkg, 'share/agent-steward'));
  assert.ok(packagedProcess, 'installed app must be under lib/agent-steward');
  assert.ok(existsSync(join(root, 'bun/bin/bun')), 'package-local Bun must be present');
  assert.ok(entries.some((path) => path.endsWith('/dist/src/main.js')));
  for (const dependency of ['@types', 'typescript', 'oxlint', 'oxfmt']) {
    assert.equal(existsSync(join(root, 'node_modules', dependency)), false, `package must exclude ${dependency}`);
  }
  assert.ok(entries.every((path) => !/(?:^|\/)(?:examples|sessions|tests|\.beads|\.internal)(?:\/|$)/i.test(path)));
  assert.ok(entries.every((path) => !path.endsWith('.ts')));
  assert.ok(entries.every((path) => !/(?:config|quota|approval|account|session)\.json$/i.test(path)));
});
