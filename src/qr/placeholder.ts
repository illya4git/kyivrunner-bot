import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pictograms that replace a QR image once it can no longer be used: assets/ticket-<kind>.png
 * (drawn by scripts/draw-placeholders.ts, or any artwork of the same names). Read once.
 */
export type PlaceholderKind = 'used' | 'expired';

export type Placeholder = {
  png: Buffer;
  filename: string;
  /** Identifies this exact artwork: a Telegram file id is reused only for the same bytes. */
  key: string;
};

const cache = new Map<PlaceholderKind, Placeholder>();

export function placeholder(kind: PlaceholderKind): Placeholder {
  let p = cache.get(kind);
  if (!p) {
    // src/qr and dist/qr are both two levels below the package root.
    const png = readFileSync(fileURLToPath(new URL(`../../assets/ticket-${kind}.png`, import.meta.url)));
    p = { png, filename: `${kind}.png`, key: `placeholder:${kind}:${createHash('sha256').update(png).digest('hex').slice(0, 16)}` };
    cache.set(kind, p);
  }
  return p;
}
