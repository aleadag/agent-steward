import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginWorkflow, reserveJobSlot } from '../src/herdr-adapter/authority.ts';
import { handleEvent, workflowEventDeps, type EventDeps } from '../src/herdr-adapter/events.ts';
import { runEpisodeJob, type JobOptions } from '../src/herdr-adapter/jobs.ts';
import type { LeaseIO } from '../src/herdr-adapter/lease.ts';
import { observeStop, type AgentSnapshot, type ReadSnapshot } from '../src/herdr-adapter/observe.ts';
import { EpisodeStore, type Episode } from '../src/herdr-adapter/state.ts';
import { workflowSession, WorkflowState, type WorkflowScope } from '../src/herdr-adapter/workflow-state.ts';
import type { Evaluation, StopInput } from '../src/contracts.ts';
import { assessStop } from '../src/triage.ts';
import { deferred, withinWorkflow as within } from './herdr-lease-helpers.ts';

const initial = '2026-09-29T10:00:00.000Z';
const scope: WorkflowScope = {
  serverId: '47:1',
  agent: 'agy',
  sessionId: 's1',
  sessionKind: 'id',
  sessionSource: 'herdr:antigravity_cli',
};
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
const quotaText = 'model-one quota exhausted';
const apiText = 'Current API failure: request timed out';
const dialog = `Requesting permission for:\n   printf approval-probe\n\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel\n\n  ↑/↓ Navigate · tab Amend`;
type Waiting = 'quota_limit' | 'recoverable_api_error' | 'approve_command' | 'permanent_error' | 'other';
function evaluation(waiting: Waiting, confidence = 1, risk = 0.1): Evaluation {
  return {
    model: 'jev-1.13.0',
    usage: {},
    answers: {
      waiting_for: {
        type: 'choice',
        choice: waiting,
        probabilities: {
          approve_command: waiting === 'approve_command' ? confidence : 0,
          approve_edit: 0,
          answer_question: 0,
          credentials: 0,
          recoverable_api_error: waiting === 'recoverable_api_error' ? confidence : 0,
          quota_limit: waiting === 'quota_limit' ? confidence : 0,
          permanent_error: waiting === 'permanent_error' ? confidence : 0,
          completed: 0,
          other: waiting === 'other' ? confidence : 0,
        },
        confidence,
      },
      risky: { type: 'noul', noul: risk },
    },
  };
}
function jobWait() {
  const entered = deferred<Date>();
  const entries: Date[] = [];
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const wait: NonNullable<JobOptions['wait']> = async (deadline, signal) => {
    const gate = deferred<void>();
    gates.push(gate);
    entries.push(deadline);
    if (entries.length === 1) entered.resolve(deadline);
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
    entries,
    wake(index = 0) {
      gates[index]?.resolve();
    },
  };
}
async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  await within(
    (async () => {
      while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 10));
    })(),
    ms,
  );
}
const permission = async (autoApprove = false) => ({
  serverId: '47:1',
  enabled: true,
  targets: 'all' as const,
  autoApprove,
});

type World = {
  root: string;
  setNow: (value: string) => void;
  now: () => string;
  state: WorkflowState;
  episodes: EpisodeStore;
  attempt: ReturnType<typeof beginWorkflow>;
  authority: NonNullable<Awaited<ReturnType<typeof beginWorkflow>['ready']>>;
  snapshot: AgentSnapshot;
  text: string;
  counts: { get: number; read: number; prompt: number; sendKeys: number; list: number; decide: number };
  prompts: string[];
  keys: [string, string[]][];
  handoffs: string[];
  waiting: Waiting;
  decide: EventDeps['decide'];
  quotaHint?: EventDeps['quotaHint'];
  herdr: EventDeps['herdr'] & {
    list: () => Promise<AgentSnapshot[]>;
    sendKeys: (paneId: string, keys: string[]) => Promise<void>;
  };
  clock: { now: () => Date };
  deps: EventDeps;
  scoped: EventDeps;
  cleanup: () => Promise<void>;
};

