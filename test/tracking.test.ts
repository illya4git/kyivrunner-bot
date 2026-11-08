import { afterEach, describe, expect, it } from 'vitest';
import { OffsetClock } from '../src/core/clock.js';
import { placeholder } from '../src/qr/placeholder.js';
import { STUDENT_CARD_ID } from '../mock/fixtures.js';
import { ADMIN_ID, FakeClock } from './helpers/services.js';
import { closeTicketEnvs, ticketEnv } from './helpers/ticket-env.js';
import type { ApiCall } from './helpers/telegram.js';

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
afterEach(closeTicketEnvs);

/** Issue a ticket via /qr for a fresh user and return it. */
async function issued(s: Awaited<ReturnType<typeof ticketEnv>>, id = 5, lang = 'en') {
  const u = s.user(id, lang);
  await s.text(u, '/qr');
  s.take();
  return { u, ticket: s.tickets.history(id)[0]! };
}

const sends = (batch: ApiCall[], method: string) => batch.filter((c) => c.method === method);
const feedCalls = (s: Awaited<ReturnType<typeof ticketEnv>>) => s.mock.requests.filter((r) => r.path.includes('/feed')).length;
const qrCalls = (s: Awaited<ReturnType<typeof ticketEnv>>) => s.mock.requests.filter((r) => r.path === '/api/v4/qr').length;

