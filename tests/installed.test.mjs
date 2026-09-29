import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const pkg = process.env.AGENT_STEWARD_PACKAGE;
const skillSource = process.env.AGENT_STEWARD_SKILL_SOURCE;

function withIsolatedHome(callback) {
  const root = mkdtempSync(join(tmpdir(), 'steward-installed-'));
  try {
    const home = join(root, 'home'), xdg = join(root, 'xdg');
    mkdirSync(home); mkdirSync(xdg);
    const run = (args, input) => spawnSync(join(pkg, 'bin/agent-steward'), args, {
      cwd: root, env: { HOME: home, XDG_CONFIG_HOME: xdg, PATH: '' }, encoding: 'utf8', input,
    });
    callback({ root, home, xdg, run });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function writeConfig(path, config) {
  writeFileSync(path, JSON.stringify(config));
}

function parsed(result) {
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 1, result.stderr);
  return JSON.parse(result.stdout);
}

test('installed help needs neither checkout nor global Node and skill bytes match', { skip: !pkg }, () => {
  assert.ok(isAbsolute(pkg), 'package path is absolute');
  assert.ok(skillSource, 'installed check must receive the explicit source skill path');
  withIsolatedHome(({ run }) => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /session start/);
    assert.match(result.stdout, /approval check/);
    const skill = readFileSync(join(pkg, 'share/agent-steward/skills/agent-steward/SKILL.md'), 'utf8');
    assert.ok(skill.includes('name: agent-steward'));
    assert.equal(skill, readFileSync(skillSource, 'utf8'));
  });
});

test('installed failures stay local, structured, and credential-free', { skip: !pkg }, () => {
  withIsolatedHome(({ root, xdg, run }) => {
    const missing = parsed(run(['session', 'start', 'task', '--dry-run', '--json']));
    assert.equal(missing.reason_code, 'invalid_config');

    const noLaunch = parsed(run(['session', 'start', 'task', '--json']));
    assert.equal(noLaunch.reason_code, 'execution_unavailable');

    const badConfig = join(root, 'bad.json');
    writeFileSync(badConfig, '{');
    assert.equal(parsed(run(['--config', badConfig, 'session', 'start', 'task', '--dry-run', '--json'])).reason_code, 'invalid_config');

    const approval = { schema_version: 1, request_id: 'installed-request', agent: { id: 'agent', tool: 'codex' }, status: 'stopped', context: 'A current stopped task needs an assessment.' };
    mkdirSync(join(xdg, 'agent-steward'));
    writeConfig(join(xdg, 'agent-steward', 'config.json'), { tools: [], accounts: [], candidates: [] });
    const missingKey = parsed(run(['approval', 'check'], JSON.stringify(approval)));
    assert.equal(missingKey.reason_code, 'missing_credentials');
    assert.equal(missingKey.request_id, 'installed-request');

    const malformed = parsed(run(['approval', 'check'], '{'));
    assert.equal(malformed.reason_code, 'invalid_input');
    assert.equal(malformed.request_id, null);
  });
});

test('installed routing reads a relative quota snapshot before a local missing-key failure', { skip: !pkg }, () => {
  withIsolatedHome(({ root, xdg, run }) => {
    const configDir = join(xdg, 'agent-steward');
    mkdirSync(configDir);
    writeConfig(join(configDir, 'config.json'), {
      tools: ['codex'],
      accounts: [{ id: 'local', source: 'codex', snapshot: 'quota.json' }],
      candidates: [{
        id: 'codex-local', tool: 'codex', provider: 'openai', model: 'example-model', account_id: 'local', quota_pool: 'primary',
        capabilities: 'test only', thinking_levels: [{ id: 'low', description: 'low' }],
      }],
    });
    writeConfig(join(configDir, 'quota.json'), { schema_version: 1, source: 'codex', account_id: 'local', windows: [] });
    const result = run(['session', 'start', 'task', '--dry-run', '--json']);
    assert.equal(result.status, 1);
    assert.equal(parsed(result).reason_code, 'missing_credentials');
    assert.equal(result.stderr, '');
  });
});

test('installed bundle contains no account, quota, example, or session inputs', { skip: !pkg }, () => {
  const root = join(pkg, 'lib/node_modules/agent-steward');
  const entries = [];
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      entries.push(full);
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  visit(join(pkg, 'share/agent-steward'));
  assert.ok(entries.some(path => path.endsWith('/dist/src/main.js')));
  assert.ok(entries.every(path => !/(?:^|\/)(?:examples|sessions|\.beads|\.internal)(?:\/|$)/i.test(path)));
  assert.ok(entries.every(path => !/(?:config|quota|approval|account|session)\.json$/i.test(path)));
});
