export const agyObserved = '2026-10-02T12:00:00.000Z';
export function agyAuth(
  subject = 'synthetic-user',
  expiry = '2026-10-02T13:00:00Z',
  issuer = 'https://accounts.google.com',
) {
  const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: subject })).toString('base64url');
  return JSON.stringify({
    auth_method: 'consumer',
    id_token: `header.${payload}.signature`,
    token: {
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      token_type: 'Bearer',
      expiry,
    },
  });
}
export function agyQuota(): Record<
  string,
  { remaining_fraction: number; reset_time?: string; reset_in_seconds?: number }
> {
  return Object.fromEntries(
    ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'].map((key) => [
      key,
      { remaining_fraction: 0.5, reset_time: '2026-10-03T12:00:00Z' },
    ]),
  );
}
