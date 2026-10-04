import { loadConfig } from './config.ts';
import { validateCandidateSyntax } from './commands.ts';
import { StewardError } from './contracts.ts';
import type { Config } from './contracts.ts';
import { isSafeSearchPath } from './process.ts';

export type DoctorIO = Parameters<typeof loadConfig>[1] & {
  env: Parameters<typeof loadConfig>[1]['env'] & { PATH?: string };
  executableAvailable?: (tool: Config['tools'][number], path: string) => boolean;
};

type Check = {
  id: string;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
  fix?: string;
  kind?: 'read' | 'json' | 'schema';
  fields?: string[];
};

export async function diagnose(override: string | undefined, io: DoctorIO) {
  const checks: Check[] = [];
  let config: Config | undefined;
  try {
    const loaded = await loadConfig(override, io);
    const candidates = loaded.candidates.filter((candidate) => loaded.tools.includes(candidate.tool));
    if (candidates.length === 0 || candidates.length > 255)
      throw new StewardError('invalid_config', { stage: 'config', kind: 'schema' });
    for (const candidate of candidates) {
      try {
        validateCandidateSyntax(candidate);
      } catch {
        throw new StewardError('invalid_config', { stage: 'config', kind: 'schema' });
      }
    }
    config = loaded;
    checks.push({ id: 'config', status: 'pass', message: 'Configuration and enabled candidate syntax are valid.' });
  } catch (error) {
    const kind = error instanceof StewardError ? error.diagnostics?.kind : undefined;
    const fields = error instanceof StewardError ? error.diagnostics?.config_fields : undefined;
    const details = {
      read: ['Configuration could not be read.', 'Create a readable config file or select one with --config.'],
      json: ['Configuration is not valid bounded JSON.', 'Correct the config JSON and keep it within input limits.'],
      schema: [
        'Configuration fields or enabled candidates are invalid.',
        'Correct the config fields and enabled candidate syntax; see examples/config.json.',
      ],
    } as const;
    const configKind = kind === 'json' || kind === 'schema' ? kind : 'read';
    checks.push({
      id: 'config',
      status: 'fail',
      kind: configKind,
      message: details[configKind][0],
      fix: details[configKind][1],
      ...(fields?.length ? { fields } : {}),
    });
  }

  const safePath = isSafeSearchPath(io.env.PATH);
  checks.push(
    safePath
      ? { id: 'path', status: 'pass', message: 'PATH contains only nonempty absolute entries.' }
      : {
          id: 'path',
          status: 'fail',
          message: 'PATH is missing or contains empty or relative entries.',
          fix: 'Set PATH to nonempty absolute directory entries.',
        },
  );

  if (config === undefined) {
    checks.push({ id: 'executables', status: 'skipped', message: 'Requires valid configuration.' });
    checks.push({ id: 'evaluator_key', status: 'skipped', message: 'Requires valid configuration.' });
  } else {
    const tools = new Set(
      config.candidates.filter((candidate) => config.tools.includes(candidate.tool)).map((candidate) => candidate.tool),
    );
    for (const tool of tools) {
      if (!safePath) {
        checks.push({ id: `executable.${tool}`, status: 'skipped', message: 'Requires a safe PATH.' });
        continue;
      }
      let available = false;
      try {
        available = io.executableAvailable?.(tool, io.env.PATH!) === true;
      } catch {
        // A failed local lookup cannot establish executable availability.
      }
      checks.push(
        available
          ? {
              id: `executable.${tool}`,
              status: 'pass',
              message: 'Executable is available; version and login are unverified.',
            }
          : {
              id: `executable.${tool}`,
              status: 'fail',
              message: 'Executable is unavailable.',
              fix: `Install ${tool} or add its directory to PATH.`,
            },
      );
    }
    const keyName = config.evaluator.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY';
    const present = (io.env[keyName] ?? '').trim().length > 0;
    checks.push(
      present
        ? { id: 'evaluator_key', status: 'pass', message: 'Selected evaluator key is present; validity is unverified.' }
        : {
            id: 'evaluator_key',
            status: 'fail',
            message: 'Selected evaluator key is missing.',
            fix: `Set ${keyName} in the environment; do not put credentials in config.`,
          },
    );
  }
  return { schema_version: 1, ok: checks.every((check) => check.status !== 'fail'), checks };
}

export function renderDoctor(report: Awaited<ReturnType<typeof diagnose>>): string {
  const icons = { pass: '✅', fail: '❌', skipped: '⏭️' };
  return report.checks
    .map(
      (check) =>
        `${icons[check.status]} ${check.id} — ${check.message}${check.fields?.length ? ` Fields: ${check.fields.join(', ')}.` : ''}${check.fix ? `\n\tFix: ${check.fix}` : ''}\n`,
    )
    .join('');
}
