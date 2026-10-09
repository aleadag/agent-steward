import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketReader } from '../src/herdr-adapter/entry.ts';
import { observeStop, type ReadSnapshot } from '../src/herdr-adapter/observe.ts';
import { approvalMenu } from '../src/herdr-adapter/best-effort-approval.ts';

const pane = {
  pane_id: 'w1:p1',
  workspace_id: 'w1',
  agent: 'agy',
  agent_status: 'idle',
  agent_session: { agent: 'agy', source: 'test', kind: 'id', value: 's1' },
  revision: 1,
  state_change_seq: 1,
};

async function capture(
  screen: string,
  change: (read: ReadSnapshot, lines: number) => ReadSnapshot | null = (read) => read,
) {
  const directory = await mkdtemp(join(tmpdir(), 'steward-capture-'));
  const path = join(directory, 'herdr.sock');
  const reads: number[] = [];
  const server = createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      const { id, method, params } = JSON.parse(data.slice(0, data.indexOf('\n')));
      assert.ok(method === 'agent.get' || method === 'agent.read');
      if (method === 'agent.read') reads.push(params.lines);
      const result =
        method === 'agent.get'
          ? { type: 'agent_info', agent: pane }
          : {
              type: 'pane_read',
              read: change(
                {
                  pane_id: pane.pane_id,
                  source: 'detection',
                  revision: 0,
                  text: screen.split('\n').slice(-params.lines).join('\n'),
                  truncated: screen.split('\n').length > params.lines,
                },
                params.lines,
              ),
            };
      socket.end(JSON.stringify({ id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    return { observed: await observeStop(socketReader(path), pane.pane_id), reads };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

const ordinary = Array.from({ length: 48 }, (_, i) => `Ordinary output ${i}`).join('\n');
const initial = ordinary.split('\n').slice(-12).join('\n');

const shortMenu = 'Requesting permission for:\nprintf probe\nRun this command?\n> 1. Yes, run command\n2. No, cancel';

for (const footer of ['', '\n↑/↓ Navigate · tab Amend', '\n↑/↓ Navigate · tab Amend\n🔧 TOOL ╱ test\nctx test']) {
  for (const wraps of [0, 3, 12, 18]) {
    test(`capture recognizes a complete menu with ${wraps} option wraps and ${footer.split('\n').length - 1} footer rows`, async () => {
      const screen =
        shortMenu.replace('2. No, cancel', '2. Yes, and always allow\n' + 'wrapped\n'.repeat(wraps) + '3. No, cancel') +
        footer;
      const { observed, reads } = await capture(screen);
      assert.ok(observed);
      assert.equal(observed.context, screen);
      assert.deepEqual(approvalMenu(observed.context), { action: 'printf probe', kind: 'approve_command' });
      assert.ok(reads.every((lines) => lines <= 48));
    });
  }
}

test('ordinary classification retains the initial short excerpt after bounded menu probing', async () => {
  const { observed, reads } = await capture(ordinary);
  assert.ok(observed);
  assert.equal(observed.context, initial);
  assert.deepEqual(reads, [12, 16, 24, 48]);
});

test('an exhausted short snapshot is not probed again', async () => {
  const { observed, reads } = await capture('Ordinary output');
  assert.equal(observed?.context, 'Ordinary output');
  assert.deepEqual(reads, [12]);
});

test('unchanged text stops probing even if Herdr marks older history truncated', async () => {
  const { observed, reads } = await capture('Ordinary output', (read) => ({ ...read, truncated: true }));
  assert.equal(observed?.context, 'Ordinary output');
  assert.deepEqual(reads, [12, 16]);
});

test('a coherent oversized probe cannot replace the bounded ordinary excerpt', async () => {
  const { observed, reads } = await capture('x'.repeat(2048) + '\n' + initial);
  assert.equal(observed?.context, initial);
  assert.deepEqual(reads, [12, 16]);
});

test('credentials in an oversized probe reject the whole observation rather than fall back', async () => {
  const { observed, reads } = await capture('api_key=supersecretvalue1234' + 'x'.repeat(2048) + '\n' + initial);
  assert.equal(observed, null);
  assert.deepEqual(reads, [12, 16]);
});

for (const [name, change] of [
  ['missing expanded snapshot', () => null],
  ['malformed source', (read: ReadSnapshot) => ({ ...read, source: 'recent' })],
  ['changed read revision', (read: ReadSnapshot) => ({ ...read, revision: 1 })],
  ['changed screen suffix', (read: ReadSnapshot) => ({ ...read, text: read.text + '\nchanged' })],
  [
    'credential in discarded context',
    (read: ReadSnapshot) => ({ ...read, text: 'api_key=supersecretvalue1234\n' + read.text }),
  ],
  ['too many actual lines', (read: ReadSnapshot) => ({ ...read, text: '\n'.repeat(49) + read.text })],
] as const) {
  test(`${name} rejects capture without reusing the earlier excerpt`, async () => {
    const { observed, reads } = await capture(ordinary, (read, lines) => (lines === 16 ? change(read) : read));
    assert.equal(observed, null);
    assert.deepEqual(reads, [12, 16]);
  });
}
