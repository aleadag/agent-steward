import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { runScheduler, type SchedulerOptions } from '../src/herdr-adapter/scheduler.ts';
import * as entry from '../src/herdr-adapter/entry.ts';
import { deferred, within } from './herdr-lease-helpers.ts';

const warning =
  'agent-steward: release unconfirmed; shutdown incomplete; event hooks may still act. Human review required.\n';
const recovery =
  'agent-steward: scheduler lease unavailable. If recovery is needed, disable the plugin, stop all adapters and verify they are dead before offline cleanup of a stranded guard or legacy lease. Preserve episode records and generation tombstones.\n';
const sensitive = 'synthetic-token synthetic-session /sensitive/state synthetic-credential';
const herdr = () => ({ get: async () => null, read: async () => null });
function options(store: EpisodeStore, signal = new AbortController().signal): SchedulerOptions {
  return { store, signal, herdr: herdr(), decide: async () => null, targets: [], sessionId: 'server-1' };
}

// Fails if release waits behind foreground work, or an unconfirmed marker is called stopped.
for (const realBudget of [false, true]) {
  test(`unconfirmed release returns incomplete and stays observable${realBudget ? ' with real five-second shutdown budget' : ''}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'steward-release-budget-'));
    const ready = deferred<void>(),
      markerEntered = deferred<void>(),
      markerResume = deferred<void>();
    const ctrl = new AbortController();
    let expire!: () => void;
    let cancelled = 0;
    const store = new EpisodeStore(directory, undefined, {
      io: {
        mkdir: async (path, permissions) => {
          if (path.endsWith('/released')) {
            markerEntered.resolve();
            await markerResume.promise;
          }
          return mkdir(path, permissions);
        },
      },
    });
    const running = runScheduler({
      ...options(store, ctrl.signal),
      onLease: () => ready.resolve(),
      ...(realBudget
        ? {}
        : {
            shutdownDeadline: (ms: number, callback: () => void) => {
              assert.equal(ms, 5_000);
              expire = callback;
              return () => {
                cancelled++;
              };
            },
          }),
    });
    let token: string | null = null;
    try {
      await within(ready.promise);
      token = await store.activeToken('server-1');
      assert.ok(token);
      const start = performance.now();
      ctrl.abort();
      await within(markerEntered.promise);
      if (!realBudget) {
        assert.equal(typeof expire, 'function');
        expire();
      }
      assert.equal(await within(running, realBudget ? 6_500 : 1_000).catch(() => 'pending'), 'shutdown_incomplete');
      if (realBudget) {
        const elapsed = performance.now() - start;
        // Observation on a responsive JS event loop, not native I/O cancellation or process exit.
        assert.ok(elapsed >= 4_900 && elapsed < 6_500, `elapsed ${elapsed}ms`);
      } else assert.equal(cancelled, 1);
      assert.equal(await store.owned(token, 'server-1'), false);
      const eventStore = new EpisodeStore(directory);
      assert.equal(await eventStore.leaseMatches(token, 'server-1'), true);
      markerResume.resolve();
      await within(store.release(token));
      assert.equal(await eventStore.leaseMatches(token, 'server-1'), false);
      assert.equal(await running, 'shutdown_incomplete', 'late confirmation cannot rewrite the result');
    } finally {
      ctrl.abort();
      markerResume.resolve();
      if (token) await store.release(token).catch(() => {});
      await within(running).catch(() => {});
    }
  }, 8_000);
}

for (const cause of ['corrupt episode', 'session loss', 'ownership loss'] as const) {
  for (const release of ['confirmed', 'rejected', 'deadline'] as const) {
    test(`internal shutdown ${cause}: ${release} bypasses hanging diagnostic`, async () => {
      const markerEntered = deferred<void>(),
        markerResume = deferred<void>();
      const diagnostic = deferred<void>(),
        diagnosticResume = deferred<void>();
      let expire!: () => void;
      let diagnostics = 0;
      const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-internal-stop-')), undefined, {
        io: {
          mkdir: async (path, permissions) => {
            if (path.endsWith('/released')) {
              markerEntered.resolve();
              if (release === 'rejected') throw new Error(sensitive);
              if (release === 'deadline') await markerResume.promise;
            }
            return mkdir(path, permissions);
          },
        },
      });
      if (cause === 'corrupt episode') {
        await store.prepare();
        const { createHash } = await import('node:crypto');
        const file = createHash('sha256').update('w1:p1').digest('hex') + '.json';
        await writeFile(join(store.directory, file), '{broken', { mode: 0o600 });
      }
      if (cause === 'ownership loss') store.heartbeat = async () => false;
      const ctrl = new AbortController();
      const running = runScheduler({
        ...options(store, ctrl.signal),
        targets: cause === 'corrupt episode' ? ['w1:p1'] : [],
        sessionValid: async () => cause !== 'session loss',
        handoff: async () => {
          diagnostics++;
          diagnostic.resolve();
          await diagnosticResume.promise;
        },
        shutdownDeadline: (ms, callback) => {
          assert.equal(ms, 5_000);
          expire = callback;
          return () => {};
        },
      });
      try {
        assert.equal(await within(markerEntered.promise.then(() => true)).catch(() => false), true);
        if (release === 'deadline') expire();
        assert.equal(
          await within(running).catch(() => 'pending'),
          release === 'confirmed' ? 'stopped' : 'shutdown_incomplete',
        );
        if (release === 'confirmed') await within(diagnostic.promise);
        assert.equal(diagnostics, release === 'confirmed' ? 1 : 0);
        assert.equal(ctrl.signal.aborted, false, 'internal exit must not depend on an external abort');
        assert.equal(await store.active('server-1'), release !== 'confirmed');
        if (release === 'deadline') {
          const token = await store.activeToken('server-1');
          assert.ok(token);
          markerResume.resolve();
          await within(store.release(token));
          assert.equal(diagnostics, 0, 'late confirmation must not add a fatal handoff after incomplete');
        }
      } finally {
        ctrl.abort();
        markerResume.resolve();
        diagnosticResume.resolve();
        await within(running).catch(() => {});
      }
    });
  }
}

test('already aborted scheduler creates no acquisition or callback work', async () => {
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-preaborted-')));
  const ctrl = new AbortController();
  ctrl.abort();
  let attempts = 0,
    callbacks = 0;
  const begin = store.beginAcquire.bind(store);
  store.beginAcquire = (session) => {
    attempts++;
    return begin(session);
  };
  assert.equal(
    await runScheduler({
      ...options(store, ctrl.signal),
      onLease: () => {
        callbacks++;
      },
      sessionValid: async () => {
        callbacks++;
        return true;
      },
      shutdownDeadline: () => {
        callbacks++;
        return () => {};
      },
    }),
    'stopped',
  );
  assert.equal(attempts, 0);
  assert.equal(callbacks, 0);
  await assert.rejects(lstat(join(store.directory, 'scheduler-lease')), { code: 'ENOENT' });
});

for (const failure of ['beginAcquire', 'release', 'ready', 'ready and revocation'] as const) {
  test(`shutdown observes ${failure} failure without exposing sensitive errors`, async () => {
    const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-stop-throw-')), undefined, {
      io: {
        mkdir: async (path, permissions) => {
          if (failure === 'ready and revocation' && path.endsWith('/released')) throw new Error(sensitive);
          return mkdir(path, permissions);
        },
      },
    });
    const ctrl = new AbortController();
    const begin = store.beginAcquire.bind(store);
    store.beginAcquire = (session) => {
      if (failure === 'beginAcquire') throw new Error(sensitive);
      const attempt = begin(session);
      if (failure === 'release')
        return {
          ...attempt,
          release: () => {
            throw new Error(sensitive);
          },
        };
      return {
        ...attempt,
        ready: attempt.ready.then(() => {
          throw new Error(sensitive);
        }),
      };
    };
    const result = await within(runScheduler({ ...options(store, ctrl.signal), onLease: () => ctrl.abort() }));
    assert.equal(result, failure === 'ready' ? 'stopped' : 'shutdown_incomplete');
    let text = '',
      failures = 0;
    assert.equal(typeof entry.reportSchedulerResult, 'function');
    entry.reportSchedulerResult(result, {
      write: (value) => {
        text += value;
      },
      fail: () => {
        failures++;
      },
    });
    assert.equal(text, failure === 'ready' ? '' : warning);
    assert.equal(failures, failure === 'ready' ? 0 : 1);
    for (const secret of sensitive.split(' ')) assert.equal(text.includes(secret), false);
    const token = await store.activeToken('server-1');
    if (token) await store.release(token).catch(() => {});
  });
}

test('abort during synchronous attempt creation closes the returned handle before work', async () => {
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-sync-abort-')));
  const ctrl = new AbortController();
  const begin = store.beginAcquire.bind(store);
  let callbacks = 0,
    deadlines = 0;
  store.beginAcquire = (session) => {
    const attempt = begin(session);
    ctrl.abort();
    return attempt;
  };
  const result = await within(
    runScheduler({
      ...options(store, ctrl.signal),
      onLease: () => {
        callbacks++;
      },
      shutdownDeadline: (ms) => {
        assert.equal(ms, 5_000);
        deadlines++;
        return () => {};
      },
    }),
  );
  assert.equal(result, 'stopped');
  assert.equal(callbacks, 0);
  assert.equal(deadlines, 1);
  assert.equal(await store.activeToken('server-1'), null);
});

test('ordinary refusal returns already_owned without joining its handoff', async () => {
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-refusal-')));
  const token = await store.acquire('server-1');
  assert.ok(token);
  const held = deferred<void>();
  let notices = 0;
  try {
    assert.equal(
      await within(
        runScheduler({
          ...options(store),
          handoff: async () => {
            notices++;
            await held.promise;
          },
        }),
      ),
      'already_owned',
    );
    assert.equal(notices, 1);
    assert.equal(await store.leaseMatches(token, 'server-1'), true);
  } finally {
    held.resolve();
    await store.release(token);
  }
});

test('abort racing refusal cannot claim a confirmed stop for an uninitialized attempt', async () => {
  const store = new EpisodeStore(await mkdtemp(join(tmpdir(), 'steward-refusal-abort-')));
  const token = await store.acquire('server-1');
  assert.ok(token);
  const ctrl = new AbortController();
  const begin = store.beginAcquire.bind(store);
  store.beginAcquire = (session) => {
    const attempt = begin(session);
    return {
      ...attempt,
      ready: attempt.ready.then((value) => {
        ctrl.abort();
        return value;
      }),
    };
  };
  try {
    assert.equal(await within(runScheduler(options(store, ctrl.signal))), 'shutdown_incomplete');
    assert.equal(await store.leaseMatches(token, 'server-1'), true);
  } finally {
    await store.release(token);
  }
});

for (const [result, text, failures] of [
  ['stopped', '', 0],
  ['already_owned', recovery, 0],
  ['shutdown_incomplete', warning, 1],
] as const) {
  test(`shutdown result reporter: ${result}`, () => {
    assert.equal(typeof entry.reportSchedulerResult, 'function');
    let actual = '',
      count = 0;
    entry.reportSchedulerResult(result, {
      write: (value) => {
        actual += value;
      },
      fail: () => {
        count++;
      },
    });
    assert.equal(actual, text);
    assert.equal(count, failures);
  });
}

async function childResult(source: string, milliseconds = 3_000) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stderr = '',
    stdout = '';
  child.stderr!.setEncoding('utf8');
  child.stdout!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout!.on('data', (chunk: string) => {
    stdout += chunk;
  });
  try {
    const [code] = await within(closed, milliseconds);
    return { code, stderr, stdout };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed;
    }
  }
}

test('visible incomplete result emits only fixed warning', async () => {
  const entryUrl = new URL('../src/herdr-adapter/entry.ts', import.meta.url).href;
  const result = await childResult(`
    import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
    import { createServer } from 'node:net';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const { runVisibleScheduler } = await import(${JSON.stringify(entryUrl)});
    const directory = await mkdtemp(join(tmpdir(), 'steward-visible-'));
    const config = join(directory, 'config');
    await mkdir(config);
    await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: [] }));
    const socket = join(directory, 'fake.sock');
    const server = createServer((connection) => connection.end());
    await new Promise((resolve) => server.listen(socket, resolve));
    const before = ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event));
    try {
      await runVisibleScheduler({
        HERDR_SOCKET_PATH: socket, HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_STATE_DIR: join(directory, 'state'),
      }, async () => 'shutdown_incomplete');
      if (['SIGINT', 'SIGTERM'].some((event, i) => process.listenerCount(event) !== before[i])) process.exitCode = 2;
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  `);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout, '');
  for (const secret of sensitive.split(' ')) assert.equal(result.stderr.includes(secret), false);
});

// Exercise the real fatal path, not merely an injected SchedulerResult: corrupt episode
// state fails reconciliation before any Herdr request, with real generation release I/O.
for (const mode of ['failed marker', 'held marker', 'confirmed fatal', 'creation throws', 'clean abort'] as const) {
  test(`visible real shutdown preserves exclusive result reporting: ${mode}`, async () => {
    const entryUrl = new URL('../src/herdr-adapter/entry.ts', import.meta.url).href;
    const schedulerUrl = new URL('../src/herdr-adapter/scheduler.ts', import.meta.url).href;
    const stateUrl = new URL('../src/herdr-adapter/state.ts', import.meta.url).href;
    const helpersUrl = new URL('./herdr-lease-helpers.ts', import.meta.url).href;
    const result = await childResult(`
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
      import { createServer } from 'node:net';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const { runVisibleScheduler } = await import(${JSON.stringify(entryUrl)});
      const { runScheduler } = await import(${JSON.stringify(schedulerUrl)});
      const { EpisodeStore } = await import(${JSON.stringify(stateUrl)});
      const { deferred, within } = await import(${JSON.stringify(helpersUrl)});
      const mode = ${JSON.stringify(mode)};
      const directory = await mkdtemp(join(tmpdir(), 'steward-visible-fatal-'));
      const config = join(directory, 'config'), state = join(directory, 'state');
      await mkdir(config);
      await writeFile(join(config, 'targets.json'), JSON.stringify({ pane_ids: mode === 'clean abort' ? [] : ['w1:p1'] }));
      await new EpisodeStore(state).prepare();
      if (mode !== 'clean abort') {
        const file = createHash('sha256').update('w1:p1').digest('hex') + '.json';
        await writeFile(join(state, file), '{broken', { mode: 0o600 });
      }
      const socket = join(directory, 'fake.sock');
      const server = createServer((connection) => connection.end());
      await new Promise((resolve) => server.listen(socket, resolve));
      const markerEntered = deferred(), markerResume = deferred();
      let expire, attempt;
      const visible = runVisibleScheduler({
        HERDR_SOCKET_PATH: socket, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: state,
      }, (options) => {
        const store = new EpisodeStore(state, undefined, { io: {
          mkdir: async (path, permissions) => {
            if (path.endsWith('/released')) {
              markerEntered.resolve();
              if (mode === 'failed marker') throw new Error(${JSON.stringify(sensitive)});
              if (mode === 'held marker') await markerResume.promise;
            }
            return mkdir(path, permissions);
          },
        } });
        const begin = store.beginAcquire.bind(store);
        store.beginAcquire = (session) => {
          if (mode === 'creation throws') throw new Error(${JSON.stringify(sensitive)});
          return (attempt = begin(session));
        };
        return runScheduler({ ...options, store,
          onLease: () => { if (mode === 'clean abort') process.emit('SIGTERM'); },
          shutdownDeadline: (ms, callback) => { assert.equal(ms, 5000); expire = callback; return () => {}; },
        });
      });
      try {
        if (mode === 'held marker') { await within(markerEntered.promise); expire(); }
        await within(visible);
      } finally {
        markerResume.resolve();
        if (attempt) await within(attempt.release()).catch(() => {});
        await new Promise((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    `);
    const incomplete = mode === 'failed marker' || mode === 'held marker' || mode === 'creation throws';
    assert.equal(result.code, incomplete ? 1 : 0);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      incomplete
        ? warning
        : mode === 'confirmed fatal'
          ? 'agent-steward: human_review_required (observation_unavailable)\n'
          : '',
    );
    for (const secret of sensitive.split(' ')) assert.equal(result.stderr.includes(secret), false);
  });
}

// Observe real late filesystem/callback rejection chains without global handlers in this test process.
for (const boundary of [
  'release',
  'heartbeat',
  'acquisition',
  'foreground',
  'timer validation',
  'timer heartbeat',
] as const) {
  test(`shutdown observes late rejected ${boundary} in isolated Bun child`, async () => {
    const schedulerUrl = new URL('../src/herdr-adapter/scheduler.ts', import.meta.url).href;
    const storeUrl = new URL('../src/herdr-adapter/state.ts', import.meta.url).href;
    const helpersUrl = new URL('./herdr-lease-helpers.ts', import.meta.url).href;
    const result = await childResult(`
      import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const { runScheduler } = await import(${JSON.stringify(schedulerUrl)});
      const { EpisodeStore } = await import(${JSON.stringify(storeUrl)});
      const { deferred, within } = await import(${JSON.stringify(helpersUrl)});
      let unhandled = false;
      process.on('unhandledRejection', () => { unhandled = true; process.exitCode = 1; });
      const entered = deferred(), resume = deferred(), ready = deferred(), foregroundResume = deferred();
      const lateSettled = deferred();
      let foregroundPending = false;
      const directory = await mkdtemp(join(tmpdir(), 'steward-late-rejection-'));
      const boundary = ${JSON.stringify(boundary)};
      let expire, heartbeats = 0, settling;
      const expose = (operation) => (settling = operation.then((value) => value, (error) => {
        lateSettled.resolve(); throw error;
      }));
      const store = new EpisodeStore(directory, undefined, { io: {
        mkdir: async (path, options) => {
          if (boundary === 'release' && path.endsWith('/released')) {
            entered.resolve(); await resume.promise; throw new Error('sensitive');
          }
          return mkdir(path, options);
        },
        rename: async (from, to) => {
          if ((boundary === 'acquisition' && to.endsWith('/active.json')) ||
              (boundary === 'heartbeat' && to.endsWith('/heartbeat.json') && ++heartbeats === 2) ||
              (boundary === 'timer heartbeat' && foregroundPending && to.endsWith('/heartbeat.json'))) {
            entered.resolve(); await resume.promise; throw new Error('sensitive');
          }
          return rename(from, to);
        },
      } });
      // Only the scheduler observes the returned rejecting promise until after the event-loop check.
      const begin = store.beginAcquire.bind(store);
      store.beginAcquire = (session) => {
        const attempt = begin(session);
        if (boundary === 'acquisition') {
          const late = expose(attempt.ready);
          return { ...attempt, ready: late };
        }
        if (boundary === 'release') return { ...attempt, release: () => expose(attempt.release()) };
        return attempt;
      };
      if (boundary === 'heartbeat' || boundary === 'timer heartbeat') {
        const heartbeat = store.heartbeat.bind(store);
        store.heartbeat = (...args) => expose(heartbeat(...args).then((value) => {
          // Real lease I/O errors normalize to false; also exercise a rejecting scheduler dependency.
          if (!value) throw new Error('sensitive');
          return value;
        }));
      }
      if (boundary === 'foreground') store.next = () => expose((async () => {
        entered.resolve(); await resume.promise; throw new Error('sensitive');
      })());
      if (boundary.startsWith('timer')) store.next = async () => {
        foregroundPending = true; await foregroundResume.promise; return null;
      };
      const ctrl = new AbortController();
      const running = runScheduler({ store, signal: ctrl.signal, sessionId: 'server-1', targets: [],
        herdr: { get: async () => null, read: async () => null }, decide: async () => null,
        onLease: () => ready.resolve(), heartbeatIntervalMs: 5,
        sessionValid: () => {
          if (boundary !== 'timer validation' || !foregroundPending) return Promise.resolve(true);
          return expose((async () => { entered.resolve(); await resume.promise; throw new Error('sensitive'); })());
        },
        shutdownDeadline: (ms, callback) => { if (ms !== 5000) throw new Error('budget'); expire = callback; return () => {}; },
      });
      try {
        if (boundary === 'release') { await within(ready.promise); ctrl.abort(); }
        await within(entered.promise);
        ctrl.abort();
        if (boundary === 'release') expire();
        const value = await within(running);
        if (value !== (boundary === 'release' ? 'shutdown_incomplete' : 'stopped')) throw new Error('result');
        resume.resolve();
        await within(lateSettled.promise);
        // This delay drains an already-settled rejection only; interleavings above use explicit barriers.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (unhandled) throw new Error('unhandled');
        await settling.catch(() => {});
        process.stdout.write('observed\\n');
      } catch {
        process.stdout.write('failed\\n'); process.exitCode = 1;
      } finally {
        ctrl.abort(); resume.resolve(); foregroundResume.resolve();
        await within(running).catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    `);
    assert.deepEqual(result, { code: 0, stderr: '', stdout: 'observed\n' });
  });
}
