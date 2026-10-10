import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  observeStop,
  type AgentSnapshot,
  type ReadSnapshot,
  type HerdrReader,
  type ObservationRejection,
} from '../src/herdr-adapter/observe.ts';
import * as diagnostics from '../src/herdr-adapter/diagnostics.ts';

const pane: AgentSnapshot = {
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  agent_status: 'idle',
  agent_session: { agent: 'agy', kind: 'id', source: 'herdr:antigravity_cli', value: 'private-session' },
  revision: 10,
  state_change_seq: 20,
};
const read: ReadSnapshot = {
  pane_id: 'w1:p1',
  source: 'detection',
  revision: 3,
  text: 'private command excerpt',
  truncated: false,
  capture_lines: 12,
};
const reader = (
  before: AgentSnapshot | null = pane,
  after: AgentSnapshot | null = pane,
  captured: ReadSnapshot | null = read,
): HerdrReader => {
  let calls = 0;
  return {
    get: async () => (calls++ === 0 ? before : after),
    read: async () => captured,
    readFixed: async () => captured,
  };
};

// Dropping or mislabeling a guard's report must fail without weakening its null result.
for (const [name, before, after, phase, reason] of [
  ['missing before', null, pane, 'before', 'missing'],
  ['ineligible before', { ...pane, agent_status: 'working' }, pane, 'before', 'status_ineligible'],
  ['invalid before revision', { ...pane, revision: NaN }, pane, 'before', 'revision_invalid'],
  ['invalid before sequence', { ...pane, state_change_seq: NaN }, pane, 'before', 'sequence_invalid'],
  ['wrong before pane', { ...pane, pane_id: 'w1:p2' }, pane, 'before', 'pane_mismatch'],
  ['wrong before workspace', { ...pane, workspace_id: 'w2' }, pane, 'before', 'workspace_mismatch'],
  ['missing session', { ...pane, agent_session: null }, pane, 'before', 'session_invalid'],
  [
    'invalid session kind',
    { ...pane, agent_session: { ...pane.agent_session!, kind: '' } },
    pane,
    'before',
    'session_kind_invalid',
  ],
  [
    'invalid session source',
    { ...pane, agent_session: { ...pane.agent_session!, source: '' } },
    pane,
    'before',
    'session_source_invalid',
  ],
  [
    'invalid session value',
    { ...pane, agent_session: { ...pane.agent_session!, value: '' } },
    pane,
    'before',
    'session_value_invalid',
  ],
  ['invalid agent', { ...pane, agent: '' }, pane, 'before', 'agent_invalid'],
  [
    'mismatched session agent',
    { ...pane, agent_session: { ...pane.agent_session!, agent: 'pi' } },
    pane,
    'before',
    'session_agent_mismatch',
  ],
  ['missing after', pane, null, 'after', 'missing'],
  ['ineligible after', pane, { ...pane, agent_status: 'working' }, 'after', 'status_ineligible'],
  [
    'changed session',
    pane,
    { ...pane, agent_session: { ...pane.agent_session!, value: 'other-private-session' } },
    'after',
    'session_changed',
  ],
  [
    'changed agent',
    pane,
    { ...pane, agent: 'pi', agent_session: { ...pane.agent_session!, agent: 'pi' } },
    'after',
    'agent_changed',
  ],
  ['changed status', pane, { ...pane, agent_status: 'done' }, 'after', 'status_changed'],
  [
    'changed kind',
    pane,
    { ...pane, agent_session: { ...pane.agent_session!, kind: 'path' } },
    'after',
    'session_kind_changed',
  ],
  [
    'changed source',
    pane,
    { ...pane, agent_session: { ...pane.agent_session!, source: 'other' } },
    'after',
    'session_source_changed',
  ],
  ['changed revision', pane, { ...pane, revision: 11 }, 'after', 'revision_changed'],
  ['changed sequence', pane, { ...pane, state_change_seq: 21 }, 'after', 'sequence_changed'],
] as const) {
  test(`observation diagnostic identifies ${name} without metadata values`, async () => {
    const failures: ObservationRejection[] = [];
    assert.equal(
      await observeStop(reader(before, after), pane.pane_id, 12, (f) => {
        failures.push(f);
      }),
      null,
    );
    assert.deepEqual(failures, [{ phase, reason }]);
    assert.doesNotMatch(JSON.stringify(failures), /private|w1:p1|herdr:|20|21/);
  });
}

