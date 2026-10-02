import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { buildCommand, shellQuote, validateCandidateSyntax } from '../src/commands.ts';
import { StewardError } from '../src/contracts.ts';
import type { Candidate } from '../src/contracts.ts';
import { candidate } from './helpers.ts';

function rejectsInvalid(candidateValue: Candidate, level = candidateValue.thinking_levels[0]?.id ?? 'low') {
  assert.throws(
    () => buildCommand(candidateValue, level),
    (error) => error instanceof StewardError && error.code === 'invalid_config',
  );
}

test('Codex custom effort and provider are TOML values, not shell code', () => {
  const value = candidate({
    provider: 'custom"provider',
    thinking_levels: [{ id: 'future-effort', description: 'Configured custom level' }],
  });
  const command = buildCommand(value, 'future-effort');
  assert.deepEqual(command.args, [
    '--model',
    'gpt-astra-example',
    '-c',
    'model_provider="custom\\"provider"',
    '-c',
    'model_reasoning_effort="future-effort"',
  ]);
  assert.equal(command.executable, 'codex');
  assert.equal(
    command.display,
    "'codex' '--model' 'gpt-astra-example' '-c' 'model_provider=\"custom\\\"provider\"' '-c' 'model_reasoning_effort=\"future-effort\"'",
  );
  assert.equal(command.runtime_selection, 'unverified');
  assert.equal(command.authentication, 'unverified');
  assert.equal(command.provider_selection, 'explicit_flag');
  assert.equal(command.syntax_validated, true);
});

test('Pi and agy preserve their exact provider and nondefault effort argv', () => {
  const pi = buildCommand(
    candidate({
      id: 'pi-astra',
      tool: 'pi',
      provider: 'openai-codex',
      thinking_levels: [{ id: 'xhigh', description: 'Configured extra high' }],
    }),
    'xhigh',
  );
  assert.deepEqual(pi.args, ['--provider', 'openai-codex', '--model', 'gpt-astra-example', '--thinking', 'xhigh']);
  assert.equal(pi.provider_selection, 'explicit_flag');

  const agy = buildCommand(
    candidate({
      id: 'gemini-agy',
      tool: 'agy',
      provider: 'google',
      model: 'gemini-example',
      thinking_levels: [{ id: 'max', description: 'Configured maximum' }],
    }),
    'max',
  );
  assert.deepEqual(agy.args, ['--model=gemini-example', '--effort=max']);
  assert.equal(agy.provider_selection, 'existing_settings');
  assert.ok(!agy.args.some((arg) => arg.includes('provider')));
});

test('agy translates logical Gemini models and efforts to native selectors', () => {
  const cases = [
    ['gemini-3.8-flash', 'low', 'gemini-3.8-flash-low'],
    ['gemini-3.8-flash', 'medium', 'gemini-3.8-flash-medium'],
    ['gemini-3.8-flash', 'high', 'gemini-3.8-flash-high'],
    ['gemini-3.7-flash', 'medium', 'gemini-3.7-flash-medium'],
    ['gemini-3.6-flash', 'high', 'gemini-3.6-flash-high'],
    ['gemini-3.1-pro', 'low', 'gemini-3.1-pro-low'],
    ['gemini-3.1-pro', 'high', 'gemini-3.1-pro-high'],
  ] as const;
  for (const [model, level, selector] of cases) {
    const value = candidate({
      tool: 'agy',
      provider: 'google',
      model,
      thinking_levels: [{ id: level, description: level }],
    });
    const command = buildCommand(value, level);
    assert.deepEqual(command.args, [`--model=${selector}`]);
    assert.equal(command.display, `'agy' '--model=${selector}'`);
    assert.equal(command.provider_selection, 'existing_settings');
    assert.equal(command.runtime_selection, 'unverified');
    assert.equal(value.model, model);
    assert.equal(value.thinking_levels[0]?.id, level);
  }
});

test('agy preflight rejects unsupported logical model and effort combinations', () => {
  for (const [model, level] of [
    ['gemini-3.8-flash', 'max'],
    ['gemini-3.7-flash', 'max'],
    ['gemini-3.6-flash', 'max'],
    ['gemini-3.1-pro', 'medium'],
    ['gemini-3.1-pro', 'max'],
    ['gemini-3.8-flash', 'default'],
    ['gemini-3.1-pro', 'default'],
  ]) {
    rejectsInvalid(candidate({ tool: 'agy', model, thinking_levels: [{ id: level!, description: 'Unsupported' }] }));
  }
});

test('agy preserves native selectors and separate effort flags for other models', () => {
  for (const [model, level, args] of [
    ['gemini-3.8-flash-medium', 'default', ['--model=gemini-3.8-flash-medium']],
    ['claude-sonnet-4-6', 'high', ['--model=claude-sonnet-4-6', '--effort=high']],
  ] as const) {
    const value = candidate({ tool: 'agy', model, thinking_levels: [{ id: level, description: level }] });
    assert.deepEqual(buildCommand(value, level).args, args);
  }
});

