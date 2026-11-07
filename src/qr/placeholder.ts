import { crc32, deflateSync } from 'node:zlib';

/**
 * Pictograms that replace a QR image once it can no longer be used. The caption carries
 * the words; the image only has to be unmistakably "not a QR code". Drawn procedurally
 * so there are no binary assets or image libraries.
 */
export type PlaceholderKind = 'used' | 'expired';

const SIZE = 640;
const cache = new Map<PlaceholderKind, Buffer>();

export function placeholderPng(kind: PlaceholderKind): Buffer {
  let png = cache.get(kind);
  if (!png) {
    png = draw(kind);
    cache.set(kind, png);
  }
  return png;
}

type RGB = [number, number, number];
const BG: RGB = [242, 242, 242];
const WHITE: RGB = [255, 255, 255];
const DISC: Record<PlaceholderKind, RGB> = { used: [46, 125, 50], expired: [140, 140, 140] };

function draw(kind: PlaceholderKind): Buffer {
  const c = SIZE / 2;
  const r = SIZE * 0.32;
  const stroke = SIZE * 0.045;
  // Glyph segments inside the disc: a check mark (used) or clock hands (expired).
  const segs: [number, number, number, number][] =
    kind === 'used'
      ? [
          [c - r * 0.5, c + r * 0.02, c - r * 0.12, c + r * 0.4],
          [c - r * 0.12, c + r * 0.4, c + r * 0.55, c - r * 0.35],
        ]
      : [
          [c, c, c, c - r * 0.6],
          [c, c, c + r * 0.42, c + r * 0.12],
        ];

  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 3 + 1);
    raw[row] = 0; // PNG filter: none
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - c, y - c);
      let px: RGB = BG;
      if (d <= r) {
        px = DISC[kind];
        if (segs.some(([x1, y1, x2, y2]) => distToSegment(x, y, x1, y1, x2, y2) <= stroke / 2)) px = WHITE;
        if (kind === 'expired' && Math.abs(d - r * 0.78) <= stroke / 3) px = WHITE; // clock rim
      }
      raw.set(px, row + 1 + x * 3);
    }
  }
  return encodePng(SIZE, SIZE, raw);
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function encodePng(width: number, height: number, rawRgbRows: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawRgbRows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