async function world(
  options: {
    waiting?: Waiting;
    text?: string;
    status?: AgentSnapshot['agent_status'];
    autoApprove?: boolean;
    heartbeatIntervalMs?: number;
    scheduleHeartbeat?: (tick: () => void) => () => void;
    shutdownDeadline?: (ms: number, expire: () => void) => () => void;
    io?: Partial<LeaseIO>;
    signal?: AbortSignal;
    permission?: () => ReturnType<typeof permission>;
  } = {},
): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'steward-jobs-'));
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
    permission: options.permission ?? (() => permission(options.autoApprove === true)),
    signal: options.signal ?? new AbortController().signal,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    ...(options.scheduleHeartbeat ? { scheduleHeartbeat: options.scheduleHeartbeat } : {}),
    ...(options.shutdownDeadline ? { shutdownDeadline: options.shutdownDeadline } : {}),
  });
  const authority = await attempt.ready;
  assert.ok(authority);
  const counts = { get: 0, read: 0, prompt: 0, sendKeys: 0, list: 0, decide: 0 };
  const prompts: string[] = [];
  const keys: [string, string[]][] = [];
  const handoffs: string[] = [];
  const current = { snapshot: pane({ agent_status: options.status ?? 'idle' }), text: options.text ?? quotaText };
  let instant = initial;
  let waiting: Waiting = options.waiting ?? 'quota_limit';
  const clock = { now: () => new Date(instant) };
  const herdr = {
    get: async () => {
      counts.get++;
      return current.snapshot;
    },
    read: async () => {
      counts.read++;
      return detection(current.text, current.snapshot.revision);
    },
    prompt: async (_paneId: string, instruction: string) => {
      counts.prompt++;
      prompts.push(instruction);
    },
    sendKeys: async (paneId: string, input: string[]) => {
      counts.sendKeys++;
      keys.push([paneId, input]);
    },
    list: async () => {
      counts.list++;
      return [current.snapshot];
    },
  };
  const decide: EventDeps['decide'] = async (input) => {
    counts.decide++;
    return assessStop(input, {
      thresholds: { risky: 0.6, choiceConfidence: 0.45 },
      now: clock.now(),
      evaluate: async () => evaluation(waiting),
    });
  };
  const base: EventDeps = {
    herdr,
    decide,
    store: episodes,
    clock,
    targets: 'all',
    autoApprove: false,
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  };
  const scoped = workflowEventDeps(base, authority, state);
  const f: World = {
    root,
    setNow: (value) => {
      instant = value;
    },
    now: () => instant,
    state,
    episodes,
    attempt,
    authority,
    get snapshot() {
      return current.snapshot;
    },
    set snapshot(value) {
      current.snapshot = value;
    },
    get text() {
      return current.text;
    },
    set text(value) {
      current.text = value;
    },
    counts,
    prompts,
    keys,
    handoffs,
    get waiting() {
      return waiting;
    },
    set waiting(value) {
      waiting = value;
    },
    decide,
    herdr,
    clock,
    deps: base,
    scoped,
    cleanup: async () => {
      attempt.close();
      await attempt.finish();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

function statusEvent(snapshot: AgentSnapshot) {
  return {
    type: 'pane.agent_status_changed' as const,
    pane_id: snapshot.pane_id,
    workspace_id: snapshot.workspace_id,
    agent: snapshot.agent ?? 'agy',
    agent_status: snapshot.agent_status,
  };
}

async function assess(f: World, deps?: EventDeps): Promise<Episode> {
  await handleEvent(statusEvent(f.snapshot), deps ?? jobDeps(f));
  const saved = await f.state.sessionRetry(f.authority.scope);
  assert.ok(saved);
  return saved;
}

function jobDeps(f: World): EventDeps {
  return {
    ...f.scoped,
    herdr: f.herdr,
    decide: f.decide,
    quotaHint: f.quotaHint,
    handoff: async (reason) => {
      f.handoffs.push(reason);
    },
  };
}

async function runJob(f: World, wait: JobOptions['wait'], signal = new AbortController().signal) {
  const binding = await f.state.binding(f.authority.scope);
  assert.ok(binding);
  return runEpisodeJob({
    state: f.state,
    authority: f.authority,
    episodes: f.episodes,
    deps: jobDeps(f),
    binding,
    signal,
    wait,
  });
}

async function seed(
  f: World,
  retry: Pick<
    Episode,
    'attempt_count' | 'last_attempt_at' | 'quota_check_count' | 'last_quota_check_at' | 'next_check_at'
  >,
): Promise<Episode> {
  const observed = await observeStop(f.herdr, 'w1:p1');
  assert.ok(observed);
  const episode: Episode = {
    pane_id: 'w1:p1',
    session_id: 's1',
    failure_episode_id: observed.current_episode_id,
    error_evidence_digest: observed.error_evidence_digest,
    first_observed_at: initial,
    last_delivery_state: 'none',
    ...retry,
  };
  await f.episodes.recordSessionRetry('agy', 's1', episode);
  return episode;
}

test('sleeping quota job waits the +5m deadline, holds no locks, and performs one due check', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  try {
    const saved = await assess(f);
    assert.equal(saved.next_check_at, '2026-09-29T10:05:00.000Z');
    assert.equal(saved.quota_check_count, 0);
    const idle = { get: f.counts.get, read: f.counts.read, decide: f.counts.decide, prompt: f.counts.prompt };
    const ctrl = new AbortController();
    const running = runJob(f, wait, ctrl.signal);
    const deadline = await within(entered.promise);
    assert.equal(deadline.toISOString(), '2026-09-29T10:05:00.000Z');
    f.setNow('2026-09-29T18:00:00.000Z');
    assert.deepEqual(
      { get: f.counts.get, read: f.counts.read, decide: f.counts.decide, prompt: f.counts.prompt },
      idle,
    );

    const readerAttempt = beginWorkflow({
      state: f.state,
      scope,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      permission: () => permission(true),
      signal: new AbortController().signal,
      heartbeatIntervalMs: 60_000,
    });
    try {
      const reader = await readerAttempt.ready;
      assert.ok(reader);
      const previous = f.snapshot;
      const previousText = f.text;
      f.snapshot = pane({ revision: 9, state_change_seq: 5 });
      f.text = dialog;
      await handleEvent(
        statusEvent(f.snapshot),
        workflowEventDeps(
          {
            ...f.deps,
            herdr: f.herdr,
            autoApprove: true,
            decide: async (input: StopInput) =>
              assessStop(input, {
                thresholds: { risky: 0.6, choiceConfidence: 0.45 },
                now: f.clock.now(),
                evaluate: async () => evaluation('approve_command', 0.9),
              }),
          },
          reader,
          f.state,
        ),
      );
      assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
      f.snapshot = previous;
      f.text = previousText;
    } finally {
      readerAttempt.close();
      await readerAttempt.finish();
    }

    const beforeDue = f.counts.decide;
    wake();
    await until(async () => (await f.state.sessionRetry(f.authority.scope))?.quota_check_count === 1);
    assert.equal(f.counts.decide - beforeDue, 1);
    assert.equal(f.counts.sendKeys, 1);
    assert.equal(f.counts.list, 0);
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.equal(after?.quota_check_count, 1);
    assert.equal(after?.attempt_count, 0);
    assert.equal(after?.next_check_at, '2026-09-29T18:15:00.000Z');
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
  } finally {
    wake();
    await f.cleanup();
  }
});

test('duplicate events consume no slot, reset no deadline and launch nothing', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  try {
    const saved = await assess(f);
    const ctrl = new AbortController();
    const first = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    await handleEvent(statusEvent(f.snapshot), f.scoped);
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.next_check_at, saved.next_check_at);
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.quota_check_count, 0);
    assert.equal(await within(runJob(f, async () => assert.fail('duplicate must not wait'))), 'not_admitted');
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.next_check_at, saved.next_check_at);
    ctrl.abort();
    assert.equal(await within(first), 'stopped');
  } finally {
    wake();
    await f.cleanup();
  }
});

for (const [label, retry, wakeAt, expected] of [
  [
    '+30s',
    {
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:00:30.000Z',
    },
    '2026-09-29T10:00:30.000Z',
    '2026-09-29T10:00:30.000Z',
  ],
  [
    '+2m',
    {
      attempt_count: 1,
      last_attempt_at: '2026-09-29T10:01:00.000Z',
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:03:00.000Z',
    },
    '2026-09-29T10:03:00.000Z',
    '2026-09-29T10:03:00.000Z',
  ],
  [
    '+8m',
    {
      attempt_count: 2,
      last_attempt_at: '2026-09-29T10:02:00.000Z',
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:10:00.000Z',
    },
    '2026-09-29T10:10:00.000Z',
    '2026-09-29T10:10:00.000Z',
  ],
] as const) {
  test(`API-error recovery waits the ${label} deadline then delivers once`, async () => {
    const f = await world({ waiting: 'recoverable_api_error', text: apiText });
    const { wait, entered, wake } = jobWait();
    try {
      await seed(f, retry);
      const running = runJob(f, wait);
      assert.equal((await within(entered.promise)).toISOString(), expected);
      const prompts = f.counts.prompt;
      f.setNow(wakeAt);
      wake();
      assert.equal(await within(running), 'finished');
      assert.equal(f.counts.prompt, prompts + 1);
      const after = await f.state.sessionRetry(f.authority.scope);
      assert.equal(after?.last_delivery_state, 'delivered');
      assert.equal(after?.next_check_at, null);
      assert.equal(after?.attempt_count, retry.attempt_count + 1);
    } finally {
      wake();
      await f.cleanup();
    }
  });
}