for (const [name, changes, reason] of [
  ['pane', { pane_id: 'w1:p2' }, 'pane_mismatch'],
  ['source', { source: 'recent' }, 'source_invalid'],
  ['revision', { revision: -1 }, 'revision_invalid'],
  ['truncated', { truncated: undefined }, 'truncated_invalid'],
  ['text type', { text: undefined }, 'text_invalid'],
  ['restriction', { context_restricted: false }, 'restriction_invalid'],
  ['capture annotation', { capture_lines: 49 }, 'capture_size_invalid'],
  ['blank text', { text: ' \n' }, 'text_blank'],
  ['actual lines', { text: 'x\n'.repeat(49) }, 'line_limit'],
  ['UTF8 bytes', { text: '🔧'.repeat(513) }, 'byte_limit'],
  ['credentials', { text: 'api_key=syntheticcredential12345678' }, 'credentials'],
  ['wrong capture size', { capture_lines: 16 }, 'capture_size_mismatch'],
] as const) {
  test(`read diagnostic identifies invalid ${name} without raw evidence`, async () => {
    const failures: ObservationRejection[] = [];
    const captured = { ...read, ...changes } as ReadSnapshot;
    assert.equal(
      await observeStop(reader(pane, pane, captured), pane.pane_id, 12, (f) => {
        failures.push(f);
      }),
      null,
    );
    assert.deepEqual(failures, [{ phase: 'read', reason }]);
    assert.doesNotMatch(JSON.stringify(failures), /synthetic|private|w1:p|🔧/);
  });
}

test('a missing fixed read has its own diagnostic and never falls back', async () => {
  const failures: ObservationRejection[] = [];
  assert.equal(
    await observeStop(reader(pane, pane, null), pane.pane_id, 12, (f) => {
      failures.push(f);
    }),
    null,
  );
  assert.deepEqual(failures, [{ phase: 'read', reason: 'missing' }]);
});

for (const [target, size, fixed, reason] of [
  ['invalid pane', 12, true, 'pane_invalid'],
  [pane.pane_id, 0, true, 'capture_size_invalid'],
  [pane.pane_id, 12, false, 'fixed_reader_missing'],
] as const) {
  test(`invalid observation request reports ${reason}`, async () => {
    const failures: ObservationRejection[] = [];
    const herdr = reader();
    if (!fixed) delete herdr.readFixed;
    assert.equal(
      await observeStop(herdr, target, size, (f) => {
        failures.push(f);
      }),
      null,
    );
    assert.deepEqual(failures, [{ phase: 'request', reason }]);
  });
}

for (const phase of ['before', 'read', 'after'] as const) {
  test(`failed ${phase} RPC reports phase and rethrows the original error despite throwing reporting`, async () => {
    const failure = new Error('secret raw transport payload');
    const failures: ObservationRejection[] = [];
    let gets = 0;
    const herdr = reader();
    herdr.get = async () => {
      if (phase === (gets++ === 0 ? 'before' : 'after')) throw failure;
      return pane;
    };
    herdr.readFixed = async () => {
      if (phase === 'read') throw failure;
      return read;
    };
    await assert.rejects(
      observeStop(herdr, pane.pane_id, 12, (f) => {
        failures.push(f);
        throw new Error('private diagnostic failure');
      }),
      (e) => e === failure,
    );
    assert.deepEqual(failures, [{ phase, reason: 'failed' }]);
    assert.doesNotMatch(JSON.stringify(failures), /secret|payload/);
  });
}

