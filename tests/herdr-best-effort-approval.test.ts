import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalMenu } from '../src/herdr-adapter/best-effort-approval.ts';
import { handleEvent, runEvent, socketReader, type EventDeps } from '../src/herdr-adapter/entry.ts';
import { beginWorkflow } from '../src/herdr-adapter/authority.ts';
import { workflowEventDeps } from '../src/herdr-adapter/events.ts';
import { EpisodeStore } from '../src/herdr-adapter/state.ts';
import { WorkflowState } from '../src/herdr-adapter/workflow-state.ts';
import { assessStop } from '../src/triage.ts';
import { observeStop, type AgentSnapshot } from '../src/herdr-adapter/observe.ts';
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

const partialMenu = 'Requesting permission for:\n   printf approval-probe\n\nRun this command?\n> 1. Yes, run command';

async function scopedApproval() {
  const directory = await mkdtemp(join(tmpdir(), 'steward-scoped-approval-'));
  const state = new WorkflowState(directory);
  const store = new EpisodeStore(directory);
  const attempt = beginWorkflow({
    state,
    scope: {
      serverId: '47:1',
      agent: 'agy',
      sessionId: 's1',
      sessionKind: 'id',
      sessionSource: 'herdr:antigravity_cli',
    },
    paneId: 'w1:p1',
    workspaceId: 'w1',
    permission: async () => ({ serverId: '47:1', enabled: true, targets: 'all' as const, autoApprove: true }),
    signal: new AbortController().signal,
  });
  const authority = await attempt.ready;
  assert.ok(authority);
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
  const herdr = {
    get: async () => current,
    read: async () => ({ pane_id: current.pane_id, source: 'detection', revision: 0, text, truncated: true }),
    sendKeys: async (pane: string, input: string[]) => {
      const saved = await store.approval(current.agent!, current.agent_session!.value);
      assert.equal(saved?.state, 'uncertain');
      keys.push([pane, input]);
    },
    prompt: async () => {
      throw new Error('permission UI must never receive a recovery prompt');
    },
  };
  const base: EventDeps & { autoApprove: boolean } = {
    herdr,
    store,
    autoApprove: true,
    targets: 'all',
    clock: { now: () => new Date(at) },
    decide: async (input) => {
      inputs.push(input);
      return assessStop(input, {
        thresholds: { risky: 0.6, choiceConfidence: 0.45 },
        now: new Date(at),
        evaluate: async () => evaluation(0.1, 0.9),
      });
    },
    handoff: async (reason) => {
      handoffs.push(reason);
    },
  };
  const deps = workflowEventDeps(base, authority, state);
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
    keys,
    inputs,
    handoffs,
    run,
    attempt,
    cleanup: async () => {
      attempt.close();
      await attempt.finish();
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

test('recognized permission reported done is approved only in global approval mode', async () => {
  const f = await fixture();
  try {
    f.changePane({ agent_status: 'done' });
    assert.equal((await observeStop(f.herdr, 'w1:p1'))?.status, 'done');
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    assert.ok(f.inputs.every((input) => input.status === 'blocked'));
    await f.run();
    assert.equal(f.keys.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('done permission menus remain default-off', async () => {
  const f = await fixture(false);
  try {
    f.changePane({ agent_status: 'done' });
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.deepEqual(f.inputs, []);
  } finally {
    await f.cleanup();
  }
});

test('done permission menus still require the existing risk policy', async () => {
  const f = await fixture();
  try {
    f.changePane({ agent_status: 'done' });
    f.setRisk(0.6);
    await f.run();
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.keys, []);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'human');
  } finally {
    await f.cleanup();
  }
});

test('done with error text retains recovery quarantine even with approval enabled', async () => {
  const f = await fixture();
  try {
    await f.store.record('w1:p1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'old-error',
      error_evidence_digest: 'old-digest',
      first_observed_at: at,
      attempt_count: 2,
      last_attempt_at: at,
      quota_check_count: 0,
      last_quota_check_at: null,
      next_check_at: at,
      last_delivery_state: 'none',
    });
    f.changePane({ agent_status: 'done' });
    f.changeText('API Error: connection timed out');
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.deepEqual(f.inputs, []);
    const history = await f.store.retry('w1:p1');
    assert.equal(history?.attempt_count, 2);
    assert.equal(history?.last_delivery_state, 'human');
    assert.equal(history?.next_check_at, null);
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

const agyUnzipMenu = `● Bash(unzip -l sentinel/android/app/build/outputs/apk/...) (ctrl+o to
expand)

Command
────────────────────────────────────────────────────────────────────────────

Requesting permission for:
   unzip -l
sentinel/android/app/build/outputs/apk/release/app-release-unsigned.ap
k

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with
'unzip'
  3. Yes, and always allow for commands that start with 'unzip' (Persist to
settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
🔧 TOOL ╱ Gemini 3.8 Flash (Medium)
ctx ░·············· 3.1% · tasks 0`;

test('AGY wrapped unzip permission menu is recognized', () => {
  const menu = approvalMenu(agyUnzipMenu);
  assert.ok(menu);
  assert.equal(menu.kind, 'approve_command');
  assert.match(menu.action, /unzip -l/);
});

test('AGY wrapped unzip permission menu can send only 1', async () => {
  const f = await fixture();
  try {
    // observeStop rejects excerpts over 12 lines; keep the wrapped choices.
    f.changeText(`Requesting permission for:
   unzip -l
sentinel/android/app/build/outputs/apk/release/app-release-unsigned.apk

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with
'unzip'
  3. Yes, and always allow for commands that start with 'unzip' (Persist to settings.json)
  4. No, cancel`);
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
  } finally {
    await f.cleanup();
  }
});

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

test('configured event entrypoint sends literal agent send-keys once through Herdr', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'steward-approval-entry-'));
  const socket = join(root, 'herdr.sock');
  const plugin = join(root, 'plugin');
  const state = join(root, 'state');
  await mkdir(plugin);
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(plugin, 'herdr-plugin.toml'), 'id = "agent-steward-recover"\n');
  const server = createServer((client) => {
    let data = '';
    client.on('data', async (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.split('\n')[0]!);
      const result =
        request.method === 'plugin.list'
          ? {
              type: 'plugin_list',
              plugins: [
                {
                  plugin_id: 'agent-steward-recover',
                  name: 'Agent Steward recover',
                  version: '0.1.0',
                  plugin_root: plugin,
                  manifest_path: join(plugin, 'herdr-plugin.toml'),
                  enabled: true,
                },
              ],
            }
          : request.method === 'agent.get'
            ? { type: 'agent_info', agent: await f.herdr.get() }
            : request.method === 'agent.read'
              ? { type: 'pane_read', read: await f.herdr.read() }
              : { type: 'agent_list', agents: await f.herdr.list() };
      client.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
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
      HERDR_PLUGIN_ID: 'agent-steward-recover',
      HERDR_PLUGIN_ROOT: plugin,
      HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_PLUGIN_STATE_DIR: state,
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await f.cleanup();
  }
});

test('changed partial menu with the same status stays human-only without a recovery schedule', async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    const decisions = f.inputs.length;
    f.changeText(partialMenu);
    await f.run();
    assert.equal(f.keys.length, 1);
    assert.equal(f.inputs.length, decisions);
    assert.equal(await f.store.retry('w1:p1'), null);
    assert.ok(f.handoffs.includes('human_review_required'));
  } finally {
    await f.cleanup();
  }
});

for (const status of ['idle', 'done'] as const) {
  test(`repeated default-off ${status} permission events cancel pending recovery once`, async () => {
    const f = await fixture(false);
    try {
      f.changePane({ agent_status: status });
      const observed = await observeStop(f.herdr, 'w1:p1');
      assert.ok(observed);
      await f.store.record('w1:p1', {
        pane_id: 'w1:p1',
        session_id: observed.session_id,
        failure_episode_id: observed.current_episode_id,
        error_evidence_digest: observed.error_evidence_digest,
        first_observed_at: at,
        attempt_count: 2,
        last_attempt_at: at,
        quota_check_count: 1,
        last_quota_check_at: at,
        next_check_at: '2026-10-03T12:05:00Z',
        last_delivery_state: 'none',
      });
      await f.run();
      await f.run();
      const history = await f.store.retry('w1:p1');
      assert.equal(history?.next_check_at, null);
      assert.equal(history?.attempt_count, 2);
      assert.equal(history?.quota_check_count, 1);
      assert.equal(history?.last_delivery_state, 'human');
      assert.equal(f.handoffs.length, 1);
      assert.deepEqual(f.keys, []);
      assert.equal(f.inputs.length, 0);
    } finally {
      await f.cleanup();
    }
  });
}

test('scoped status hook approves a complete menu without a global supervisor lease', async () => {
  const f = await scopedApproval();
  try {
    assert.equal(await f.store.active(), false);
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    assert.equal(f.inputs.length, 2);
    assert.equal((await f.store.approval('agy', 's1'))?.state, 'delivered');
    assert.deepEqual(f.handoffs, []);
    assert.equal(await f.store.retry('w1:p1'), null);
  } finally {
    await f.cleanup();
  }
});

test('captured authority pause after the first assessment sends zero keys', async () => {
  const f = await scopedApproval();
  try {
    const decide = f.deps.decide;
    f.deps.decide = async (input) => {
      const result = await decide(input);
      f.attempt.close();
      return result;
    };
    await f.run();
    assert.deepEqual(f.keys, []);
    assert.equal(f.inputs.length, 1);
    assert.notEqual((await f.store.approval('agy', 's1'))?.state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

test('fresh menu uses the shared approval lock without inheriting a recovery grant', async () => {
  const f = await scopedApproval();
  try {
    const observed = await observeStop(f.deps.herdr, 'w1:p1');
    assert.ok(observed);
    await f.store.recordSessionRetry('agy', 's1', {
      pane_id: 'w1:p1',
      session_id: 's1',
      failure_episode_id: 'a'.repeat(64),
      error_evidence_digest: 'b'.repeat(64),
      first_observed_at: at,
      attempt_count: 2,
      last_attempt_at: at,
      quota_check_count: 1,
      last_quota_check_at: at,
      next_check_at: '2026-10-03T12:05:00Z',
      last_delivery_state: 'none',
    });
    await f.run();
    assert.deepEqual(f.keys, [['w1:p1', ['1']]]);
    const history = await f.store.sessionRetry('agy', 's1');
    assert.equal(history?.attempt_count, 2);
    assert.equal(history?.quota_check_count, 1);
    assert.equal(history?.next_check_at, '2026-10-03T12:05:00Z');
    assert.equal(history?.last_delivery_state, 'none');
  } finally {
    await f.cleanup();
  }
});
