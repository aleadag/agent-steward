import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApprovalInputSchema } from '../dist/src/contracts.js';
import { parseArgs, run } from '../dist/src/cli.js';

const skill = readFileSync(new URL('../skills/agent-steward/SKILL.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function parseSkillCommands(text) {
  return [...text.matchAll(/^```bash\n([\s\S]*?)\n```/gm)].flatMap(match => match[1].split('\n'))
    .filter(line => line.startsWith('agent-steward '));
}

function shellWords(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

function invocationForm(invocation) {
  if (invocation.kind === 'help') return 'help';
  if (invocation.kind === 'approval') return 'approval-stdin';
  return invocation.task.startsWith('-') ? 'route-literal-task' : 'route-task';
}

function parseUsageForm(line) {
  let form = line.replace(/^agent-steward\s+/, '');
  form = form.replace(/^\[--config <path>\]\s+/, '--config config.json ');
  form = form.replace('session start <task> [--dry-run] [--json]', 'session start Review --dry-run --json');
  form = form.replace('session start --dry-run -- <task>', 'session start --dry-run -- --help');
  form = form.replace('approval check < stopped-state.json', 'approval check');
  return parseArgs(shellWords(form));
}

async function emittedHelp() {
  const out = [];
  await run(['--help'], {
    env: {}, cwd: '/isolated/work',
    readText: async () => { throw new Error('help must not read files'); },
    readStdin: async () => { throw new Error('help must not read stdin'); },
    stdout: text => out.push(text), stderr: () => {}, now: () => new Date(0),
    newRequestId: () => 'unused', post: async () => { throw new Error('help must not post'); },
  });
  return out.join('');
}

test('bundled skill command forms match parsed actual CLI help and parser behavior', async () => {
  assert.match(skill, /^---\nname: agent-steward\ndescription: Use to route a task with agent-steward or assess a stopped agent[.] Session inspection, effort adjustment, and quota inspection apply only when supported by a later installed CLI version[.]\n---/);
  const usage = [...(await emittedHelp()).matchAll(/^  (agent-steward .+)$/gm)].map(match => match[1]);
  assert.ok(usage.length > 0, 'run --help must emit parseable usage forms');
  const implementedForms = usage.map(line => invocationForm(parseUsageForm(line)));
  const skillForms = parseSkillCommands(skill).map(line => {
    let command = line.slice('agent-steward '.length).replace(/\s+<\s+stopped-state\.json$/, '');
    return invocationForm(parseArgs(shellWords(command)));
  });
  assert.deepEqual(skillForms, implementedForms);
  const invocations = parseSkillCommands(skill).map(line => {
    const command = line.slice('agent-steward '.length).replace(/\s+<\s+stopped-state\.json$/, '');
    return parseArgs(shellWords(command));
  });
  assert.deepEqual(invocations.map(item => item.kind), ['help', 'route', 'route', 'approval']);
  assert.equal(invocations[2].task, '--help');
  for (const unavailable of ['session show', 'account list', 'usage refresh', 'session choose-effort']) {
    assert.match(skill, new RegExp(unavailable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.{0,100}(?:unavailable|not available|does not)', 'is'));
  }
  assert.match(skill, /does not launch agents/i);
});

test('skill approval example parses with the real strict schema and identifies user-supplied input', () => {
  const block = skill.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'skill must include an actual approval JSON example');
  const input = JSON.parse(block[1]);
  assert.equal(ApprovalInputSchema.parse(input).status, 'stopped');
  assert.match(skill, /user-prepared input/i);
  assert.match(skill, /TYPESAFE_API_KEY/);
  assert.match(skill, /no launch|does not launch/i);
  assert.match(skill, /recognizable credential/i);
  assert.match(skill, /unknown quota/i);
  assert.match(skill, /manual_review/);
  assert.match(skill, /no_action/);
  assert.match(skill, /automatic_approval_forbidden/);
  assert.match(skill, /assessment.{0,80}(?:not|does not).{0,40}permission/is);
});

test('README documents offline distribution, option boundary, schemas, baselines, caveat and manual skill setup', () => {
  for (const phrase of [
    'nix develop path:.', 'nix build path:.#agent-steward', 'nix flake check path:.',
    'nix run path:. --no-update-lock-file -- --help',
    'session start --dry-run -- "--help"', 'schema_version', 'request_id',
    '1,048,576', '64', 'Codex 0.157.1', 'Pi 0.87.1', '`agy` 1.2.11',
    'jev-1.13.0', 'skills/agent-steward/SKILL.md', 'manual', 'user-selected',
    'runtime model/effort', 'authentication/account binding',
  ]) assert.ok(readme.includes(phrase), `README missing ${phrase}`);
  assert.match(readme, /not available|unavailable/i);
  assert.match(readme, /copy|link/i);
  assert.doesNotMatch(readme, /\/nix\/store\/[0-9a-z]{32}/);
});

test('production CLI and entry sources have no child-process, write, or Herdr capability', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(cli + main, /from ['"]node:child_process['"]|from ['"]node:fs\/promises['"]|herdr|spawn\(|exec\(/i);
  assert.match(main, /readBoundedUtf8\(process\.stdin\)/);
  assert.match(main, /readFileText/);
  assert.match(main, /postHttps/);
  assert.match(main, /from ['"]node:process['"]/);
  assert.match(main, /^#!\/usr\/bin\/env node/);
  assert.match(main, /process\.exitCode\s*=\s*await run/);
});
