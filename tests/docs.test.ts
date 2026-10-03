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

function assertCommandParity(usage: string[], text: string): void {
  const implementedForms = usage.map(parseUsageForm);
  const skillForms = parseSkillCommands(text).map((line) => {
    const command = line.slice('agent-steward '.length).replace(/\s+<\s+stopped-state\.json$/, '');
    return parseArgs(shellWords(command));
  });
  assert.deepEqual(skillForms, implementedForms);
}

function parseUsageForm(line: string): Invocation {
  let form = line.replace(/^agent-steward\s+/, '');
  form = form.replace(/^\[--config <path>\]\s+/, '--config ./config.json ');
  form = form.replace('router start <task> --dry-run [--json]', 'router start "Review the parser" --dry-run --json');
  form = form.replace('router start <task>', 'router start "Review the parser"');
  form = form.replace('router start --dry-run -- <task>', 'router start --dry-run -- --help');
  form = form.replace('router list [--limit <n>]', 'router list');
  form = form.replace('router show <request-id> [--json]', 'router show "generated-id" --json');
  form = form.replace('stop check < stopped-state.json', 'stop check');
  form = form.replace('quota refresh [--json]', 'quota refresh --json');
  return parseArgs(shellWords(form));
}

async function emittedHelp(): Promise<string> {
  const out: string[] = [];
  const runtime: Runtime = {
    env: {},
    fileSize: async () => {
      throw new Error('help must not stat files');
    },
    withLedgerLock: async () => {
      throw new Error('help must not lock files');
    },
    appendText: async () => {
      throw new Error('help must not write files');
    },
    readTextIfPresent: async () => {
      throw new Error('help must not read ledger');
    },
    mkdirp: async () => {
      throw new Error('help must not create directories');
    },
    chmod: async () => {
      throw new Error('help must not change modes');
    },
    writeText: async () => {
      throw new Error('help must not write snapshots');
    },
    rename: async () => {
      throw new Error('help must not rename files');
    },
    unlink: async () => {
      throw new Error('help must not unlink files');
    },
    withAgyLock: async () => {
      throw new Error('help must not lock AGY');
    },
    collectAgy: async () => {
      throw new Error('help must not collect AGY');
    },
    setupAgy: async () => {
      throw new Error('help must not setup AGY');
    },
    runAgyHook: async () => {
      throw new Error('help must not run AGY hook');
    },
    httpGet: async () => {
      throw new Error('help must not fetch quota');
    },
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
  assertCommandParity(usage, skill);
  const invocations = parseSkillCommands(skill).map((line) => {
    const command = line.slice('agent-steward '.length).replace(/\s+<\s+stopped-state\.json$/, '');
    return parseArgs(shellWords(command));
  });
  assert.deepEqual(
    invocations.map((item) => item.kind),
    [
      'help',
      'route',
      'route',
      'route',
      'list',
      'list',
      'show',
      'quota-refresh',
      'quota-setup-agy',
      'quota-hook-agy',
      'stop',
    ],
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

test('command-form parity detects meaningful invocation drift', () => {
  const cases = [
    ['--config ./config.json router start task --dry-run --json', '--config ./config.json router start task --json'],
    ['--config ./config.json router start task --dry-run --json', '--config ./config.json router start task --dry-run'],
    ['--config ./config.json router start task', 'router start task'],
    ['--config ./config.json router start task', '--config other.json router start task'],
    ['router start task', 'router start other-task'],
    ['router start --dry-run -- --help', 'router start --dry-run -- --version'],
    ['router list --limit 5', 'router list --limit 6'],
    ['router list --json', 'router list'],
    ['router show generated-id --json', 'router show generated-id'],
    ['router show generated-id', 'router show other-id'],
    ['--config ./config.json quota refresh --json', '--config ./config.json quota refresh'],
    ['--config ./config.json quota refresh', 'quota refresh'],
    ['--config ./config.json stop check', 'stop check'],
  ];
  for (const [original, changed] of cases) {
    assert.ok(original && changed);
    const usage = [`agent-steward ${original}`];
    assertCommandParity(usage, `\`\`\`bash\nagent-steward ${original}\n\`\`\``);
    assert.throws(
      () => assertCommandParity(usage, `\`\`\`bash\nagent-steward ${changed}\n\`\`\``),
      assert.AssertionError,
      `parity must detect ${original} becoming ${changed}`,
    );
  }
});

test('quota refresh usage parses and README describes generated state', () => {
  assert.deepEqual(parseUsageForm('agent-steward [--config <path>] quota refresh [--json]'), {
    kind: 'quota-refresh',
    config: './config.json',
    json: true,
  });
  assert.ok(readme.includes('quota refresh'));
  assert.ok(readme.includes('$XDG_STATE_HOME/agent-steward/quota/'));
  assert.doesNotMatch(readme + skill, /does not (?:fetch or refresh|collect) live quota/);
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

test('optional adapter watches configured Herdr agent sessions not a Pi/Codex allowlist', () => {
  const section = readme
    .split('### Optional Herdr adapter (not activated)')[1]
    ?.split('\n## Command preview references')[0];
  assert.ok(section);
  assert.match(section, /agent_session/);
  assert.match(section, /terminal/);
  assert.doesNotMatch(section, /only on explicitly configured Pi\/Codex pane targets/);
  assert.match(skill, /agent_session/);
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
  assert.match(readme, /Release `v0\.1\.0-alpha\.7` is validated for x86_64-linux only/);
  assert.match(readme, /`v0\.1\.0-alpha\.3` tag is unchanged/);
  assert.match(readme, /Portable packaging is unreleased/);
  assert.match(readme, /Export\/evaluation is not native validation/);
  assert.match(readme, /Three-platform validation is established only when all three native\s+jobs/);
  assert.match(readme, /Installing the bundled adapter does not activate it/);
});

test('skill is harness-agnostic and has no Herdr launcher recipe', () => {
  assert.doesNotMatch(skill, /herdr plugin pane open/);
  assert.doesNotMatch(skill, /PI_HERDR_LAUNCH_SCRIPT/);
  assert.doesNotMatch(skill, /pi-herdr-subagents/);
  assert.doesNotMatch(skill, /subagent/);
  assert.doesNotMatch(skill, /session start/);
  assert.doesNotMatch(skill, /agent wait/);
  assert.doesNotMatch(skill, /pane close/);
  assert.doesNotMatch(skill, /idle\/done/);
  assert.match(skill, /router start/);
  assert.match(skill, /router list/);
  assert.match(skill, /router show/);
  assert.match(skill, /stop check/);
  assert.match(skill, /never type the CLI into a shell/i);
});

test('managed delegation preserves complete instructions and authorization boundaries', () => {
  assert.ok(skill.includes('same complete instruction'));
  const managedDelegation = skill.split('For managed delegation,')[1]?.split('\nRespect spawning restrictions:')[0];
  assert.ok(managedDelegation, 'skill must include the managed-delegation instructions');
  assert.match(
    managedDelegation,
    /complete `instruction` must include this invocation's unique `name`, assigned absolute `assigned_cwd`, and agreed report\/notification identity/,
  );
  assert.ok(skill.includes('spawning restrictions'));
  assert.match(skill, /requested, not verified/);
  assert.match(skill, /does not enable automatic approval/);
  assert.match(skill, /may appear in local argv/);
  assert.match(skill, /Do not use Bash\/Herdr to bypass a denied delegation tool/);
  assert.ok(!skill.includes('executor: "agent-steward"'));
  assert.ok(!skill.includes('--native-prompt-file'));
  assert.ok(!skill.includes('routingBrief'));
});
