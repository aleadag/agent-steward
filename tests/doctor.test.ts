import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run } from '../src/cli.ts';
import { createRuntime } from '../src/main.ts';
import { renderDoctor } from '../src/doctor.ts';
import { candidate, config } from './helpers.ts';

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'steward-doctor-'));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('doctor text distinguishes all statuses with icons and keeps fields and fixes readable', () => {
  const report = {
    schema_version: 1,
    ok: false,
    checks: [
      { id: 'path', status: 'pass' as const, message: 'PATH is safe.' },
      {
        id: 'config',
        status: 'fail' as const,
        message: 'Invalid config.',
        fields: ['thresholds.risky'],
        fix: 'Correct the field.',
      },
      { id: 'evaluator_key', status: 'skipped' as const, message: 'Requires valid configuration.' },
    ],
  };
  const json = JSON.stringify(report);
  assert.equal(
    renderDoctor(report),
    '✅ path — PATH is safe.\n' +
      '❌ config — Invalid config. Fields: thresholds.risky.\n\tFix: Correct the field.\n' +
      '⏭️ evaluator_key — Requires valid configuration.\n',
  );
  assert.equal(JSON.stringify(report), json);
});

test('doctor resolves actual executable permissions without executing tools or modifying files', async () => {
  await fixture(async (root) => {
    const configPath = join(root, 'config.json');
    const toolPath = join(root, 'codex');
    const contents = JSON.stringify(config());
    await writeFile(configPath, contents);
    await writeFile(toolPath, '#!/bin/sh\necho invoked > "$0.invoked"\n');
    const io = createRuntime();
    io.env = { HOME: root, PATH: root, TYPESAFE_API_KEY: 'OpaqueFixtureSecret' };
    const output: string[] = [];
    io.stdout = (text) => output.push(text);
    io.stderr = (text) => {
      throw new Error(text);
    };
    const forbidden = async (): Promise<never> => {
      throw new Error('unexpected side effect');
    };
    io.post = forbidden;
    io.httpGet = forbidden;
    io.launch = forbidden;
    io.writeText = forbidden;
    io.appendText = forbidden;
    io.readStdin = forbidden;
    for (const [mode, expected] of [
      [0o600, 1],
      [0o700, 0],
    ] as const) {
      await chmod(toolPath, mode);
      output.length = 0;
      assert.equal(await run(['--config', configPath, 'doctor', '--json'], io), expected);
      const report = JSON.parse(output.join(''));
      assert.equal(
        report.checks.find((check: { id: string }) => check.id === 'executable.codex').status,
        expected === 0 ? 'pass' : 'fail',
      );
    }
    assert.deepEqual((await readdir(root)).sort(), ['codex', 'config.json']);
    assert.equal(await readFile(configPath, 'utf8'), contents);
    assert.doesNotMatch(output.join(''), /OpaqueFixtureSecret/);
  });
});

test('doctor skips executable lookup on unsafe PATH but still checks evaluator key', async () => {
  await fixture(async (root) => {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(config()));
    for (const path of [undefined, '', 'relative', `${root}${delimiter}`, `${delimiter}${root}`]) {
      const io = createRuntime();
      io.env = { HOME: root, PATH: path };
      io.executableAvailable = () => {
        throw new Error('unsafe lookup');
      };
      const output: string[] = [];
      io.stdout = (text) => output.push(text);
      assert.equal(await run(['doctor', '--config', configPath, '--json'], io), 1);
      const report = JSON.parse(output.join(''));
      assert.deepEqual(
        report.checks.map((check: { status: string }) => check.status),
        ['pass', 'fail', 'skipped', 'fail'],
      );
      assert.match(report.checks[3].fix, /TYPESAFE_API_KEY/);
    }
  });
});

test('doctor reports invalid native candidate syntax and credential-safe schema fields', async () => {
  await fixture(async (root) => {
    const configPath = join(root, 'config.json');
    const io = createRuntime();
    io.env = { HOME: root, PATH: root };
    const output: string[] = [];
    io.stdout = (text) => output.push(text);
    for (const cfg of [
      config({ candidates: [candidate({ provider: '--unsafe-option' })] }),
      config({ thresholds: { risky: 2, choiceConfidence: 0.45 } }),
    ]) {
      await writeFile(configPath, JSON.stringify(cfg));
      output.length = 0;
      assert.equal(await run(['doctor', '--config', configPath, '--json'], io), 1);
      const check = JSON.parse(output.join('')).checks[0];
      assert.equal(check.kind, 'schema');
      if (cfg.thresholds.risky === 2) assert.deepEqual(check.fields, ['thresholds.risky']);
    }
  });
});
