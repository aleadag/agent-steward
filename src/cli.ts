import { StopInputSchema, StopResultSchema, StewardError, errorResult } from './contracts.ts';
import type { ErrorResult, Result, SelectedResult, StopInput, StopResult } from './contracts.ts';
import { loadConfig } from './config.ts';
import { validateCandidateSyntax } from './commands.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';
import { loadQuota } from './quota.ts';
import { assertNoCredentials } from './privacy.ts';
import { makeEvaluator } from './jev.ts';
import type { Evaluate, HttpPost, Questions } from './jev.ts';
import { route } from './routing.ts';
import { assessStop } from './triage.ts';
import { assertLiveTask, buildNativeLaunch } from './launch.ts';
import type { NativeLaunch } from './launch.ts';
import { appendEvent, readLedger, formatLedgerRecord } from './ledger.ts';
import type { LedgerEventKind } from './ledger.ts';

export type Invocation =
  | { kind: 'help' }
  | { kind: 'route'; config?: string; task: string; dryRun: boolean; json: boolean }
  | { kind: 'list'; limit: number; json: boolean }
  | { kind: 'show'; requestId: string; json: boolean }
  | { kind: 'stop'; config?: string };

export type Runtime = {
  env: { HOME?: string; XDG_CONFIG_HOME?: string; XDG_STATE_HOME?: string; TYPESAFE_API_KEY?: string };
  appendText: (path: string, text: string) => Promise<void>;
  readTextIfPresent: (path: string) => Promise<string | null>;
  mkdirp: (path: string, mode: number) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  cwd: string;
  readText: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  newRequestId: () => string;
  post: HttpPost;
  terminal: { stdin: boolean; stdout: boolean };
  launch: (command: NativeLaunch) => Promise<number>;
};

const HELP = `agent-steward - standalone task routing and stopped-agent decisions

Usage:
  agent-steward --help
  agent-steward [--config <path>] router start <task>
  agent-steward [--config <path>] router start <task> --dry-run [--json]
  agent-steward [--config <path>] router start --dry-run -- <task>
  agent-steward router list [--limit <n>]
  agent-steward router list --json
  agent-steward router show <request-id> [--json]
  agent-steward [--config <path>] stop check < stopped-state.json

Live router start requires terminal input and output and launches the selected native agent in the foreground.
Live starts do not support --json. Dry-run prints a route preview without launching; --json returns that preview as JSON.
The task is passed in argv and may appear briefly in local process listings; do not include secrets.
Provider, model, thinking level and account are requested, not verified; the CLI creates no workflow session id.
Native permission controls remain with the selected tool. The CLI does not invoke the optional Herdr wrapper.
Router list/show read local request history only, without config or Jev. List defaults to 20 records.
History never stores task text; exited means native-process return, not job success.
Stop check reads JSON from stdin and writes a version-2 JSON result.
`;

const DIAGNOSTICS: Record<string, string> = {
  quota_missing: 'agent-steward: quota_missing',
  quota_unreadable: 'agent-steward: quota_unreadable',
  quota_malformed: 'agent-steward: quota_malformed',
  quota_identity_mismatch: 'agent-steward: quota_identity_mismatch',
  quota_stale: 'agent-steward: quota_stale',
};

function invalidInput(): never {
  throw new StewardError('invalid_input');
}

