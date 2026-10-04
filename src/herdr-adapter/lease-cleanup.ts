import type { Stats } from 'node:fs';
import { join } from 'node:path';
import type { LeaseIdentity, LeaseIO } from './lease.ts';

export type CleanupOptions = {
  generations: string;
  selected: LeaseIdentity;
  io: LeaseIO;
  alive: (pid: number) => boolean | null;
  isOpen: () => boolean;
  assertShared: () => Promise<void>;
  readOwner: (path: string) => Promise<LeaseIdentity>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const temp = /^heartbeat\.json\.([0-9a-f-]+)\.tmp$/;
const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && (!a.isFile() || a.nlink === b.nlink);
const sameOwner = (a: LeaseIdentity, b: LeaseIdentity): boolean =>
  a.protocol === b.protocol && a.token === b.token && a.pid === b.pid && a.session === b.session;

async function privateInfo(o: CleanupOptions, path: string, directory: boolean): Promise<Stats> {
  const info = await o.io.lstat(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    info.uid !== uid ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    throw new Error('unsafe cleanup candidate');
  return info;
}

async function children(o: CleanupOptions, path: string, limit: number): Promise<string[]> {
  const directory = await o.io.opendir(path);
  try {
    const names: string[] = [];
    for (;;) {
      const entry = await directory.read();
      if (entry === null) return names;
      if (names.length === limit) throw new Error('cleanup candidate exceeds budget');
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
}

type Candidate = {
  path: string;
  directory: Stats;
  owner: LeaseIdentity;
  files: { name: string; info: Stats }[];
  marker?: Stats;
};
async function candidate(o: CleanupOptions, token: string): Promise<Candidate> {
  const path = join(o.generations, token);
  const directory = await privateInfo(o, path, true);
  const ownerFile = await privateInfo(o, join(path, 'owner.json'), false);
  const owner = await o.readOwner(join(path, 'owner.json'));
  if (owner.token !== token || o.alive(owner.pid) !== false) throw new Error('unproven dead owner');
  const names = await children(o, path, 64);
  const files: Candidate['files'] = [];
  let marker: Stats | undefined;
  for (const name of names) {
    if (name === 'released') {
      marker = await privateInfo(o, join(path, name), true);
      if ((await children(o, join(path, name), 0)).length !== 0) throw new Error('nonempty marker');
    } else if (name === 'owner.json' || name === 'heartbeat.json' || uuid.test(temp.exec(name)?.[1] ?? '')) {
      const info = await privateInfo(o, join(path, name), false);
      if (name === 'owner.json' && !sameFile(ownerFile, info)) throw new Error('owner replaced');
      files.push({ name, info });
    } else {
      throw new Error('unknown generation content');
    }
  }
  if (!files.some((file) => file.name === 'owner.json')) throw new Error('owner disappeared');
  return { path, directory, owner, files, marker };
}

async function unchanged(o: CleanupOptions, c: Candidate): Promise<void> {
  if (!sameFile(c.directory, await privateInfo(o, c.path, true))) throw new Error('generation replaced');
  const ownerFile = c.files.find((file) => file.name === 'owner.json')!;
  if (!sameFile(ownerFile.info, await privateInfo(o, join(c.path, 'owner.json'), false)))
    throw new Error('owner replaced');
  if (!sameOwner(c.owner, await o.readOwner(join(c.path, 'owner.json'))) || o.alive(c.owner.pid) !== false) {
    throw new Error('owner no longer proven dead');
  }
}

async function removeCandidate(o: CleanupOptions, c: Candidate): Promise<boolean> {
  const files = c.files.filter((file) => file.name !== 'owner.json');
  const owner = c.files.find((file) => file.name === 'owner.json')!;
  const targets = [
    ...files.map((file) => ({ ...file, directory: false })),
    ...(c.marker ? [{ name: 'released', info: c.marker, directory: true }] : []),
    { ...owner, directory: false },
  ];
  for (const target of targets) {
    if (!o.isOpen()) return false;
    await o.assertShared();
    if (!o.isOpen()) return false;
    try {
      await unchanged(o, c);
      const path = join(c.path, target.name);
      if (!sameFile(target.info, await privateInfo(o, path, target.directory))) return false;
      if (!o.isOpen()) return false;
      if (target.directory) await o.io.rmdir(path);
      else await o.io.unlink(path);
    } catch {
      return false;
    }
  }
  await o.assertShared();
  if (!o.isOpen()) return false;
  try {
    if (!sameFile(c.directory, await privateInfo(o, c.path, true))) return false;
    await o.io.rmdir(c.path);
    return true;
  } catch {
    return false;
  }
}

export async function collectDeadGenerations(o: CleanupOptions): Promise<void> {
  if (!o.isOpen()) return;
  await o.assertShared();
  let directory: Awaited<ReturnType<LeaseIO['opendir']>>;
  try {
    directory = await o.io.opendir(o.generations);
  } catch {
    await o.assertShared();
    return;
  }
  try {
    let removed = 0;
    for (let inspected = 0; inspected < 128 && removed < 32 && o.isOpen(); inspected++) {
      await o.assertShared();
      let name: string;
      try {
        const entry = await directory.read();
        if (entry === null) break;
        name = entry.name;
      } catch {
        break;
      }
      if (!uuid.test(name) || name === o.selected.token) continue;
      let c: Candidate;
      try {
        c = await candidate(o, name);
      } catch {
        continue;
      }
      if (await removeCandidate(o, c)) removed++;
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // Failure to close maintenance iteration does not grant authority.
    }
  }
  await o.assertShared();
}
