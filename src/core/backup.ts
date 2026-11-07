import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/client.js';

const NAME = /^bot-\d{8}-\d{6}\.sqlite$/;

/**
 * Consistent online copy via `VACUUM INTO` (safe while the bot runs, compact, WAL folded in),
 * then keep only the newest `keep` copies. The access token stays encrypted in backups; the
 * key (ENCRYPTION_KEY) is not in the database.
 */
export function backupDb(db: Db, dir: string, keep: number, now = new Date()): { file: string; removed: string[] } {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(dir, `bot-${stamp}.sqlite`);
  rmSync(file, { force: true }); // VACUUM INTO refuses to overwrite
  db.$client.prepare('VACUUM INTO ?').run(file);

  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return { file, removed };
}
