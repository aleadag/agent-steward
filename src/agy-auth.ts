import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { SnapshotSchema, StewardError } from './contracts.ts';
import { assertByteLength, assertJsonDepth } from './limits.ts';

export type AgyIdentity = { identityFingerprint: string; expiresAt: string; renewable: boolean };
export function agyAuthPath(env: { HOME?: string }): string {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new StewardError('invalid_input');
  return join(env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}
export function readAgyIdentity(text: string): AgyIdentity | null {
  try {
    assertByteLength(text);
    const auth = JSON.parse(text);
    assertJsonDepth(auth);
    if (auth?.auth_method !== 'consumer') return null;
    let identity: string;
    if (auth.id_token === undefined) {
      const email = z.email().safeParse(auth.id_token_email);
      if (!email.success) return null;
      // Keep the native spelling; uncertain identity changes invalidate old data.
      identity = `antigravity:email:${email.data}`;
    } else {
      if (typeof auth.id_token !== 'string') return null;
      const parts = auth.id_token.split('.');
      if (parts.length !== 3 || parts.some((p: string) => !p || !/^[A-Za-z0-9_-]+$/.test(p))) return null;
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (
        !['https://accounts.google.com', 'accounts.google.com'].includes(claims?.iss) ||
        typeof claims.sub !== 'string' ||
        !claims.sub.trim()
      )
        return null;
      identity = `antigravity:https://accounts.google.com:${claims.sub}`;
    }
    const expires = SnapshotSchema.shape.windows.element.shape.reset_at.safeParse(auth.token?.expiry);
    if (!expires.success || typeof auth.token?.access_token !== 'string' || !auth.token.access_token) return null;
    return {
      identityFingerprint: createHash('sha256').update(identity).digest('hex'),
      expiresAt: expires.data,
      renewable: typeof auth.token.refresh_token === 'string' && auth.token.refresh_token.length > 0,
    };
  } catch {
    return null;
  }
}
