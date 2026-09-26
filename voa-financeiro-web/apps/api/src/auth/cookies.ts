export interface RefreshCookieOptions {
  name: string;
  secure: boolean;
  domain?: string | undefined;
}

/** Path of the refresh cookie: it is only needed by the auth routes. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function serializeRefreshCookie(options: RefreshCookieOptions, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${options.name}=${encodeURIComponent(value)}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** `Max-Age=0` removes the cookie from the browser. */
export function clearRefreshCookie(options: RefreshCookieOptions): string {
  return serializeRefreshCookie(options, '', 0);
}
