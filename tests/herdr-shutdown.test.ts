import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as entry from '../src/herdr-adapter/entry.ts';
import { within } from './herdr-lease-helpers.ts';

const warning = 'agent-steward: release unconfirmed; shutdown incomplete. Human review required.\n';
const sensitive = 'synthetic-token synthetic-session /sensitive/state synthetic-credential';

test('shutdown result reporter: finished/stopped/not_admitted stay silent', () => {
  for (const result of ['finished', 'stopped', 'not_admitted', 'paused', 'resumed'] as const) {
    let actual = '',
      count = 0;
    entry.reportWorkflowResult(result, {
      write: (value) => {
        actual += value;
      },
      fail: () => {
        count++;
      },
    });
    assert.equal(actual, '');
    assert.equal(count, 0);
  }
});

test('shutdown result reporter: shutdown_incomplete', () => {
  let actual = '',
    count = 0;
  entry.reportWorkflowResult('shutdown_incomplete', {
    write: (value) => {
      actual += value;
    },
    fail: () => {
      count++;
    },
  });
  assert.equal(actual, warning);
  assert.equal(count, 1);
  for (const secret of sensitive.split(' ')) assert.equal(actual.includes(secret), false);
  assert.equal(actual.includes('event hooks may still'), false);
});

async function childResult(source: string, milliseconds = 4_000) {
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

test('event incomplete result emits only the fixed warning', async () => {
  const entryUrl = new URL('../src/herdr-adapter/entry.ts', import.meta.url).href;
  const result = await childResult(`
    const { reportWorkflowResult } = await import(${JSON.stringify(entryUrl)});
    reportWorkflowResult('shutdown_incomplete', {
      write: (text) => process.stderr.write(text),
      fail: () => { process.exitCode = 1; },
    });
  `);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout, '');
  for (const secret of sensitive.split(' ')) assert.equal(result.stderr.includes(secret), false);
});

test('isolated child observes late rejected workflow finish without unhandled rejection', async () => {
  const authorityUrl = new URL('../src/herdr-adapter/authority.ts', import.meta.url).href;
  const stateUrl = new URL('../src/herdr-adapter/workflow-state.ts', import.meta.url).href;
  const helpersUrl = new URL('./herdr-lease-helpers.ts', import.meta.url).href;
  const result = await childResult(`
    import { mkdtemp, mkdir, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const { beginWorkflow } = await import(${JSON.stringify(authorityUrl)});
    const { WorkflowState } = await import(${JSON.stringify(stateUrl)});
    const { deferred, within } = await import(${JSON.stringify(helpersUrl)});
    let unhandled = false;
    process.on('unhandledRejection', () => { unhandled = true; process.exitCode = 1; });
    const directory = await mkdtemp(join(tmpdir(), 'steward-late-finish-'));
    const entered = deferred();
    const resume = deferred();
    const state = new WorkflowState(directory, undefined, {
      io: {
        mkdir: async (path, options) => {
          if (path.endsWith('/released')) {
            entered.resolve();
            await resume.promise;
            throw new Error(${JSON.stringify(sensitive)});
          }
          return mkdir(path, options);
        },
      },
    });
    const attempt = beginWorkflow({
      state,
      scope: { serverId: '47:1', agent: 'agy', sessionId: 's1', sessionKind: 'id', sessionSource: 'herdr:antigravity_cli' },
      paneId: 'w1:p1',
      workspaceId: 'w1',
      permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all', autoApprove: false }),
      signal: new AbortController().signal,
      shutdownDeadline: (ms, expire) => {
        if (ms !== 5000) throw new Error('budget');
        const timer = setTimeout(expire, 25);
        return () => clearTimeout(timer);
      },
    });
    try {
      const authority = await within(attempt.ready);
      if (!authority) throw new Error('authority');
      const finishing = attempt.finish();
      await within(entered.promise);
      const value = await within(finishing);
      if (value !== 'shutdown_incomplete') throw new Error('result');
      resume.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (unhandled) throw new Error('unhandled');
      process.stdout.write('observed\\n');
    } catch {
      process.stdout.write('failed\\n');
      process.exitCode = 1;
    } finally {
      resume.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  `);
  assert.deepEqual(result, { code: 0, stderr: '', stdout: 'observed\n' });
});

const runtimeUrl = new URL('./herdr-event-child-runtime.ts', import.meta.url).href;

async function runEventChild(
  hold: import('./herdr-event-child-runtime.ts').ChildHold,
  signal: 'SIGINT' | 'SIGTERM' | null,
  extra: { rejectRelease?: boolean; pause?: boolean; inWindow?: boolean } = {},
  milliseconds = 10_000,
) {
  return childResult(
    `
    const { runHeldEvent } = await import(${JSON.stringify(runtimeUrl)});
    await runHeldEvent(${JSON.stringify({ hold, signal, ...extra })});
  `,
    milliseconds,
  );
}

