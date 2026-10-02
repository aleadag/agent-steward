#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { appendFile, readFile, writeFile, mkdir, chmod, rename, unlink, lstat } from 'node:fs/promises';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { QuotaHttpGet } from './quota-refresh.ts';
import { postHttps } from './jev.ts';
import { readBoundedUtf8, readFileText } from './io.ts';
import { run } from './cli.ts';
import type { Runtime } from './cli.ts';
import { fileURLToPath } from 'node:url';
import { agyPaths, setupAgy, verifyAgySetup } from './agy-setup.ts';
import { runAgyHook } from './agy-hook.ts';
import { collectNativeAgy, sendAgyCapture, runPreviousAgyRenderer } from './agy-runtime.ts';
import { fileSize, withLedgerLock } from './ledger-io.ts';
import { launchForeground } from './process.ts';
import type { NativeLaunch } from './launch.ts';

export const httpGet: QuotaHttpGet = async (url, headers) => {
  const original = new URL(url);
  const signal = AbortSignal.timeout(15_000);
  let target = original;
  for (let redirects = 0; ; redirects++) {
    if (target.protocol !== 'https:' || target.host !== original.host || target.username || target.password)
      throw new Error('quota_fetch');
    const response = await new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let stream: IncomingMessage | undefined;
      let settled = false;
      const finish = (value?: { status: number; body: string; location?: string }): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', fail);
        if (value === undefined) {
          stream?.destroy();
          request?.destroy();
          reject(new Error('quota_fetch'));
        } else resolve(value);
      };
      const fail = (): void => finish();
      if (signal.aborted) {
        fail();
        return;
      }
      try {
        request = https.request(target, { method: 'GET', headers, signal }, (incoming) => {
          stream = incoming;
          const status = incoming.statusCode ?? 0;
          if (status !== 200) {
            incoming.destroy();
            const location = incoming.headers.location;
            finish({ status, body: '', ...(location === undefined ? {} : { location }) });
            return;
          }
          readBoundedUtf8(incoming).then((body) => finish({ status, body }), fail);
        });
        request.once('error', fail);
        signal.addEventListener('abort', fail, { once: true });
        if (signal.aborted) fail();
        else request.end();
      } catch {
        fail();
      }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { status: response.status, body: response.body };
    if (redirects !== 0 || !response.location) throw new Error('quota_fetch');
    target = new URL(response.location, target);
  }
};

export function createRuntime(): Runtime {
  const runtime: Runtime = {
    env: {
      get HOME() {
        return process.env.HOME;
      },
      get XDG_CONFIG_HOME() {
        return process.env.XDG_CONFIG_HOME;
      },
      get XDG_STATE_HOME() {
        return process.env.XDG_STATE_HOME;
      },
      get TYPESAFE_API_KEY() {
        return process.env.TYPESAFE_API_KEY;
      },
      get CODEX_HOME() {
        return process.env.CODEX_HOME;
      },
      get PI_CODING_AGENT_DIR() {
        return process.env.PI_CODING_AGENT_DIR;
      },
    },
    cwd: process.cwd(),
    readText: readFileText,
    writeText: (path: string, text: string, mode: number) =>
      writeFile(path, text, { encoding: 'utf8', mode, flag: 'wx' }),
    rename,
    unlink,
    httpGet,
    fileSize,
    withLedgerLock,
    withAgyLock: withLedgerLock,
    collectAgy: (paths, requestId) =>
      collectNativeAgy({
        paths,
        requestId,
        now: runtime.now,
        nativeEnv: process.env,
        executable: Bun.which('agy') ?? 'agy',
      }),
    setupAgy: () =>
      setupAgy(
        agyPaths(runtime.env),
        process.env.AGENT_STEWARD_COMMAND
          ? [process.env.AGENT_STEWARD_COMMAND]
          : [process.execPath, fileURLToPath(import.meta.url)],
        {
          readText: readFileText,
          lstat,
          writeText: runtime.writeText,
          rename,
          unlink,
          mkdirp: runtime.mkdirp,
          chmod,
          withLock: withLedgerLock,
        },
      ),
    runAgyHook: (input) =>
      runAgyHook(input, {
        now: runtime.now,
        readManifest: () => verifyAgySetup(agyPaths(runtime.env), { readText: readFileText }),
        captureRequest:
          process.env.AGENT_STEWARD_AGY_CAPTURE_SOCKET && process.env.AGENT_STEWARD_AGY_CAPTURE_REQUEST_ID
            ? {
                socketPath: process.env.AGENT_STEWARD_AGY_CAPTURE_SOCKET,
                requestId: process.env.AGENT_STEWARD_AGY_CAPTURE_REQUEST_ID,
              }
            : null,
        sendCapture: sendAgyCapture,
        runRenderer: (command, data) =>
          runPreviousAgyRenderer(command, data, process.env.AGENT_STEWARD_SHELL ?? Bun.which('sh') ?? '/bin/sh'),
      }),
    appendText: async (path: string, text: string) => {
      try {
        await chmod(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await appendFile(path, text, { encoding: 'utf8', mode: 0o600 });
    },
    readTextIfPresent: async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    mkdirp: async (path: string, mode: number) => {
      await mkdir(path, { recursive: true, mode });
    },
    chmod,
    readStdin: () => readBoundedUtf8(process.stdin),
    stdout: (text: string) => {
      process.stdout.write(text);
    },
    stderr: (text: string) => {
      process.stderr.write(text);
    },
    now: () => new Date(),
    newRequestId: () => randomUUID(),
    post: postHttps,
    terminal: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    launch: (command: NativeLaunch) => launchForeground(command, { cwd: process.cwd(), env: process.env }),
  };
  return runtime;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), createRuntime());