for (const [count, last, at, next] of [
  [0, null, '2026-09-29T10:05:00.000Z', '2026-09-29T10:20:00.000Z'],
  [1, '2026-09-29T10:05:00.000Z', '2026-09-29T10:20:00.000Z', '2026-09-29T11:05:00.000Z'],
  [2, '2026-09-29T10:20:00.000Z', '2026-09-29T11:05:00.000Z', '2026-09-29T13:05:00.000Z'],
  [3, '2026-09-29T11:05:00.000Z', '2026-09-29T13:05:00.000Z', '2026-09-29T19:05:00.000Z'],
  [4, '2026-09-29T13:05:00.000Z', '2026-09-29T19:05:00.000Z', '2026-09-30T01:05:00.000Z'],
] as const) {
  test(`quota due check count ${count} schedules ${next}`, async () => {
    const f = await world();
    const { wait, entered, wake } = jobWait();
    const ctrl = new AbortController();
    try {
      await seed(f, {
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: count,
        last_quota_check_at: last,
        next_check_at: at,
      });
      f.setNow(at);
      const running = runJob(f, wait, ctrl.signal);
      assert.equal((await within(entered.promise)).toISOString(), next);
      const after = await f.state.sessionRetry(f.authority.scope);
      assert.equal(after?.quota_check_count, count + 1);
      assert.equal(after?.next_check_at, next);
      assert.equal(after?.last_delivery_state, 'none');
      assert.equal(f.counts.prompt, 0);
      ctrl.abort();
      assert.equal(await within(running), 'stopped');
    } finally {
      wake();
      await f.cleanup();
    }
  });
}

test('24-hour cutoff hands off once and cannot be extended by a reset hint', async () => {
  const f = await world();
  try {
    await seed(f, {
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 1,
      last_quota_check_at: '2026-09-29T10:05:00.000Z',
      next_check_at: '2026-09-30T10:00:00.000Z',
    });
    f.setNow('2026-09-30T10:00:00.000Z');
    let hints = 0;
    f.quotaHint = async () => {
      hints++;
      return '2026-10-01T10:00:00.000Z';
    };
    assert.equal(await within(runJob(f, async () => {})), 'finished');
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.equal(after?.next_check_at, null);
    assert.equal(after?.last_delivery_state, 'human');
    assert.equal(after?.quota_check_count, 1);
    assert.equal(hints, 0);
    assert.equal(f.counts.prompt, 0);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

for (const [hint, expected] of [
  ['2026-09-29T10:03:00Z', '2026-09-29T10:03:00.000Z'],
  ['2026-09-29T10:06:00Z', '2026-09-29T10:05:00.000Z'],
  ['2026-09-29T10:00:00Z', '2026-09-29T10:05:00.000Z'],
  ['2026-09-29T09:59:00Z', '2026-09-29T10:05:00.000Z'],
  ['tomorrow', '2026-09-29T10:05:00.000Z'],
  [null, '2026-09-29T10:05:00.000Z'],
] as const) {
  test(`cached quota hint only advances the first deadline: ${hint}`, async () => {
    const f = await world();
    const { wait, entered, wake } = jobWait();
    try {
      f.quotaHint = async () => hint;
      const saved = await assess(f);
      assert.equal(saved.next_check_at, expected);
      assert.equal(saved.quota_check_count, 0);
      const ctrl = new AbortController();
      const running = runJob(f, wait, ctrl.signal);
      assert.equal((await within(entered.promise)).toISOString(), expected);
      ctrl.abort();
      assert.equal(await within(running), 'stopped');
    } finally {
      wake();
      await f.cleanup();
    }
  });
}

test('due quota check applies a forward hint without extra delivery', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  try {
    await assess(f);
    let hints = 0;
    f.quotaHint = async () => {
      hints++;
      return '2026-09-29T10:08:00Z';
    };
    const ctrl = new AbortController();
    const running = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await until(async () => (await f.state.sessionRetry(f.authority.scope))?.quota_check_count === 1);
    assert.equal(hints, 1);
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.next_check_at, '2026-09-29T10:08:00.000Z');
    assert.equal(f.counts.prompt, 0);
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
  } finally {
    wake();
    await f.cleanup();
  }
});

test('optional quota hint failure keeps the ordinary deadline', async () => {
  const f = await world();
  try {
    f.quotaHint = async () => {
      throw new Error('private lookup failure');
    };
    const saved = await assess(f);
    assert.equal(saved.next_check_at, '2026-09-29T10:05:00.000Z');
  } finally {
    await f.cleanup();
  }
});

test('non-quota decisions never look up hints or start a job wait', async () => {
  const f = await world({ waiting: 'permanent_error', text: apiText });
  try {
    let hints = 0;
    f.quotaHint = async () => {
      hints++;
      return '2026-09-29T10:03:00Z';
    };
    await handleEvent(
      statusEvent(f.snapshot),
      workflowEventDeps({ ...jobDeps(f), quotaHint: f.quotaHint }, f.authority, f.state),
    );
    assert.equal(hints, 0);
    assert.equal(await f.state.sessionRetry(f.authority.scope), null);
    assert.equal(await within(runJob(f, async () => assert.fail('manual outcome must not wait'))), 'not_admitted');
  } finally {
    await f.cleanup();
  }
});

test('unchanged or changed ready evidence is reclassified and shares the unresolved retry budget', async () => {
  for (const changed of [false, true]) {
    const f = await world({ waiting: 'recoverable_api_error', text: apiText });
    const { wait, entered, wake } = jobWait();
    try {
      await seed(f, {
        attempt_count: 0,
        last_attempt_at: null,
        quota_check_count: 0,
        last_quota_check_at: null,
        next_check_at: '2026-09-29T10:00:30.000Z',
      });
      const running = runJob(f, wait);
      await within(entered.promise);
      f.setNow('2026-09-29T10:00:30.000Z');
      if (changed) {
        f.snapshot = pane({ revision: 9, state_change_seq: 5 });
        f.text = 'a different API failure';
      }
      wake();
      assert.equal(await within(running), 'finished');
      const after = await f.state.sessionRetry(f.authority.scope);
      assert.equal(after?.last_delivery_state, 'delivered');
      assert.equal(after?.attempt_count, 1);
      assert.equal(f.counts.prompt, 1);
    } finally {
      wake();
      await f.cleanup();
    }
  }
});

test('blocked UI at a recovery deadline stays human-only', async () => {
  const f = await world({ waiting: 'recoverable_api_error', text: apiText, status: 'blocked' });
  const { wait, entered, wake } = jobWait();
  try {
    await seed(f, {
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:00:30.000Z',
    });
    const running = runJob(f, wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:00:30.000Z');
    wake();
    assert.equal(await within(running), 'finished');
    assert.equal(f.counts.prompt, 0);
    assert.equal(f.counts.sendKeys, 0);
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.equal(after?.last_delivery_state, 'human');
    assert.equal(after?.next_check_at, null);
  } finally {
    wake();
    await f.cleanup();
  }
});

test('malformed decision quarantines without delivery', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  try {
    await assess(f);
    f.decide = async () => ({ garbage: true });
    const running = runJob(f, wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    assert.equal(await within(running), 'finished');
    assert.equal(f.counts.prompt, 0);
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.equal(after?.last_delivery_state, 'human');
    assert.ok(f.handoffs.includes('decision_failed'));
  } finally {
    wake();
    await f.cleanup();
  }
});

test('lost socket at wake quarantines once and does not reconnect-loop', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  try {
    await assess(f);
    const running = runJob(f, wait);
    await within(entered.promise);
    f.herdr.get = async () => {
      f.counts.get++;
      throw new Error('socket lost');
    };
    f.setNow('2026-09-29T10:05:00.000Z');
    const decisions = f.counts.decide;
    wake();
    assert.equal(await within(running), 'finished');
    assert.equal(f.counts.decide, decisions);
    assert.equal(f.counts.prompt, 0);
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.equal(after?.last_delivery_state, 'human');
    assert.equal(after?.next_check_at, null);
    assert.ok(f.handoffs.includes('observation_unavailable'));
  } finally {
    wake();
    await f.cleanup();
  }
});

test('jobs never expose sendKeys or list on the recovery transport', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  try {
    await assess(f);
    const running = runJob(f, wait);
    await within(entered.promise);
    f.text = dialog;
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await within(running);
    assert.equal(f.counts.sendKeys, 0);
    assert.equal(f.counts.list, 0);
    assert.equal(f.counts.prompt, 0);
  } finally {
    wake();
    await f.cleanup();
  }
});

