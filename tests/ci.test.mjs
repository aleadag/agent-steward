import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/native.yml', import.meta.url), 'utf8');

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
  assert.doesNotMatch(
    workflow,
    /secrets\.|TYPESAFE_API_KEY|plugin link|plugin enable|write-all|contents: write|macos-15-intel|ubuntu-latest|macos-latest|Rosetta|QEMU|emulat|fallback/i,
  );
});
