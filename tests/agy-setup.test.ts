import { test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agyPaths, setupAgy, verifyAgySetup } from '../src/agy-setup.ts';
import type { AgySetupIO } from '../src/agy-setup.ts';
import { withLedgerLock } from '../src/ledger-io.ts';

export const setupFS: AgySetupIO = {
  readText: (p) => fs.readFile(p, 'utf8'),
  lstat: fs.lstat,
  writeText: (p, t, mode) => fs.writeFile(p, t, { mode, flag: 'wx' }),
  rename: fs.rename,
  unlink: fs.unlink,
  mkdirp: async (p, mode) => {
    await fs.mkdir(p, { recursive: true, mode });
  },
  chmod: fs.chmod,
  withLock: withLedgerLock,
};
async function fixture(run: (paths: ReturnType<typeof agyPaths>) => Promise<void>) {
  const home = await fs.mkdtemp(join(tmpdir(), 'agy-setup-'));
  try {
    const paths = agyPaths({ HOME: home });
    await fs.mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    await fs.writeFile(
      paths.settings,
      JSON.stringify({
        unrelated: 'keep',
        statusLine: { type: 'command', command: '/old/render', padding: 2, enabled: false },
      }),
    );
    await run(paths);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
test('a manually installed unquoted hook is not wrapped without ownership metadata', async () =>
  fixture(async (paths) => {
    const settings = JSON.parse(await setupFS.readText(paths.settings));
    settings.statusLine.command = '/installed/steward quota hook agy';
    await fs.writeFile(paths.settings, JSON.stringify(settings));
    await assert.rejects(setupAgy(paths, ['/installed/steward'], setupFS));
  }));

test('a recursive saved renderer is not a verified setup', async () =>
  fixture(async (paths) => {
    await setupAgy(paths, ['/installed/steward'], setupFS);
    const manifest = JSON.parse(await setupFS.readText(paths.manifest));
    manifest.previousStatusLine = { type: 'command', command: manifest.installedCommand };
    await fs.writeFile(paths.manifest, JSON.stringify(manifest));
    assert.equal(await verifyAgySetup(paths, setupFS), null);
  }));

test('an older orphaned hook is not wrapped after its manifest is lost', async () =>
  fixture(async (paths) => {
    await setupAgy(paths, ['/old-package/steward'], setupFS);
    await fs.unlink(paths.manifest);
    const before = await setupFS.readText(paths.settings);
    await assert.rejects(setupAgy(paths, ['/new-package/steward'], setupFS));
    assert.equal(await setupFS.readText(paths.settings), before);
    await assert.rejects(fs.lstat(paths.manifest));
  }));

test('successful atomic rename needs no cleanup of a now-absent temporary file', async () =>
  fixture(async (paths) => {
    await setupAgy(paths, ['/installed/steward'], {
      ...setupFS,
      unlink: async () => {
        throw new Error('unexpected successful-rename cleanup');
      },
    });
    assert.equal(
      JSON.parse(await setupFS.readText(paths.settings)).statusLine.command,
      "'/installed/steward' 'quota' 'hook' 'agy'",
    );
    assert.ok(await verifyAgySetup(paths, setupFS));
  }));

test('explicit setup preserves renderer and settings, and repeated/upgraded setup does not recursively wrap', async () =>
  fixture(async (paths) => {
    const before = JSON.parse(await setupFS.readText(paths.settings));
    await setupAgy(paths, ['/installed/steward'], setupFS);
    const after = JSON.parse(await setupFS.readText(paths.settings));
    assert.equal(after.unrelated, 'keep');
    assert.equal(after.statusLine.padding, 2);
    assert.equal(after.statusLine.enabled, true);
    assert.equal(after.statusLine.command, "'/installed/steward' 'quota' 'hook' 'agy'");
    assert.deepEqual((await verifyAgySetup(paths, setupFS))?.previousStatusLine, before.statusLine);
    assert.equal((await fs.stat(paths.manifest)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(paths.workdir)).mode & 0o777, 0o700);
    await Promise.all([
      setupAgy(paths, ['/installed/steward'], setupFS),
      setupAgy(paths, ['/installed/steward'], setupFS),
    ]);
    await setupAgy(paths, ['/new/steward'], setupFS);
    assert.deepEqual((await verifyAgySetup(paths, setupFS))?.previousStatusLine, before.statusLine);
    const reformat = JSON.parse(await setupFS.readText(paths.settings));
    await fs.writeFile(paths.settings, JSON.stringify(reformat, null, 4));
    assert.ok(await verifyAgySetup(paths, setupFS));
    reformat.statusLine.enabled = false;
    await fs.writeFile(paths.settings, JSON.stringify(reformat));
    assert.equal(await verifyAgySetup(paths, setupFS), null);
  }));
test('setup refuses user edits and unsupported native statusLine types', async () =>
  fixture(async (paths) => {
    await setupAgy(paths, ['/installed/steward'], setupFS);
    const edited = JSON.parse(await setupFS.readText(paths.settings));
    edited.statusLine.command = '/user/replacement';
    await fs.writeFile(paths.settings, JSON.stringify(edited));
    await assert.rejects(setupAgy(paths, ['/installed/steward'], setupFS));
    assert.equal(JSON.parse(await setupFS.readText(paths.settings)).statusLine.command, '/user/replacement');
    await fs.unlink(paths.manifest);
    edited.statusLine.type = 'unsupported';
    await fs.writeFile(paths.settings, JSON.stringify(edited));
    await assert.rejects(setupAgy(paths, ['/installed/steward'], setupFS));
  }));
test('setup refuses symlinked settings/workdir and relative state paths', async () =>
  fixture(async (paths) => {
    const original = paths.settings + '.original';
    await fs.rename(paths.settings, original);
    await fs.symlink(original, paths.settings);
    await assert.rejects(setupAgy(paths, ['/installed/steward'], setupFS));
    await fs.unlink(paths.settings);
    await fs.rename(original, paths.settings);
    await fs.mkdir(paths.state, { recursive: true });
    await fs.symlink(paths.state, paths.workdir);
    await assert.rejects(setupAgy(paths, ['/installed/steward'], setupFS));
    assert.throws(() => agyPaths({ HOME: '/home', XDG_STATE_HOME: 'relative' }));
    assert.throws(() => agyPaths({ HOME: 'relative' }));
  }));
test('failed settings replacement retains original configuration and cleans temporary files', async () =>
  fixture(async (paths) => {
    const before = await setupFS.readText(paths.settings);
    await assert.rejects(
      setupAgy(paths, ['/installed/steward'], {
        ...setupFS,
        rename: async (from, to) => {
          if (to === paths.settings) throw new Error('private');
          await fs.rename(from, to);
        },
      }),
    );
    assert.equal(await setupFS.readText(paths.settings), before);
    assert.ok(!(await fs.readdir(join(paths.settings, '..'))).some((p) => p.endsWith('.tmp')));
  }));
test('absent original renderer is backed up as absent', async () =>
  fixture(async (paths) => {
    await fs.writeFile(paths.settings, '{}');
    await setupAgy(paths, ['/installed/steward'], setupFS);
    assert.equal((await verifyAgySetup(paths, setupFS))?.previousStatusLine, null);
  }));
