import { isAbsolute, resolve } from 'node:path';
import { ConfigSchema, StewardError } from './contracts.ts';
import type { Config, ConfigEnv, ReadText } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';
import { assertNoCredentials } from './privacy.ts';

export async function loadConfig(
  override: string | undefined,
  io: {
    env: ConfigEnv;
    cwd: string;
    readText: ReadText;
  },
): Promise<Config> {
  let kind: 'read' | 'json' | 'schema' = 'read';
  try {
    let configPath: string;
    if (override !== undefined) {
      if (override.trim().length === 0) throw new Error();
      configPath = resolve(io.cwd, override);
    } else {
      const xdg = io.env.XDG_CONFIG_HOME;
      if (xdg !== undefined && xdg.length > 0) {
        if (!isAbsolute(xdg)) throw new Error();
        configPath = resolve(xdg, 'agent-steward', 'config.json');
      } else {
        const home = io.env.HOME;
        if (home === undefined || home.length === 0 || !isAbsolute(home)) throw new Error();
        configPath = resolve(home, '.config', 'agent-steward', 'config.json');
      }
    }

    const contents = await io.readText(configPath);
    assertByteLength(contents);
    kind = 'json';
    const parsed: unknown = JSON.parse(contents);
    assertJsonDepth(parsed);
    kind = 'schema';
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      const fields = result.error.issues
        .flatMap((issue) =>
          issue.code === 'unrecognized_keys' ? issue.keys.map((key) => [...issue.path, key]) : [issue.path],
        )
        .filter(
          (parts) =>
            parts.length > 0 &&
            parts.every(
              (part) =>
                typeof part === 'number' || (typeof part === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part)),
            ),
        )
        .map((parts) => parts.join('.'))
        .filter((field) => {
          if (field.length > 256) return false;
          try {
            assertNoCredentials(field, io.env.TYPESAFE_API_KEY ?? '');
            return true;
          } catch {
            return false;
          }
        });
      throw new StewardError('invalid_config', {
        stage: 'config',
        kind,
        config_fields: [...new Set(fields)].slice(0, 16),
      });
    }
    return result.data;
  } catch (error) {
    if (error instanceof StewardError && error.code === 'invalid_config') throw error;
    throw new StewardError('invalid_config', { stage: 'config', kind });
  }
}
