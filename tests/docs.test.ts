import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StopInputSchema } from '../src/contracts.ts';
import { parseArgs, run } from '../src/cli.ts';
import type { Invocation, Runtime } from '../src/cli.ts';

const skill = readFileSync(new URL('../skills/agent-steward/SKILL.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const stopExample = JSON.parse(readFileSync(new URL('../examples/stop.json', import.meta.url), 'utf8'));

function parseSkillCommands(text: string): string[] {
  return [...text.matchAll(/^```bash\n([\s\S]*?)\n```/gm)]
    .flatMap((match) => match[1]!.split('\n'))
    .filter((line) => line.startsWith('agent-steward '));
}

function shellWords(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

function invocationForm(invocation: Invocation): string {
  if (invocation.kind === 'help') return 'help';
  if (invocation.kind === 'stop') return 'stop-stdin';
  return invocation.task.startsWith('-') ? 'route-literal-task' : 'route-task';
}

function parseUsageForm(line: string): Invocation {
  let form = line.replace(/^agent-steward\s+/, '');
  form = form.replace(/^\[--config <path>\]\s+/, '--config config.json ');
  form = form.replace('session start <task> --dry-run [--json]', 'session start "Review the parser" --dry-run --json');
  form = form.replace('session start <task>', 'session start "Review the parser"');
  form = form.replace('session start --dry-run -- <task>', 'session start --dry-run -- --help');
  form = form.replace('stop check < stopped-state.json', 'stop check');
  return parseArgs(shellWords(form));
}

async function emittedHelp(): Promise<string> {
  const out: string[] = [];
  const runtime: Runtime = {
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
    terminal: { stdin: false, stdout: false },
    launch: async () => {
      throw new Error('help must not launch');
    },
  };
  await run(['--help'], runtime);
  return out.join('');
}

test('bundled skill command forms match parsed actual CLI help and parser behavior', async () => {
  const usage = [...(await emittedHelp()).matchAll(/^  (agent-steward .+)$/gm)].map((match) => match[1]!);
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
  const routes = invocations.filter((item) => item.kind === 'route');
  assert.equal(routes.length, 3);
  const [firstRoute, secondRoute, thirdRoute] = routes;
  assert.ok(firstRoute && secondRoute && thirdRoute);
  assert.equal(firstRoute.task, 'Review the parser');
  assert.equal(firstRoute.dryRun, false);
  assert.equal(firstRoute.json, false);
  assert.equal(secondRoute.task, 'Review the parser');
  assert.equal(secondRoute.dryRun, true);
  assert.equal(secondRoute.json, true);
  assert.equal(thirdRoute.task, '--help');
  assert.equal(thirdRoute.dryRun, true);
  assert.equal(thirdRoute.json, false);
});

test('skill stop JSON example parses with the real strict schema', () => {
  const block = skill.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'skill must include an actual stop JSON example');
  const example = block[1];
  assert.ok(example, 'skill stop JSON example must contain a JSON body');
  const input = JSON.parse(example);
  assert.equal(StopInputSchema.parse(input).status, 'blocked');
  assert.equal(input.current_episode_id, input.retry.failure_episode_id);
  assert.equal(StopInputSchema.parse(stopExample).current_episode_id, stopExample.retry.failure_episode_id);
});

test('optional adapter documents incomplete shutdown and offline recovery boundaries', () => {
  const section = readme
    .split('### Optional Herdr adapter (not activated)')[1]
    ?.split('\n## Command preview references')[0];
  assert.ok(section, 'README must retain the optional adapter section');
  for (const term of [
    'shutdown_incomplete',
    'release unconfirmed',
    'five seconds',
    'event hooks may still',
    'pre-admitted',
    'offline',
    'generation tombstones',
    '15-second',
  ])
    assert.ok(section.includes(term), `optional adapter section must include ${term}`);
});

test('unreleased portability does not rewrite published-alpha or live-runtime claims', () => {
  for (const platform of ['x86_64-linux', 'aarch64-linux', 'aarch64-darwin']) assert.ok(readme.includes(platform));
  assert.match(readme, /Published `v0\.1\.0-alpha\.1` remains the Linux-only release/);
  assert.match(readme, /Portable packaging is unreleased/);
  assert.match(readme, /Export\/evaluation is not native validation/);
  assert.match(readme, /Three-platform validation is established only when all three native\s+jobs/);
  assert.match(readme, /Installing the bundled adapter does not activate it/);
});

test('managed delegation is skill-driven existing transport, not patched subagent API', () => {
  assert.ok(skill.includes('herdr plugin pane open'));
  assert.ok(skill.includes('--entrypoint argv'));
  assert.ok(skill.includes('same complete instruction'));
  const managedDelegation = skill.split('For managed delegation,')[1]?.split('\nRespect spawning restrictions:')[0];
  assert.ok(managedDelegation, 'skill must include the managed-delegation instructions');
  assert.match(
    managedDelegation,
    /complete `instruction` must include this invocation's unique `name`, assigned absolute `assigned_cwd`, and agreed report\/notification identity/,
  );
  assert.ok(skill.includes('automatic result delivery'));
  assert.ok(skill.includes('spawning restrictions'));
  assert.ok(!skill.includes('executor: "agent-steward"'));
  assert.ok(!skill.includes('--native-prompt-file'));
  assert.ok(!skill.includes('routingBrief'));
});
