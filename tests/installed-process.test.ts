import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processRow } from './installed-process.ts';

function observerFailure(command: string): string {
  const previous = process.env.AGENT_STEWARD_PS;
  process.env.AGENT_STEWARD_PS = command;
  try {
    let failure: unknown;
    try {
      processRow(123);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error, 'failed native observation must remain fail-closed');
    return failure.message;
  } finally {
    if (previous === undefined) delete process.env.AGENT_STEWARD_PS;
    else process.env.AGENT_STEWARD_PS = previous;
  }
}

function diagnostic(message: string): Record<string, unknown> {
  const prefix = 'diagnostic=';
  const start = message.indexOf(prefix);
  assert.notEqual(start, -1, 'native observation failure must include bounded diagnostics');
  const end = message.indexOf('}', start);
  assert.notEqual(end, -1, 'native observation diagnostics must be complete JSON');
  return JSON.parse(message.slice(start + prefix.length, end + 1)) as Record<string, unknown>;
}

test('missing absolute process observer reports bounded spawn-error metadata without changing fail-closed behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-process-observer-'));
  try {
    const missing = join(root, 'a'.repeat(180), 'b'.repeat(180), 'missing-ps');
    const message = observerFailure(missing);
    const details = diagnostic(message);

    assert.ok(['undefined', 'null'].includes(String(details.statusKind)));
    assert.equal(details.errorCode, 'ENOENT');
    assert.ok(typeof details.errorPath === 'string');
    assert.ok(details.errorPath.length <= 128);
    assert.equal(details.stdoutBytes, 0);
    assert.equal(details.stderrBytes, 0);
    assert.ok(message.length <= 512, 'diagnostic must remain bounded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonzero native observer reports only bounded byte counts and never its output', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-process-observer-'));
  const stdoutMarker = 'OBSERVER_STDOUT_MUST_NOT_LEAK';
  const stderrMarker = 'OBSERVER_STDERR_MUST_NOT_LEAK';
  try {
    const helper = join(root, 'ps-stub');
    writeFileSync(
      helper,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdoutMarker)});\nprocess.stderr.write(${JSON.stringify(stderrMarker)});\nprocess.exitCode = 23;\n`,
      { mode: 0o700 },
    );
    const message = observerFailure(helper);
    const details = diagnostic(message);

    assert.equal(details.statusKind, 'number');
    assert.equal(details.signal, null);
    assert.equal(details.stdoutBytes, Buffer.byteLength(stdoutMarker));
    assert.equal(details.stderrBytes, Buffer.byteLength(stderrMarker));
    assert.doesNotMatch(message, /OBSERVER_STDOUT_MUST_NOT_LEAK|OBSERVER_STDERR_MUST_NOT_LEAK/);
    assert.ok(message.length <= 512, 'diagnostic must remain bounded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
