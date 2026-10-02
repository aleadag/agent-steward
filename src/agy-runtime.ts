import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { AgyPaths } from './agy-setup.ts';
import { agyPaths, verifyAgySetup } from './agy-setup.ts';
import type { AgyCapture, AgyHookResult } from './agy-hook.ts';
import { createAgyProtocol } from './agy-protocol.ts';
import type { AgyEvent } from './agy-protocol.ts';
import { SnapshotSchema } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';
import { readBoundedUtf8, readFileText } from './io.ts';

export type NativeAgyResult =
  | { status: 'captured'; observation: AgyCapture }
  | { status: 'auth' | 'fetch' | 'malformed'; diagnostic?: 'quota_agy_setup' | 'quota_agy_trust' };
const captureSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  observedAt: SnapshotSchema.shape.windows.element.shape.observed_at,
  quota: z.unknown(),
});
export async function sendAgyCapture(
  request: { requestId: string; socketPath: string },
  observation: AgyCapture,
): Promise<void> {
  const text = JSON.stringify(captureSchema.parse(observation));
  assertByteLength(text);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(request.socketPath);
    socket.setTimeout(1000, () => socket.destroy(new Error('agy_capture')));
    socket.once('error', reject);
    socket.once('connect', () => socket.end(text + '\n'));
    socket.once('close', (hadError) => {
      if (!hadError) resolve();
    });
  });
}
export async function collectNativeAgy(options: {
  paths: AgyPaths;
  now: () => Date;
  nativeEnv: Record<string, string | undefined>;
  executable: string;
  requestId: string;
}): Promise<NativeAgyResult> {
  const paths = options.nativeEnv.PATH?.split(delimiter);
  if (!paths?.length || paths.some((path) => !path || !isAbsolute(path))) return { status: 'fetch' };
  if (
    Object.entries(options.nativeEnv).some(
      ([key, value]) =>
        !!value &&
        (key.startsWith('AGY_GATEWAY_') ||
          [
            'AGY_ADC_AUTH',
            'GOOGLE_APPLICATION_CREDENTIALS',
            'ANTIGRAVITY_LS_ADDRESS',
            'ANTIGRAVITY_CSRF_TOKEN',
            'ANTIGRAVITY_PROJECT_ID',
          ].includes(key)),
    )
  )
    return { status: 'auth' };
  try {
    const expected = agyPaths(options.nativeEnv);
    if ((Object.keys(expected) as (keyof AgyPaths)[]).some((key) => expected[key] !== options.paths[key]))
      return { status: 'auth' };
  } catch {
    return { status: 'auth' };
  }
  if (!(await verifyAgySetup(options.paths, { readText: readFileText })))
    return { status: 'fetch', diagnostic: 'quota_agy_setup' };
  let directory: string | undefined, server: Server | undefined, proc: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sockets = new Set<Socket>();
  let result: NativeAgyResult = { status: 'fetch' };
  try {
    const stat = await lstat(options.paths.workdir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: 'fetch' };
    directory = await mkdtemp(join(tmpdir(), 'as-'));
    await chmod(directory, 0o700);
    const socketPath = join(directory, 's');
    if (Buffer.byteLength(socketPath) > 103) throw new Error('agy_capture');
    const protocol = createAgyProtocol(options.requestId, options.now);
    let settled = false;
    let finish: (value: NativeAgyResult) => void = () => {};
    const completed = new Promise<NativeAgyResult>((resolve) => {
      finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
    });
    const event = (value: AgyEvent): void => {
      if (settled) return;
      for (const action of protocol.accept(value)) {
        if (action.kind === 'write') {
          try {
            proc?.terminal?.write(action.text);
          } catch {
            finish({ status: 'fetch' });
          }
        } else {
          const final = protocol.result();
          finish(
            final && 'observation' in final
              ? { status: 'captured', observation: final.observation }
              : (final ?? { status: 'fetch' }),
          );
        }
      }
    };
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.setTimeout(1000, () => socket.destroy());
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (settled) {
          socket.destroy();
          return;
        }
        if (buffer.length + chunk.length > 1048576) {
          socket.destroy();
          finish({ status: 'malformed' });
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
          const raw: unknown = JSON.parse(text);
          assertJsonDepth(raw);
          const observation = captureSchema.parse(raw);
          if (observation.requestId === options.requestId) event({ kind: 'capture', observation });
        } catch {
          finish({ status: 'malformed' });
        }
        socket.end();
      });
    });
    server.on('error', () => finish({ status: 'fetch' }));
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    let queries = '';
    proc = Bun.spawn([options.executable, '--log-file=/dev/null'], {
      cwd: options.paths.workdir,
      detached: true,
      env: {
        ...Object.fromEntries(
          Object.entries(options.nativeEnv).filter(([key]) => key.toUpperCase() !== 'TYPESAFE_API_KEY'),
        ),
        TERM: 'xterm-256color',
        AGY_CLI_DISABLE_AUTO_UPDATE: '1',
        AGENT_STEWARD_AGY_CAPTURE_SOCKET: socketPath,
        AGENT_STEWARD_AGY_CAPTURE_REQUEST_ID: options.requestId,
      },
      terminal: {
        cols: 140,
        rows: 40,
        data(terminal, data) {
          queries += Buffer.from(data).toString('latin1');
          queries = queries
            // eslint-disable-next-line no-control-regex -- Reply only to the native cursor query.
            .replace(/\x1b\[6n/g, () => {
              terminal.write('\x1b[1;1R');
              return '';
            })
            .slice(-3);
          event({ kind: 'terminal', bytes: data });
        },
      },
    });
    proc.exited.then(
      (code) => event({ kind: 'exit', code }),
      () => finish({ status: 'fetch' }),
    );
    timer = setTimeout(() => event({ kind: 'deadline' }), 45000);
    result = await completed;
  } catch {
    result = { status: 'fetch' };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (proc) {
        const signal = (name: NodeJS.Signals): void => {
          try {
            process.kill(-proc!.pid, name);
          } catch {
            if (proc!.exitCode === null) proc!.kill(name);
          }
        };
        signal('SIGTERM');
        const exited = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 2000);
          proc!.exited.then(
            () => {
              clearTimeout(timeout);
              resolve(true);
            },
            () => {
              clearTimeout(timeout);
              resolve(false);
            },
          );
        });
        if (!exited) {
          signal('SIGKILL');
          const killed = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 3000);
            proc!.exited.then(
              () => {
                clearTimeout(timeout);
                resolve(true);
              },
              () => {
                clearTimeout(timeout);
                resolve(false);
              },
            );
          });
          if (!killed) result = { status: 'fetch' };
        }
      }
    } catch {
      result = { status: 'fetch' };
    }
    try {
      proc?.terminal?.close();
    } catch {
      result = { status: 'fetch' };
    }
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        result = { status: 'fetch' };
      }
    }
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    } catch {
      result = { status: 'fetch' };
    }
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      result = { status: 'fetch' };
    }
  }
  return result;
}
export async function runPreviousAgyRenderer(command: string, input: string, shell: string): Promise<AgyHookResult> {
  const child = spawn(shell, ['-c', command], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const kill = (): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  };
  const cancel = (): void => kill();
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, cancel);
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  let failed = false;
  const timer = setTimeout(() => {
    failed = true;
    kill();
    child.stdout.destroy();
  }, 2000);
  try {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const stdout = await readBoundedUtf8(child.stdout);
    const exitCode = await exited;
    return failed ? { stdout: '', exitCode: 1 } : { stdout, exitCode };
  } catch {
    kill();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      exited.then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return { stdout: '', exitCode: 1 };
  } finally {
    clearTimeout(timer);
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.removeListener(signal, cancel);
  }
}
