import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type Sealed = { enc: Buffer; iv: Buffer; tag: Buffer };

/** AES-256-GCM with a fresh 96-bit IV per message. */
export function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { enc, iv, tag: cipher.getAuthTag() };
}

/** Throws if the key is wrong or the data was tampered with. */
export function open(key: Buffer, s: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key, s.iv);
  decipher.setAuthTag(s.tag);
  return Buffer.concat([decipher.update(s.enc), decipher.final()]).toString('utf8');
}

/** Matches JWT-shaped strings (three base64url parts, header starting with `eyJ`). */
export const JWT_PATTERN = /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;

export function looksLikeJwt(s: string): boolean {
  return new RegExp(JWT_PATTERN.source).test(s);
}

export function redactJwts(s: string): string {
  return s.replace(JWT_PATTERN, '[jwt]');
}

/** "eyJ0eX…a1c9" — enough to tell tokens apart, useless to an attacker. */
export function maskSecret(s: string): string {
  return s.length <= 12 ? '•••' : `${s.slice(0, 6)}…${s.slice(-4)}`;
}
