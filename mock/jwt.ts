import { createHash, randomBytes } from 'node:crypto';

/**
 * A JWT-shaped token with the claims the real one carries (tymon/jwt-auth, ES256).
 * The signature is filler: nobody verifies it, the bot only decodes `exp`/`sub`.
 * With `seed`, the token is deterministic (stable dev credentials across mock restarts).
 */
export function fakeJwt(claims: { sub: number; exp: number; iat?: number; d?: string }, seed?: string): string {
  const bytes = (n: number, salt: string) =>
    seed === undefined ? randomBytes(n) : createHash('sha512').update(`${seed}:${salt}`).digest().subarray(0, n);
  const iat = claims.iat ?? claims.exp - 16_070_400;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    iss: 'https://kyiv.digital/api/v4/login/verify',
    iat,
    nbf: iat,
    exp: claims.exp,
    jti: bytes(8, 'jti').toString('hex'),
    sub: String(claims.sub),
    prv: '23bd5c8949f600adb39e701c400872db7a5976f7',
    d: claims.d ?? 'mock-device',
  };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64(header)}.${b64(payload)}.${bytes(64, 'sig').toString('base64url')}`;
}
