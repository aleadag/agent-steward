export type CacheDep = { name: string; version: string; hash: string };
export type CacheLock = {
  packages: Record<string, [string, string, { os?: string; cpu?: string }, string]>;
};
export function selectedLockGraph(lock: CacheLock, os: string, cpu: string): CacheDep[] {
  return Object.entries(lock.packages)
    .filter(([, [, , meta]]) => (!meta.os || meta.os === os) && (!meta.cpu || meta.cpu === cpu))
    .map(([name, [id, , , hash]]) => ({ name, version: id.slice(name.length + 1), hash }));
}
export function assertCacheMatchesLock(lock: CacheLock, manifest: CacheDep[], os: string, cpu: string): void {
  const lines = (deps: CacheDep[]) => deps.map(({ name, version, hash }) => [name, version, hash].join('\t')).sort();
  if (JSON.stringify(lines(selectedLockGraph(lock, os, cpu))) !== JSON.stringify(lines(manifest)))
    throw new Error(`Nix Bun cache does not exactly match the ${os} ${cpu} bun.lock graph`);
}
if (import.meta.main) {
  const lock = Bun.JSONC.parse(await Bun.file('bun.lock').text()) as CacheLock;
  const manifest = JSON.parse(process.env.AGENT_STEWARD_BUN_CACHE_LOCK!) as CacheDep[];
  assertCacheMatchesLock(lock, manifest, process.env.AGENT_STEWARD_BUN_OS!, process.env.AGENT_STEWARD_BUN_CPU!);
}