export function parseArgs(argv: readonly string[]): Invocation {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const taskTail = separator < 0 ? [] : argv.slice(separator + 1);
  let config: string | undefined;
  let help = false;
  const commandTokens: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < options.length; index++) {
    const token = options[index]!;
    if (token === '--config') {
      if (seen.has(token)) invalidInput();
      seen.add(token);
      const value = options[++index];
      if (value === undefined || value.length === 0 || value.startsWith('--')) invalidInput();
      config = value;
    } else if (token === '--help' || token === '-h') {
      if (help) invalidInput();
      help = true;
    } else {
      commandTokens.push(token);
    }
  }

  if (commandTokens[0] === 'router' && (commandTokens[1] === 'list' || commandTokens[1] === 'show')) {
    if (config !== undefined || separator >= 0) invalidInput();
    const kind = commandTokens[1];
    let json = false;
    let limit = 20;
    let requestId: string | undefined;
    let hasLimit = false;
    for (let index = 2; index < commandTokens.length; index++) {
      const token = commandTokens[index]!;
      if (token === '--json') {
        if (json) invalidInput();
        json = true;
      } else if (kind === 'list' && token === '--limit') {
        if (hasLimit) invalidInput();
        hasLimit = true;
        const value = commandTokens[++index];
        if (value === undefined || !/^[1-9]\d*$/.test(value)) invalidInput();
        limit = Number(value);
        if (!Number.isSafeInteger(limit)) invalidInput();
      } else if (kind === 'show' && !token.startsWith('-') && token.trim() && requestId === undefined) {
        requestId = token;
      } else invalidInput();
    }
    if (help) return { kind: 'help' };
    if (kind === 'list') return { kind, limit, json };
    if (requestId === undefined) invalidInput();
    return { kind: 'show', requestId, json };
  }

  if (help) {
    if (commandTokens.length > 0) {
      if (commandTokens[0] === 'router' && commandTokens[1] === 'start') {
        const routeFlags = new Set<string>();
        for (const token of commandTokens.slice(2)) {
          if (token === '--dry-run' || token === '--json') {
            if (routeFlags.has(token)) invalidInput();
            routeFlags.add(token);
          } else if (token.startsWith('-')) invalidInput();
        }
      } else if (
        !(commandTokens[0] === 'stop' && commandTokens[1] === 'check' && commandTokens.length === 2 && separator < 0)
      )
        invalidInput();
    }
    return { kind: 'help' };
  }
  if (commandTokens[0] === 'stop' && commandTokens[1] === 'check') {
    if (commandTokens.length !== 2 || separator >= 0) invalidInput();
    return config === undefined ? { kind: 'stop' } : { kind: 'stop', config };
  }
  if (commandTokens[0] !== 'router' || commandTokens[1] !== 'start') invalidInput();

  let dryRun = false;
  let json = false;
  const taskParts: string[] = [];
  for (const token of commandTokens.slice(2)) {
    if (token === '--dry-run') {
      if (dryRun) invalidInput();
      dryRun = true;
    } else if (token === '--json') {
      if (json) invalidInput();
      json = true;
    } else if (token.startsWith('-')) {
      invalidInput();
    } else {
      taskParts.push(token);
    }
  }
  taskParts.push(...taskTail);
  if (taskParts.length !== 1 || taskParts[0]!.trim().length === 0) invalidInput();

  const invocation: Invocation = { kind: 'route', task: taskParts[0]!, dryRun, json };
  return config === undefined ? invocation : { ...invocation, config };
}

function readOptionalApiKey(runtime: Runtime): string {
  const value = runtime.env.TYPESAFE_API_KEY;
  return typeof value === 'string' ? value : '';
}

function safeRequestId(requestId: string | null, apiKey: string): string | null {
  if (requestId === null) return null;
  try {
    assertNoCredentials(requestId, apiKey);
    return requestId;
  } catch {
    return null;
  }
}

function safeError(error: unknown, requestId: string | null, apiKey: string): ErrorResult {
  const id = safeRequestId(requestId, apiKey);
  try {
    const result = errorResult(error, id);
    assertNoCredentials(result, apiKey);
    return result;
  } catch {
    return errorResult(new StewardError('credential_detected'), safeRequestId(id, apiKey));
  }
}

function safeStopError(error: unknown, requestId: string | null, apiKey: string): StopResult {
  const id = safeRequestId(requestId, apiKey);
  let result = { ...errorResult(error, id), schema_version: 2 as const };
  try {
    assertNoCredentials(result, apiKey);
  } catch {
    result = { ...errorResult(new StewardError('credential_detected'), safeRequestId(id, apiKey)), schema_version: 2 };
  }
  return result;
}

