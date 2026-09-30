import { dirname, isAbsolute, resolve } from 'node:path';
import { ConfigSchema, StewardError } from './contracts.ts';
import type { Config, ConfigEnv, ReadText } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';

export async function loadConfig(
  override: string | undefined,
  io: {
    env: ConfigEnv;
    cwd: string;
    readText: ReadText;
  },
): Promise<Config> {
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
    const parsed: unknown = JSON.parse(contents);
    assertJsonDepth(parsed);
    const config = ConfigSchema.parse(parsed);
    const configDirectory = dirname(configPath);
    return {
      ...config,
      accounts: config.accounts.map((account) =>
        account.snapshot === undefined || isAbsolute(account.snapshot)
          ? account
          : { ...account, snapshot: resolve(configDirectory, account.snapshot) },
      ),
    };
  } catch {
    throw new StewardError('invalid_config');
  }
}
