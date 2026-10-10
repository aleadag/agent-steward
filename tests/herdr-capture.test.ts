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
  get = () => pane,
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
          ? { type: 'agent_info', agent: get() }
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

test('fixed rechecks use their saved size rather than the adaptive reader', async () => {
  const sizes: number[] = [];
  const observed = await observeStop(
    {
      get: async () => pane,
      read: async () => ({
        pane_id: pane.pane_id,
        source: 'detection',
        revision: 0,
        text: 'different adaptive excerpt',
        truncated: true,
      }),
      readFixed: async (_pane: string, lines: number) => {
        sizes.push(lines);
        return {
          pane_id: pane.pane_id,
          source: 'detection',
          revision: 0,
          text: 'assessed excerpt\n',
          truncated: true,
          capture_lines: lines,
        };
      },
    },
    pane.pane_id,
    24,
  );
  assert.equal(observed?.context, 'assessed excerpt\n');
  assert.deepEqual(sizes, [24]);
});

for (const size of [0, -1, 49, 1.5, NaN]) {
  test(`fixed recheck rejects invalid capture size ${size}`, async () => {
    const observed = await observeStop(
      {
        get: async () => pane,
        read: async () => ({
          pane_id: pane.pane_id,
          source: 'detection',
          revision: 0,
          text: 'assessed excerpt',
          truncated: true,
        }),
      },
      pane.pane_id,
      size,
    );
    assert.equal(observed, null);
  });
}

test('fixed recheck refuses a reader without the fixed-size capability', async () => {
  const observed = await observeStop(
    {
      get: async () => pane,
      read: async () => ({
        pane_id: pane.pane_id,
        source: 'detection',
        revision: 0,
        text: 'assessed excerpt',
        truncated: true,
      }),
    },
    pane.pane_id,
    24,
  );
  assert.equal(observed, null);
});

for (const [name, changes] of [
  ['different capture size', { capture_lines: 16 }],
  ['invalid local capture size', { capture_lines: 0 }],
  ['wrong source', { source: 'recent' }],
  ['oversized text', { text: 'x'.repeat(2049) }],
  ['too many actual lines', { text: 'x\n'.repeat(49) }],
  ['credentials', { text: 'api_key=pretendcredential12345678' }],
] as const) {
  test(`fixed recheck rejects ${name}`, async () => {
    const observed = await observeStop(
      {
        get: async () => pane,
        read: async () => null,
        readFixed: async () =>
          Object.assign(
            {
              pane_id: pane.pane_id,
              source: 'detection',
              revision: 0,
              text: 'assessed excerpt',
              truncated: true,
              capture_lines: 24,
            },
            changes,
          ),
      },
      pane.pane_id,
      24,
    );
    assert.equal(observed, null);
  });
}

test('peer capture-size annotations cannot choose the local recheck size', async () => {
  const { observed } = await capture(shortMenu, (read) => ({ ...read, capture_lines: 48 }));
  assert.equal(observed?.capture_lines, 12);
});

const ordinary = Array.from({ length: 48 }, (_, i) => `Ordinary output ${i}`).join('\n');
const initial = ordinary.split('\n').slice(-12).join('\n');

const shortMenu = 'Requesting permission for:\nprintf probe\nRun this command?\n> 1. Yes, run command\n2. No, cancel';

const nixMenu = `Requesting permission for:

NODE=/nix/store/bfqsxlviikq7vlp36kasy5hhamlxlkd2-nodejs-slim-24.19.0
/bin/node

/nix/store/4igdp92hi4zdyxxg3wx5hiv4m2m6i3am-determinate-nix-3.22.3/b
in/nix
develop --offline --option substitute false --option max-jobs 0
--command \\
     "$NODE" node_modules/vitest/vitest.mjs run --exclude
'**/.internal/**' \\
     infra/supabase/tests/private-test-toolchain.test.mjs
--maxWorkers=1

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start
with '/nix/store/4igdp92hi4zdyxxg3wx5hiv4m2m6i3am-determinate-nix-
3.22.3/bin/nix'
  3. Yes, and always allow for commands that start with
'/nix/store/4igdp92hi4zdyxxg3wx5hiv4m2m6i3am-determinate-nix-
3.22.3/bin/nix' (Persist to settings.json)
  4. No, cancel`;

// The menu itself fits both bounds. Skipping its exact row boundary can
// prepend unrelated history and prevent the strict parser from recognizing it.
for (const [name, history] of [
  ['no history (control)', ''],
  ['one older output line', 'Earlier unrelated output\n'],
  ['oversized older output', ('Earlier unrelated output: ' + 'x'.repeat(200) + '\n').repeat(12)],
] as const) {
  for (const footer of ['', '\n\n↑/↓ Navigate · tab Amend\nTOOL ╱ test']) {
    test(`wrapped Nix menu is captured with ${name} and ${footer ? 'a footer' : 'no footer'}`, async () => {
      const expected = nixMenu + footer;
      assert.equal(approvalMenu(expected)?.kind, 'approve_command');
      const { observed, reads } = await capture(history + expected);
      assert.ok(observed);
      assert.ok(observed.context.includes('Requesting permission for:'));
      assert.ok(observed.context.endsWith(expected));
      assert.ok(Buffer.byteLength(observed.context, 'utf8') <= 2048);
      if (!history) assert.equal(observed.context, expected);
      if (name === 'one older output line') assert.equal(observed.context, history + expected);
      if (name === 'oversized older output' && footer) assert.equal(observed.context_restricted, true);
      assert.equal(new Set(reads).size, reads.length);
      assert.ok(reads.length <= 37 && reads.every((n) => n >= 12 && n <= 48));
    });
  }
}

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

