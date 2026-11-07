import { afterEach, describe, expect, it } from 'vitest';
import type { InputFile } from 'grammy';
import { STUDENT_CARD_ID } from '../mock/fixtures.js';
import { DEGRADED_AFTER } from '../src/services/tracker.js';
import { ADMIN_ID } from './helpers/services.js';
import { closeTicketEnvs, ticketEnv } from './helpers/ticket-env.js';
import type { ApiCall } from './helpers/telegram.js';

const HOUR = 3_600_000;
const admin = { id: ADMIN_ID, first_name: 'Admin', language_code: 'en' };
afterEach(closeTicketEnvs);

/** Read the bytes of a document the bot sent. */
function documentText(call: ApiCall): string {
  // grammY keeps the bytes in a private field; fine to peek at in tests.
  const file = call.payload.document as InputFile;
  return (file as unknown as { fileData: Buffer }).fileData.toString('utf8');
}

async function withHistory() {
  const s = await ticketEnv();
  const a = s.user(5);
  const b = s.user(6, 'uk');
  await s.text(a, '/qr');
  await s.text(b, '/qr');
  s.state.validate(s.tickets.history(5)[0]!.kdTicketId, { mode: 'Метро', place: 'Хрещатик' });
  await s.tracker.tick();
  s.clock.advance(14 * HOUR); // b's ticket expires at midnight
  await s.tracker.tick();
  s.take();
  return { ...s, a, b };
}

describe('/settings and /set', () => {
  it('lists every setting and changes one with validation and an audit entry', async () => {
    const s = await ticketEnv();
    await s.text(admin, '/settings');
    const text = s.textsTo(ADMIN_ID, s.take())[0]!;
    for (const k of ['default_daily_quota', 'reserve_trips', 'poll_interval_sec', 'paused']) expect(text).toContain(k);

    await s.text(admin, '/set default_daily_quota 3');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('2 → <b>3</b>');
    expect(s.settings.get('default_daily_quota')).toBe(3);
    expect(s.audit.recent({ kind: 'setting_changed' })[0]?.data).toMatchObject({ key: 'default_daily_quota', from: 2, to: 3 });

    await s.text(admin, '/set default_daily_quota -1');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('Invalid value');
    await s.text(admin, '/set nope 1');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('Unknown key');
    await s.text(admin, '/set active_card_id 1');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('changed elsewhere');
    expect(s.settings.get('active_card_id')).toBe(STUDENT_CARD_ID);
  });

  it('is admin-only', async () => {
    const s = await ticketEnv();
    const u = s.user(5);
    for (const cmd of ['/settings', '/set paused true', '/stats', '/logs', '/export', '/pause']) await s.text(u, cmd);
    expect(s.textsTo(5, s.take()).every((x) => x.includes('🔒'))).toBe(true);
    expect(s.settings.get('paused')).toBe(false);
  });
});

describe('/pause and /resume', () => {
  it('stops issuing, tells the other admins, and resumes', async () => {
    const s = await ticketEnv();
    s.access.touch({ id: 2000 });
    s.access.setRole(2000, 'admin', ADMIN_ID);
    const u = s.user(5);

    await s.text(admin, '/pause');
    let batch = s.take();
    expect(s.textsTo(ADMIN_ID, batch)[0]).toContain('paused');
    expect(s.textsTo(2000, batch)[0]).toContain('paused ticket issuing');

    await s.text(u, '/qr');
    expect(s.textsTo(5, s.take()).join()).toContain('paused');
    expect(s.state.codeList()).toHaveLength(0);

    await s.text(admin, '/pause');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('already paused');
    await s.text(admin, '/resume');
    batch = s.take();
    expect(s.textsTo(2000, batch)[0]).toContain('resumed');
    await s.text(u, '/qr');
    expect(s.photosTo(5, s.take())).toHaveLength(1);
    expect(s.audit.recent({ kind: 'paused' })).toHaveLength(1);
  });
});

describe('/stats', () => {
  it('summarises per user with totals, places and the card balance', async () => {
    const s = await withHistory();
    await s.text(admin, '/stats week');
    const text = s.textsTo(ADMIN_ID, s.take())[0]!;
    expect(text).toContain('7 days');
    expect(text).toMatch(/U5: 1 🎫 · 1 ✅ · 0 ⌛/);
    expect(text).toMatch(/U6: 1 🎫 · 0 ✅ · 1 ⌛/);
    expect(text).toMatch(/Total:<\/b> 2 🎫 · 1 ✅ · 1 ⌛/);
    expect(text).toContain('Метро, Хрещатик — 1');
    expect(text).toContain('Trips on the card: <b>35</b>');

    await s.text(admin, '/stats today'); // it's the next day now
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('No tickets in this period');
    await s.text(admin, '/stats yearly');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('Usage');
  });

  it('shows per-user stats and log from the user card', async () => {
    const s = await withHistory();
    await s.press(admin, 'ust:5');
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('Хрещатик');
    await s.press(admin, 'ulg:5');
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('ticket_used');
  });
});

