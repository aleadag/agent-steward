import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/native.yml', import.meta.url), 'utf8');
const flake = readFileSync(new URL('../flake.nix', import.meta.url), 'utf8');
const approvedFallbackQuery = /^[ \t]*nix config show sandbox-fallback[ \t]*$/gm;

function runNativeNixSteps(fullSuiteExit = 0) {
  let previous = -1;
  const scripts = ['Native Nix gates', 'Full Nix test suite', 'Native flake checks'].map((name) => {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.ok(start >= 0, `missing native test stage: ${name}`);
    assert.ok(start > previous, `native test stage out of order: ${name}`);
    previous = start;
    const next = workflow.indexOf('      - name:', start + 1);
    const step = workflow.slice(start, next < 0 ? undefined : next);
    const block = /        run: \|\n((?:          [^\n]*\n?)+)/.exec(step);
    assert.ok(block, `missing runnable native test stage: ${name}`);
    return block[1].replace(/^          /gm, '').replaceAll('${{ matrix.system }}', 'x86_64-linux');
  });
  const root = mkdtempSync(join(tmpdir(), 'steward-native-gates-'));
  const log = join(root, 'calls.jsonl');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const nix = join(bin, 'nix');
    writeFileSync(
      nix,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args.some((arg) => arg.endsWith('.full-suite'))) process.exit(Number(process.env.FULL_SUITE_EXIT));
`,
    );
    chmodSync(nix, 0o700);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', scripts.join('\n')], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        CALL_LOG: log,
        FULL_SUITE_EXIT: String(fullSuiteExit),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return {
      code: result.status,
      stderr: result.stderr,
      calls: readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('native CI executes the full suite before installed flake checks with one build job', () => {
  const result = runNativeNixSteps();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 5);
  assert.ok(result.calls[0].includes('path:.#agent-steward'));
  assert.ok(result.calls[1].includes('path:.#default'));
  assert.equal(result.calls[2][0], 'run');
  assert.ok(result.calls[3].includes('path:.#checks.x86_64-linux.full-suite'));
  assert.deepEqual(result.calls[3].slice(-4), ['--no-link', '--max-jobs', '1', '-L']);
  assert.deepEqual(result.calls[4].slice(0, 2), ['flake', 'check']);
  assert.deepEqual(result.calls[4].slice(-3), ['--max-jobs', '1', '-L']);
});

test('a failed full-suite check fails native CI rather than continuing to installed checks', () => {
  const result = runNativeNixSteps(17);
  assert.equal(result.code, 17, result.stderr);
  assert.equal(result.calls.length, 4);
  assert.ok(result.calls.at(-1).includes('path:.#checks.x86_64-linux.full-suite'));
});

function assertNativeWorkflowHasNoUnapprovedFallbacks(source) {
  assert.doesNotMatch(
    source.replace(approvedFallbackQuery, ''),
    /secrets\.|TYPESAFE_API_KEY|plugin link|plugin enable|write-all|contents: write|macos-15-intel|ubuntu-latest|macos-latest|Rosetta|QEMU|emulat|fallback/i,
  );
  assert.equal([...source.matchAll(approvedFallbackQuery)].length, 1);
}

test('three immutable native jobs enforce architecture and full frozen gates', () => {
  assert.deepEqual(
    [...workflow.matchAll(/^\s+- system: ([^\n]+)$/gm)].map((match) => match[1]),
    ['x86_64-linux', 'aarch64-linux', 'aarch64-darwin'],
  );
  assert.deepEqual(
    [...workflow.matchAll(/^\s+runner: ([^\n]+)$/gm)].map((match) => match[1]),
    ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15'],
  );
  const usesLines = workflow.split('\n').filter((value) => value.includes('uses:'));
  assert.equal(usesLines.length, 2);
  assert.deepEqual(
    [...workflow.matchAll(/^[ \t]*- uses: ([^\n]+)$/gm)].map((match) => match[1]),
    [
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'cachix/install-nix-action@13d8dd58da0234aa297dedd986986ccb8e7f3e24',
    ],
  );
  for (const line of usesLines)
    assert.match(line, /uses: (?:actions\/checkout|cachix\/install-nix-action)@[0-9a-f]{40}\s*$/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  for (const gate of [
    'uname -s',
    'uname -m',
    'builtins.currentSystem',
    'process.arch',
    'process.platform',
    'bun install --frozen-lockfile --ignore-scripts',
    'bun run build',
    'bun test',
    'bun test tests/ci.test.mjs',
    'bun run typecheck',
    'bun run lint',
    'bun run format:check',
    '#agent-steward',
    '#default',
    '-- --help',
    'nix flake check',
  ])
    assert.ok(workflow.includes(gate), `native gate missing: ${gate}`);
  assertNativeWorkflowHasNoUnapprovedFallbacks(workflow);
});

test('Darwin probe is bounded, self-owned, and precedes unchanged native gates', () => {
  const start = workflow.indexOf('      - name: Bounded Darwin CI probe');
  const end = workflow.indexOf('      - name: Native Nix gates');
  const frozen = workflow.indexOf('      - name: Frozen Bun gates');
  assert.ok(start > frozen, 'probe must follow the full frozen Bun gate');
  assert.ok(end > start, 'probe must precede the existing native Nix gates');
  const step = workflow.slice(start, end);

  assert.match(step, /if: matrix\.system == 'aarch64-darwin'/);
  assert.match(step, /CLIENT_NIX_SETTINGS.*not proof of daemon settings/i);
  for (const setting of ['sandbox', 'sandbox-paths', 'sandbox-fallback'])
    assert.ok(step.includes(`nix config show ${setting}`), `missing named Nix setting: ${setting}`);
  assert.match(step, /nix --version/);
  assert.match(step, /nix develop path:\. --no-write-lock-file -c bun -e/);
  assert.doesNotMatch(
    step,
    /nix show-config|nix config show\s*(?:\||$)|NIX_CONFIG|process\.env|printenv|sudo|setuid|setgid/i,
  );
  assert.doesNotMatch(step, /(?:^|\n)\s*env\s*(?:\||$)/m);

  assert.match(step, /statSync\(['"]\/bin\/ps['"]\)/);
  assert.match(
    step,
    /spawnSync\(['"]\/bin\/ps['"],\s*\[\s*['"]-p['"],\s*String\(process\.pid\),\s*['"]-o['"],\s*['"]pid=['"]\s*\]/,
  );
  assert.equal((step.match(/\bspawnSync\s*\(/g) ?? []).length, 1);
  assert.match(step, /encoding:\s*['"]utf8['"]/);
  assert.match(step, /timeout:\s*1000/);
  assert.match(step, /env:\s*\{\s*PATH:\s*['"]['"]\s*\}/);
  assert.match(step, /catch\s*\{\s*console\.error\(['"]Darwin probe metadata failed['"]\)/s);

  for (const field of ['statusKind', 'status', 'signal', 'errorCode', 'errorErrno', 'errorSyscall', 'errorPath'])
    assert.match(step, new RegExp(`\\b${field}:`));
  assert.match(step, /stdoutBytes:\s*Buffer\.byteLength\(psResult\.stdout \?\? ['"]['"]\)/);
  assert.match(step, /stderrBytes:\s*Buffer\.byteLength\(psResult\.stderr \?\? ['"]['"]\)/);
  assert.equal((step.match(/psResult\.stdout/g) ?? []).length, 1);
  assert.equal((step.match(/psResult\.stderr/g) ?? []).length, 1);
  assert.match(step, /JSON\.stringify\(/);
  assert.doesNotMatch(
    step,
    /(?:readFileSync|createReadStream|execSync|execFileSync|spawnSync\(['"]ps['"]|command -v ps)/,
  );
});

test('installed observer selects locked Darwin ps while preserving the Linux procps path', () => {
  const paths = flake.match(/^\s*psPath = if pkgs\.stdenv\.hostPlatform\.isDarwin then (.+) else (.+);$/m);
  assert.ok(paths, 'installed observer must define platform-specific ps paths');
  assert.equal(paths[1], '"${pkgs.darwin.ps}/bin/ps"');
  assert.equal(paths[2], '"${pkgs.procps}/bin/ps"');
  assert.match(flake, /AGENT_STEWARD_PS="\$\{psPath\}"/);
});

test('workflow fallback exception rejects setting prefixes and command suffixes', () => {
  const approvedQuery = 'nix config show sandbox-fallback';
  for (const unapprovedQuery of [
    'nix config show sandbox-fallback-extra',
    'nix config show sandbox-fallback --json',
    'nix config show sandbox-fallback; printf unapproved',
  ]) {
    const mutatedWorkflow = workflow.replace(approvedQuery, unapprovedQuery);
    assert.notEqual(mutatedWorkflow, workflow);
    assert.throws(() => assertNativeWorkflowHasNoUnapprovedFallbacks(mutatedWorkflow), /fallback/i);
  }
});