for (const screen of [
  nixMenu.replace('Run this command?', 'Run with displayed options?'),
  nixMenu.replace('  4. No, cancel', '  4. No, cancel\n  5. Unknown control'),
  nixMenu.replace('NODE=', 'Requesting permission for:\nNODE='),
]) {
  test('main capture retains evidence with unrecognized menu grammar', async () => {
    assert.equal(approvalMenu(screen), null);
    const { observed } = await capture(screen);
    assert.equal(observed?.context, screen);
  });
}

test('supporting cues wait for header and retain the coarse prefix', async () => {
  const { observed, reads } = await capture('Earlier output\n' + nixMenu);
  assert.equal(observed?.context, 'Earlier output\n' + nixMenu);
  assert.deepEqual(reads, [12, 16, 24]);
});

test('weak cues select bounded evidence at exhaustion without forcing human-only provenance', async () => {
  const screen = 'Run this command?\n' + ordinary;
  const { observed } = await capture(screen.slice(screen.indexOf('\n') + 1) + '\n1. Yes, run command');
  assert.ok(observed?.context.startsWith('Ordinary output 1\n'));
  assert.equal(observed?.context_restricted, undefined);
});

const largeScreen =
  ('Earlier output: ' + 'x'.repeat(200) + '\n').repeat(12) + nixMenu + '\n\n↑/↓ Navigate · tab Amend\nTOOL ╱ test';

for (const change of [
  () => null,
  (read: ReadSnapshot) => ({ ...read, source: 'recent' }),
  (read: ReadSnapshot) => ({ ...read, pane_id: 'w1:p2' }),
  (read: ReadSnapshot) => ({ ...read, revision: 1 }),
  (read: ReadSnapshot) => ({ ...read, text: read.text + '\nchanged' }),
  (read: ReadSnapshot) => ({ ...read, text: 'api_key=supersecretvalue1234\n' + read.text }),
  (read: ReadSnapshot) => ({ ...read, text: '\n'.repeat(49) + read.text }),
  (read: ReadSnapshot) => ({ ...read, text: largeScreen.split('\n').slice(-13).join('\n') }),
]) {
  test('invalid intermediate acquisition rejects earlier bounded evidence', async () => {
    const { observed, reads } = await capture(largeScreen, (read, lines) => (lines === 25 ? change(read) : read));
    assert.ok(reads.includes(25));
    assert.equal(observed, null);
  });
}

test('remote extra fields cannot clear the local omission restriction', async () => {
  const { observed } = await capture(
    largeScreen,
    (read) => ({ ...read, context_restricted: false }) as unknown as ReadSnapshot,
  );
  assert.equal(observed?.context_restricted, true);
  assert.ok(observed?.context.includes('Requesting permission for:'));
});

test('weak oversized evidence stays restricted and caps unique probes', async () => {
  const screen = 'x'.repeat(2048) + '\n' + ordinary.split('\n').slice(2).join('\n') + '\n1. Yes, run command';
  const { observed, reads } = await capture(screen);
  assert.equal(observed?.context_restricted, true);
  assert.equal(reads.length, 37);
  assert.equal(new Set(reads).size, 37);
  assert.equal(observed?.context.split('\n').length, 47);
});

for (const flag of [false, 'true', null, 1]) {
  test('invalid internal omission metadata rejects observation', async () => {
    const observed = await observeStop(
      {
        get: async () => pane,
        read: async () =>
          ({
            pane_id: pane.pane_id,
            source: 'detection',
            revision: 0,
            text: shortMenu,
            truncated: false,
            context_restricted: flag,
          }) as unknown as ReadSnapshot,
      },
      pane.pane_id,
    );
    assert.equal(observed, null);
  });
}

test('configured key in intermediate evidence rejects the entire capture', async () => {
  const old = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'synthetic-capture-comparison';
  try {
    const { observed } = await capture(largeScreen, (read, lines) =>
      lines === 25 ? { ...read, text: 'synthetic-capture-comparison\n' + read.text } : read,
    );
    assert.equal(observed, null);
  } finally {
    if (old === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = old;
  }
});

test('multibyte oversized context is independently reacquired and restricted', async () => {
  const screen = largeScreen.replaceAll('x', 'é');
  const { observed } = await capture(screen);
  assert.equal(observed?.context_restricted, true);
  assert.ok(Buffer.byteLength(observed!.context, 'utf8') <= 2048);
  assert.ok(observed?.context.endsWith('\nTOOL ╱ test'));
});

test('actor change during intermediate acquisition rejects the selected evidence', async () => {
  let current = pane;
  const { observed } = await capture(
    largeScreen,
    (read, lines) => {
      if (lines === 25) current = { ...pane, state_change_seq: 2 };
      return read;
    },
    () => current,
  );
  assert.equal(observed, null);
});

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