test('Pi does not apply agy model translation', () => {
  const value = candidate({ tool: 'pi', provider: 'google', model: 'gemini-3.8-flash' });
  assert.deepEqual(buildCommand(value, 'low').args, [
    '--provider',
    'google',
    '--model',
    'gemini-3.8-flash',
    '--thinking',
    'low',
  ]);
});

test('default omits effort overrides for all tools without claiming effective effort', () => {
  const cases: [Candidate, string[]][] = [
    [
      candidate({ thinking_levels: [{ id: 'default', description: 'Omit override' }] }),
      ['--model', 'gpt-astra-example', '-c', 'model_provider="openai"'],
    ],
    [
      candidate({ id: 'pi-default', tool: 'pi', thinking_levels: [{ id: 'default', description: 'Omit override' }] }),
      ['--provider', 'openai', '--model', 'gpt-astra-example'],
    ],
    [
      candidate({ id: 'agy-default', tool: 'agy', thinking_levels: [{ id: 'default', description: 'Omit override' }] }),
      ['--model=gpt-astra-example'],
    ],
  ];
  for (const [value, args] of cases) {
    const command = buildCommand(value, 'default');
    assert.deepEqual(command.args, args);
    assert.equal(command.runtime_selection, 'unverified');
  }
});

test('shell display safely quotes literal shell metacharacters without altering argv', () => {
  const model = "semi;$(touch /tmp/nope)'\\$HOME";
  const provider = "custom'provider;$(echo unsafe)";
  const value = candidate({ model, provider, thinking_levels: [{ id: "it's;$(true)", description: 'literal' }] });
  const command = buildCommand(value, "it's;$(true)");
  assert.equal(command.args[1], model);
  assert.equal(command.args[3], `model_provider="custom'provider;$(echo unsafe)"`);
  assert.equal(command.args[5], `model_reasoning_effort="it's;$(true)"`);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.ok(command.display.includes("'semi;$(touch /tmp/nope)'\\''\\$HOME'"));
  assert.ok(command.display.includes('$(echo unsafe)'));
});

test('Codex TOML values preserve literal backslashes and quotes', () => {
  const value = candidate({
    provider: 'back\\slash"quote',
    thinking_levels: [{ id: 'low', description: 'Configured low' }],
  });
  const command = buildCommand(value, 'low');
  assert.equal(command.args[3], 'model_provider="back\\\\slash\\"quote"');
});

test('preflight rejects ASCII controls and leading-option model/provider values', () => {
  for (const value of [
    candidate({ model: '-model' }),
    candidate({ provider: '-provider' }),
    candidate({ model: 'bad\nmodel' }),
    candidate({ provider: 'bad\u007fprovider' }),
    candidate({ thinking_levels: [{ id: 'bad\u0000level', description: 'bad' }] }),
  ]) {
    assert.throws(
      () => validateCandidateSyntax(value),
      (error) => error instanceof StewardError && error.code === 'invalid_config',
    );
  }
});

test('preflight rejects unsupported Pi and agy efforts and empty effort lists', () => {
  for (const value of [
    candidate({ tool: 'pi', thinking_levels: [{ id: 'turbo', description: 'unsupported' }] }),
    candidate({ tool: 'agy', thinking_levels: [{ id: 'xhigh', description: 'unsupported' }] }),
    candidate({ thinking_levels: [] }),
  ])
    assert.throws(
      () => validateCandidateSyntax(value),
      (error) => error instanceof StewardError && error.code === 'invalid_config',
    );
});

test('Codex accepts configured nonempty custom effort IDs', () => {
  const value = candidate({ thinking_levels: [{ id: 'vendor-special-effort', description: 'Custom Codex effort' }] });
  assert.doesNotThrow(() => validateCandidateSyntax(value));
  assert.deepEqual(buildCommand(value, 'vendor-special-effort').args.slice(-2), [
    '-c',
    'model_reasoning_effort="vendor-special-effort"',
  ]);
});

test('buildCommand rechecks level membership and does not substitute an alternative', () => {
  const value = candidate({
    thinking_levels: [
      { id: 'low', description: 'Configured low' },
      { id: 'high', description: 'Configured high' },
    ],
  });
  rejectsInvalid(value, 'medium');
  assert.deepEqual(buildCommand(value, 'high').args.slice(-2), ['-c', 'model_reasoning_effort="high"']);
});

test('known effort vocabularies include every verified Pi and agy level', () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.doesNotThrow(() =>
      validateCandidateSyntax(candidate({ tool: 'pi', thinking_levels: [{ id: level, description: level }] })),
    );
  }
  for (const level of ['low', 'medium', 'high', 'max']) {
    assert.doesNotThrow(() =>
      validateCandidateSyntax(candidate({ tool: 'agy', thinking_levels: [{ id: level, description: level }] })),
    );
  }
});
