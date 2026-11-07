/**
 * The header envelope the Kyiv Digital Android app sends on every request.
 * See docs/README.md#the-request-envelope-required-on-every-request
 */
export const KD_CLIENT_AUTH = '<KYIV_CLIENT_AUTH>';
export const KD_APP_VERSION = '4.0.0';
export const KD_PLATFORM = '0'; // Android
export const KD_OS_VERSION = '11';

export type KyivCredentials = {
  accessToken: string;
  deviceUuid: string;
};

/** JWT `sub` (Kyiv Digital user id), used in the User-Agent. Falls back to 'me'. */
export function jwtSubject(token: string): string {
  const claims = decodeJwtClaims(token);
  return claims?.sub !== undefined ? String(claims.sub) : 'me';
}

/** Decode JWT claims without verifying (we only need `exp`/`sub` for bookkeeping). */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Headers for one request. `json` = the request carries a JSON body.
 * Empty-body POSTs (generate QR) must NOT send Content-Type — matches the app.
 */
export function envelopeHeaders(creds: KyivCredentials, opts: { json?: boolean; locale?: 'uk' | 'en' } = {}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: 'application/json',
    'X-Client-Auth': KD_CLIENT_AUTH,
    'X-Client-Version': KD_APP_VERSION,
    'X-Client-Platform': KD_PLATFORM,
    'X-Client-Locale': opts.locale ?? 'uk',
    'X-Client-Theme': '1',
    'X-Device-UUID': creds.deviceUuid,
    'User-Agent': `KD/${KD_APP_VERSION} Android/${KD_OS_VERSION} User/${jwtSubject(creds.accessToken)}`,
  };
  if (opts.json) h['Content-Type'] = 'application/json; charset=UTF-8';
  return h;
}
