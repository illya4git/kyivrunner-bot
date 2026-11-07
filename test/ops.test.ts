import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDb } from '../src/core/backup.js';
import { loadConfig } from '../src/core/config.js';
import { startHealthServer } from '../src/core/health.js';
import { ADMIN_ID, makeServices } from './helpers/services.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'kr-test-'));
  dirs.push(d);
  return d;
}

describe('backupDb', () => {
  it('writes a consistent copy and keeps only the newest N', () => {
    const s = makeServices();
    s.access.touch({ id: 5, first_name: 'Olena' });
    const dir = tempDir();
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me');

    for (let i = 0; i < 4; i++) backupDb(s.db, dir, 2, new Date(Date.UTC(2026, 10, 7 + i, 1, 0, 0)));
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['bot-20261109-010000.sqlite', 'bot-20261110-010000.sqlite', 'unrelated.txt']);

    const copy = new Database(join(dir, 'bot-20261110-010000.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT first_name FROM users WHERE tg_id = 5').get()).toEqual({ first_name: 'Olena' });
    expect(copy.prepare('SELECT role FROM users WHERE tg_id = ?').get(ADMIN_ID)).toEqual({ role: 'admin' });
    copy.close();
  });

  it('overwrites a backup taken in the same second', () => {
    const s = makeServices();
    const dir = tempDir();
    const at = new Date(Date.UTC(2026, 10, 7, 1));
    backupDb(s.db, dir, 5, at);
    expect(() => backupDb(s.db, dir, 5, at)).not.toThrow();
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe('health endpoint', () => {
  it('answers 200 when healthy, 503 when not, 404 elsewhere', async () => {
    let ok = true;
    const server = await startHealthServer(0, () => ({ ok, detail: 'x' }));
    const port = (server.address() as { port: number }).port;
    try {
      const good = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ ok: true, detail: 'x' });
      ok = false;
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('reports a failing check as unhealthy instead of crashing', async () => {
    const server = await startHealthServer(0, () => {
      throw new Error('db gone');
    });
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('db gone') });
    } finally {
      server.close();
    }
  });
});

describe('ops config', () => {
  it('puts backups next to the database by default', () => {
    const c = loadConfig({
      BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      ADMIN_IDS: '1',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      DB_PATH: '/data/bot.sqlite',
      KYIV_CLIENT_AUTH: 'ab'.repeat(32),
    });
    expect(c).toMatchObject({ backupDir: '/data/backups', backupKeep: 14, healthPort: 8080 });
  });
});
