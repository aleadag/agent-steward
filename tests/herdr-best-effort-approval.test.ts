import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleEvent,
  runEvent,
  runVisibleScheduler,
  socketReader,
  type EventDeps,
} from '../src/herdr-adapter/entry.ts';
import { runScheduler, type SchedulerOptions } from '../src/herdr-adapter/scheduler.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { assessStop } from '../src/triage.ts';
import type { AgentSnapshot } from '../src/herdr-adapter/observe.ts';
import type { Evaluation, StopInput } from '../src/contracts.ts';

const at = '2026-10-03T12:00:00Z';
const dialog = (command = 'printf approval-probe') =>
  `Requesting permission for:\n   ${command}\n\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel\n\n  ↑/↓ Navigate · tab Amend`;
const evaluation = (
  risk = 0.1,
  confidence = 0.9,
  waiting: 'approve_command' | 'approve_edit' = 'approve_command',
): Evaluation => ({
  model: 'jev-1.13.0',
  usage: {},
  answers: {
    waiting_for: {
      type: 'choice',
      choice: waiting,
      probabilities: {
        approve_command: waiting === 'approve_command' ? 0.9 : 0,
        approve_edit: waiting === 'approve_edit' ? 0.9 : 0,
        answer_question: 0,
        credentials: 0,
        recoverable_api_error: 0,
        quota_limit: 0,
        permanent_error: 0,
        completed: 0,
        other: 0.1,
      },
      confidence,
    },
    risky: { type: 'noul', noul: risk },
  },
});

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'steward-best-effort-'));
  const store = new EpisodeStore(directory);
  const token = await store.acquire('server-1');
  assert.ok(token);
  let current: AgentSnapshot = {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent: 'agy',
    agent_status: 'idle',
    agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's1' },
    revision: 259,
    state_change_seq: 4,
  };
  let text = dialog();
  const keys: [string, string[]][] = [];
  const inputs: StopInput[] = [];
  const handoffs: string[] = [];
  let risk = 0.1;
  let confidence = 0.9;
  let admission = true;
  let waiting: 'approve_command' | 'approve_edit' = 'approve_command';
  const herdr = {
    get: async () => current,
    list: async () => [current],
    read: async () => ({ pane_id: current.pane_id, source: 'detection', revision: 0, text, truncated: true }),
    sendKeys: async (pane: string, input: string[]) => {
      // Catches submitting before the persistent uncertain-write marker exists.
      const saved = await (
        store as EpisodeStore & { approval: (pane: string, session: string) => Promise<{ state: string } | null> }
      ).approval(current.agent!, current.agent_session!.value);
      assert.equal(saved?.state, 'uncertain');
      keys.push([pane, input]);
    },
    prompt: async () => {
      throw new Error('permission UI must never receive a recovery prompt');
    },
  };
  const deps: EventDeps & { autoApprove: boolean } = {
    herdr,
    store,
    autoApprove: enabled,
    targets: 'all',
    sessionId: 'server-1',
    leaseToken: token,
    sessionValid: async () => true,
    admissionOpen: () => admission,
    clock: { now: () => new Date(at) },
    decide: async (input) => {
      inputs.push(input);
      return assessStop(input, {
        thresholds: { risky: 0.6, choiceConfidence: 0.45 },
        now: new Date(at),
        evaluate: async () => evaluation(risk, confidence, waiting),
      });
    },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  };
  const run = () =>
    handleEvent(
      {
        type: 'pane.agent_status_changed',
        pane_id: current.pane_id,
        workspace_id: current.workspace_id,
        agent: current.agent,
        agent_status: current.agent_status,
      },
      deps,
    );
  return {
    deps,
    store,
    herdr,
    keys,
    inputs,
    handoffs,
    run,
    changeText: (next: string) => {
      text = next;
    },
    changePane: (changes: Partial<AgentSnapshot>) => {
      current = { ...current, ...changes };
    },
    setRisk: (next: number) => {
      risk = next;
    },
    setConfidence: (next: number) => {
      confidence = next;
    },
    stopAdmission: () => {
      admission = false;
    },
    setWaiting: (next: 'approve_command' | 'approve_edit') => {
      waiting = next;
    },
    cleanup: async () => {
      await store.release(token);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Catches retaining the default-deny branch when globally enabled, or requiring raw blocked status.
test('global best-effort mode assesses idle permission UI and sends only one key', async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    assert.equal(f.inputs[0]?.pending_action?.action, 'printf approval-probe');
    assert.equal(f.inputs[0]?.automatic_approval_forbidden, false);
    assert.deepEqual(f.handoffs, []);
    await f.run();
    assert.equal(f.keys.length, 1);
    assert.equal(f.inputs.length, 2);
    // A footer or lifecycle sequence change must not grant another attempt for the same menu.
    f.changeText(dialog() + '\nTOOL · ctx 2.6%');
    f.changePane({ state_change_seq: 5 });
    await f.run();
    assert.equal(f.keys.length, 1);
    f.changeText(dialog('printf next-probe'));
    await f.run();
    assert.equal(f.keys.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('approval remains default-off globally', async () => {
  const f = await fixture(false);
  try {
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.ok(f.inputs.every((input) => input.automatic_approval_forbidden));
  } finally {
    await f.cleanup();
  }
});

// Catches sending solely from a menu match rather than the real risk/confidence policy.
for (const [name, risk, confidence] of [
  ['high risk', 0.6, 0.9],
  ['low confidence', 0.1, 0.44],
] as const) {
  test(`${name} remains human in global approval mode`, async () => {
    const f = await fixture();
    try {
      f.setRisk(risk);
      f.setConfidence(confidence);
      await f.run();
      assert.deepEqual(f.keys, []);
      assert.equal(f.inputs.length, 1);
      assert.equal(f.inputs[0]?.automatic_approval_forbidden, false);
      assert.ok(f.handoffs.includes('human_review_required'));
    } finally {
      await f.cleanup();
    }
  });
}

const compactDialog =
  'Requesting permission for:\n  printf approval-probe\nRun this command?\n> 1. Yes, run command\n  2. No, cancel';
for (const [name, text] of [
  ['persistent grant on key 1', dialog().replace('1. Yes, run command', '1. Yes, and always allow')],
  ['conflicting dialogs', 'Requesting permission for: command A\n' + dialog()],
  [
    'inline header without a bounded action block',
    dialog().replace(
      'Requesting permission for:\n   printf approval-probe',
      'Requesting permission for: printf approval-probe',
    ),
  ],
  ['setup prefix before an apparent menu', 'Settings Error\n' + dialog()],
  [
    'trailing trust dialog with alternative numbered controls',
    compactDialog + '\nDo you trust this project?\n1) Yes, trust this project\n2) No',
  ],
  ['trailing persistent key 1 in brackets', compactDialog + '\n[1] Always allow in this conversation'],
  ['trailing setup dialog', compactDialog + '\nSettings Error\nContinue with defaults?'],
  ['unknown trailing question', compactDialog + '\nWould you like to delete the file? (y/n)'],
  ['trust', 'Do you trust this project?\n1. Yes'],
  ['login', 'Sign in\n1. Continue'],
  ['settings', 'Settings Error\n1. Continue with defaults'],
] as const) {
  test(`${name} never receives approval input`, async () => {
    const f = await fixture();
    try {
      f.changeText(text);
      await f.run();
      assert.deepEqual(f.keys, []);
    } finally {
      await f.cleanup();
    }
  });
}

// Catches ignoring a dialog or occupant change after the expensive assessment.
for (const boundary of ['dialog', 'session', 'control', 'lease', 'shutdown'] as const) {
  test(`${boundary} change during classification prevents key delivery`, async () => {
    const f = await fixture();
    try {
      const original = f.deps.decide;
      f.deps.decide = async (input) => {
        const result = await original(input);
        if (boundary === 'dialog') f.changeText(dialog('different command'));
        if (boundary === 'session')
          f.changePane({ agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's2' } });
        if (boundary === 'control') f.changeText(dialog().replace('1. Yes, run command', '1. No, cancel'));
        if (boundary === 'lease') f.deps.sessionValid = async () => false;
        if (boundary === 'shutdown') f.stopAdmission();
        return result;
      };
      await f.run();
      assert.deepEqual(f.keys, []);
    } finally {
      await f.cleanup();
    }
  });
}

// Catches reclassifying/replaying a write whose result is unknown, including after restart.
test('unknown key outcome is persistent and never resent', async () => {
  const f = await fixture();
  try {
    f.herdr.sendKeys = async (pane, keys) => {
      f.keys.push([pane, keys]);
      throw new Error('lost acknowledgment');
    };
    await f.run();
    assert.equal(f.keys.length, 1);
    await f.run();
    f.changeText(dialog('different command'));
    f.deps.store = new EpisodeStore(f.store.directory);
    await f.run();
    assert.equal(f.keys.length, 1);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

// Catches erasing an unresolved session's quarantine when another session uses its pane.
test('uncertain session stays quarantined after replacement, restart and return', async () => {
  const f = await fixture();
  let token = f.deps.leaseToken!;
  try {
    const send = f.herdr.sendKeys;
    f.herdr.sendKeys = async (pane, keys) => {
      f.keys.push([pane, keys]);
      throw new Error('lost acknowledgment');
    };
    await f.run();
    assert.equal(f.keys.length, 1);
    f.herdr.sendKeys = send;
    f.changePane({ agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's2' } });
    await f.run();
    assert.equal(f.keys.length, 2);
    await f.store.release(token);
    const restarted = new EpisodeStore(f.store.directory);
    const next = await restarted.acquire('server-1');
    assert.ok(next);
    token = next;
    f.deps.store = restarted;
    f.deps.leaseToken = next;
    f.changePane({
      pane_id: 'w1:p2',
      agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's1' },
    });
    f.changeText(dialog('printf different-probe'));
    await f.run();
    assert.equal(f.keys.length, 2);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await (f.deps.store as EpisodeStore).release(token);
    await f.cleanup();
  }
});

// Catches duplicate submission when two panes present the same resumable session/menu.
test('same session on different panes shares one approval-attempt lock', async () => {
  const f = await fixture();
  try {
    const native = await f.herdr.get();
    f.deps.herdr = {
      ...f.herdr,
      get: async (pane) => ({ ...native, pane_id: pane }),
      read: async (pane) => ({ pane_id: pane, source: 'detection', revision: 0, text: dialog(), truncated: true }),
      sendKeys: async (pane, keys) => {
        assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
        f.keys.push([pane, keys]);
      },
    };
    await Promise.all(
      ['w1:p1', 'w1:p2'].map((pane) =>
        handleEvent(
          {
            type: 'pane.agent_status_changed',
            pane_id: pane,
            workspace_id: 'w1',
            agent: 'agy',
            agent_status: 'idle',
          },
          f.deps,
        ),
      ),
    );
    assert.equal(f.keys.length, 1);
    assert.deepEqual(f.keys[0]?.[1], ['1']);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

// Catches admitting a key sender without the per-pane lock needed by event/poll concurrency.
test('approval requires an episode lock', async () => {
  const f = await fixture();
  try {
    f.deps.store = {
      active: async () => true,
      retry: f.store.retry.bind(f.store),
      record: f.store.record.bind(f.store),
    };
    await f.run();
    assert.deepEqual(f.keys, []);
  } finally {
    await f.cleanup();
  }
});

// Catches requiring preexisting saved targets instead of discovering all current/new agent panels.
test('global scheduler discovers a permission pane with no saved episode', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    await f.store.release(f.deps.leaseToken!);
    const send = f.herdr.sendKeys;
    f.herdr.sendKeys = async (pane, keys) => {
      await send(pane, keys);
      abort.abort();
    };
    const options: SchedulerOptions & { autoApprove: boolean } = {
      store: f.store,
      herdr: f.herdr,
      decide: f.deps.decide,
      sessionId: 'server-1',
      signal: abort.signal,
      autoApprove: true,
      clock: f.deps.clock,
    };
    const deadline = setTimeout(() => abort.abort(), 2000);
    try {
      assert.equal(await runScheduler(options), 'stopped');
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
  } finally {
    await f.cleanup();
  }
});

// Catches failing to pass the global setting through the real config entrypoint.
test('one adapter setting enables all panels without pane_ids; malformed enable values stay off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-approval-config-'));
  const server = createServer();
  const socket = join(root, 'herdr.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const config = join(root, 'config');
  await mkdir(config);
  try {
    for (const [value, enabled] of [
      [true, true],
      [false, false],
      ['true', false],
      [null, false],
    ] as const) {
      await writeFile(join(config, 'targets.json'), JSON.stringify({ auto_approve: value }));
      let called = false;
      await runVisibleScheduler(
        { HERDR_SOCKET_PATH: socket, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: join(root, 'state') },
        async (options) => {
          called = true;
          assert.equal((options as SchedulerOptions & { autoApprove?: boolean }).autoApprove, enabled);
          assert.equal(options.targets, undefined);
          return 'stopped';
        },
      );
      assert.ok(called);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// Catches approving from an earlier low-risk decision after the policy changes.
test('fresh high-risk decision after initial approval prevents input', async () => {
  const f = await fixture();
  try {
    const decide = f.deps.decide;
    f.deps.decide = async (input) => {
      if (f.inputs.length === 1) f.setRisk(0.8);
      return decide(input);
    };
    await f.run();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.keys, []);
  } finally {
    await f.cleanup();
  }
});

// Catches bypassing a caller's explicit prohibition when a recognizer finds a menu.
test('explicit restriction result never receives approval input', async () => {
  const f = await fixture();
  try {
    f.deps.decide = async (input) =>
      assessStop(
        { ...input, automatic_approval_forbidden: true },
        {
          thresholds: { risky: 0.6, choiceConfidence: 0.45 },
          now: new Date(at),
          evaluate: async () => evaluation(),
        },
      );
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

for (const boundary of ['session', 'lease', 'shutdown'] as const) {
  test(`${boundary} loss after the uncertain prewrite prevents input`, async () => {
    const f = await fixture();
    try {
      const record = f.store.recordApproval.bind(f.store);
      f.store.recordApproval = async (pane, attempt) => {
        await record(pane, attempt);
        if (attempt.state !== 'uncertain') return;
        if (boundary === 'session')
          f.changePane({ agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 's2' } });
        if (boundary === 'lease') f.deps.sessionValid = async () => false;
        if (boundary === 'shutdown') f.stopAdmission();
      };
      await f.run();
      assert.equal(f.inputs.length, 2);
      assert.deepEqual(f.keys, []);
      assert.equal((await f.store.approval('agy', 's1'))?.state, 'uncertain');
    } finally {
      await f.cleanup();
    }
  });
}

// Catches coupling approval recognition to AGY instead of its explicit control layout.
test('shared delivery accepts a recognized menu on another live agent session', async () => {
  const f = await fixture();
  try {
    f.changePane({
      agent: 'codex',
      agent_status: 'blocked',
      agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 's1' },
    });
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs[0]?.agent.tool, 'codex');
  } finally {
    await f.cleanup();
  }
});

// Catches losing recovery history or storing raw command/UI text in approval metadata.
test('approval metadata is private and does not replace recovery history', async () => {
  const f = await fixture();
  try {
    const history = {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'old-error',
      error_evidence_digest: 'old-digest',
      first_observed_at: at,
      attempt_count: 2,
      last_attempt_at: at,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: null,
      last_delivery_state: 'human' as const,
    };
    await f.store.record('w1:p1', history);
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.deepEqual(await f.store.retry('w1:p1'), history);
    const attempt = await f.store.approval('agy', 's1');
    assert.ok(attempt);
    assert.equal(JSON.stringify(attempt).includes('approval-probe'), false);
    assert.deepEqual(await f.store.targets(), ['w1:p1']);
  } finally {
    await f.cleanup();
  }
});

test('recognized one-time edit menu uses the edit policy and the same key transport', async () => {
  const f = await fixture();
  try {
    f.setWaiting('approve_edit');
    f.changeText(
      dialog('Replace the draft heading')
        .replace('Run this command?', 'Apply this edit?')
        .replace('1. Yes, run command', '1. Yes, apply edit'),
    );
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs[0]?.pending_action?.action, 'Replace the draft heading');
  } finally {
    await f.cleanup();
  }
});

// Catches caching the initial pane list and missing panels started later.
test('global polling discovers a panel opened after supervisor startup', async () => {
  const f = await fixture();
  const abort = new AbortController();
  let lists = 0;
  try {
    await f.store.release(f.deps.leaseToken!);
    f.herdr.list = async () => (++lists === 1 ? [] : [await f.herdr.get()]);
    // A controlled next wake avoids waiting five seconds without replacing real lease/attempt state.
    f.store.next = async () => new Date(at).getTime() + 100;
    const send = f.herdr.sendKeys;
    f.herdr.sendKeys = async (pane, keys) => {
      await send(pane, keys);
      abort.abort();
    };
    const deadline = setTimeout(() => abort.abort(), 2000);
    try {
      assert.equal(
        await runScheduler({
          store: f.store,
          herdr: f.herdr,
          decide: f.deps.decide,
          sessionId: 'server-1',
          signal: abort.signal,
          autoApprove: true,
          clock: f.deps.clock,
        }),
        'stopped',
      );
    } finally {
      clearTimeout(deadline);
    }
    assert.ok(lists >= 2);
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
  } finally {
    await f.cleanup();
  }
});

// Catches dropping the global setting or mangling the key at the real socket/CLI boundary.
test('configured event entrypoint sends literal agent send-keys once through Herdr', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'steward-approval-entry-'));
  const socket = join(root, 'herdr.sock');
  const server = createServer((client) => {
    let data = '';
    client.on('data', async (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.split('\n')[0]!);
      const result =
        request.method === 'agent.get'
          ? { type: 'agent_info', agent: await f.herdr.get() }
          : request.method === 'agent.read'
            ? { type: 'pane_read', read: await f.herdr.read() }
            : { type: 'agent_list', agents: await f.herdr.list() };
      client.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const info = await stat(socket);
  const session = `${info.dev}:${info.ino}`;
  await f.store.release(f.deps.leaseToken!);
  const token = await f.store.acquire(session);
  assert.ok(token);
  const argv = join(root, 'argv');
  const binary = join(root, 'fake-herdr');
  const config = join(root, 'config');
  await mkdir(config);
  await writeFile(join(config, 'targets.json'), JSON.stringify({ auto_approve: true }));
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argv}'\n`, { mode: 0o700 });
  try {
    assert.equal((await socketReader(socket).list?.())?.[0]?.pane_id, 'w1:p1');
    const env = {
      HERDR_SOCKET_PATH: socket,
      HERDR_BIN_PATH: binary,
      HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_PLUGIN_STATE_DIR: f.store.directory,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        agent_status: 'idle',
        agent: 'agy',
      }),
    };
    await runEvent(env, f.deps.decide);
    assert.equal(await readFile(argv, 'utf8'), 'agent\nsend-keys\nw1:p1\n1\n');
    await runEvent(env, f.deps.decide);
    assert.equal(await readFile(argv, 'utf8'), 'agent\nsend-keys\nw1:p1\n1\n');
  } finally {
    await f.store.release(token);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await f.cleanup();
  }
});
