import assert from 'node:assert/strict';
import { afterEach, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginWorkflow, reserveJobSlot } from '../src/herdr-adapter/authority.ts';
import { appendDiagnostic, type DiagnosticEvent } from '../src/herdr-adapter/diagnostics.ts';
import { handleEvent, workflowEventDeps, type EventDeps } from '../src/herdr-adapter/events.ts';
import { runEpisodeJob, type JobOptions } from '../src/herdr-adapter/jobs.ts';
import type { LeaseIO } from '../src/herdr-adapter/lease.ts';
import { observeStop, type AgentSnapshot, type ReadSnapshot } from '../src/herdr-adapter/observe.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { workflowSession, WorkflowState, type WorkflowScope } from '../src/herdr-adapter/workflow-state.ts';
import type { Evaluation } from '../src/contracts.ts';
import { assessStop } from '../src/triage.ts';
import { deferred, withinWorkflow as within } from './herdr-lease-helpers.ts';

const MAX_LOG = 1_048_576;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'steward-diagnostics-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

const event: DiagnosticEvent = {
  at: '2026-10-05T12:00:00Z',
  scopeHash: 'a'.repeat(64),
  outcome: 'shutdown_incomplete',
  reason: 'release_unconfirmed',
};

function lineFor(value: DiagnosticEvent): string {
  return `${JSON.stringify({
    at: value.at,
    scopeHash: value.scopeHash,
    outcome: value.outcome,
    reason: value.reason,
  })}\n`;
}

async function records(root: string, name: 'workflow.log' | 'workflow.log.1'): Promise<unknown[]> {
  const text = await readFile(join(root, name), 'utf8');
  assert.match(text, /(^|\n)$/);
  return text
    .trim()
    .split('\n')
    .filter((entry) => entry.length > 0)
    .map((entry) => JSON.parse(entry));
}

test('appendDiagnostic writes one exact bounded private JSON line', async () => {
  const root = await privateRoot();
  await appendDiagnostic(root, event);
  const text = await readFile(join(root, 'workflow.log'), 'utf8');
  assert.deepEqual(JSON.parse(text.trim()), event);
  assert.equal(text, `${JSON.stringify(event)}\n`);
  assert.equal((await lstat(join(root, 'workflow.log'))).mode & 0o777, 0o600);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(root), ['workflow.log']);
});

for (const extra of [
  { context: 'prompt text' },
  { instruction: 'retry the agent' },
  { token: 'sk-' + 'x'.repeat(30) },
  { password: 'synthetic-credential' },
] as const) {
  test(`extra ${Object.keys(extra)[0]} field is rejected and not serialized`, async () => {
    const root = await privateRoot();
    await assert.rejects(() => appendDiagnostic(root, { ...event, ...extra } as DiagnosticEvent));
    assert.deepEqual(await readdir(root), []);
  });
}

test('corrupt and oversize events are rejected without creating a log', async () => {
  const root = await privateRoot();
  await assert.rejects(() => appendDiagnostic(root, { ...event, at: 'not-a-timestamp' } as DiagnosticEvent));
  await assert.rejects(() => appendDiagnostic(root, { ...event, outcome: 'heartbeat' } as unknown as DiagnosticEvent));
  await assert.rejects(() => appendDiagnostic(root, { ...event, scopeHash: 'A'.repeat(64) } as DiagnosticEvent));
  await assert.rejects(() =>
    appendDiagnostic(root, {
      ...event,
      at: `${'2026-10-05T12:00:00.'}${'0'.repeat(2000)}Z`,
    } as DiagnosticEvent),
  );
  assert.deepEqual(await readdir(root), []);
});