describe('/logs', () => {
  it('hides interactions by default and shows everything for one user', async () => {
    const s = await withHistory();
    await s.text(admin, '/logs');
    const all = s.textsTo(ADMIN_ID, s.take())[0]!;
    expect(all).toContain('ticket_issued');
    expect(all).not.toContain('<b>interaction</b>');

    await s.text(admin, '/logs 5 30');
    const one = s.textsTo(ADMIN_ID, s.take())[0]!;
    expect(one).toContain('<b>interaction</b>');
    expect(one).toContain('U5');
    expect(one).not.toContain('U6');

    await s.text(admin, '/logs 10');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('interactions hidden');
    await s.text(admin, '/logs @nobody');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('not found');
    await s.text(admin, '/logs 5 lots');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('Usage');
  });

  it('stays valid HTML with hostile data and under Telegram’s length limit', async () => {
    const s = await ticketEnv();
    for (let i = 0; i < 40; i++) s.audit.log({ kind: 'api_error', data: { msg: `<b>&${'x'.repeat(200)}` } });
    await s.text(admin, '/logs 30');
    const text = s.textsTo(ADMIN_ID, s.take())[0]!;
    expect(text.length).toBeLessThan(4096);
  });
});

describe('/export', () => {
  it('sends tickets as CSV with places and no QR payloads', async () => {
    const s = await withHistory();
    await s.text(admin, '/export tickets 7');
    const doc = s.take().find((c) => c.method === 'sendDocument')!;
    expect(String(doc.payload.caption)).toContain('rows: 2');
    const csv = documentText(doc);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM for spreadsheet apps
    expect(csv).toContain('id,kd_ticket_id,user_id,username,name,day,status');
    expect(csv).toContain('Метро,Хрещатик');
    expect(csv).toContain(',expired,');
    for (const t of s.tickets.history(5).concat(s.tickets.history(6))) expect(csv).not.toContain(t.code);
    expect(s.audit.recent({ kind: 'exported' })[0]?.data).toMatchObject({ what: 'tickets', rows: 2 });
  });

  it('sends events as CSV, and validates arguments', async () => {
    const s = await withHistory();
    await s.text(admin, '/export events all');
    const csv = documentText(s.take().find((c) => c.method === 'sendDocument')!);
    expect(csv).toContain('id,time,user_id,role,kind,data');
    expect(csv).toContain('ticket_used');

    await s.text(admin, '/export passwords');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('Usage');
  });
});

describe('admin alerts', () => {
  it('warns about a low balance once per day', async () => {
    const s = await ticketEnv();
    s.settings.set('low_balance_alert', 35, ADMIN_ID);
    const a = s.user(5);
    const b = s.user(6);
    await s.text(a, '/qr'); // 36 → 35
    await s.text(b, '/qr'); // 35 → 34
    await new Promise((r) => setTimeout(r, 10));
    const alerts = s.textsTo(ADMIN_ID, s.take()).filter((x) => x.startsWith('🪫'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('<b>35</b>');
  });

  it('warns once a day when the card blocks generation', async () => {
    const s = await ticketEnv();
    s.access.touch(admin); // English
    s.state.patchCard(STUDENT_CARD_ID, { blocked: true });
    await s.text(s.user(5), '/qr');
    await s.text(s.user(6), '/qr');
    await new Promise((r) => setTimeout(r, 10));
    expect(s.textsTo(ADMIN_ID, s.take()).filter((x) => x.startsWith('⛔ The card'))).toHaveLength(1);
  });

  it('reports a sustained Kyiv Digital outage once, then the recovery', async () => {
    const s = await ticketEnv();
    s.access.touch(admin); // English
    await s.text(s.user(5), '/qr');
    s.take();
    s.mock.addFault({ kind: '503', remaining: 100 });
    for (let i = 0; i < DEGRADED_AFTER + 2; i++) await s.tracker.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.textsTo(ADMIN_ID, s.take()).filter((x) => x.startsWith('📡'))).toHaveLength(1);

    s.mock.faults = [];
    await s.tracker.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.textsTo(ADMIN_ID, s.take()).filter((x) => x.includes('reachable again'))).toHaveLength(1);
  });
});

describe('audit pruning', () => {
  it('deletes events older than the retention period', async () => {
    const s = await ticketEnv();
    s.audit.log({ kind: 'paused' });
    s.clock.advance(3 * 24 * HOUR);
    s.audit.log({ kind: 'resumed' });
    expect(s.audit.prune(2)).toBeGreaterThanOrEqual(1);
    expect(s.audit.recent({ kind: 'paused' })).toHaveLength(0);
    expect(s.audit.recent({ kind: 'resumed' })).toHaveLength(1);
  });
});