describe('TicketTracker', () => {
  it('reports the use at once and the place from 5 minutes after the scan', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.clock.advance(HOUR);
    s.state.validate(ticket.kdTicketId, { mode: 'Метро', place: 'Хрещатик' });

    await s.tracker.tick();
    let batch = s.take();
    expect(String(sends(batch, 'editMessageCaption')[0]?.payload.caption)).toContain('used at 11:00');
    const reply = sends(batch, 'sendMessage')[0]!;
    expect(reply.payload.reply_parameters).toMatchObject({ message_id: ticket.messageId });
    expect(String(reply.payload.text)).toContain('finding the place');
    expect(feedCalls(s)).toBe(0); // too early to look

    s.clock.advance(4 * MIN);
    await s.tracker.tick();
    expect(feedCalls(s)).toBe(0);

    s.clock.advance(MIN);
    await s.tracker.tick();
    batch = s.take();
    expect(feedCalls(s)).toBe(1);
    expect(sends(batch, 'sendMessage')).toHaveLength(0); // no second notification
    expect(String(sends(batch, 'editMessageCaption')[0]!.payload.caption)).toContain('🚇 Метро · Хрещатик');
    const replyEdit = sends(batch, 'editMessageText')[0]!;
    expect(replyEdit.payload).toMatchObject({ message_id: s.tickets.get(ticket.id)!.statusReplyId });
    expect(String(replyEdit.payload.text)).toContain('🚇 Метро · Хрещатик');
    expect(s.tickets.get(ticket.id)).toMatchObject({ status: 'used', place: 'Хрещатик', mode: 'Метро' });
    expect(s.audit.recent({ kind: 'place_found' })[0]?.data).toMatchObject({ ticket: ticket.id, foundAfterSec: 300 });
  });

  it('keeps looking while the feed lags, labelling a vehicle with its route', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.state.validate(ticket.kdTicketId, { mode: 'Автобус №87', place: 'МАЗ 215-069', feedDelaySec: 40 * 60 });
    await s.tracker.tick();
    for (let i = 0; i < 7; i++) {
      s.clock.advance(5 * MIN);
      await s.tracker.tick();
      expect(s.tickets.get(ticket.id)?.place).toBeNull();
    }
    s.clock.advance(5 * MIN); // 40 min after the scan
    await s.tracker.tick();
    expect(s.tickets.get(ticket.id)?.place).toBe('МАЗ 215-069');
    expect(String(sends(s.take(), 'editMessageCaption').at(-1)!.payload.caption)).toContain('🚌 Автобус №87 · МАЗ 215-069');
  });

  it('gives up on the place hours after the scan and drops the "finding" note', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.state.validate(ticket.kdTicketId, { feedDelaySec: 100_000 });
    await s.tracker.tick();
    s.clock.advance(6 * HOUR - SEC);
    await s.tracker.tick();
    expect(s.audit.recent({ kind: 'place_unresolved' })).toHaveLength(0);
    s.clock.advance(SEC);
    await s.tracker.tick();
    const lastReply = sends(s.take(), 'editMessageText').at(-1)!;
    expect(String(lastReply.payload.text)).not.toContain('finding');
    expect(s.audit.recent({ kind: 'place_unresolved' })).toHaveLength(1);

    const calls = feedCalls(s);
    await s.tracker.tick();
    expect(sends(s.take(), 'editMessageText')).toHaveLength(0); // done for good
    expect(feedCalls(s)).toBe(calls);
  });

  it("matches the right validation: ignores a physical-card tap and another rider's scan", async () => {
    const s = await ticketEnv();
    const a = await issued(s, 5);
    const b = await issued(s, 6);
    s.state.foreignValidation(STUDENT_CARD_ID, { mode: 'Тролейбус', place: 'Площа Перемоги', atSec: Math.floor(s.clock.now() / 1000) - 60 });
    s.state.validate(a.ticket.kdTicketId, { mode: 'Метро', place: 'Лівобережна' });
    s.clock.advance(4 * SEC); // two codes at the same gate, seconds apart
    s.state.validate(b.ticket.kdTicketId, { mode: 'Метро', place: 'Лівобережна 2' });

    await s.tracker.tick();
    s.clock.advance(5 * MIN);
    await s.tracker.tick();
    expect(s.tickets.get(a.ticket.id)).toMatchObject({ mode: 'Метро', place: 'Лівобережна' });
    expect(s.tickets.get(b.ticket.id)).toMatchObject({ mode: 'Метро', place: 'Лівобережна 2' });
    expect(feedCalls(s)).toBe(1); // one feed request serves both
  });

  it("never steals another ticket's validation when its own is late in the feed", async () => {
    const s = await ticketEnv();
    const a = await issued(s, 5);
    const b = await issued(s, 6);
    s.state.validate(a.ticket.kdTicketId, { mode: 'Метро', place: 'Лівобережна' });
    s.clock.advance(5 * SEC);
    s.state.validate(b.ticket.kdTicketId, { mode: 'Метро', place: 'Хрещатик', feedDelaySec: 10 * 60 });

    await s.tracker.tick();
    s.clock.advance(5 * MIN);
    await s.tracker.tick(); // A's event is visible and 5 s from B's used_at
    expect(s.tickets.get(a.ticket.id)?.place).toBe('Лівобережна');
    expect(s.tickets.get(b.ticket.id)?.place).toBeNull();

    s.clock.advance(5 * MIN);
    await s.tracker.tick();
    expect(s.tickets.get(b.ticket.id)?.place).toBe('Хрещатик');
  });

  it('treats a code that left /qr before expiry as used, and takes its time and place from the feed', async () => {
    const s = await ticketEnv();
    s.state.foreignValidation(STUDENT_CARD_ID, { mode: 'Тролейбус', place: 'До видачі', atSec: Math.floor(s.clock.now() / 1000) - 60 });
    const { ticket } = await issued(s);
    s.clock.advance(10 * MIN);
    s.state.validate(ticket.kdTicketId, { mode: 'Метро', place: 'Хрещатик' });
    s.clock.advance(2 * HOUR + MIN); // the bot was down; the code is gone from /qr

    await s.tracker.tick();
    expect(s.tickets.get(ticket.id)).toMatchObject({ status: 'used', usedAt: null });
    expect(s.audit.recent({ kind: 'ticket_used' })[0]?.data).toMatchObject({ missingFromList: true });
    expect(String(sends(s.take(), 'sendMessage')[0]!.payload.text)).toContain('finding the place');

    s.clock.advance(5 * MIN);
    await s.tracker.tick();
    expect(s.tickets.get(ticket.id)).toMatchObject({ place: 'Хрещатик', usedAt: ticket.issuedAt + 10 * MIN });
    expect(String(sends(s.take(), 'editMessageCaption')[0]!.payload.caption)).toContain('used at 10:10');
  });

  it('at midnight: expires unused tickets (with a reply) and silently retires used QR images', async () => {
    const s = await ticketEnv();
    const used = await issued(s, 5);
    const unused = await issued(s, 6);
    s.state.validate(used.ticket.kdTicketId, { mode: 'Метро', place: 'Хрещатик' });
    await s.tracker.tick();
    s.take();

    s.clock.advance(14 * HOUR); // 00:00+ next day in Kyiv
    await s.tracker.tick();
    const batch = s.take();

    const media = sends(batch, 'editMessageMedia');
    const retired = media.find((c) => c.payload.message_id === used.ticket.messageId)!;
    expect(String((retired.payload.media as { caption: string }).caption)).toContain('used 07.11.2026 at 10:00');
    const expired = media.find((c) => c.payload.message_id === unused.ticket.messageId)!;
    expect(String((expired.payload.media as { caption: string }).caption)).toContain('not used');

    const replies = sends(batch, 'sendMessage');
    expect(replies.map((r) => Number(r.payload.chat_id))).toEqual([6]); // only the expiry notifies
    expect(s.tickets.get(used.ticket.id)?.imageRetired).toBe(true);

    await s.tracker.tick();
    expect(sends(s.take(), 'editMessageMedia')).toHaveLength(0);
  });

  it('uploads each placeholder image once, then reuses its Telegram file id', async () => {
    const s = await ticketEnv();
    const tickets = [];
    for (const id of [5, 6, 7]) tickets.push((await issued(s, id)).ticket);
    s.state.validate(tickets[0]!.kdTicketId);
    s.state.validate(tickets[1]!.kdTicketId);
    await s.tracker.tick();
    s.take();

    s.clock.advance(14 * HOUR); // past midnight: two used images retire, one ticket expires
    await s.tracker.tick();
    const media = sends(s.take(), 'editMessageMedia').map((c) => (c.payload.media as { media: unknown }).media);
    expect(media).toHaveLength(3);
    const uploads = media.filter((m) => typeof m !== 'string');
    expect(uploads).toHaveLength(2); // one "used", one "expired"
    expect(media.filter((m) => typeof m === 'string')).toEqual([s.files.get(placeholder('used').key)]); // the second "used" reuses the first upload

    // The next day (after the nightly maintenance): every swap reuses an id, nothing is uploaded.
    s.clock.advance(4 * HOUR);
    const next = (await issued(s, 8)).ticket;
    s.clock.advance(24 * HOUR);
    await s.tracker.tick();
    const later = sends(s.take(), 'editMessageMedia').filter((c) => c.payload.message_id === next.messageId);
    expect(typeof (later[0]!.payload.media as { media: unknown }).media).toBe('string');
  });

  it('uploads again when Telegram rejects a stored file id', async () => {
    const s = await ticketEnv();
    s.files.set(placeholder('expired').key, 'from-another-bot');
    s.failIf.push((method, p) =>
      method === 'editMessageMedia' && (p.media as { media: unknown }).media === 'from-another-bot' ? 'Bad Request: wrong file identifier/HTTP URL specified' : null,
    );
    const { ticket } = await issued(s);
    s.clock.advance(14 * HOUR);
    await s.tracker.tick();
    const media = sends(s.take(), 'editMessageMedia').map((c) => (c.payload.media as { media: unknown }).media);
    expect(media[0]).toBe('from-another-bot');
    expect(typeof media[1]).not.toBe('string'); // re-uploaded
    expect(s.tickets.get(ticket.id)?.status).toBe('expired');
    expect(s.files.get(placeholder('expired').key)).toMatch(/^file-/);
  });

  it('makes no API calls when there is nothing to track', async () => {
    const s = await ticketEnv();
    await s.tracker.tick();
    await s.tracker.tick();
    expect(s.mock.requests).toHaveLength(0);
  });

  it('reconciles on start: a ticket used while the bot was down is reported by the first pass', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.state.validate(ticket.kdTicketId); // happened "while down"
    s.tracker.start();
    try {
      for (let i = 0; i < 50 && s.tickets.get(ticket.id)?.status === 'active'; i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      s.tracker.stop();
    }
    expect(s.tickets.get(ticket.id)?.status).toBe('used');
    expect(sends(s.take(), 'sendMessage')).toHaveLength(1);
  });

  it("logs the owner's own codes once as foreign", async () => {
    const s = await ticketEnv();
    await issued(s);
    s.state.generate(STUDENT_CARD_ID); // from the phone app
    await s.tracker.tick();
    await s.tracker.tick();
    expect(s.audit.recent({ kind: 'foreign_code' })).toHaveLength(1);
  });

  it('survives Kyiv Digital outages and recovers on the next pass', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.state.validate(ticket.kdTicketId);
    s.mock.addFault({ kind: '503', remaining: 1 });
    await expect(s.tracker.tick()).resolves.toBeUndefined();
    expect(s.tickets.get(ticket.id)?.status).toBe('active');
    await s.tracker.tick();
    expect(s.tickets.get(ticket.id)?.status).toBe('used');
  });

  it('paces /qr and the feed separately: fast while fresh, otherwise idle', async () => {
    const s = await ticketEnv();
    const near = (ms: number) => expect(Math.abs(s.tracker.nextDelayMs() - ms)).toBeLessThan(2 * SEC);
    near(300 * SEC); // nothing to watch
    const { ticket } = await issued(s);
    near(30 * SEC); // issuing just listed the codes; /qr again in 30 s
    s.clock.advance(15 * MIN + SEC);
    near(300 * SEC); // unused but stale: /qr every 5 min
    expect(s.tracker.qrIntervalMs()).toBe(300 * SEC);

    s.state.validate(ticket.kdTicketId, { feedDelaySec: 3600 });
    await s.tracker.tick();
    expect(s.tickets.get(ticket.id)?.status).toBe('used');
    near(300 * SEC); // nothing active; the place search starts in 5 min
    s.clock.advance(2 * MIN);
    near(180 * SEC);
    s.clock.advance(3 * MIN);
    near(1 * SEC); // searchable now, never searched
    await s.tracker.tick();
    near(30 * SEC); // fresh scan: feed every 30 s
    s.clock.advance(10 * MIN + SEC);
    near(300 * SEC); // older than 15 min: every 5 min

    s.settings.set('poll_idle_interval_sec', 120, ADMIN_ID);
    near(120 * SEC);
  });

  it('skips an endpoint on a timer pass until its interval has passed', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    const before = qrCalls(s);
    await s.tracker.tick(false);
    expect(qrCalls(s)).toBe(before); // issuing listed the codes moments ago
    await s.tracker.tick(true);
    expect(qrCalls(s)).toBe(before + 1);

    s.state.validate(ticket.kdTicketId, { feedDelaySec: 3600 });
    await s.tracker.tick(true);
    s.clock.advance(5 * MIN);
    await s.tracker.tick(false);
    expect(feedCalls(s)).toBe(1);
    await s.tracker.tick(false);
    expect(feedCalls(s)).toBe(1);
  });

  it('varies the intervals by up to ±20%, re-rolled after each request', async () => {
    let r = 0;
    const s = await ticketEnv({ random: () => r });
    await issued(s); // the issue's code list rolls the /qr jitter
    expect(s.tracker.qrIntervalMs()).toBeCloseTo(24 * SEC, 3);
    r = 1;
    await s.tracker.tick();
    expect(s.tracker.qrIntervalMs()).toBeCloseTo(36 * SEC, 3);
    s.clock.advance(16 * MIN);
    expect(s.tracker.qrIntervalMs()).toBeCloseTo(360 * SEC, 3);
  });

  it('counts as live for the idle cadence plus max backoff, with slack', async () => {
    const s = await ticketEnv();
    expect(s.tracker.isLive()).toBe(false); // no pass yet
    await s.tracker.tick();
    const at = s.tracker.lastPassAt!;
    expect(s.tracker.isLive(at + 14 * 60 * SEC)).toBe(true); // 5 min idle + 5 backoff + 5 slack
    expect(s.tracker.isLive(at + 16 * 60 * SEC)).toBe(false);
    s.settings.set('poll_idle_interval_sec', 3600, ADMIN_ID);
    expect(s.tracker.isLive(at + 69 * 60 * SEC)).toBe(true);
  });

  it('wakes from the idle cadence when a ticket is issued', async () => {
    const s = await ticketEnv();
    s.tracker.start();
    try {
      // the first pass runs at once, then reschedules
      for (let i = 0; i < 50 && (s.tracker.nextPassAt ?? 0) - Date.now() < SEC; i++) await new Promise((r) => setTimeout(r, 20));
      expect(s.tracker.nextPassAt! - Date.now()).toBeGreaterThan(200 * SEC);
      await issued(s);
      expect(s.tracker.nextPassAt! - Date.now()).toBeLessThanOrEqual(30 * SEC);
    } finally {
      s.tracker.stop();
    }
  });

  it('stops polling with rejected credentials', async () => {
    const s = await ticketEnv();
    await issued(s);
    s.state.devToken.revoked = true;
    await s.tracker.tick(); // 401 → credentials invalid
    const n = s.mock.requests.length;
    await s.tracker.tick();
    expect(s.mock.requests).toHaveLength(n);
  });
});

describe('/dev clock', () => {
  it('shifts the shared clock to midnight and lets the tracker expire tickets', async () => {
    const clock = new OffsetClock(new FakeClock(Date.UTC(2026, 10, 7, 8)));
    const s = await ticketEnv({ clock });
    const admin = { id: ADMIN_ID, first_name: 'Admin', language_code: 'en' };
    const { ticket } = await issued(s);

    await s.text(admin, '/dev clock midnight');
    const batch = s.take();
    expect(s.textsTo(ADMIN_ID, batch)[0]).toContain('08.11.2026 00:00');
    expect(s.tickets.get(ticket.id)?.status).toBe('expired');

    await s.text(admin, '/dev clock reset');
    expect(clock.offsetMs).toBe(0);
  });

  it('is not available to regular users', async () => {
    const s = await ticketEnv();
    const u = s.user(5);
    await s.text(u, '/dev clock +1h');
    expect(s.textsTo(5, s.take())[0]).toContain('Unknown command');
  });
});
