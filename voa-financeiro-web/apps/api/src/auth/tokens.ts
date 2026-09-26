import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Access token (JWT) lifetime, in seconds. Kept short on purpose: the refresh token renews it. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Refresh token lifetime (session), in seconds. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Identifier stored in `auth_sessions.token_id` and in the `sid` claim of the access token. */
export function createSessionTokenId(): string {
  return randomUUID();
}

/** Opaque refresh token (384 bits). It is only ever returned inside an httpOnly cookie. */
export function createRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

/** Keyed hash stored in `auth_sessions.refresh_token_hash`; the token itself is never persisted. */
export function hashRefreshToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function matchesRefreshToken(token: string, storedHash: string, secret: string): boolean {
  const actual = Buffer.from(hashRefreshToken(token, secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}
