import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { assertCacheMatchesLock, selectedLockGraph, type CacheDep, type CacheLock } from './bun-cache.ts';

const lock = Bun.JSONC.parse(await Bun.file(new URL('../bun.lock', import.meta.url)).text()) as CacheLock;
const targets = [
  ['x86_64-linux', 'linux', 'x64', 13],
  ['aarch64-linux', 'linux', 'arm64', 13],
  ['aarch64-darwin', 'darwin', 'arm64', 11],
] as const;
const manifests = process.env.AGENT_STEWARD_BUN_CACHE_GRAPHS
  ? (JSON.parse(process.env.AGENT_STEWARD_BUN_CACHE_GRAPHS) as Record<string, CacheDep[]>)
  : undefined;
for (const [system, os, cpu, count] of targets) {
  test(`${system}: exact graph and rejected mutations`, () => {
    const selected = selectedLockGraph(lock, os, cpu);
    assert.equal(selected.length, count);
    const native = selected.filter(({ name }) => name.startsWith('@ox'));
    assert.deepEqual(
      native.map(({ name }) => name).sort(),
      ['oxfmt', 'oxlint']
        .flatMap((tool) =>
          os === 'linux'
            ? [`@${tool}/binding-linux-${cpu}-gnu`, `@${tool}/binding-linux-${cpu}-musl`]
            : [`@${tool}/binding-darwin-${cpu}`],
        )
        .sort(),
    );
    if (manifests) {
      assert.deepEqual(Object.keys(manifests).sort(), targets.map(([name]) => name).sort());
      assert.ok(manifests[system], 'Nix manifest must include this target');
    }
    const expected = manifests ? manifests[system]! : selected;
    assertCacheMatchesLock(lock, expected, os, cpu);
    const first = expected[0]!;
    const badGraphs = [
      expected.slice(1),
      [...expected, first],
      [{ ...first, version: '0.0.0' }, ...expected.slice(1)],
      [{ ...first, hash: 'sha512-wrong' }, ...expected.slice(1)],
      [...expected, { name: '@oxfmt/binding-win32-x64-msvc', version: '0.71.0', hash: 'sha512-wrong' }],
    ];
    for (const bad of badGraphs)
      assert.throws(() => assertCacheMatchesLock(lock, bad, os, cpu), /cache does not exactly match/);
    const changed = structuredClone(lock);
    changed.packages[first.name]![3] = 'sha512-changed-lock';
    assert.throws(() => assertCacheMatchesLock(changed, expected, os, cpu), /cache does not exactly match/);
  });
}
