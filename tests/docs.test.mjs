import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StopInputSchema } from '../dist/src/contracts.js';
import { parseArgs, run } from '../dist/src/cli.js';

const skill = readFileSync(new URL('../skills/agent-steward/SKILL.md', import.meta.url), 'utf8');
const stopExample = JSON.parse(readFileSync(new URL('../examples/stop.json', import.meta.url), 'utf8'));

function parseSkillCommands(text) {
  return [...text.matchAll(/^```bash\n([\s\S]*?)\n```/gm)]
    .flatMap((match) => match[1].split('\n'))
    .filter((line) => line.startsWith('agent-steward '));
}

function shellWords(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function invocationForm(invocation) {
  if (invocation.kind === 'help') return 'help';
  if (invocation.kind === 'stop') return 'stop-stdin';
  return invocation.task.startsWith('-') ? 'route-literal-task' : 'route-task';
}

function parseUsageForm(line) {
  let form = line.replace(/^agent-steward\s+/, '');
  form = form.replace(/^\[--config <path>\]\s+/, '--config config.json ');
  form = form.replace('session start <task> --dry-run [--json]', 'session start "Review the parser" --dry-run --json');
  form = form.replace('session start <task>', 'session start "Review the parser"');
  form = form.replace('session start --dry-run -- <task>', 'session start --dry-run -- --help');
  form = form.replace('stop check < stopped-state.json', 'stop check');
  return parseArgs(shellWords(form));
}

async function emittedHelp() {
  const out = [];
  await run(['--help'], {
    env: {},
    cwd: '/isolated/work',
    readText: async () => {
      throw new Error('help must not read files');
    },
    readStdin: async () => {
      throw new Error('help must not read stdin');
    },
    stdout: (text) => out.push(text),
    stderr: () => {},
    now: () => new Date(0),
    newRequestId: () => 'unused',
    post: async () => {
      throw new Error('help must not post');
    },
  });
  return out.join('');
}

test('bundled skill command forms match parsed actual CLI help and parser behavior', async () => {
  const usage = [...(await emittedHelp()).matchAll(/^  (agent-steward .+)$/gm)].map((match) => match[1]);
  assert.ok(usage.length > 0, 'run --help must emit parseable usage forms');
  const implementedForms = usage.map((line) => invocationForm(parseUsageForm(line)));
  const skillForms = parseSkillCommands(skill).map((line) => {
    let command = line.slice('agent-steward '.length).replace(/\s+<\s+stopped-state\.json$/, '');
    return invocationForm(parseArgs(shellWords(command)));
  });
  assert.deepEqual(skillForms, implementedForms);
  const invocations = parseSkillCommands(skill).map((line) => {
    const command = line.slice('agent-steward '.length).replace(/\s+<\s+stopped-state\.json$/, '');
    return parseArgs(shellWords(command));
  });
  assert.deepEqual(
    invocations.map((item) => item.kind),
    ['help', 'route', 'route', 'route', 'stop'],
  );
  assert.equal(invocations[1].task, 'Review the parser');
  assert.equal(invocations[1].dryRun, false);
  assert.equal(invocations[1].json, false);
  assert.equal(invocations[2].task, 'Review the parser');
  assert.equal(invocations[2].dryRun, true);
  assert.equal(invocations[2].json, true);
  assert.equal(invocations[3].task, '--help');
  assert.equal(invocations[3].dryRun, true);
  assert.equal(invocations[3].json, false);
});

test('skill stop JSON example parses with the real strict schema', () => {
  const block = skill.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'skill must include an actual stop JSON example');
  const input = JSON.parse(block[1]);
  assert.equal(StopInputSchema.parse(input).status, 'blocked');
  assert.equal(input.current_episode_id, input.retry.failure_episode_id);
  assert.equal(StopInputSchema.parse(stopExample).current_episode_id, stopExample.retry.failure_episode_id);
});