for (const mode of ['throws', 'rejects', 'stalls'] as const) {
  test(`a diagnostic sink that ${mode} cannot change an observation refusal`, async () => {
    let calls = 0;
    const sink = () => {
      calls++;
      if (mode === 'throws') throw new Error('private sink failure');
      return mode === 'rejects' ? Promise.reject(new Error('private sink failure')) : new Promise<void>(() => {});
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([
        observeStop(reader(null), pane.pane_id, 12, sink),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('diagnostic blocked observation')), 100);
        }),
      ]);
      assert.equal(observed, null);
      assert.equal(calls, 1);
    } finally {
      clearTimeout(timer);
    }
  });
}

test('diagnostics preserve the original RPC await boundaries during successful acquisition', async () => {
  let sequence = pane.state_change_seq;
  const herdr = reader();
  herdr.get = async () => ({ ...pane, state_change_seq: sequence });
  herdr.readFixed = async () => {
    queueMicrotask(() =>
      queueMicrotask(() => {
        sequence++;
      }),
    );
    return read;
  };
  const failures: ObservationRejection[] = [];
  const observed = await observeStop(herdr, pane.pane_id, 12, (f) => {
    failures.push(f);
  });
  assert.ok(observed);
  assert.equal(observed.state_change_seq, pane.state_change_seq);
  assert.equal(sequence, pane.state_change_seq + 1);
  assert.deepEqual(failures, []);
});

test('successful observations produce no rejection diagnostic', async () => {
  const failures: ObservationRejection[] = [];
  const observed = await observeStop(reader(), pane.pane_id, 12, (f) => {
    failures.push(f);
  });
  assert.equal(observed?.context, read.text);
  assert.deepEqual(failures, []);
});

const detail = {
  attempt_id: 'bf326bf4-d8fd-4dab-80f5-3e6eb22747de',
  checkpoint: 'after_assessment_1',
  purpose: 'revalidation',
  phase: 'after',
  reason: 'sequence_changed',
} as const;
test('plugin diagnostic output is bounded, correlated and contains only allowlisted fields', () => {
  const lines: string[] = [];
  diagnostics.writeApprovalObservationDiagnostic(detail, {}, (text) => {
    lines.push(text);
  });
  assert.equal(lines.length, 1);
  const output = lines[0]!;
  assert.match(output, /observation_rejected/);
  for (const value of Object.values(detail)) assert.ok(output.includes(value));
  assert.ok(Buffer.byteLength(output) < 256);
  assert.equal(output.split('\n').length, 2);
  assert.doesNotMatch(output, /w1:p1|private|herdr:|context|digest/);
});

for (const bad of [
  { ...detail, reason: 'raw command\nsecond line' },
  { ...detail, phase: 'secret value' },
  { ...detail, attempt_id: 'w1:p1' },
  { ...detail, checkpoint: 'raw error' },
  { ...detail, purpose: 'unknown' },
  { ...detail, context: 'private text' },
]) {
  test('plugin diagnostic drops unknown fields and values without reflecting them', () => {
    const lines: string[] = [];
    diagnostics.writeApprovalObservationDiagnostic(bad as typeof detail, {}, (text) => {
      lines.push(text);
    });
    assert.deepEqual(lines, []);
  });
}

for (const key of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'] as const) {
  test(`plugin diagnostic checks the configured ${key} even without evaluation`, () => {
    const lines: string[] = [];
    diagnostics.writeApprovalObservationDiagnostic(detail, { [key]: detail.attempt_id }, (text) => {
      lines.push(text);
    });
    assert.deepEqual(lines, []);
  });
}

for (const mode of ['throws', 'rejects', 'stalls'] as const) {
  test(`plugin output that ${mode} is diagnostic-only`, () => {
    let calls = 0;
    assert.equal(
      diagnostics.writeApprovalObservationDiagnostic(detail, {}, () => {
        calls++;
        if (mode === 'throws') throw new Error('private output failure');
        return mode === 'rejects' ? Promise.reject(new Error('private output failure')) : new Promise<void>(() => {});
      }),
      undefined,
    );
    assert.equal(calls, 1);
  });
}
