import { StewardError } from './contracts.ts';
import { assertJsonDepth } from './limits.ts';

const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
];
const credentialKey = /^(api[_-]?key|access[_-]?token|client[_-]?secret|password)$/i;

export type CredentialKeys = string | readonly string[];

export function configuredApiKeys(env: { TYPESAFE_API_KEY?: string; OPENROUTER_API_KEY?: string }): string[] {
  return [env.TYPESAFE_API_KEY ?? '', env.OPENROUTER_API_KEY ?? ''];
}

function recognizable(value: string, apiKey: CredentialKeys): boolean {
  const keys = typeof apiKey === 'string' ? [apiKey] : apiKey;
  return keys.some((key) => key.length > 0 && value.includes(key)) || patterns.some((pattern) => pattern.test(value));
}

export function assertNoCredentials(content: unknown, apiKey: CredentialKeys): string | undefined {
  assertJsonDepth(content);

  const stack: unknown[] = [content];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string' && recognizable(value, apiKey)) {
      throw new StewardError('credential_detected');
    }
    if (value === null || typeof value !== 'object') continue;

    const entries: [string, unknown][] = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry])
      : Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]);
    for (const [key, child] of entries) {
      if (recognizable(key, apiKey) || (credentialKey.test(key) && typeof child === 'string' && child.length > 0)) {
        throw new StewardError('credential_detected');
      }
      if (child !== null && typeof child === 'object') stack.push(child);
      else if (typeof child === 'string' && recognizable(child, apiKey)) throw new StewardError('credential_detected');
    }
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(content);
  } catch {
    throw new StewardError('invalid_input');
  }
  if (serialized !== undefined && recognizable(serialized, apiKey)) {
    throw new StewardError('credential_detected');
  }
  return serialized;
}
