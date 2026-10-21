import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./package-checks.sh', import.meta.url));

async function runChecks(scope: string, testExit = 0) {
  const root = await mkdtemp(join(tmpdir(), 'steward-package-checks-'));
  const bin = join(root, 'bin');
  const log = join(root, 'calls.jsonl');
  try {
    await mkdir(bin);
    await mkdir(join(root, 'tests'));
    for (const name of ['config.test.ts', 'herdr-jobs.test.ts', 'future regression.test.ts'])
      await writeFile(join(root, 'tests', name), '');
    const bun = join(bin, 'bun');
    await writeFile(
      bun,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, timing: process.env.AGENT_STEWARD_TEST_TIMING }) + '\\n');
if (args[0] === 'test') process.exit(Number(process.env.TEST_EXIT));
`,
    );
    await chmod(bun, 0o700);
    const result = spawnSync('bash', [runner, scope], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        CALL_LOG: log,
        TEST_EXIT: String(testExit),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    const calls: { args: string[]; timing?: string }[] = await readFile(log, 'utf8')
      .then((text) =>
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      )
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    return { code: result.status, stderr: result.stderr, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('package core scope selects policy, validation and parsing tests, then smokes the compiled CLI', async () => {
  const result = await runChecks('core');
  assert.equal(result.code, 0, result.stderr);
  const selected = result.calls[0]!.args;
  assert.equal(selected[0], 'test');
  for (const file of [
    'approval',
    'commands',
    'config',
    'contracts',
    'privacy',
    'quota',
    'retry',
    'routing',
    'triage',
    'native-route',
    'api-routing',
    'policy-check',
  ])
    assert.ok(selected.includes(`tests/${file}.test.ts`), `core behavior missing: ${file}`);
  for (const file of ['herdr-jobs', 'herdr-final-boundaries', 'herdr-shutdown', 'agy-runtime', 'installed'])
    assert.equal(selected.includes(`tests/${file}.test.ts`), false, `integration must stay outside package: ${file}`);
  const actual = await readdir(new URL('.', import.meta.url));
  assert.ok(selected.slice(1).every((file) => actual.includes(file.slice('tests/'.length))));
  assert.equal(new Set(selected).size, selected.length);
  assert.equal(result.calls[0]!.timing, '0');
  assert.deepEqual(result.calls[1]!.args, ['dist/src/main.js', '--help']);
  assert.equal(result.calls.length, 2);
});

test('full scope discovers every test file, including newly added and space-containing names', async () => {
  const result = await runChecks('full');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls[0]!.args, [
    'test',
    'tests/config.test.ts',
    'tests/future regression.test.ts',
    'tests/herdr-jobs.test.ts',
  ]);
  assert.equal(result.calls[0]!.timing, '1');
  assert.deepEqual(result.calls[1]!.args, ['dist/src/main.js', '--help']);
});

for (const scope of ['core', 'full']) {
  test(`${scope} scope propagates test failure and never proceeds to a successful smoke test`, async () => {
    const result = await runChecks(scope, 17);
    assert.equal(result.code, 17, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]!.args[0], 'test');
  });
}

test('unknown scopes are refused rather than silently skipping tests', async () => {
  const result = await runChecks('unknown');
  assert.equal(result.code, 2, result.stderr);
  assert.deepEqual(result.calls, []);
});