function emitJson(runtime: Runtime, value: Result | StopResult): void {
  runtime.stdout(`${JSON.stringify(value)}\n`);
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

function formatEvaluation(name: string, evaluation: SelectedResult['evaluations']['pair']): string[] {
  const answer = Object.values(evaluation.answers)[0];
  const lines = [
    `${name} evaluator model: ${jsonValue(evaluation.model)}`,
    `${name} input tokens: ${evaluation.usage.input_tokens ?? 'not reported'}`,
    `${name} output tokens: ${evaluation.usage.output_tokens ?? 'not reported'}`,
  ];
  if (answer?.type === 'choice') {
    lines.push(`${name} probabilities: ${jsonValue(answer.probabilities)}`);
    lines.push(`${name} confidence: ${answer.confidence}`);
  }
  return lines;
}

export function renderDecisionCard(result: SelectedResult): string {
  const { selected, quota, planned_command: command, evaluations } = result;
  const lines = [
    `request ID: ${jsonValue(result.request_id)}`,
    `decision: selected`,
    `tool: ${jsonValue(selected.tool)}`,
    `provider: ${jsonValue(selected.provider)}`,
    `model: ${jsonValue(selected.model)}`,
    `thinking level: ${jsonValue(selected.thinking_level)}`,
    `account: ${jsonValue(selected.account_id)}`,
    `quota source: ${jsonValue(quota.source)}`,
    `snapshot status: ${quota.snapshot_status}`,
    `pool: ${jsonValue(selected.quota_pool)}`,
    `account status: ${quota.account_status}`,
    `pool status: ${quota.pool_status}`,
  ];

  const accountWindows = quota.windows.filter((window) => window.scope.type === 'account');
  const poolWindows = quota.windows.filter((window) => window.scope.type === 'pool');
  const appendWindows = (label: string, windows: typeof quota.windows): void => {
    if (windows.length === 0) {
      lines.push(`${label} remaining: unknown`);
      lines.push(`${label} freshness: unknown`);
      return;
    }
    for (const window of windows) {
      const suffix = window.scope.type === 'pool' ? ` ${jsonValue(window.scope.pool_id)}` : '';
      lines.push(
        `${label}${suffix} remaining: ${window.status === 'known' ? `${window.remaining_percent}%` : 'unknown'}`,
      );
      lines.push(`${label}${suffix} reset at: ${jsonValue(window.reset_at)}`);
      lines.push(`${label}${suffix} observed at: ${jsonValue(window.observed_at)}`);
      lines.push(`${label}${suffix} valid until: ${jsonValue(window.valid_until)}`);
      lines.push(`${label}${suffix} freshness: ${window.status}${window.reason === null ? '' : ` (${window.reason})`}`);
    }
  };
  appendWindows('account', accountWindows);
  appendWindows('pool', poolWindows);

  lines.push(...formatEvaluation('pair', evaluations.pair));
  if ('kind' in evaluations.effort) {
    lines.push(`fixed thinking level: ${jsonValue(evaluations.effort.level)}`);
  } else {
    lines.push(...formatEvaluation('effort', evaluations.effort));
  }
  lines.push(`planned command: ${command.display}`);
  lines.push('runtime model/effort: unverified');
  lines.push(
    `authentication/account binding: unverified (${command.provider_selection === 'existing_settings' ? 'provider comes from existing settings' : 'provider selector is explicit'})`,
  );
  lines.push('The planned command is display-only; quoting does not authorize execution.');
  return `${lines.join('\n')}\n`;
}

function decisionExitCode(result: Result | StopResult): number {
  if (result.decision === 'stop_decision') {
    switch (result.proposed_action.kind) {
      case 'approve_request':
      case 'send_recovery_instruction':
      case 'wait_for_quota':
        return 0;
      case 'manual_review':
        return 2;
      case 'no_action':
        return 3;
    }
  }
  switch (result.decision) {
    case 'selected':
    case 'approve':
      return 0;
    case 'manual_review':
      return 2;
    case 'no_action':
      return 3;
    case 'error':
      return 1;
  }
}

function emitError(
  runtime: Runtime,
  error: unknown,
  requestId: string | null,
  apiKey: string,
  humanRoute: boolean,
): number {
  const result = safeError(error, requestId, apiKey);
  emitJson(runtime, result);
  if (humanRoute) runtime.stderr(`agent-steward: ${result.reason_code}\n`);
  return 1;
}

async function readStopInput(
  runtime: Runtime,
  onRequestId: (id: string | null) => void,
  apiKey: string,
): Promise<StopInput> {
  let contents: string;
  try {
    contents = await runtime.readStdin();
    assertByteLength(contents);
  } catch {
    throw new StewardError('invalid_input');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
    assertJsonDepth(raw);
  } catch {
    throw new StewardError('invalid_input');
  }

  let candidateId: string | null = null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).request_id;
    if (typeof value === 'string' && value.trim().length > 0) candidateId = value;
  }
  const requestId = safeRequestId(candidateId, apiKey);
  if (candidateId !== null && requestId === null) {
    onRequestId(null);
    throw new StewardError('credential_detected');
  }
  onRequestId(requestId);

  const parsed = StopInputSchema.safeParse(raw);
  if (!parsed.success) throw new StewardError('invalid_input');
  return parsed.data;
}