test('concurrent appends serialize complete line records under one private log', async () => {
  const root = await privateRoot();
  const events = Array.from({ length: 24 }, (_, index) => ({
    ...event,
    at: `2026-10-05T12:00:00.${String(index).padStart(3, '0')}Z`,
    outcome: 'created' as const,
    reason: null,
  }));
  await Promise.all(events.map((entry) => appendDiagnostic(root, entry)));
  const saved = await records(root, 'workflow.log');
  assert.equal(saved.length, 24);
  assert.deepEqual(
    new Set(saved.map((entry) => (entry as DiagnosticEvent).at)),
    new Set(events.map((entry) => entry.at)),
  );
  for (const entry of saved)
    assert.deepEqual(Object.keys(entry as object).sort(), ['at', 'outcome', 'reason', 'scopeHash']);
  assert.equal((await lstat(join(root, 'workflow.log'))).size <= MAX_LOG, true);
  assert.deepEqual(await readdir(root), ['workflow.log']);
});

test('rotation happens before an append would exceed 1 MiB and keeps one private backup', async () => {
  const root = await privateRoot();
  const created: DiagnosticEvent = { ...event, outcome: 'created', reason: null };
  const line = lineFor(created);
  const fill = line.repeat(Math.floor(MAX_LOG / Buffer.byteLength(line)));
  assert.ok(Buffer.byteLength(fill) <= MAX_LOG);
  assert.ok(Buffer.byteLength(fill) + Buffer.byteLength(line) > MAX_LOG);
  await writeFile(join(root, 'workflow.log'), fill, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  const overflow: DiagnosticEvent = { ...event, outcome: 'finished', reason: 'completed' };
  await appendDiagnostic(root, overflow);
  assert.equal((await lstat(join(root, 'workflow.log'))).size <= MAX_LOG, true);
  assert.equal((await lstat(join(root, 'workflow.log.1'))).size <= MAX_LOG, true);
  assert.equal((await lstat(join(root, 'workflow.log'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(root, 'workflow.log.1'))).mode & 0o777, 0o600);
  assert.deepEqual(await records(root, 'workflow.log'), [overflow]);
  assert.equal((await records(root, 'workflow.log.1')).length, fill.trim().split('\n').length);
  assert.deepEqual((await readdir(root)).sort(), ['workflow.log', 'workflow.log.1']);
  const second: DiagnosticEvent = { ...event, outcome: 'handoff', reason: 'human' };
  const refill = lineFor(second).repeat(Math.floor(MAX_LOG / Buffer.byteLength(lineFor(second))));
  await writeFile(join(root, 'workflow.log'), refill, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  const next: DiagnosticEvent = { ...event, outcome: 'handoff', reason: 'capacity' };
  await appendDiagnostic(root, next);
  assert.deepEqual(await records(root, 'workflow.log'), [next]);
  assert.deepEqual((await records(root, 'workflow.log.1'))[0], second);
  assert.deepEqual((await readdir(root)).sort(), ['workflow.log', 'workflow.log.1']);
});

test('concurrent rotation never creates a second backup or a torn line', async () => {
  const root = await privateRoot();
  const created: DiagnosticEvent = { ...event, outcome: 'created', reason: null };
  const line = lineFor(created);
  await writeFile(join(root, 'workflow.log'), line.repeat(Math.floor(MAX_LOG / Buffer.byteLength(line))), {
    mode: 0o600,
  });
  await chmod(join(root, 'workflow.log'), 0o600);
  const extra = Array.from({ length: 8 }, (_, index) => ({
    ...event,
    at: `2026-10-05T13:00:00.${String(index).padStart(3, '0')}Z`,
    outcome: 'handoff' as const,
    reason: 'canceled' as const,
  }));
  await Promise.all(extra.map((entry) => appendDiagnostic(root, entry)));
  const names = (await readdir(root)).sort();
  assert.ok(names.includes('workflow.log'));
  assert.ok(names.every((name) => name === 'workflow.log' || name === 'workflow.log.1'));
  for (const name of names) {
    const info = await lstat(join(root, name));
    assert.equal(info.size <= MAX_LOG, true);
    assert.equal(info.mode & 0o777, 0o600);
    await records(root, name as 'workflow.log' | 'workflow.log.1');
  }
  const combined = [
    ...(names.includes('workflow.log.1') ? await records(root, 'workflow.log.1') : []),
    ...(await records(root, 'workflow.log')),
  ];
  for (const entry of extra) {
    assert.ok(combined.some((saved) => (saved as DiagnosticEvent).at === entry.at));
  }
});

for (const [name, mutate] of [
  [
    'symlink log',
    async (root: string) => {
      await writeFile(join(root, 'workflow.log.target'), lineFor(event), { mode: 0o600 });
      await symlink(join(root, 'workflow.log.target'), join(root, 'workflow.log'));
    },
  ],
  [
    'world-readable log',
    async (root: string) => {
      await writeFile(join(root, 'workflow.log'), lineFor(event), { mode: 0o600 });
      await chmod(join(root, 'workflow.log'), 0o644);
    },
  ],
  [
    'hard-linked log',
    async (root: string) => {
      await writeFile(join(root, 'workflow.log'), lineFor(event), { mode: 0o600 });
      await link(join(root, 'workflow.log'), join(root, 'workflow.log.extra'));
    },
  ],
  [
    'unsafe directory',
    async (root: string) => {
      await chmod(root, 0o755);
    },
  ],
] as const) {
  test(`unsafe ${name} path cannot be appended or repaired`, async () => {
    const root = await privateRoot();
    await mutate(root);
    const before = await readdir(root);
    await assert.rejects(() => appendDiagnostic(root, event));
    assert.deepEqual(await readdir(root), before);
    if (before.includes('workflow.log')) {
      const info = await lstat(join(root, 'workflow.log'));
      if (info.isFile() && info.nlink === 1)
        assert.equal(await readFile(join(root, 'workflow.log'), 'utf8'), lineFor(event));
    }
  });
}

async function fileBytes(root: string, name: string): Promise<Buffer | null> {
  try {
    return await readFile(join(root, name));
  } catch {
    return null;
  }
}

test('existing invalid UTF-8 current log is refused and bytes are unchanged', async () => {
  const root = await privateRoot();
  const planted = Buffer.alloc(MAX_LOG, 0x80);
  planted[MAX_LOG - 1] = 10;
  await writeFile(join(root, 'workflow.log'), planted, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  const before = await readFile(join(root, 'workflow.log'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual(await readFile(join(root, 'workflow.log')), before);
  assert.equal(before.length, MAX_LOG);
  assert.equal(await fileBytes(root, 'workflow.log.1'), null);
  assert.deepEqual(await readdir(root), ['workflow.log']);
});

test('existing extra context field in current log is refused and bytes are unchanged', async () => {
  const root = await privateRoot();
  const planted = `${JSON.stringify({ ...event, outcome: 'created', reason: null, context: 'SYNTHETIC_CONTEXT_NOT_ALLOWED' })}\n`;
  await writeFile(join(root, 'workflow.log'), planted, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  const before = await readFile(join(root, 'workflow.log'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual(await readFile(join(root, 'workflow.log')), before);
  assert.match(before.toString('utf8'), /SYNTHETIC_CONTEXT_NOT_ALLOWED/);
  assert.equal(await fileBytes(root, 'workflow.log.1'), null);
});

test('existing corrupt current log line is refused and bytes are unchanged', async () => {
  const root = await privateRoot();
  const planted = '{not-json}\n';
  await writeFile(join(root, 'workflow.log'), planted, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  const before = await readFile(join(root, 'workflow.log'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual(await readFile(join(root, 'workflow.log')), before);
  assert.equal(await fileBytes(root, 'workflow.log.1'), null);
});

test('existing overlong current log line is refused and bytes are unchanged', async () => {
  const root = await privateRoot();
  const planted = `${JSON.stringify({ at: event.at, scopeHash: event.scopeHash, outcome: 'created', reason: null })}${' '.repeat(900)}\n`;
  assert.ok(Buffer.byteLength(planted) > 1024);
  await writeFile(join(root, 'workflow.log'), planted, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  const before = await readFile(join(root, 'workflow.log'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual(await readFile(join(root, 'workflow.log')), before);
  assert.equal(await fileBytes(root, 'workflow.log.1'), null);
});

test('rotation refuses to replace an unsafe backup and leaves the current log intact', async () => {
  const root = await privateRoot();
  const created: DiagnosticEvent = { ...event, outcome: 'created', reason: null };
  const line = lineFor(created);
  const fill = line.repeat(Math.floor(MAX_LOG / Buffer.byteLength(line)));
  await writeFile(join(root, 'workflow.log'), fill, { mode: 0o600 });
  await chmod(join(root, 'workflow.log'), 0o600);
  await writeFile(join(root, 'workflow.log.1.target'), 'secret', { mode: 0o600 });
  await symlink(join(root, 'workflow.log.1.target'), join(root, 'workflow.log.1'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.equal(await readFile(join(root, 'workflow.log'), 'utf8'), fill);
  assert.equal((await lstat(join(root, 'workflow.log.1'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(root, 'workflow.log.1.target'), 'utf8'), 'secret');
});

test('normal append refuses a symlink backup and leaves the sentinel unchanged', async () => {
  const root = await privateRoot();
  await writeFile(join(root, 'sentinel'), 'sentinel', { mode: 0o600 });
  await chmod(join(root, 'sentinel'), 0o600);
  await symlink(join(root, 'sentinel'), join(root, 'workflow.log.1'));
  const before = (await readdir(root)).sort();
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual((await readdir(root)).sort(), before);
  assert.equal((await lstat(join(root, 'workflow.log.1'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(root, 'sentinel'), 'utf8'), 'sentinel');
  assert.equal(await fileBytes(root, 'workflow.log'), null);
});

test('normal append refuses an oversize backup and leaves it unchanged', async () => {
  const root = await privateRoot();
  const planted = Buffer.alloc(MAX_LOG + 1, 97);
  await writeFile(join(root, 'workflow.log.1'), planted, { mode: 0o600 });
  await chmod(join(root, 'workflow.log.1'), 0o600);
  const before = await readFile(join(root, 'workflow.log.1'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual(await readFile(join(root, 'workflow.log.1')), before);
  assert.equal(before.length, MAX_LOG + 1);
  assert.equal(await fileBytes(root, 'workflow.log'), null);
});

test('normal append refuses a corrupt backup and leaves it unchanged', async () => {
  const root = await privateRoot();
  const planted = '{not-json}\n';
  await writeFile(join(root, 'workflow.log.1'), planted, { mode: 0o600 });
  await chmod(join(root, 'workflow.log.1'), 0o600);
  const before = await readFile(join(root, 'workflow.log.1'));
  await assert.rejects(() => appendDiagnostic(root, event));
  assert.deepEqual(await readFile(join(root, 'workflow.log.1')), before);
  assert.equal(await fileBytes(root, 'workflow.log'), null);
});

for (const [name, mutate] of [
  [
    'world-readable backup',
    async (root: string) => {
      await writeFile(join(root, 'workflow.log.1'), lineFor(event), { mode: 0o600 });
      await chmod(join(root, 'workflow.log.1'), 0o644);
    },
  ],
  [
    'hard-linked backup',
    async (root: string) => {
      await writeFile(join(root, 'workflow.log.1'), lineFor(event), { mode: 0o600 });
      await chmod(join(root, 'workflow.log.1'), 0o600);
      await link(join(root, 'workflow.log.1'), join(root, 'workflow.log.1.extra'));
    },
  ],
] as const) {
  test(`normal append refuses ${name} without repair`, async () => {
    const root = await privateRoot();
    await mutate(root);
    const before = (await readdir(root)).sort();
    const backup = await readFile(join(root, 'workflow.log.1'));
    const info = await lstat(join(root, 'workflow.log.1'));
    await assert.rejects(() => appendDiagnostic(root, event));
    assert.deepEqual((await readdir(root)).sort(), before);
    assert.deepEqual(await readFile(join(root, 'workflow.log.1')), backup);
    const after = await lstat(join(root, 'workflow.log.1'));
    assert.equal(after.mode, info.mode);
    assert.equal(after.nlink, info.nlink);
    assert.equal(await fileBytes(root, 'workflow.log'), null);
  });
}

test('ENOSPC fails closed and a later append can succeed after the failure', async () => {
  const root = await privateRoot();
  const entered = deferred<void>();
  await assert.rejects(
    () =>
      appendDiagnostic(root, event, {
        io: {
          open: async (path, flags, mode) => {
            if (String(path).endsWith('.tmp')) {
              entered.resolve();
              throw Object.assign(new Error('full'), { code: 'ENOSPC' });
            }
            return open(path, flags, mode);
          },
        },
      }),
    (error: NodeJS.ErrnoException) => error.code === 'ENOSPC',
  );
  await within(entered.promise);
  assert.ok(!(await readdir(root)).includes('workflow.log'));
  await appendDiagnostic(root, event);
  assert.deepEqual(await records(root, 'workflow.log'), [event]);
});

const scope: WorkflowScope = {
  serverId: '47:1',
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
const expectedHash = createHash('sha256')
  .update(JSON.stringify(['47:1', 'agy', 's1']))
  .digest('hex');
const initial = '2026-09-29T10:00:00.000Z';
const quotaText = 'model-one quota exhausted';
const apiText = 'Current API failure: request timed out';
const pane = (overrides: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  agent_status: 'idle',
  agent_session: { agent: 'agy', source: 'herdr:antigravity_cli', kind: 'id', value: 's1' },
  revision: 8,
  state_change_seq: 4,
  ...overrides,
});
const detection = (text: string, revision = 8): ReadSnapshot => ({
  pane_id: 'w1:p1',
  source: 'detection',
  revision,
  text,
  truncated: false,
});
function evaluation(waiting: 'quota_limit' | 'recoverable_api_error' | 'completed'): Evaluation {
  return {
    model: 'jev-1.13.0',
    usage: {},
    answers: {
      waiting_for: {
        type: 'choice',
        choice: waiting,
        probabilities: {
          approve_command: 0,
          approve_edit: 0,
          answer_question: 0,
          credentials: 0,
          recoverable_api_error: waiting === 'recoverable_api_error' ? 1 : 0,
          quota_limit: waiting === 'quota_limit' ? 1 : 0,
          permanent_error: 0,
          completed: waiting === 'completed' ? 1 : 0,
          other: 0,
        },
        confidence: 1,
      },
      risky: { type: 'noul', noul: 0.1 },
    },
  };
}
function jobWait() {
  const entered = deferred<Date>();
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const wait: NonNullable<JobOptions['wait']> = async (deadline, signal) => {
    const gate = deferred<void>();
    gates.push(gate);
    if (gates.length === 1) entered.resolve(deadline);
    await Promise.race([
      gate.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
  };
  return {
    wait,
    entered,
    wake(index = 0) {
      gates[index]?.resolve();
    },
  };
}
async function until(check: () => Promise<boolean>, ms = 3_000): Promise<void> {
  await within(
    (async () => {
      while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 10));
    })(),
    ms,
  );
}
async function logged(root: string): Promise<DiagnosticEvent[]> {
  await until(async () => {
    try {
      await readFile(join(root, 'workflow.log'));
      return true;
    } catch {
      return false;
    }
  });
  return (await records(root, 'workflow.log')) as DiagnosticEvent[];
}
async function lifecycle(
  options: {
    waiting?: 'quota_limit' | 'recoverable_api_error' | 'completed';
    text?: string;
    heartbeatIntervalMs?: number;
    shutdownDeadline?: (ms: number, expire: () => void) => () => void;
    io?: Partial<LeaseIO>;
    diagnose?: (event: DiagnosticEvent) => Promise<void>;
  } = {},
) {
  const root = await privateRoot();
  const state = new WorkflowState(root, undefined, {
    ...(options.io ? { io: options.io } : {}),
    ...(options.shutdownDeadline ? { shutdownDeadline: options.shutdownDeadline } : {}),
  });
  const episodes = new EpisodeStore(root);
  const attempt = beginWorkflow({
    state,
    scope,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all' as const, autoApprove: false }),
    signal: new AbortController().signal,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    ...(options.shutdownDeadline ? { shutdownDeadline: options.shutdownDeadline } : {}),
    ...(options.diagnose ? { diagnose: options.diagnose } : {}),
  });
  const admitted = await attempt.ready;
  assert.ok(admitted);
  const authority = admitted;
  let instant = initial;
  const waiting = options.waiting ?? 'quota_limit';
  const current = { snapshot: pane(), text: options.text ?? quotaText };
  const counts = { prompt: 0, get: 0, read: 0 };
  const herdr = {
    get: async () => {
      counts.get++;
      return current.snapshot;
    },
    read: async () => {
      counts.read++;
      return detection(current.text, current.snapshot.revision);
    },
    prompt: async () => {
      counts.prompt++;
    },
  };
  const clock = { now: () => new Date(instant) };
  const decide: EventDeps['decide'] = async (input) =>
    assessStop(input, {
      thresholds: { risky: 0.6, choiceConfidence: 0.45 },
      now: clock.now(),
      evaluate: async () => evaluation(waiting),
    });
  const deps: EventDeps = {
    herdr,
    decide,
    store: episodes,
    clock,
    targets: 'all',
    autoApprove: false,
    handoff: async () => {},
  };
  const scoped = workflowEventDeps(deps, authority, state);
  const jobDeps = (): EventDeps => ({ ...scoped, herdr, decide, handoff: async () => {} });
  async function assess(): Promise<Episode> {
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: current.snapshot.pane_id,
        workspace_id: current.snapshot.workspace_id,
        agent: current.snapshot.agent ?? 'agy',
        agent_status: current.snapshot.agent_status,
      },
      jobDeps(),
    );
    const saved = await state.sessionRetry(authority.scope);
    assert.ok(saved);
    return saved;
  }
  async function runJob(wait: JobOptions['wait'], signal = new AbortController().signal) {
    const binding = await state.binding(authority.scope);
    assert.ok(binding);
    return runEpisodeJob({
      state,
      authority,
      episodes,
      deps: jobDeps(),
      binding,
      signal,
      wait,
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
    });
  }
  return {
    root,
    state,
    episodes,
    attempt,
    authority,
    counts,
    herdr,
    setNow: (value: string) => {
      instant = value;
    },
    assess,
    runJob,
    cleanup: async () => {
      attempt.close();
      await attempt.finish();
    },
  };
}

test('healthy no-action hook does not create a diagnostic or a job', async () => {
  const f = await lifecycle({ waiting: 'completed', text: 'Task completed successfully.\n' });
  try {
    await handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent: 'agy',
        agent_status: 'idle',
      },
      workflowEventDeps(
        {
          herdr: f.herdr,
          decide: async (input) =>
            assessStop(input, {
              thresholds: { risky: 0.6, choiceConfidence: 0.45 },
              now: new Date(initial),
              evaluate: async () => evaluation('completed'),
            }),
          store: f.episodes,
          clock: { now: () => new Date(initial) },
          targets: 'all',
          autoApprove: false,
          handoff: async () => {},
        },
        f.authority,
        f.state,
      ),
    );
    const slot = reserveJobSlot(f.state, f.authority);
    try {
      assert.equal(await slot.ready, null);
    } finally {
      await slot.finish();
    }
    assert.ok(!(await readdir(f.root)).includes('workflow.log'));
  } finally {
    await f.cleanup();
  }
});

test('created is emitted only after slot promotion, not for a pending assessment', async () => {
  const f = await lifecycle();
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    await f.assess();
    assert.ok(!(await readdir(f.root)).includes('workflow.log'));
    const running = f.runJob(wait, ctrl.signal);
    await within(entered.promise);
    const saved = await logged(f.root);
    assert.deepEqual(
      saved.map((entry) => ({ outcome: entry.outcome, reason: entry.reason, scopeHash: entry.scopeHash })),
      [{ outcome: 'created', reason: null, scopeHash: expectedHash }],
    );
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
  } finally {
    wake();
    ctrl.abort();
    await f.cleanup();
  }
});

test('capacity refusal logs handoff without created', async () => {
  const f = await lifecycle();
  try {
    await f.assess();
    f.state.validateCapacity = async () => {
      throw new Error('capacity unavailable');
    };
    assert.equal(await within(f.runJob(async () => assert.fail('not admitted'))), 'not_admitted');
    const saved = await logged(f.root);
    assert.equal(
      saved.some((entry) => entry.outcome === 'created'),
      false,
    );
    assert.ok(saved.some((entry) => entry.outcome === 'handoff' && entry.reason === 'capacity'));
    for (const entry of saved) {
      assert.equal(entry.scopeHash, expectedHash);
      assert.deepEqual(Object.keys(entry).sort(), ['at', 'outcome', 'reason', 'scopeHash']);
    }
  } finally {
    await f.cleanup();
  }
});

test('delivered recovery logs created then finished/completed', async () => {
  const f = await lifecycle({ waiting: 'recoverable_api_error', text: apiText });
  const { wait, entered, wake } = jobWait();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    await f.episodes.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: initial,
      last_delivery_state: 'none',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:00:30.000Z',
    });
    const running = f.runJob(wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:00:30.000Z');
    wake();
    assert.equal(await within(running), 'finished');
    assert.equal(f.counts.prompt, 1);
    await until(async () => ((await logged(f.root)) as DiagnosticEvent[]).length >= 2);
    const saved = await logged(f.root);
    assert.deepEqual(
      saved.map((entry) => [entry.outcome, entry.reason]),
      [
        ['created', null],
        ['finished', 'completed'],
      ],
    );
  } finally {
    wake();
    await f.cleanup();
  }
});

test('heartbeat renewals are not logged', async () => {
  const seen: DiagnosticEvent[] = [];
  const f = await lifecycle({
    diagnose: async (entry) => {
      seen.push(entry);
    },
  });
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    await f.assess();
    const running = f.runJob(wait, ctrl.signal);
    await within(entered.promise);
    await until(async () => seen.some((entry) => entry.outcome === 'created'));
    await f.state.lease(scope).heartbeat(f.authority.generation, workflowSession(scope));
    await f.state.lease(scope).heartbeat(f.authority.generation, workflowSession(scope));
    await f.state.lease(scope).heartbeat(f.authority.generation, workflowSession(scope));
    assert.deepEqual(
      seen.map((entry) => entry.outcome),
      ['created'],
    );
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
  } finally {
    wake();
    ctrl.abort();
    await f.cleanup();
  }
});

test('rejected created diagnostic does not grant input or prevent confirmed delivery', async () => {
  let diagnoses = 0;
  const f = await lifecycle({
    waiting: 'recoverable_api_error',
    text: apiText,
    diagnose: async () => {
      diagnoses++;
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    },
  });
  const { wait, entered, wake } = jobWait();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    await f.episodes.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: initial,
      last_delivery_state: 'none',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:00:30.000Z',
    });
    const running = f.runJob(wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:00:30.000Z');
    wake();
    assert.equal(await within(running), 'finished');
    assert.equal(f.counts.prompt, 1);
    assert.ok(diagnoses >= 1);
  } finally {
    wake();
    await f.cleanup();
  }
});

test('owner close does not join a hanging diagnostic to meet its shutdown budget', async () => {
  const createdEntered = deferred<void>();
  const createdResume = deferred<void>();
  const incompleteResume = deferred<void>();
  let holdRelease = false;
  const releaseResume = deferred<void>();
  let expire!: () => void;
  const f = await lifecycle({
    diagnose: async (entry) => {
      if (entry.outcome === 'created') {
        createdEntered.resolve();
        await createdResume.promise;
        return;
      }
      if (entry.outcome === 'shutdown_incomplete') await incompleteResume.promise;
    },
    io: {
      mkdir: async (path, permissions) => {
        if (holdRelease && path.includes('/capacity/') && path.endsWith('/released')) {
          await releaseResume.promise;
        }
        await mkdir(path, permissions);
      },
    },
    shutdownDeadline: (ms, callback) => {
      assert.equal(ms, 5_000);
      expire = callback;
      return () => {};
    },
  });
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    const observed = await observeStop(f.herdr, 'w1:p1');
    assert.ok(observed);
    await f.episodes.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: observed.current_episode_id,
      error_evidence_digest: observed.error_evidence_digest,
      first_observed_at: initial,
      last_delivery_state: 'none',
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:05:00.000Z',
    });
    const running = f.runJob(wait, ctrl.signal);
    await within(entered.promise);
    await within(createdEntered.promise);
    holdRelease = true;
    ctrl.abort();
    expire();
    assert.equal(await within(running), 'shutdown_incomplete');
    createdResume.resolve();
    incompleteResume.resolve();
  } finally {
    createdResume.resolve();
    incompleteResume.resolve();
    releaseResume.resolve();
    wake();
    ctrl.abort();
    await f.cleanup();
  }
});

for (const revoke of ['capacity', 'history'] as const) {
  test(`slot-only ${revoke} loss after created emits one lost terminal without joining diagnose`, async () => {
    const seen: DiagnosticEvent[] = [];
    const terminalHold = deferred<void>();
    const terminalEntered = deferred<void>();
    const f = await lifecycle({
      diagnose: async (entry) => {
        seen.push(entry);
        if (entry.outcome !== 'created') {
          terminalEntered.resolve();
          await terminalHold.promise;
          throw new Error('rejected terminal');
        }
      },
    });
    const { wait, entered, wake } = jobWait();
    const ctrl = new AbortController();
    try {
      await f.assess();
      const running = f.runJob(wait, ctrl.signal);
      await within(entered.promise);
      const binding = await f.state.binding(scope);
      assert.ok(binding);
      assert.deepEqual(
        seen.map((entry) => [entry.outcome, entry.reason]),
        [['created', null]],
      );
      if (revoke === 'capacity') {
        const capacity = f.state.capacity(scope.serverId, 0);
        const selected = await capacity.inspect();
        assert.equal(selected.kind, 'selected');
        if (selected.kind === 'selected') await capacity.release(selected.identity.token);
      } else {
        const history = await f.state.sessionRetry(scope);
        assert.ok(history);
        await f.episodes.recordSessionRetry(scope.agent, scope.sessionId, {
          ...history,
          next_check_at: null,
          lifecycle_handoff_sent: true,
        });
      }
      wake();
      assert.equal(await within(running), 'stopped');
      assert.equal(ctrl.signal.aborted, false);
      assert.equal(f.authority.signal.aborted, false);
      assert.equal(f.counts.prompt, 0);
      assert.equal((await f.state.binding(scope))?.generation, binding.generation);
      await f.state.validateCapacity(scope.serverId, 1);
      assert.equal((await f.state.capacity(scope.serverId, 1).inspect()).kind, 'absent');
      assert.deepEqual(
        seen.map((entry) => [entry.outcome, entry.reason, entry.scopeHash]),
        [
          ['created', null, expectedHash],
          ['handoff', 'lost', expectedHash],
        ],
      );
      for (const entry of seen) assert.deepEqual(Object.keys(entry).sort(), ['at', 'outcome', 'reason', 'scopeHash']);
      await within(terminalEntered.promise);
    } finally {
      terminalHold.resolve();
      wake();
      ctrl.abort();
      await f.cleanup();
    }
  });
}
