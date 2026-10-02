#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { appendFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { postHttps } from './jev.ts';
import { readBoundedUtf8, readFileText } from './io.ts';
import { run } from './cli.ts';
import { launchForeground } from './process.ts';
import type { NativeLaunch } from './launch.ts';

const runtime = {
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
  },
  cwd: process.cwd(),
  readText: readFileText,
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

process.exitCode = await run(process.argv.slice(2), runtime);
