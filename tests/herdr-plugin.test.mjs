import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = process.env.AGENT_STEWARD_PACKAGE;
const pinnedNode = process.env.AGENT_STEWARD_PINNED_NODE;

// Catches the plugin depending on checkout-relative paths or node from PATH,
// or a package that activates Herdr configuration during installation.
test(
  'installed optional plugin runs from outside checkout with pinned Node and fake Herdr',
  { skip: !pkg, timeout: 12000 },
  async () => {
    assert.ok(pinnedNode, 'installed check must supply the package Node runtime');
    const root = mkdtempSync(join(tmpdir(), 'steward-herdr-installed-'));
    const plugin = join(pkg, 'share/agent-steward/herdr-plugin');
    const state = join(root, 'state'),
      config = join(root, 'config'),
      home = join(root, 'home'),
      bin = join(root, 'bin');
    const socket = join(root, 'herdr.sock'),
      cli = join(root, 'fake-herdr');
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(config);
    mkdirSync(home);
    mkdirSync(bin);
    assert.ok(process.env.AGENT_STEWARD_DIRNAME, 'installed check must supply dirname without a global PATH');
    symlinkSync(process.env.AGENT_STEWARD_DIRNAME, join(bin, 'dirname')); // run.sh needs dirname, not node.
    writeFileSync(join(config, 'targets.json'), JSON.stringify({ pane_ids: [] }));
    writeFileSync(cli, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const server = createServer((connection) => connection.destroy());
    let child;
    try {
      server.listen(socket);
      await once(server, 'listening');
      assert.ok(readFileSync(join(plugin, 'herdr-plugin.toml'), 'utf8').includes('min_herdr_version = "0.9.1"'));
      assert.equal(
        realpathSync(join(plugin, 'agent-steward-herdr-adapter')),
        realpathSync(join(pkg, 'bin/agent-steward-herdr-adapter')),
      );
      child = spawn('/bin/sh', [join(plugin, 'run.sh'), 'scheduler'], {
        cwd: root,
        env: {
          PATH: bin,
          HOME: home,
          XDG_CONFIG_HOME: config,
          HERDR_SOCKET_PATH: socket,
          HERDR_BIN_PATH: cli,
          HERDR_PLUGIN_CONFIG_DIR: config,
          HERDR_PLUGIN_STATE_DIR: state,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const lease = join(state, 'scheduler-lease/owner.json');
      let started = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (existsSync(lease)) {
          started = true;
          break;
        }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(started, `packaged supervisor must start and acquire the fake-socket lease: ${stderr}`);
      assert.equal(realpathSync(`/proc/${child.pid}/exe`), realpathSync(pinnedNode));
      const argv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
      assert.ok(
        argv.includes(join(pkg, 'lib/node_modules/agent-steward/dist/src/herdr-adapter/entry.js')),
        'wrapper must use the installed entry, not the checkout',
      );
      const owner = JSON.parse(readFileSync(lease, 'utf8'));
      const info = statSync(socket);
      assert.equal(owner.session, `${info.dev}:${info.ino}`);
      assert.equal(existsSync(join(config, 'herdr')), false, 'package must not enable/link plugins');
      assert.equal(existsSync(join(home, '.config/herdr')), false, 'package must not edit Herdr user config');
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'close');
      }
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