// Catches reporting a clean stop when slot cleanup is still unconfirmed after SIGINT.
test('runEvent SIGINT with held capacity release reports incomplete within one 5s window', async () => {
  const started = Date.now();
  const result = await runEventChild('capacity', 'SIGINT');
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.equal(result.stderr.includes('unhandled'), false);
  assert.ok(elapsed >= 4_500 && elapsed < 8_000, `elapsed ${elapsed}`);
}, 15_000);

// Catches a second fresh 5s window when G release is held after slot confirmation.
test('runEvent SIGINT with held generation release reports incomplete within one 5s window', async () => {
  const started = Date.now();
  const result = await runEventChild('generation', 'SIGINT');
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.ok(elapsed >= 4_500 && elapsed < 8_000, `elapsed ${elapsed}`);
}, 15_000);

// Catches sequential G-then-job 5s budgets when both releases are held.
test('runEvent SIGINT with both releases held still finishes within one 5s window', async () => {
  const started = Date.now();
  const result = await runEventChild('both', 'SIGINT');
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.ok(elapsed >= 4_500 && elapsed < 8_000, `elapsed ${elapsed}`);
}, 15_000);

// Catches joining an unowned hung decide after G can confirm, forcing false incomplete.
test('runEvent SIGINT during hung decide confirms G without joining decide or warning', async () => {
  const started = Date.now();
  const result = await runEventChild('decide', 'SIGINT');
  const elapsed = Date.now() - started;
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.equal(result.stdout.includes('unhandled'), false);
  assert.ok(elapsed < 2_000, `elapsed ${elapsed}`);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
}, 15_000);

// Catches SIGTERM skipping the same combined reporting path as SIGINT.
test('runEvent SIGTERM with held capacity release reports incomplete', async () => {
  const result = await runEventChild('capacity', 'SIGTERM');
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
}, 15_000);

// Catches swallowing a late rejected generation release as a clean result.
test('runEvent late rejected generation release cannot rewrite an incomplete result', async () => {
  const result = await runEventChild('generation', 'SIGINT', { rejectRelease: true });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
}, 15_000);

// Catches treating pause as confirmed while control publication is still held.
test('run.sh pause with held control publication reports incomplete', async () => {
  const result = await runEventChild('control', null, { pause: true });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
}, 15_000);

// Catches sequential slot-then-G 5s windows on internal human cleanup.
test('runEvent internal human with held slot release reports incomplete within one 5s window', async () => {
  const started = Date.now();
  const result = await runEventChild('human', null);
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.ok(elapsed >= 4_500 && elapsed < 8_000, `elapsed ${elapsed}`);
}, 15_000);

// Catches sequential slot-then-G 5s windows on internal lost cleanup.
test('runEvent internal lost with held slot release reports incomplete within one 5s window', async () => {
  const started = Date.now();
  const result = await runEventChild('lost', null);
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.ok(elapsed >= 4_500 && elapsed < 8_000, `elapsed ${elapsed}`);
}, 15_000);

// Catches treating a fatal generation marker failure as a confirmed stop.
test('runEvent fatal generation marker reports incomplete', async () => {
  const result = await runEventChild('marker', null);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
}, 15_000);

// Catches ignoring an in-window late release rejection.
test('runEvent in-window late rejected generation release reports incomplete', async () => {
  const result = await runEventChild('generation', 'SIGINT', { rejectRelease: true, inWindow: true });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, warning);
  assert.equal(result.stdout.startsWith('settled'), true);
}, 15_000);

// Catches forcing incomplete after an in-window late successful ACK.
test('runEvent in-window late generation ACK can confirm before the deadline', async () => {
  const started = Date.now();
  const result = await runEventChild('generation', 'SIGINT', { inWindow: true });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(elapsed < 2_000, `elapsed ${elapsed}`);
}, 15_000);

// Catches unobserved late producer heartbeat rejection on the entry driver.
test('runEvent SIGINT during held generation heartbeat reports without unhandled rejection', async () => {
  const result = await runEventChild('heartbeat', 'SIGINT', { rejectRelease: true, inWindow: true });
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.equal(result.stdout.includes('unhandled'), false);
}, 15_000);

// Catches unobserved late capacity acquisition rejection on the entry driver.
test('runEvent SIGINT during held capacity acquisition reports without unhandled rejection', async () => {
  const result = await runEventChild('acquisition', 'SIGINT', { rejectRelease: true, inWindow: true });
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.equal(result.stdout.includes('unhandled'), false);
}, 15_000);

// Catches joining hung job foreground after G can confirm.
test('runEvent SIGINT during held job foreground confirms without joining get', async () => {
  const started = Date.now();
  const result = await runEventChild('foreground', 'SIGINT');
  const elapsed = Date.now() - started;
  assert.equal(result.stdout.startsWith('settled'), true);
  assert.equal(result.stdout.includes('unhandled'), false);
  assert.ok(elapsed < 2_000, `elapsed ${elapsed}`);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
}, 15_000);

// Catches joining a far-future wait after G and slot can confirm.
test('runEvent SIGINT during job timer wait confirms within the bound', async () => {
  const started = Date.now();
  const result = await runEventChild('timer', 'SIGINT');
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(elapsed < 2_000, `elapsed ${elapsed}`);
}, 15_000);
