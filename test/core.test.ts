import { describe, expect, it } from 'vitest';
import { kyivDay, kyivDateTime, kyivTime } from '../src/core/clock.js';
import { loadConfig } from '../src/core/config.js';
import { Mutex } from '../src/core/mutex.js';
import { esc } from '../src/core/html.js';

describe('Kyiv time helpers', () => {
  it('rolls the day over at Kyiv midnight, not UTC midnight', () => {
    // November: Kyiv is UTC+2
    expect(kyivDay(Date.UTC(2026, 10, 7, 21, 59))).toBe('2026-11-07');
    expect(kyivDay(Date.UTC(2026, 10, 7, 22, 0))).toBe('2026-11-08');
  });
  it('handles summer time (UTC+3)', () => {
    expect(kyivDay(Date.UTC(2026, 6, 1, 20, 59))).toBe('2026-07-01');
    expect(kyivDay(Date.UTC(2026, 6, 1, 21, 0))).toBe('2026-07-02');
    expect(kyivTime(Date.UTC(2026, 6, 1, 5, 14))).toBe('08:14');
  });
  it('formats date-time', () => {
    expect(kyivDateTime(Date.UTC(2026, 10, 7, 6, 5))).toBe('07.11.2026 08:05');
  });
});

describe('config', () => {
  const base = {
    BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    ADMIN_IDS: '1, 2',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  it('parses a valid env with defaults', () => {
    const c = loadConfig(base);
    expect(c.adminIds).toEqual([1, 2]);
    expect(c.kyivBaseUrl).toBe('https://kyiv.digital');
    expect(c.devMode).toBe(false);
    expect(c.encryptionKey.length).toBe(32);
  });
  it('rejects a non-production API URL without DEV_MODE', () => {
    expect(() => loadConfig({ ...base, KYIV_BASE_URL: 'http://localhost:8787' })).toThrow(/DEV_MODE/);
    expect(loadConfig({ ...base, KYIV_BASE_URL: 'http://localhost:8787/', DEV_MODE: 'true' }).kyivBaseUrl).toBe('http://localhost:8787');
  });
  it('rejects bad admin ids and keys', () => {
    expect(() => loadConfig({ ...base, ADMIN_IDS: 'abc' })).toThrow(/ADMIN_IDS/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
  });
});

describe('Mutex', () => {
  it('serializes critical sections and survives failures', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
    });
    const failing = m.run(() => {
      order.push('b');
      throw new Error('boom');
    });
    const fast = m.run(() => order.push('c'));
    await slow;
    await expect(failing).rejects.toThrow('boom');
    await fast;
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('esc', () => {
  it('escapes HTML specials', () => {
    expect(esc('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});
