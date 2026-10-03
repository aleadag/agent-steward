import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const usage =
  'Usage: steward-spawn --target-pane <id> [--direction <right|down>] --name <unique> --cwd <absolute-dir> -- <instruction>';

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface Layout {
  panes?: { pane_id?: string; rect?: { width?: number; height?: number } }[];
}

function run(args: string[]): number {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const options: Record<string, string> = {};
  let index = 0;
  while (index < args.length && args[index] !== '--') {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !['--target-pane', '--direction', '--name', '--cwd'].includes(flag) || value === undefined) return 1;
    options[flag] = value;
    index += 2;
  }
  const instruction = args[index + 1];
  let target = options['--target-pane'];
  let direction = options['--direction'];
  const name = options['--name'];
  const cwd = options['--cwd'];
  if (args[index] !== '--' || args.length !== index + 2 || !instruction || !target || !name || !cwd) return 1;
  if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) return 1;
  const steward = Bun.which('agent-steward');
  const herdr = Bun.which('herdr');
  if (!steward || !herdr || !isAbsolute(steward) || !isAbsolute(herdr)) return 1;
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const call = (argv: string[]) =>
    spawnSync(herdr, argv, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  if (!direction) {
    const result = call(['pane', 'layout', '--pane', target]);
    if (result.status !== 0) return 1;
    const raw = JSON.parse(result.stdout) as { result?: Layout & { layout?: Layout }; layout?: Layout } & Layout;
    const block = raw.result ?? raw;
    const layout = block.layout ?? block;
    let area = -1;
    for (const pane of layout.panes ?? []) {
      const width = Number(pane.rect?.width ?? 0);
      const height = Number(pane.rect?.height ?? 0);
      if (width * height > area && pane.pane_id) {
        area = width * height;
        target = pane.pane_id;
        direction = 2 * height >= width ? 'down' : 'right';
      }
    }
    if (area < 0) return 1;
  }
  if (direction !== 'right' && direction !== 'down') return 1;
  const launchDir = mkdtempSync(join(tmpdir(), 'steward-spawn-'));
  chmodSync(launchDir, 0o700);
  const launchScript = join(launchDir, 'start.sh');
  writeFileSync(
    launchScript,
    `#!/usr/bin/env bash\nset +x\ntrap '' TSTP\ncd -- ${quote(cwd)} || exit 1\nexec ${quote(steward)} router start -- ${quote(instruction)}\n`,
    { mode: 0o600 },
  );
  // Retain the private script even on failure: Herdr may already have launched it.
  const opened = call([
    'plugin',
    'pane',
    'open',
    '--plugin',
    'agent-steward-launcher',
    '--entrypoint',
    'argv',
    '--placement',
    'split',
    '--target-pane',
    target,
    '--direction',
    direction,
    '--cwd',
    cwd,
    '--env',
    `PI_HERDR_LAUNCH_SCRIPT=${launchScript}`,
    '--no-focus',
  ]);
  if (opened.status === 0) {
    try {
      const result = JSON.parse(opened.stdout) as { result?: { plugin_pane?: { pane?: { pane_id?: string } } } };
      const paneId = result.result?.plugin_pane?.pane?.pane_id;
      if (paneId) call(['pane', 'rename', paneId, name]);
    } catch {
      // Missing pane identity does not undo a successful open.
    }
  }
  process.stdout.write(`${name}\n`);
  return opened.status ?? 1;
}

if (import.meta.main) {
  let status = 1;
  try {
    status = run(process.argv.slice(2));
  } catch {
    // Invalid paths, malformed layout and unavailable IO fail without echoing inputs.
  }
  process.exit(status);
}
