import { pathToFileURL } from 'node:url';
const packageRoot = process.env.STEWARD_FAKE_AGY_PACKAGE;
const moduleUrl = (name: string) =>
  packageRoot
    ? pathToFileURL(`${packageRoot}/lib/agent-steward/dist/src/${name}.js`).href
    : new URL(`../src/${name}.ts`, import.meta.url).href;
const { runAgyHook } = await import(moduleUrl('agy-hook'));
const { sendAgyCapture } = await import(moduleUrl('agy-runtime'));
const { parseAgyManifest } = await import(moduleUrl('agy-setup'));
const { readFileText } = await import(moduleUrl('io'));
import { join, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
const scenario = process.env.STEWARD_FAKE_AGY_CASE ?? 'success';
let pending = '',
  submitted = false;
function agyQuota() {
  return Object.fromEntries(
    ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly']
      .filter((key) => scenario !== 'incomplete' || key !== '3p-weekly')
      .map((key) => [
        key,
        { remaining_fraction: submitted ? 0.5 : 0.99, reset_time: new Date(Date.now() + 86400000).toISOString() },
      ]),
  );
}
if (scenario === 'renew') {
  const auth = join(process.env.HOME!, '.gemini/antigravity-cli/antigravity-oauth-token');
  const value = await Bun.file(auth).json();
  value.token.expiry = '2050-01-01T00:00:00Z';
  await Bun.write(auth, JSON.stringify(value));
}
if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.slice(2).some((a) => a !== '--log-file=/dev/null'))
  process.exit(91);
process.stdin.setRawMode(true);
const socketPath = process.env.AGENT_STEWARD_AGY_CAPTURE_SOCKET!,
  requestId = process.env.AGENT_STEWARD_AGY_CAPTURE_REQUEST_ID!;
if (process.env.STEWARD_FAKE_AGY_OBSERVER)
  await Bun.write(
    process.env.STEWARD_FAKE_AGY_OBSERVER,
    JSON.stringify({
      socketPath,
      socketMode: (await stat(socketPath)).mode & 0o777,
      directoryMode: (await stat(dirname(socketPath))).mode & 0o777,
      pid: process.pid,
      cwd: process.cwd(),
      evaluatorKeyPresent: !!process.env.TYPESAFE_API_KEY,
      updatesDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE === '1',
    }),
  );
async function capture() {
  const input = JSON.stringify({ quota: agyQuota(), email: 'synthetic-native-secret' });
  if (process.env.STEWARD_FAKE_AGY_HOOK) {
    const command = JSON.parse(process.env.STEWARD_FAKE_AGY_HOOK) as string[];
    const child = Bun.spawn([...command, 'quota', 'hook', 'agy'], {
      env: process.env,
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    await child.exited;
  } else
    await runAgyHook(input, {
      now: () => new Date(),
      captureRequest: { socketPath, requestId: scenario === 'wrong' ? 'wrong-request' : requestId },
      sendCapture: sendAgyCapture,
      readManifest: async () =>
        parseAgyManifest(
          await readFileText(
            join(
              process.env.XDG_STATE_HOME || join(process.env.HOME!, '.local/state'),
              'agent-steward/agy/statusline.json',
            ),
          ),
        ),
      runRenderer: async () => ({ stdout: '', exitCode: 0 }),
    });
}
if (scenario === 'trust') console.log('Do you trust the contents of this project?');
else if (scenario === 'auth') console.log('Select login method:');
else if (scenario === 'overflow') process.stdout.write('x'.repeat(1048577));
else if (scenario === 'early') process.exit(0);
else if (scenario === 'timeout') console.log('loading');
else {
  await capture();
  process.stdout.write('\x1b[6');
  await Bun.sleep(5);
  process.stdout.write('n');
  console.log('\n> Accept-edits mode: file edits auto-approved\n');
}
for await (const bytes of process.stdin) {
  pending += Buffer.from(bytes).toString();
  // eslint-disable-next-line no-control-regex -- Simulated terminal cursor replies.
  pending = pending.replace(/\x1b\[\d+;\d+R/g, '');
  if (!submitted && pending === '/usage') {
    console.log(scenario === 'unknown' ? '\n/usage unknown command' : '\n> /usage  View model quota usage');
  }
  if (!submitted && pending === '/usage\r') {
    submitted = true;
    if (scenario === 'error') console.log('Failed to refresh quota');
    else {
      await Bun.sleep(10);
      console.log('\n└ Models & Quota\nGEMINI MODELS\nCLAUDE AND GPT MODELS\nesc Close\n');
      if (scenario === 'ipc-overflow') {
        const socket = createConnection(socketPath);
        socket.on('error', () => {});
        socket.on('connect', () => socket.end('x'.repeat(1048577)));
      } else if (scenario === 'malformed')
        await sendAgyCapture(
          { socketPath, requestId },
          { requestId, observedAt: new Date().toISOString(), quota: { 'gemini-5h': { remaining_fraction: 2 } } },
        );
      else await capture();
      if (scenario === 'wrong') process.exit(0);
    }
  }
  if (pending === '/usage\r\x1b') process.exit(0);
  if (pending.includes('\r') && !['/usage\r', '/usage\r\x1b'].includes(pending)) process.exit(92);
}
