import { StewardError } from './contracts.ts';
import type { Candidate, PlannedCommand, ThinkingLevel, Tool } from './contracts.ts';

const PI_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const AGY_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const AGY_MODEL_LEVELS = new Map<string, readonly string[]>([
  ['gemini-3.8-flash', ['low', 'medium', 'high']],
  ['gemini-3.7-flash', ['low', 'medium', 'high']],
  ['gemini-3.6-flash', ['low', 'medium', 'high']],
  ['gemini-3.1-pro', ['low', 'high']],
]);
const ASCII_CONTROLS = /[\x00-\x1f\x7f]/;

function invalidConfig(): never {
  throw new StewardError('invalid_config');
}

function validateArgString(value: string, optionLike = false): void {
  if (value.trim().length === 0 || ASCII_CONTROLS.test(value) || (optionLike && value.startsWith('-'))) invalidConfig();
}

function validateLevel(tool: Tool, level: ThinkingLevel): void {
  validateArgString(level.id);
  if (level.id === 'default') return;
  if (tool === 'pi' && !PI_EFFORTS.has(level.id)) invalidConfig();
  if (tool === 'agy' && !AGY_EFFORTS.has(level.id)) invalidConfig();
}

export function validateCandidateSyntax(candidate: Candidate): void {
  validateArgString(candidate.model, true);
  validateArgString(candidate.provider, true);
  if (candidate.thinking_levels.length === 0) invalidConfig();
  for (const level of candidate.thinking_levels) {
    validateLevel(candidate.tool, level);
    if (candidate.tool === 'agy') agyArgs(candidate.model, level.id);
  }
}

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function effortArgs(tool: Tool, level: string): string[] {
  if (level === 'default') return [];
  switch (tool) {
    case 'codex':
      return ['-c', `model_reasoning_effort=${JSON.stringify(level)}`];
    case 'pi':
      return ['--thinking', level];
    case 'agy':
      return [`--effort=${level}`];
  }
}

function agyArgs(model: string, level: string): string[] {
  const levels = AGY_MODEL_LEVELS.get(model);
  if (levels === undefined) return [`--model=${model}`, ...effortArgs('agy', level)];
  if (!levels.includes(level)) invalidConfig();
  return [`--model=${model}-${level}`];
}

export function buildCommand(candidate: Candidate, level: string): PlannedCommand {
  validateCandidateSyntax(candidate);
  if (!candidate.thinking_levels.some((configured) => configured.id === level)) invalidConfig();

  const displayProvider = candidate.provider;
  let args: string[];
  let providerSelection: PlannedCommand['provider_selection'];
  switch (candidate.tool) {
    case 'codex':
      args = [
        '--model',
        candidate.model,
        '-c',
        `model_provider=${JSON.stringify(displayProvider)}`,
        ...effortArgs(candidate.tool, level),
      ];
      providerSelection = 'explicit_flag';
      break;
    case 'pi':
      args = ['--provider', displayProvider, '--model', candidate.model, ...effortArgs(candidate.tool, level)];
      providerSelection = 'explicit_flag';
      break;
    case 'agy':
      args = agyArgs(candidate.model, level);
      providerSelection = 'existing_settings';
      break;
  }

  const executable = candidate.tool;
  return {
    executable,
    args,
    display: [executable, ...args].map(shellQuote).join(' '),
    syntax_validated: true,
    runtime_selection: 'unverified',
    authentication: 'unverified',
    provider_selection: providerSelection,
  };
}
