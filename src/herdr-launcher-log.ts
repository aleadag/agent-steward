import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { ErrorResultSchema } from './contracts.ts';
import type { ErrorResult } from './contracts.ts';
import { assertJsonDepth } from './limits.ts';
import { assertNoCredentials } from './privacy.ts';

const FailureLogSchema = ErrorResultSchema.pick({ request_id: true, reason_code: true, diagnostics: true }).extend({
  request_id: ErrorResultSchema.shape.request_id.refine(
    (value) => value === null || /^[A-Za-z0-9._:-]{1,128}$/.test(value),
  ),
});

function failureText(value: unknown, apiKey: string): string {
  assertJsonDepth(value);
  const failure = FailureLogSchema.parse(value);
  if (
    failure.diagnostics?.config_fields?.some(
      (field) => !/^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+))*$/.test(field),
    )
  )
    throw new Error('invalid_failure_diagnostic');
  assertNoCredentials(failure, apiKey);
  const text = JSON.stringify(failure);
  if (Buffer.byteLength(text) > 8_192) throw new Error('invalid_failure_diagnostic');
  return text;
}

export async function publishLauncherFailure(socketPath: string, failure: ErrorResult, apiKey: string): Promise<void> {
  const selectedText = failureText(
    {
      request_id: failure.request_id,
      reason_code: failure.reason_code,
      ...(failure.diagnostics === undefined ? {} : { diagnostics: failure.diagnostics }),
    },
    apiKey,
  );
  const id = randomUUID();
  const request = JSON.stringify({
    id,
    method: 'plugin.action.invoke',
    params: {
      plugin_id: 'agent-steward-launcher',
      action_id: 'log-failure',
      context: { correlation_id: failure.request_id ?? id, selected_text: selectedText },
    },
  });
  assertNoCredentials(request, apiKey);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath);
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (success = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (success) resolve();
      else reject(new Error('launcher_log_unavailable'));
    };
    const deadline = setTimeout(finish, 2_000);
    socket.once('connect', () => socket.write(`${request}\n`));
    socket.once('error', () => finish());
    socket.once('end', () => finish());
    socket.on('data', (chunk: Buffer) => {
      if (data.length + chunk.length > 65_536) {
        finish();
        return;
      }
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(data.subarray(0, end).toString('utf8'));
        finish(
          response.id === id &&
            !response.error &&
            response.result?.type === 'plugin_action_invoked' &&
            response.result.action?.plugin_id === 'agent-steward-launcher' &&
            response.result.action?.action_id === 'log-failure',
        );
      } catch {
        finish();
      }
    });
  });
}

export function renderLauncherFailure(context: string, apiKey = ''): string {
  if (Buffer.byteLength(context) > 65_536) throw new Error('invalid_failure_diagnostic');
  const parsed: unknown = JSON.parse(context);
  assertJsonDepth(parsed);
  const selectedText = (parsed as { selected_text?: unknown } | null)?.selected_text;
  if (typeof selectedText !== 'string' || Buffer.byteLength(selectedText) > 8_192)
    throw new Error('invalid_failure_diagnostic');
  return `${failureText(JSON.parse(selectedText), apiKey)}\n`;
}

if (import.meta.main) {
  try {
    process.stdout.write(
      renderLauncherFailure(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '', process.env.TYPESAFE_API_KEY),
    );
  } catch {
    process.stderr.write('agent-steward-launcher: invalid_failure_diagnostic\n');
    process.exitCode = 1;
  }
}
