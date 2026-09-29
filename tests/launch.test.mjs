import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand } from '../dist/src/commands.js';
import { assertLiveTask, buildNativeLaunch } from '../dist/src/launch.js';
import { candidate } from './helpers.mjs';

const toolCandidates = [
  candidate({ tool: 'codex', provider: 'openai' }),
  candidate({ tool: 'pi', provider: 'openai-codex' }),
  candidate({ tool: 'agy', provider: 'google' }),
];
const tasks = ['@private.md', '--help', "x';$(touch /tmp/never)", 'first line\nsecond line'];

function expectedPromptArgs(tool, task) {
  const message = `User task:\n${task}`;
  return tool === 'agy' ? [`--prompt-interactive=${message}`] : ['--', message];
}

test('native launch appends one prefixed task argument without changing configured argv', () => {
  for (const value of toolCandidates) {
    const original = buildCommand(value, 'low');
    for (const task of tasks) {
      const launch = buildNativeLaunch(original, task);
      assert.equal(launch.executable, value.tool);
      assert.deepEqual(launch.args, [...original.args, ...expectedPromptArgs(value.tool, task)]);
    }
  }
});

test('native launch preserves default effort omission for every tool', () => {
  const defaultArgs = {
    codex: ['--model', 'gpt-astra-example', '-c', 'model_provider="openai"'],
    pi: ['--provider', 'openai-codex', '--model', 'gpt-astra-example'],
    agy: ['--model=gpt-astra-example'],
  };
  for (const value of toolCandidates) {
    const defaultCandidate = {
      ...value,
      thinking_levels: [{ id: 'default', description: 'Use tool default' }],
    };
    const original = buildCommand(defaultCandidate, 'default');
    assert.deepEqual(original.args, defaultArgs[value.tool]);
    const launch = buildNativeLaunch(original, '@private.md');
    assert.deepEqual(launch.args, [...defaultArgs[value.tool], ...expectedPromptArgs(value.tool, '@private.md')]);
  }
});

test('live tasks reject blank text and ASCII controls other than tab and newline', () => {
  assert.throws(() => assertLiveTask(' \t\n'), { code: 'invalid_input' });
  const forbiddenControls = [
    ...Array.from({ length: 0x20 }, (_, code) => code).filter((code) => code !== 0x09 && code !== 0x0a),
    0x7f,
  ];
  for (const code of forbiddenControls) {
    assert.throws(() => assertLiveTask(`before${String.fromCharCode(code)}after`), { code: 'invalid_input' });
  }
  assert.doesNotThrow(() => assertLiveTask('tab\there\nand newline'));
  assert.throws(() => buildNativeLaunch(buildCommand(toolCandidates[0], 'low'), 'bad\x1b[2J'), {
    code: 'invalid_input',
  });
});