function assertRoutePreflight(config: Awaited<ReturnType<typeof loadConfig>>): void {
  const enabledTools = new Set(config.tools);
  const candidates = config.candidates.filter((candidate) => enabledTools.has(candidate.tool));
  if (candidates.length === 0 || candidates.length > 255) throw new StewardError('invalid_config');
  for (const candidate of candidates) validateCandidateSyntax(candidate);
}

export async function run(argv: readonly string[], runtime: Runtime): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseArgs(argv);
  } catch (error) {
    return emitError(runtime, error, null, readOptionalApiKey(runtime), false);
  }
  if (invocation.kind === 'help') {
    runtime.stdout(HELP);
    return 0;
  }

  if (invocation.kind === 'list' || invocation.kind === 'show') {
    try {
      const records = await readLedger(runtime);
      if (invocation.kind === 'list') {
        const listed = records.slice(0, invocation.limit);
        if (invocation.json) runtime.stdout(`${JSON.stringify(listed)}\n`);
        else if (listed.length > 0) runtime.stdout(listed.map(formatLedgerRecord).join(''));
      } else {
        const record = records.find((record) => record.request_id === invocation.requestId);
        if (record === undefined) {
          runtime.stderr('agent-steward: not_found\n');
          return 2;
        }
        runtime.stdout(invocation.json ? `${JSON.stringify(record)}\n` : `${JSON.stringify(record, null, 2)}\n`);
      }
      return 0;
    } catch (error) {
      return emitError(runtime, error, null, readOptionalApiKey(runtime), true);
    }
  }

  const apiKey = readOptionalApiKey(runtime);
  let requestId: string | null = null;
  if (invocation.kind === 'route') {
    try {
      const generated = runtime.newRequestId();
      requestId = safeRequestId(generated, apiKey);
      if (requestId === null) throw new StewardError('credential_detected');
    } catch (error) {
      return emitError(runtime, error, requestId, apiKey, !invocation.json);
    }
    if (!invocation.dryRun) {
      if (invocation.json) return emitError(runtime, new StewardError('invalid_input'), requestId, apiKey, false);
      if (!runtime.terminal.stdin || !runtime.terminal.stdout)
        return emitError(runtime, new StewardError('interactive_terminal_required'), requestId, apiKey, true);
      try {
        assertLiveTask(invocation.task);
      } catch (error) {
        return emitError(runtime, error, requestId, apiKey, true);
      }
    }
  }

  const recordEvent = async (event: LedgerEventKind, selected?: SelectedResult, exitCode?: number): Promise<void> => {
    if (requestId === null) return;
    await appendEvent(runtime, {
      schema_version: 1,
      request_id: requestId,
      recorded_at: runtime.now().toISOString(),
      event,
      ...(selected === undefined
        ? {}
        : {
            selected: {
              tool: selected.selected.tool,
              provider: selected.selected.provider,
              model: selected.selected.model,
              thinking_level: selected.selected.thinking_level,
              account_id: selected.selected.account_id,
            },
            usage: selected.evaluations.pair.usage,
          }),
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    });
  };
  let routeDecisionKnown = false;
  const humanRoute = invocation.kind === 'route' && !invocation.json;
  try {
    let stopInput: StopInput | undefined;
    if (invocation.kind === 'stop') {
      stopInput = await readStopInput(
        runtime,
        (id) => {
          requestId = id;
        },
        apiKey,
      );
    }

    const config = await loadConfig(invocation.config, {
      env: runtime.env,
      cwd: runtime.cwd,
      readText: runtime.readText,
    });

    let quota: Awaited<ReturnType<typeof loadQuota>> | undefined;
    if (invocation.kind === 'route') {
      assertRoutePreflight(config);
      quota = await loadQuota(config, {
        readText: runtime.readText,
        now: runtime.now(),
        diagnostic: (code) => runtime.stderr(`${DIAGNOSTICS[code] ?? 'agent-steward: quota_diagnostic'}\n`),
      });
    }

    let evaluator: ReturnType<typeof makeEvaluator> | undefined;
    const evaluate: Evaluate = async (state: unknown, questions: Questions) => {
      if (evaluator === undefined) {
        if (apiKey.trim().length === 0) throw new StewardError('missing_credentials');
        evaluator = makeEvaluator({ model: config.jev.model, apiKey, post: runtime.post });
      }
      return evaluator(state, questions);
    };

    let result: Result | StopResult;
    if (invocation.kind === 'route') {
      result = await route({ task: invocation.task, requestId: requestId!, config, quota: quota!, evaluate });
    } else {
      result = await assessStop(stopInput!, { thresholds: config.thresholds, evaluate, now: runtime.now() });
    }

    if (invocation.kind === 'stop') {
      let safeResult: StopResult;
      try {
        assertNoCredentials(result, apiKey);
        const parsed = StopResultSchema.safeParse(result);
        if (!parsed.success) throw new StewardError('invalid_response');
        safeResult = parsed.data;
      } catch (error) {
        const safeFailure =
          error instanceof StewardError && error.code === 'invalid_response'
            ? error
            : new StewardError('credential_detected');
        safeResult = safeStopError(safeFailure, requestId, apiKey);
      }
      emitJson(runtime, safeResult);
      return decisionExitCode(safeResult);
    }

    let safeResult: Result;
    try {
      assertNoCredentials(result, apiKey);
      safeResult = result as Result;
    } catch {
      safeResult = errorResult(new StewardError('credential_detected'), safeRequestId(requestId, apiKey));
    }
    try {
      assertNoCredentials(safeResult, apiKey);
    } catch {
      safeResult = errorResult(new StewardError('credential_detected'), null);
    }

    routeDecisionKnown = true;
    if (!invocation.dryRun && safeResult.decision === 'selected') {
      const command = buildNativeLaunch(safeResult.planned_command, invocation.task);
      const summary =
        `agent-steward: requested tool=${jsonValue(safeResult.selected.tool)}; ` +
        `provider requested/unverified: ${jsonValue(safeResult.selected.provider)}; ` +
        `model requested/unverified: ${jsonValue(safeResult.selected.model)}; ` +
        `thinking requested/unverified: ${jsonValue(safeResult.selected.thinking_level)}; ` +
        `account requested/unverified: ${jsonValue(safeResult.selected.account_id)}\n`;
      assertNoCredentials(summary, apiKey);
      runtime.stderr(summary);
      await recordEvent('launched', safeResult);
      let exitCode: number;
      try {
        exitCode = await runtime.launch(command);
      } catch {
        await recordEvent('launch-failed');
        return emitError(runtime, new StewardError('launch_failed'), requestId, apiKey, true);
      }
      await recordEvent('exited', undefined, exitCode);
      return exitCode;
    }
    if (safeResult.decision === 'selected') await recordEvent('dry-run', safeResult);
    else if (safeResult.decision === 'error') await recordEvent('evaluation_failed');
    if (safeResult.decision === 'selected' && !invocation.json) {
      runtime.stdout(renderDecisionCard(safeResult));
    } else {
      emitJson(runtime, safeResult);
      if (safeResult.decision === 'error' && humanRoute) runtime.stderr(`agent-steward: ${safeResult.reason_code}\n`);
    }
    return decisionExitCode(safeResult);
  } catch (error) {
    if (invocation.kind === 'stop') {
      emitJson(runtime, safeStopError(error, requestId, apiKey));
      return 1;
    }
    try {
      if (!routeDecisionKnown) await recordEvent('evaluation_failed');
    } catch (ledgerError) {
      return emitError(runtime, ledgerError, requestId, apiKey, humanRoute);
    }
    return emitError(runtime, error, requestId, apiKey, humanRoute);
  }
}
