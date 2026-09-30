import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { delimiter } from 'node:path';
import { launchForeground } from '../src/process.ts';
import { StewardError } from '../src/contracts.ts';
import type { NativeLaunch } from '../src/launch.ts';
import { runSubcase } from './helpers.ts';

type SpawnedChild = ReturnType<typeof import('node:child_process').spawn>;
type FakeChild = EventEmitter & { kill: (signal: NodeJS.Signals) => boolean };
type SpawnCall = [string, readonly string[] | undefined, unknown];

const command: NativeLaunch = {
  executable: 'pi',
  args: ['--model', 'fast', '--', 'User task:\nReview the parser'],
};
const env: NodeJS.ProcessEnv = {
  TYPESAFE_API_KEY: 'SyntheticKey-Not-Real',
  typesafe_api_key: 'SyntheticCaseVariant-Not-Real',
  OPENAI_API_KEY: 'SyntheticProviderKey-Not-Real',
  PATH: '/trusted/bin',
};

function fakeChild(): { child: FakeChild; kills: NodeJS.Signals[] } {
  const kills: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    kill: (signal: NodeJS.Signals) => {
      kills.push(signal);
      return true;
    },
  });
  return { child, kills };
}

function fakeSignals(): EventEmitter {
  return new EventEmitter();
}

function asSpawnedChild(child: FakeChild): SpawnedChild {
  return child as unknown as SpawnedChild;
}

function asSpawnImpl(
  implementation: (executable: string, args: readonly string[] | undefined, options: unknown) => SpawnedChild,
): typeof import('node:child_process').spawn {
  // launchForeground calls the three-argument spawn overload; Node types expose spawn as several overloads.
  return implementation as unknown as typeof import('node:child_process').spawn;
}

function launchWith(child: FakeChild, options: { signalSource?: EventEmitter } = {}) {
  const calls: SpawnCall[] = [];
  const promise = launchForeground(command, {
    cwd: '/isolated/work',
    env,
    signalSource: options.signalSource ?? fakeSignals(),
    spawnImpl: asSpawnImpl((executable, args, spawnOptions) => {
      calls.push([executable, args, spawnOptions]);
      return asSpawnedChild(child);
    }),
  });
  return { promise, calls };
}

function assertLaunchFailed(promise: Promise<number>, forbidden: readonly string[] = []) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof StewardError);
    assert.equal(error.code, 'launch_failed');
    assert.equal(error.message, 'launch_failed');
    for (const text of forbidden) assert.ok(!error.message.includes(text));
    return true;
  });
}

test('launch uses fixed argv, inherited terminal, caller cwd and filtered environment', async () => {
  const { child } = fakeChild();
  const { promise, calls } = launchWith(child);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'pi');
  assert.deepEqual(calls[0]![1], ['--model', 'fast', '--', 'User task:\nReview the parser']);
  assert.deepEqual(calls[0]![2], {
    cwd: '/isolated/work',
    env: { OPENAI_API_KEY: 'SyntheticProviderKey-Not-Real', PATH: '/trusted/bin' },
    stdio: 'inherit',
    shell: false,
  });
  child.emit('exit', 0, null);
  assert.equal(await promise, 0);
});

test('missing, empty and relative PATH components fail before spawning', async () => {
  const unsafePaths: [string, string | undefined][] = [
    ['missing PATH', undefined],
    ['empty PATH', ''],
    ['empty PATH entry', `${delimiter}/trusted/bin`],
    ['relative PATH entry', `./bin${delimiter}/trusted/bin`],
  ];
  for (const [name, path] of unsafePaths) {
    await runSubcase(name, async () => {
      let calls = 0;
      const badEnv: NodeJS.ProcessEnv = { ...env };
      if (path === undefined) delete badEnv.PATH;
      else badEnv.PATH = path;
      const promise = launchForeground(command, {
        cwd: '/isolated/work',
        env: badEnv,
        spawnImpl: asSpawnImpl(() => {
          calls += 1;
          return asSpawnedChild(fakeChild().child);
        }),
      });
      await assertLaunchFailed(promise, [path || 'PATH']);
      assert.equal(calls, 0);
    });
  }
});

test('child exit status is returned without another spawn', async () => {
  const { child } = fakeChild();
  const { promise, calls } = launchWith(child);
  child.emit('exit', 7, null);
  assert.equal(await promise, 7);
  assert.equal(calls.length, 1);
});

test('signaled child exits return defined nonzero shell statuses', async () => {
  const signaledStatuses: [NodeJS.Signals, number][] = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 1],
  ];
  for (const [signal, status] of signaledStatuses) {
    await runSubcase(signal, async () => {
      const { child } = fakeChild();
      const { promise, calls } = launchWith(child);
      child.emit('exit', null, signal);
      assert.equal(await promise, status);
      assert.equal(calls.length, 1);
    });
  }
});

test('spawn error before a spawn event is fixed and does not retry', async () => {
  const { child } = fakeChild();
  const signalSource = fakeSignals();
  const { promise, calls } = launchWith(child, { signalSource });
  child.emit('error', new Error('private path'));
  await assertLaunchFailed(promise, ['private path', '/trusted/bin']);
  assert.equal(calls.length, 1);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

test('spawn error after a spawn event remains an uncertain fixed failure', async () => {
  const { child } = fakeChild();
  const signalSource = fakeSignals();
  const { promise, calls } = launchWith(child, { signalSource });
  child.emit('spawn');
  child.emit('error', new Error('private path'));
  await assertLaunchFailed(promise, ['private path', '/trusted/bin']);
  assert.equal(calls.length, 1);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

test('synchronous spawn failure is fixed and never retried', async () => {
  let calls = 0;
  const promise = launchForeground(command, {
    cwd: '/isolated/work',
    env,
    spawnImpl: () => {
      calls += 1;
      throw new Error('private path');
    },
  });
  await assertLaunchFailed(promise, ['private path', '/trusted/bin']);
  assert.equal(calls, 1);
});

test('parent SIGTERM forwards once and listener is removed on child exit', async () => {
  const { child, kills } = fakeChild();
  const signalSource = fakeSignals();
  const { promise, calls } = launchWith(child, { signalSource });
  assert.equal(signalSource.listenerCount('SIGTERM'), 1);
  signalSource.emit('SIGINT');
  assert.deepEqual(kills, []);
  signalSource.emit('SIGTERM');
  signalSource.emit('SIGTERM');
  assert.deepEqual(kills, ['SIGTERM']);
  child.emit('exit', 0, null);
  assert.equal(await promise, 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  assert.equal(calls.length, 1);
});

test('parent SIGTERM listener is removed on child error', async () => {
  const { child } = fakeChild();
  const signalSource = fakeSignals();
  const { promise } = launchWith(child, { signalSource });
  child.emit('error', new Error('private path'));
  await assertLaunchFailed(promise, ['private path']);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});
