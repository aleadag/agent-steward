#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { postHttps } from './jev.js';
import { readBoundedUtf8, readFileText } from './io.js';
import { run } from './cli.js';
import { launchForeground } from './process.js';
import type { NativeLaunch } from './launch.js';

const runtime = {
  env: {
    get HOME() {
      return process.env.HOME;
    },
    get XDG_CONFIG_HOME() {
      return process.env.XDG_CONFIG_HOME;
    },
    get TYPESAFE_API_KEY() {
      return process.env.TYPESAFE_API_KEY;
    },
  },
  cwd: process.cwd(),
  readText: readFileText,
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
