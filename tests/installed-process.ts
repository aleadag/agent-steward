import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

export type ProcessRow = { pid: number; parent: number; state: string; command: string };

function invoke(variable: string, args: string[]): string {
  const command = process.env[variable];
  assert.ok(command, `installed observation requires ${variable}`);
  const result = spawnSync(command, args, { env: { PATH: '' }, encoding: 'utf8', timeout: 1_000 });
  assert.equal(result.status, 0, 'native installed process observation failed');
  assert.equal(result.error, undefined, 'native installed process observation failed');
  return result.stdout.trim();
}

export function executablePath(pid: number): string {
  const path = invoke('AGENT_STEWARD_PROCESS_PATH', [String(pid)]);
  assert.ok(path.startsWith('/'), 'native executable path is absolute');
  return realpathSync(path);
}

export function processRow(pid: number): ProcessRow {
  const line = invoke('AGENT_STEWARD_PS', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,stat=,command=']);
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
  assert.ok(match, 'owned process row must be complete');
  assert.equal(Number(match[1]), pid);
  return { pid, parent: Number(match[2]), state: match[3]!, command: match[4]! };
}

export function childPids(parent: number): number[] {
  // Enumerate identifiers only; never read unrelated processes' argv/environment.
  return invoke('AGENT_STEWARD_PS', ['-axo', 'pid=,ppid='])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      assert.ok(match, 'native PID/PPID row must be complete');
      return { pid: Number(match[1]), parent: Number(match[2]) };
    })
    .filter((row) => row.parent === parent)
    .map((row) => row.pid);
}

export function assertInstalledProcess(pid: number, runtime: string, entry: string): void {
  assert.equal(executablePath(pid), realpathSync(runtime));
  const row = processRow(pid);
  assert.ok(row.command.split(/\s+/).includes(entry), 'installed entry must appear intact in argv');
  // Store paths used in these assertions have no spaces; runtime identity is obtained natively above.
  if (process.platform === 'linux') {
    assert.equal(realpathSync(`/proc/${pid}/exe`), realpathSync(runtime));
    assert.ok(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(entry));
  }
}

export function findInstalledChild(parent: number, runtime: string, entry: string): number | undefined {
  const pid = childPids(parent).find((child) => {
    const row = processRow(child);
    return row.parent === parent && row.command.split(/\s+/).includes(entry);
  });
  if (pid === undefined) return undefined;
  assertInstalledProcess(pid, runtime, entry);
  assert.equal(processRow(pid).parent, parent, 'packaged main.js must have the adapter as PPID');
  if (process.platform === 'linux') {
    const children = readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8').trim().split(/\s+/);
    assert.ok(children.includes(String(pid)), 'Linux task children must confirm the portable PPID');
  }
  return pid;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  const row = processRow(pid);
  if (/^[ZX]/.test(row.state)) return false;
  if (process.platform === 'linux') {
    if (!existsSync(`/proc/${pid}/stat`)) return false;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ', 1)[0];
    return state !== undefined && state !== 'Z' && state !== 'X';
  }
  return true;
}
