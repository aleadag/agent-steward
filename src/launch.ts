import { StewardError } from './contracts.js';
import type { PlannedCommand } from './contracts.js';

export type NativeLaunch = { executable: PlannedCommand['executable']; args: string[] };

function hasUnsafeTaskControls(task: string): boolean {
  for (let index = 0; index < task.length; index += 1) {
    const code = task.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

export function assertLiveTask(task: string): void {
  if (!task.trim() || hasUnsafeTaskControls(task)) throw new StewardError('invalid_input');
}

export function buildNativeLaunch(command: PlannedCommand, task: string): NativeLaunch {
  assertLiveTask(task);
  const message = `User task:\n${task}`;
  return {
    executable: command.executable,
    args: [...command.args, ...(command.executable === 'agy' ? [`--prompt-interactive=${message}`] : ['--', message])],
  };
}
