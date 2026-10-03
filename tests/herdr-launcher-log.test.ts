import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const main = new URL('../src/main.ts', import.meta.url).pathname;
const renderer = new URL('../src/herdr-launcher-log.ts', import.meta.url).pathname;
const failure = {
  request_id: 'failure-1',
  reason_code: 'invalid_config',
  diagnostics: { stage: 'config', kind: 'schema', config_fields: ['auto_approve'] },
};

async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

type LogRequest = {
  id: string;
  method: string;
  params: { plugin_id: string; action_id: string; context: { correlation_id: string; selected_text: string } };
};

async function route(
  plugin: string | undefined,
  reply: 'ok' | 'error' | 'close' | 'oversized' | 'timeout' | 'wrong-id' | 'wrong-action' | 'invalid-json' = 'ok',
  managed = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'steward-launcher-log-'));
  const socketPath = join(root, 'herdr.sock');
  const sockets = new Set<Socket>();
  const requests: LogRequest[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.split('\n')[0]!) as LogRequest;
      requests.push(request);
      if (reply === 'timeout') return;
      if (reply === 'close') {
        socket.end();
        return;
      }
      if (reply === 'oversized') {
        socket.end('x'.repeat(65_537));
        return;
      }
      if (reply === 'invalid-json') {
        socket.end('{private-invalid-json\n');
        return;
      }
      socket.end(
        JSON.stringify(
          reply === 'error'
            ? { id: request.id, error: { code: 'plugin_disabled', message: 'private-server-detail SyntheticKey333' } }
            : {
                id: reply === 'wrong-id' ? 'different-request' : request.id,
                result: {
                  type: 'plugin_action_invoked',
                  action: {
                    plugin_id: 'agent-steward-launcher',
                    action_id: reply === 'wrong-action' ? 'different-action' : 'log-failure',
                  },
                },
              },
        ) + '\n',
      );
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const config = join(root, 'config.json');
    await writeFile(
      config,
      JSON.stringify({ tools: [], candidates: [], auto_approve: 'private-config-value', SyntheticKey333: true }),
    );
    const env = {
      HOME: root,
      XDG_STATE_HOME: root,
      TYPESAFE_API_KEY: 'SyntheticKey333',
      HERDR_ENV: managed ? '1' : '0',
      HERDR_SOCKET_PATH: socketPath,
      ...(plugin === undefined ? {} : { HERDR_PLUGIN_ID: plugin }),
    };
    const started = performance.now();
    const result = await execute(
      main,
      ['--config', config, 'router', 'start', 'private-task', '--dry-run', '--json'],
      env,
    );
    return { ...result, requests, elapsed: performance.now() - started };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test('launcher failures invoke a logged action with only safe request diagnostics', async () => {
  const result = await route('agent-steward-launcher');
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0]!;
  assert.equal(request.method, 'plugin.action.invoke');
  assert.equal(request.params.plugin_id, 'agent-steward-launcher');
  assert.equal(request.params.action_id, 'log-failure');
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(request.params.context.selected_text), {
    ...failure,
    request_id: printed.request_id,
  });
  assert.equal(request.params.context.correlation_id, printed.request_id);
  assert.doesNotMatch(JSON.stringify(result.requests), /private-|SyntheticKey333|Bearer|message/);
  assert.equal(result.stderr, '');
});

test('ordinary CLI and other plugins do not invoke launcher logging', async () => {
  for (const [plugin, managed] of [
    [undefined, true],
    ['agent-steward-recover', true],
    ['agent-steward-launcher', false],
  ] as const) {
    const result = await route(plugin, 'ok', managed);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).reason_code, 'invalid_config');
    assert.deepEqual(result.requests, []);
    assert.equal(result.stderr, '');
  }
});

test('unavailable or malformed plugin logging preserves the original error and uses a fixed warning', async () => {
  for (const reply of ['error', 'close', 'oversized', 'timeout', 'wrong-id', 'wrong-action', 'invalid-json'] as const) {
    const result = await route('agent-steward-launcher', reply);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).reason_code, 'invalid_config');
    assert.equal(result.requests.length, 1);
    assert.equal(result.stderr, 'agent-steward: launcher_log_unavailable\n');
    assert.ok(result.elapsed < 4_000, `logging exceeded its deadline: ${reply}`);
    assert.doesNotMatch(result.stdout + result.stderr, /private-|SyntheticKey333/);
  }
});

test('logged action renders diagnostics without context, messages or terminal output', async () => {
  const result = await execute(renderer, [], {
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      selected_text: JSON.stringify(failure),
      workspace_label: 'private-label',
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), failure);
  assert.equal(result.stderr, '');
});

test('logged action rejects malformed, oversized and credential-bearing input without echo', async () => {
  for (const context of [
    '{private-invalid-json',
    JSON.stringify({}),
    JSON.stringify({ selected_text: JSON.stringify({ ...failure, message: 'private-prompt' }) }),
    JSON.stringify({
      selected_text: JSON.stringify({
        ...failure,
        diagnostics: { stage: 'config', config_fields: ['github_pat_abcdefghijklmnopqrstuvwxyz'] },
      }),
    }),
    JSON.stringify({ selected_text: 'x'.repeat(8_193) }),
    JSON.stringify({ selected_text: JSON.stringify({ ...failure, request_id: 'x'.repeat(129) }) }),
    JSON.stringify({ selected_text: JSON.stringify({ ...failure, request_id: 'private prompt text' }) }),
    JSON.stringify({
      selected_text: JSON.stringify({
        ...failure,
        diagnostics: { stage: 'config', config_fields: ['private prompt text'] },
      }),
    }),
    JSON.stringify({
      selected_text: JSON.stringify({ ...failure, diagnostics: { stage: 'evaluation', http_status: 'private-value' } }),
    }),
  ]) {
    const result = await execute(renderer, [], { HERDR_PLUGIN_CONTEXT_JSON: context });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'agent-steward-launcher: invalid_failure_diagnostic\n');
  }
});