test('saturation marks the episode human without clearing counters or waiting', async () => {
  const f = await world();
  const attempts: ReturnType<typeof beginWorkflow>[] = [];
  const slots: ReturnType<typeof reserveJobSlot>[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const selected = { ...scope, sessionId: `fill${i}` };
      const attempt = beginWorkflow({
        state: f.state,
        scope: selected,
        paneId: 'w1:p1',
        workspaceId: 'w1',
        permission: () => permission(false),
        signal: new AbortController().signal,
        heartbeatIntervalMs: 60_000,
      });
      attempts.push(attempt);
      const auth = await attempt.ready;
      assert.ok(auth);
      await f.episodes.recordSessionRetry('agy', selected.sessionId, {
        pane_id: 'w1:p1',
        session_id: selected.sessionId,
        failure_episode_id: 'a'.repeat(64),
        error_evidence_digest: 'b'.repeat(64),
        first_observed_at: initial,
        attempt_count: 2,
        last_attempt_at: initial,
        quota_check_count: 3,
        last_quota_check_at: initial,
        next_check_at: '2026-09-29T10:05:00.000Z',
        last_delivery_state: 'none',
      });
      const binding = await f.state.binding(selected);
      assert.ok(binding);
      await f.state.recordBinding({
        ...binding,
        phase: 'pending',
        failureEpisodeId: 'a'.repeat(64),
        historyPaneId: 'w1:p1',
      });
      const slot = reserveJobSlot(f.state, auth);
      slots.push(slot);
      assert.ok(await within(slot.ready, 3000));
    }
    const saved = await assess(f);
    assert.equal(saved.quota_check_count, 0);
    assert.equal(await within(runJob(f, async () => assert.fail('saturated admission must not wait'))), 'not_admitted');
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.equal(after?.last_delivery_state, 'human');
    assert.equal(after?.next_check_at, null);
    assert.equal(after?.quota_check_count, 0);
    assert.equal(after?.attempt_count, 0);
    assert.equal(f.handoffs.length, 1);
    assert.equal(f.counts.prompt, 0);
  } finally {
    for (const slot of slots) {
      slot.close();
      await slot.finish();
    }
    for (const attempt of attempts) {
      attempt.close();
      await attempt.finish();
    }
    await f.cleanup();
  }
}, 30_000);

test('already aborted job creates no slot and does not wait', async () => {
  const f = await world();
  try {
    await assess(f);
    const ctrl = new AbortController();
    ctrl.abort();
    assert.equal(
      await within(runJob(f, async () => assert.fail('pre-aborted job must not wait'), ctrl.signal)),
      'stopped',
    );
    const binding = await f.state.binding(f.authority.scope);
    assert.equal(binding?.phase, 'observing');
  } finally {
    await f.cleanup();
  }
});

test('overdue deadline performs one fresh check rather than a catch-up burst', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    await seed(f, {
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:05:00.000Z',
    });
    f.setNow('2026-09-29T12:00:00.000Z');
    const decisions = f.counts.decide;
    const running = runJob(f, wait, ctrl.signal);
    assert.equal((await within(entered.promise)).toISOString(), '2026-09-29T12:15:00.000Z');
    assert.equal(f.counts.decide - decisions, 1);
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.quota_check_count, 1);
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.next_check_at, '2026-09-29T12:15:00.000Z');
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
  } finally {
    wake();
    await f.cleanup();
  }
});

test('pause interrupts an hours-long wait and resume never resurrects the old job', async () => {
  let beat = () => {};
  const f = await world({
    scheduleHeartbeat: (tick) => {
      beat = tick;
      return () => {
        beat = () => {};
      };
    },
  });
  const { wait, entered, wake } = jobWait();
  try {
    await assess(f);
    const running = runJob(f, wait);
    await within(entered.promise);
    assert.equal(await f.state.pause('47:1'), 'paused');
    beat();
    assert.equal(await within(running), 'stopped');
    assert.equal(await f.state.resume('47:1', true), 'resumed');
    assert.equal(await f.authority.valid(), false);
    let waited = false;
    const again = await within(
      runJob(f, async () => {
        waited = true;
      }),
    );
    assert.ok(again === 'stopped' || again === 'not_admitted');
    assert.equal(waited, false);
  } finally {
    wake();
    await f.cleanup();
  }
});

