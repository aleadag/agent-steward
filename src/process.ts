import { spawn } from 'node:child_process';
import process from 'node:process';
import { delimiter, isAbsolute } from 'node:path';
import { StewardError } from './contracts.ts';
import type { NativeLaunch } from './launch.ts';

type SignalSource = {
  on(signal: 'SIGTERM', listener: () => void): void;
  off(signal: 'SIGTERM', listener: () => void): void;
};

type LaunchOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  signalSource?: SignalSource;
};

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

export function isSafeSearchPath(path: string | undefined): boolean {
  const paths = path?.split(delimiter);
  return paths !== undefined && paths.length > 0 && paths.every((entry) => entry.length > 0 && isAbsolute(entry));
}

export async function launchForeground(command: NativeLaunch, options: LaunchOptions): Promise<number> {
  if (!isSafeSearchPath(options.env.PATH)) throw new StewardError('launch_failed');

  const env = Object.fromEntries(
    Object.entries(options.env).filter(([key]) => key.toUpperCase() !== 'TYPESAFE_API_KEY'),
  );

  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = (options.spawnImpl ?? spawn)(command.executable, command.args, {
        cwd: options.cwd,
        env,
        stdio: 'inherit',
        shell: false,
      });
    } catch {
      reject(new StewardError('launch_failed'));
      return;
    }

    const signals = options.signalSource ?? process;
    let forwarded = false;
    const onTerminate = (): void => {
      if (forwarded) return;
      forwarded = true;
      child.kill('SIGTERM');
    };
    const cleanup = (): void => signals.off('SIGTERM', onTerminate);

    signals.on('SIGTERM', onTerminate);
    child.once('error', () => {
      cleanup();
      reject(new StewardError('launch_failed'));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? signalExitCode(signal));
    });
  });
}