test('abort during a held decision starts revocation before the decision resumes', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  const resume = deferred<void>();
  const held = deferred<void>();
  try {
    await assess(f);
    const original = f.decide;
    f.decide = async (input) => {
      held.resolve();
      await resume.promise;
      return original(input);
    };
    const ctrl = new AbortController();
    const running = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await within(held.promise);
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
    assert.equal(f.counts.prompt, 0);
    resume.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.counts.prompt, 0);
    const after = await f.state.sessionRetry(f.authority.scope);
    assert.notEqual(after?.last_delivery_state, 'delivered');
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('held observation is not joined on abort', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  const resume = deferred<void>();
  const held = deferred<void>();
  try {
    await assess(f);
    const original = f.herdr.get.bind(f.herdr);
    let once = false;
    f.herdr.get = async (paneId) => {
      if (!once) {
        once = true;
        held.resolve();
        await resume.promise;
      }
      return original(paneId);
    };
    const ctrl = new AbortController();
    const running = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await within(held.promise);
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
    resume.resolve();
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('held handoff cannot delay confirmed finish or let a later abort rewrite it', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  const resume = deferred<void>();
  const held = deferred<void>();
  try {
    await assess(f);
    const ctrl = new AbortController();
    const binding = await f.state.binding(f.authority.scope);
    assert.ok(binding);
    const running = runEpisodeJob({
      state: f.state,
      authority: f.authority,
      episodes: f.episodes,
      deps: {
        ...jobDeps(f),
        herdr: {
          get: async () => {
            throw new Error('socket lost');
          },
          read: async () => {
            throw new Error('socket lost');
          },
        },
        handoff: async () => {
          held.resolve();
          await resume.promise;
        },
      },
      binding,
      signal: ctrl.signal,
      wait,
    });
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await within(held.promise);
    assert.equal(await within(running), 'finished');
    ctrl.abort();
    assert.equal(await running, 'finished');
    resume.resolve();
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('abort during held heartbeat rename does not join the rename', async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  let hold = false;
  const f = await world({
    io: {
      rename: async (from, to) => {
        if (hold && to.includes('/workflows/') && to.endsWith('/heartbeat.json')) {
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
      },
    },
  });
  const { wait, entered: waitEntered, wake } = jobWait();
  try {
    await assess(f);
    const running = runJob(f, wait);
    await within(waitEntered.promise);
    hold = true;
    void f.state.lease(scope).heartbeat(f.authority.generation, workflowSession(scope));
    await within(entered.promise);
    f.attempt.close();
    assert.equal(await within(running), 'stopped');
    resume.resolve();
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('abort during slot publication closes the attempt without joining ready', async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  let hold = true;
  const f = await world({
    io: {
      rename: async (from, to) => {
        if (hold && to.includes('/capacity/') && to.endsWith('/active.json')) {
          hold = false;
          entered.resolve();
          await resume.promise;
        }
        await rename(from, to);
      },
    },
  });
  const ctrl = new AbortController();
  try {
    await assess(f);
    const running = runJob(f, async () => assert.fail('must not wait before a slot exists'), ctrl.signal);
    await within(entered.promise);
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
    resume.resolve();
  } finally {
    resume.resolve();
    await f.cleanup();
  }
});

test('unconfirmed release marker stays incomplete; old generation is denied only after confirmation', async () => {
  const markerEntered = deferred<void>();
  const markerResume = deferred<void>();
  let expire!: () => void;
  let cancelled = 0;
  const f = await world({
    io: {
      mkdir: async (path, permissions) => {
        if (path.includes('/capacity/') && path.endsWith('/released')) {
          markerEntered.resolve();
          await markerResume.promise;
        }
        await mkdir(path, permissions);
      },
    },
    shutdownDeadline: (ms, callback) => {
      if (ms !== 5_000) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      }
      expire = callback;
      return () => {
        cancelled++;
      };
    },
  });
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    await assess(f);
    const running = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    const slot = f.state.capacity('47:1', 0);
    const selected = await slot.inspect();
    assert.equal(selected.kind, 'selected');
    ctrl.abort();
    await within(markerEntered.promise);
    expire();
    assert.equal(await within(running), 'shutdown_incomplete');
    assert.equal(cancelled, 1);
    if (selected.kind === 'selected') {
      assert.equal(await slot.owned(selected.identity.token, selected.identity.session), false);
      assert.equal(await slot.leaseMatches(selected.identity.token, selected.identity.session), true);
      markerResume.resolve();
      await within(slot.release(selected.identity.token));
      assert.equal(await slot.leaseMatches(selected.identity.token, selected.identity.session), false);
    }
    assert.equal(await running, 'shutdown_incomplete');
  } finally {
    markerResume.resolve();
    wake();
    ctrl.abort();
    await f.cleanup();
  }
});

test('unconfirmed release returns incomplete with a real five-second shutdown budget', async () => {
  const markerEntered = deferred<void>();
  const markerResume = deferred<void>();
  const f = await world({
    io: {
      mkdir: async (path, permissions) => {
        if (path.includes('/capacity/') && path.endsWith('/released')) {
          markerEntered.resolve();
          await markerResume.promise;
        }
        await mkdir(path, permissions);
      },
    },
  });
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    await assess(f);
    const running = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    const start = performance.now();
    ctrl.abort();
    await within(markerEntered.promise);
    assert.equal(await within(running, 6_500).catch(() => 'pending'), 'shutdown_incomplete');
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4_900 && elapsed < 6_500, `elapsed ${elapsed}ms`);
  } finally {
    markerResume.resolve();
    wake();
    ctrl.abort();
    await f.cleanup();
  }
}, 8_000);

async function seedApi(f: World): Promise<Episode> {
  return seed(f, {
    attempt_count: 0,
    last_attempt_at: null,
    quota_check_count: 0,
    last_quota_check_at: null,
    next_check_at: '2026-09-29T10:00:30.000Z',
  });
}

// These regressions fail if G alone is accepted as job proof after any suspended boundary.
for (const revoke of ['terminal', 'capacity', 'history'] as const) {
  for (const boundary of ['sleep', 'get', 'decision', 'prewrite'] as const) {
    // recordBinding takes the retry lock; terminal publication cannot overtake a
    // decision/prewrite already holding it. Capacity revocation can and must fence both.
    if (revoke === 'terminal' && (boundary === 'decision' || boundary === 'prewrite')) continue;
    test(`job fence: ${revoke} revocation during ${boundary} denies input and successor`, async () => {
      const f = await world({ waiting: 'recoverable_api_error', text: apiText });
      const { wait, entered, wake } = jobWait();
      const held = deferred<void>(),
        resume = deferred<void>();
      const ctrl = new AbortController();
      try {
        await seedApi(f);
        const get = f.herdr.get;
        const decide = f.decide;
        let once = false;
        f.herdr.get = async (id) => {
          if (boundary === 'get' && !once) {
            once = true;
            held.resolve();
            await resume.promise;
          }
          return get(id);
        };
        f.decide = async (input) => {
          if (boundary === 'decision' && !once) {
            once = true;
            held.resolve();
            await resume.promise;
          }
          return decide(input);
        };
        // The facade uses its own EpisodeStore instance: hold the real durable writer.
        const record = EpisodeStore.prototype.recordSessionRetry;
        if (boundary === 'prewrite')
          EpisodeStore.prototype.recordSessionRetry = async function (agent, session, episode) {
            await record.call(this, agent, session, episode);
            if (this.directory === f.root && episode.last_delivery_state === 'uncertain') {
              held.resolve();
              await resume.promise;
            }
          };
        try {
          const running = runJob(f, wait, ctrl.signal);
          await within(entered.promise);
          f.setNow('2026-09-29T10:00:30.000Z');
          if (boundary !== 'sleep') {
            wake();
            await within(held.promise);
          }
          const binding = await f.state.binding(scope);
          assert.ok(binding);
          if (revoke === 'terminal') await f.state.recordBinding({ ...binding, phase: 'terminal', reason: 'canceled' });
          else if (revoke === 'capacity') {
            const capacity = f.state.capacity(scope.serverId, 0);
            const selected = await capacity.inspect();
            assert.equal(selected.kind, 'selected');
            if (selected.kind === 'selected') await capacity.release(selected.identity.token);
          } else {
            const history = await f.state.sessionRetry(scope);
            assert.ok(history);
            // An independent terminal history cannot be mistaken for this job's write.
            await record.call(f.episodes, scope.agent, scope.sessionId, {
              ...history,
              next_check_at: null,
              lifecycle_handoff_sent: true,
            });
          }
          resume.resolve();
          wake();
          await within(running);
          assert.equal(f.counts.prompt, 0);
          assert.equal((await f.state.binding(scope))?.generation, binding.generation);
          await f.state.validateCapacity(scope.serverId, 1);
          assert.equal((await f.state.capacity(scope.serverId, 1).inspect()).kind, 'absent');
        } finally {
          EpisodeStore.prototype.recordSessionRetry = record;
        }
      } finally {
        ctrl.abort();
        resume.resolve();
        wake();
        await f.cleanup();
      }
    });
  }
}

for (const source of ['external', 'authority'] as const) {
  for (const boundary of ['permission', 'binding', 'history', 'refusal-read'] as const) {
    test(`job shutdown: ${source} abort bypasses held ${boundary}`, async () => {
      const held = deferred<void>(),
        resume = deferred<void>();
      let armed = false,
        budgets = 0;
      const f = await world({
        permission: async () => {
          if (armed && boundary === 'permission') {
            held.resolve();
            await resume.promise;
          }
          return permission();
        },
        shutdownDeadline: (ms, expire) => {
          if (ms === 5000) {
            budgets++;
            return () => {};
          }
          const timer = setTimeout(expire, ms);
          return () => clearTimeout(timer);
        },
      });
      const { wait, entered, wake } = jobWait();
      const ctrl = new AbortController();
      let running: Promise<unknown> | undefined;
      try {
        await assess(f);
        const binding = f.state.binding.bind(f.state);
        const history = f.state.sessionRetry.bind(f.state);
        f.state.binding = async (scope) => {
          if (armed && boundary === 'binding') {
            held.resolve();
            await resume.promise;
          }
          return binding(scope);
        };
        f.state.sessionRetry = async (scope) => {
          if (armed && (boundary === 'history' || boundary === 'refusal-read')) {
            held.resolve();
            await resume.promise;
          }
          return history(scope);
        };
        if (boundary === 'refusal-read') {
          f.state.validateCapacity = async () => {
            armed = true;
            throw new Error('damaged capacity');
          };
        }
        running = runJob(f, wait, ctrl.signal);
        if (boundary !== 'refusal-read') {
          await within(entered.promise);
          armed = true;
          f.setNow('2026-09-29T10:05:00.000Z');
          wake();
        }
        await within(held.promise);
        const before = budgets;
        if (source === 'external') ctrl.abort();
        else f.attempt.close();
        if (boundary !== 'refusal-read') assert.ok(budgets > before, 'release budget starts synchronously');
        assert.equal(await within(running), 'stopped');
        assert.equal(f.counts.prompt, 0);
      } finally {
        ctrl.abort();
        armed = false;
        resume.resolve();
        wake();
        await within(running ?? Promise.resolve()).catch(() => {});
        await f.cleanup();
      }
    });
  }
}

for (const cause of ['socket', 'malformed', 'manual'] as const) {
  for (const release of ['confirmed', 'rejected', 'deadline'] as const) {
    for (const notice of ['held', 'rejected'] as const) {
      test(`job internal finish: ${cause}, ${release} release, ${notice} notice without abort`, async () => {
        const marker = deferred<void>(),
          markerResume = deferred<void>(),
          noticeResume = deferred<void>();
        let expire!: () => void;
        let budgets = 0,
          notices = 0;
        const f = await world({
          io: {
            mkdir: async (path, mode) => {
              if (path.includes('/capacity/') && path.endsWith('/released')) {
                marker.resolve();
                if (release === 'rejected') throw new Error('release failed');
                if (release === 'deadline') await markerResume.promise;
              }
              return mkdir(path, mode);
            },
          },
          shutdownDeadline: (ms, callback) => {
            if (ms === 5000) {
              budgets++;
              expire = callback;
              return () => {};
            }
            const timer = setTimeout(callback, ms);
            return () => clearTimeout(timer);
          },
        });
        const { wait, entered, wake } = jobWait();
        const ctrl = new AbortController();
        let running: Promise<unknown> | undefined;
        try {
          await assess(f);
          const binding = await f.state.binding(scope);
          assert.ok(binding);
          if (cause === 'socket')
            f.herdr.get = async () => {
              throw new Error('socket lost');
            };
          if (cause === 'malformed') f.decide = async () => ({});
          if (cause === 'manual') f.waiting = 'permanent_error';
          running = runEpisodeJob({
            state: f.state,
            authority: f.authority,
            episodes: f.episodes,
            binding,
            signal: ctrl.signal,
            wait,
            deps: {
              ...jobDeps(f),
              handoff: async () => {
                notices++;
                if (notice === 'held') await noticeResume.promise;
                throw new Error('late notification failure');
              },
            },
          });
          await within(entered.promise);
          f.setNow('2026-09-29T10:05:00.000Z');
          wake();
          await within(marker.promise);
          assert.equal(budgets, 1);
          if (release === 'deadline') expire();
          assert.equal(await within(running), release === 'confirmed' ? 'finished' : 'shutdown_incomplete');
          assert.equal(notices, release === 'confirmed' ? 1 : 0);
          assert.equal(ctrl.signal.aborted, false);
          assert.equal((await f.state.sessionRetry(scope))?.last_delivery_state, 'human');
          markerResume.resolve();
          noticeResume.resolve();
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(notices, release === 'confirmed' ? 1 : 0);
        } finally {
          ctrl.abort();
          markerResume.resolve();
          noticeResume.resolve();
          wake();
          await within(running ?? Promise.resolve()).catch(() => {});
          await f.cleanup();
        }
      });
    }
  }
}

test('job refused promotion quarantines only its tentative pending history', async () => {
  const f = await world();
  try {
    const saved = await seed(f, {
      attempt_count: 2,
      last_attempt_at: initial,
      quota_check_count: 3,
      last_quota_check_at: initial,
      next_check_at: '2026-09-29T10:05:00.000Z',
    });
    f.state.validateCapacity = async () => {
      throw new Error('capacity unavailable');
    };
    assert.equal(await within(runJob(f, async () => assert.fail('not admitted'))), 'not_admitted');
    assert.equal((await f.state.binding(scope))?.phase, 'terminal');
    assert.deepEqual(await f.state.sessionRetry(scope), {
      ...saved,
      next_check_at: null,
      last_delivery_state: 'human',
    });
    assert.equal(f.handoffs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('job refused promotion keeps the pane lock from publication through reservation and cleanup', async () => {
  const f = await world();
  let competingWriters = 0;
  try {
    await assess(f);
    f.state.validateCapacity = async () => {
      await new EpisodeStore(f.root).withEpisodeLock('w1:p1', async () => {
        competingWriters++;
      });
      throw new Error('capacity unavailable');
    };
    assert.equal(await within(runJob(f, async () => assert.fail('refused'))), 'not_admitted');
    assert.equal(competingWriters, 0, 'no promotion may interleave between tentative publication and refusal cleanup');
    assert.equal((await f.state.sessionRetry(scope))?.next_check_at, null);
    assert.equal((await f.state.binding(scope))?.phase, 'terminal');
  } finally {
    await f.cleanup();
  }
});

for (const phase of ['refusal', 'quarantine'] as const) {
  test(`job ${phase}: unavailable canonical lock is incomplete, never an unlocked write`, async () => {
    const f = await world();
    const entered = deferred<void>(),
      resume = deferred<void>();
    let locked: Promise<unknown> | undefined;
    const hold = async () => {
      locked = new EpisodeStore(f.root).withEpisodeLock('retry-session:' + JSON.stringify(['agy', 's1']), async () => {
        entered.resolve();
        await resume.promise;
      });
      await within(entered.promise);
      throw new Error('synthetic failure with another canonical writer');
    };
    try {
      const saved = await assess(f);
      if (phase === 'refusal') f.state.validateCapacity = hold;
      else f.herdr.get = hold;
      f.setNow('2026-09-29T10:05:00.000Z');
      assert.equal(await within(runJob(f, async () => assert.fail('already due'))), 'shutdown_incomplete');
      assert.deepEqual(await f.state.sessionRetry(scope), saved);
      assert.equal(f.handoffs.length, 0);
      assert.equal(f.counts.prompt, 0);
    } finally {
      resume.resolve();
      await locked;
      await f.cleanup();
    }
  });
}

test('job quarantine: late canonical read cannot initiate write or notice after stop', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  const held = deferred<void>(),
    resume = deferred<void>(),
    settled = deferred<void>();
  const ctrl = new AbortController();
  const record = EpisodeStore.prototype.recordSessionRetry;
  let writesAfterStop = 0;
  try {
    const saved = await assess(f);
    EpisodeStore.prototype.recordSessionRetry = async function (agent, session, episode) {
      if (this.directory === f.root && ctrl.signal.aborted) writesAfterStop++;
      return record.call(this, agent, session, episode);
    };
    const read = f.state.sessionRetry.bind(f.state);
    let failed = false;
    f.state.sessionRetry = async (scope) => {
      const result = await read(scope);
      if (failed) {
        held.resolve();
        await resume.promise;
        settled.resolve();
      }
      return result;
    };
    f.herdr.get = async () => {
      failed = true;
      throw new Error('socket lost');
    };
    const running = runJob(f, wait, ctrl.signal);
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await within(held.promise);
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
    resume.resolve();
    await within(settled.promise);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(await read(scope), saved);
    assert.equal(writesAfterStop, 0);
    assert.equal(f.handoffs.length, 0);
  } finally {
    EpisodeStore.prototype.recordSessionRetry = record;
    ctrl.abort();
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

for (const boundary of ['get', 'decision', 'prompt'] as const) {
  test(`job late rejection: held ${boundary} settles after stopped without replay`, async () => {
    const f = await world({ waiting: 'recoverable_api_error', text: apiText });
    const { wait, entered, wake } = jobWait();
    const held = deferred<void>(),
      resume = deferred<void>();
    const ctrl = new AbortController();
    try {
      await seedApi(f);
      const rejectLate = async () => {
        held.resolve();
        await resume.promise;
        throw new Error('late foreground failure');
      };
      if (boundary === 'get') f.herdr.get = rejectLate;
      if (boundary === 'decision') f.decide = rejectLate;
      if (boundary === 'prompt')
        f.herdr.prompt = async () => {
          f.counts.prompt++;
          await rejectLate();
        };
      const running = runJob(f, wait, ctrl.signal);
      await within(entered.promise);
      f.setNow('2026-09-29T10:00:30.000Z');
      wake();
      await within(held.promise);
      ctrl.abort();
      assert.equal(await within(running), 'stopped');
      const before = await f.state.sessionRetry(scope);
      if (boundary === 'prompt') assert.equal(before?.last_delivery_state, 'uncertain');
      resume.resolve();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(await f.state.sessionRetry(scope), before);
      assert.equal(f.counts.prompt, boundary === 'prompt' ? 1 : 0);
      assert.equal(f.handoffs.length, 0);
    } finally {
      ctrl.abort();
      resume.resolve();
      wake();
      await f.cleanup();
    }
  });
}

for (const boundary of ['permission', 'history', 'wait', 'publication', 'release', 'heartbeat'] as const) {
  test(`job late rejection: ${boundary} is observed after bounded cancellation`, async () => {
    const held = deferred<void>(),
      resume = deferred<void>(),
      late = deferred<void>();
    let armed = false;
    let expire!: () => void;
    let beat = () => {};
    const rejectLate = async () => {
      held.resolve();
      await resume.promise;
      late.resolve();
      throw new Error('late synthetic failure');
    };
    const f = await world({
      ...(boundary === 'heartbeat'
        ? {
            scheduleHeartbeat: (tick: () => void) => {
              beat = tick;
              return () => {
                beat = () => {};
              };
            },
          }
        : { heartbeatIntervalMs: 60_000 }),
      permission: async () => {
        if (armed && boundary === 'permission') await rejectLate();
        return permission();
      },
      io: {
        rename: async (from, to) => {
          if (
            (boundary === 'publication' && to.includes('/capacity/') && to.endsWith('/active.json')) ||
            (armed && boundary === 'heartbeat' && to.includes('/workflows/') && to.endsWith('/heartbeat.json'))
          )
            await rejectLate();
          return rename(from, to);
        },
        mkdir: async (path, mode) => {
          if (boundary === 'release' && path.includes('/capacity/') && path.endsWith('/released')) await rejectLate();
          return mkdir(path, mode);
        },
      },
      shutdownDeadline: (ms, callback) => {
        if (ms === 5000) {
          expire = callback;
          return () => {};
        }
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });
    const { wait, entered, wake } = jobWait();
    const ctrl = new AbortController();
    try {
      const saved = await assess(f);
      const read = f.state.sessionRetry.bind(f.state);
      f.state.sessionRetry = async (scope) => {
        if (armed && boundary === 'history') await rejectLate();
        return read(scope);
      };
      const running = runJob(f, boundary === 'wait' ? rejectLate : wait, ctrl.signal);
      if (boundary !== 'publication' && boundary !== 'wait') {
        await within(entered.promise);
        armed = true;
        if (boundary === 'permission' || boundary === 'history') {
          f.setNow('2026-09-29T10:05:00.000Z');
          wake();
        }
        if (boundary === 'release') ctrl.abort();
        if (boundary === 'heartbeat') beat();
      }
      await within(held.promise);
      ctrl.abort();
      if (boundary === 'release') expire();
      const expected = boundary === 'release' ? 'shutdown_incomplete' : 'stopped';
      assert.equal(await within(running), expected);
      resume.resolve();
      await within(late.promise);
      // Drain already-settled rejections; Bun reports any unobserved chain as a test error.
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(await running, expected);
      assert.deepEqual(await read(scope), saved);
      assert.equal(f.counts.prompt, 0);
      assert.equal(f.handoffs.length, 0);
    } finally {
      ctrl.abort();
      armed = false;
      resume.resolve();
      wake();
      await f.cleanup();
    }
  });
}

test('job transport cannot start another observation after a held read loses its slot', async () => {
  const f = await world();
  const { wait, entered, wake } = jobWait();
  const held = deferred<void>(),
    resume = deferred<void>();
  try {
    await assess(f);
    const read = f.herdr.read;
    f.herdr.read = async (paneId) => {
      held.resolve();
      await resume.promise;
      return read(paneId);
    };
    const running = runJob(f, wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:05:00.000Z');
    wake();
    await within(held.promise);
    const capacity = f.state.capacity(scope.serverId, 0);
    const selected = await capacity.inspect();
    assert.equal(selected.kind, 'selected');
    if (selected.kind === 'selected') await capacity.release(selected.identity.token);
    const gets = f.counts.get,
      decisions = f.counts.decide;
    resume.resolve();
    await within(running);
    assert.equal(f.counts.get, gets);
    assert.equal(f.counts.decide, decisions);
    assert.equal(f.counts.prompt, 0);
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('job proof: a validation spanning its own canonical write does not revoke the slot', async () => {
  const f = await world();
  const held = deferred<void>(),
    resume = deferred<void>();
  let attempt: ReturnType<typeof reserveJobSlot> | undefined;
  try {
    const saved = await assess(f);
    const binding = await f.state.binding(scope);
    assert.ok(binding);
    await f.state.recordBinding({ ...binding, phase: 'pending', failureEpisodeId: saved.failure_episode_id });
    attempt = reserveJobSlot(f.state, f.authority);
    const slot = await attempt.ready;
    assert.ok(slot);
    const read = f.state.sessionRetry.bind(f.state);
    let once = true;
    f.state.sessionRetry = async (scope) => {
      const snapshot = await read(scope);
      if (once) {
        once = false;
        held.resolve();
        await resume.promise;
      }
      return snapshot;
    };
    const checking = slot.valid();
    await within(held.promise);
    await f.episodes.withEpisodeLock('w1:p1', () =>
      f.episodes.withEpisodeLock('retry-session:' + JSON.stringify(['agy', 's1']), () =>
        slot.record({ ...saved, next_check_at: null, last_delivery_state: 'human' }),
      ),
    );
    resume.resolve();
    assert.equal(await within(checking), true);
    assert.equal(await slot.valid(), true);
  } finally {
    resume.resolve();
    attempt?.close();
    await attempt?.finish();
    await f.cleanup();
  }
});

test('job proof: own uncertainty survives renewal while prompt acknowledgment is held', async () => {
  let beat = () => {};
  const f = await world({
    waiting: 'recoverable_api_error',
    text: apiText,
    scheduleHeartbeat: (tick) => {
      beat = tick;
      return () => {
        beat = () => {};
      };
    },
  });
  const { wait, entered, wake } = jobWait();
  const held = deferred<void>(),
    resume = deferred<void>();
  try {
    await seedApi(f);
    f.herdr.prompt = async () => {
      f.counts.prompt++;
      held.resolve();
      await resume.promise;
    };
    const running = runJob(f, wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:00:30.000Z');
    wake();
    await within(held.promise);
    const read = f.state.sessionRetry.bind(f.state);
    let renewals = 0;
    f.state.sessionRetry = async (scope) => {
      renewals++;
      return read(scope);
    };
    await until(async () => {
      if (renewals >= 3) return true;
      beat();
      return false;
    });
    assert.equal(f.authority.signal.aborted, false);
    assert.equal((await read(scope))?.last_delivery_state, 'uncertain');
    resume.resolve();
    assert.equal(await within(running), 'finished');
    assert.equal((await read(scope))?.last_delivery_state, 'delivered');
    assert.equal(f.counts.prompt, 1);
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('job finish does not turn an already-started slot renewal into generation loss', async () => {
  const promptHeld = deferred<void>(),
    promptResume = deferred<void>();
  const renewalHeld = deferred<void>(),
    renewalResume = deferred<void>(),
    renewed = deferred<void>();
  let beat = () => {};
  let holdRenewal = false;
  const f = await world({
    waiting: 'recoverable_api_error',
    text: apiText,
    scheduleHeartbeat: (tick) => {
      beat = tick;
      return () => {
        beat = () => {};
      };
    },
    io: {
      rename: async (from, to) => {
        if (holdRenewal && to.includes('/capacity/') && to.endsWith('/heartbeat.json')) {
          renewalHeld.resolve();
          await renewalResume.promise;
          const result = await rename(from, to);
          renewed.resolve();
          return result;
        }
        return rename(from, to);
      },
    },
  });
  const { wait, entered, wake } = jobWait();
  const named = async <T>(name: string, promise: Promise<T>) => {
    try {
      return await within(promise);
    } catch {
      throw new Error(`${name} watchdog expired`);
    }
  };
  try {
    await seedApi(f);
    f.herdr.prompt = async () => {
      promptHeld.resolve();
      await promptResume.promise;
    };
    const running = runJob(f, wait);
    await named('entered', entered.promise);
    f.setNow('2026-09-29T10:00:30.000Z');
    wake();
    await named('promptHeld', promptHeld.promise);
    holdRenewal = true;
    beat();
    await named('renewalHeld', renewalHeld.promise);
    promptResume.resolve();
    assert.equal(await named('jobFinishedWhileRenewalHeld', running), 'finished');
    renewalResume.resolve();
    await named('renewed', renewed.promise);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.authority.admissionOpen(), true);
  } finally {
    promptResume.resolve();
    renewalResume.resolve();
    wake();
    await f.cleanup();
  }
});

test('job duplicate during held capacity publication cannot quarantine the live deadline', async () => {
  const held = deferred<void>(),
    resume = deferred<void>();
  const f = await world({
    io: {
      rename: async (from, to) => {
        if (to.includes('/capacity/') && to.endsWith('/active.json')) {
          held.resolve();
          await resume.promise;
        }
        return rename(from, to);
      },
    },
  });
  const { wait, entered, wake } = jobWait();
  const ctrl = new AbortController();
  try {
    const saved = await assess(f);
    const running = runJob(f, wait, ctrl.signal);
    await within(held.promise);
    assert.equal(await within(runJob(f, async () => assert.fail('duplicate cannot wait'))), 'not_admitted');
    assert.deepEqual(await f.state.sessionRetry(scope), saved);
    assert.equal((await f.state.binding(scope))?.phase, 'pending');
    assert.equal(f.handoffs.length, 0);
    resume.resolve();
    await within(entered.promise);
    ctrl.abort();
    assert.equal(await within(running), 'stopped');
  } finally {
    ctrl.abort();
    resume.resolve();
    wake();
    await f.cleanup();
  }
});

test('missing prompt acknowledgment never replays the recovery instruction', async () => {
  const f = await world({ waiting: 'recoverable_api_error', text: apiText });
  const { wait, entered, wake } = jobWait();
  const resume = deferred<void>();
  const held = deferred<void>();
  try {
    await seed(f, {
      attempt_count: 0,
      last_attempt_at: null,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: '2026-09-29T10:00:30.000Z',
    });
    f.herdr.prompt = async () => {
      held.resolve();
      await resume.promise;
      throw new Error('lost acknowledgment');
    };
    const running = runJob(f, wait);
    await within(entered.promise);
    f.setNow('2026-09-29T10:00:30.000Z');
    wake();
    await within(held.promise);
    const afterUncertain = await f.state.sessionRetry(f.authority.scope);
    assert.equal(afterUncertain?.last_delivery_state, 'uncertain');
    resume.resolve();
    assert.equal(await within(running), 'finished');
    assert.equal((await f.state.sessionRetry(f.authority.scope))?.last_delivery_state, 'uncertain');
    assert.equal(f.prompts.length, 0);
    const again = await within(runJob(f, async () => assert.fail('uncertain history must not wait')));
    assert.equal(again, 'not_admitted');
    assert.equal(f.counts.prompt, 0);
  } finally {
    resume.resolve();
    wake();
    await f.cleanup();
  }
});
