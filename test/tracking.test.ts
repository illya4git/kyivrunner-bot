import { afterEach, describe, expect, it } from 'vitest';
import { OffsetClock } from '../src/core/clock.js';
import { MAX_PLACE_ATTEMPTS } from '../src/services/places.js';
import { STUDENT_CARD_ID } from '../mock/fixtures.js';
import { ADMIN_ID, FakeClock } from './helpers/services.js';
import { closeTicketEnvs, ticketEnv } from './helpers/ticket-env.js';
import type { ApiCall } from './helpers/telegram.js';

const SEC = 1000;
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

describe('TicketTracker', () => {
  it('notices a used ticket on its own and reports the place', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.clock.advance(HOUR);
    s.state.validate(ticket.kdTicketId, { mode: 'Метро', place: 'Хрещатик' });

    await s.tracker.tick();
    const batch = s.take();
    const caption = String(sends(batch, 'editMessageCaption')[0]?.payload.caption);
    expect(caption).toContain('used at 11:00');
    expect(caption).toContain('Метро, Хрещатик');
    const reply = sends(batch, 'sendMessage')[0]!;
    expect(reply.payload.reply_parameters).toMatchObject({ message_id: ticket.messageId });
    expect(String(reply.payload.text)).toContain('Метро, Хрещатик');
    expect(s.tickets.get(ticket.id)).toMatchObject({ status: 'used', place: 'Хрещатик', mode: 'Метро' });
  });

  it('shows "finding the place" while the feed lags, then edits caption and reply', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.state.validate(ticket.kdTicketId, { mode: 'Автобус', place: 'вул. Борщагівська', feedDelaySec: 45 });

    await s.tracker.tick();
    let batch = s.take();
    expect(String(sends(batch, 'sendMessage')[0]!.payload.text)).toContain('finding the place');
    const replyId = s.tickets.get(ticket.id)!.statusReplyId;

    s.clock.advance(45 * SEC);
    await s.tracker.tick();
    batch = s.take();
    expect(sends(batch, 'sendMessage')).toHaveLength(0); // no second notification
    expect(String(sends(batch, 'editMessageCaption')[0]!.payload.caption)).toContain('Автобус, вул. Борщагівська');
    const replyEdit = sends(batch, 'editMessageText')[0]!;
    expect(replyEdit.payload).toMatchObject({ message_id: replyId });
    expect(String(replyEdit.payload.text)).toContain('Автобус, вул. Борщагівська');
  });

  it('gives up on the place after the attempt budget and drops the "finding" note', async () => {
    const s = await ticketEnv();
    const { ticket } = await issued(s);
    s.state.validate(ticket.kdTicketId, { feedDelaySec: 100_000 });
    for (let i = 0; i < MAX_PLACE_ATTEMPTS; i++) {
      await s.tracker.tick();
      s.clock.advance(30 * SEC);
    }
    const batch = s.take();
    const lastReply = sends(batch, 'editMessageText').at(-1)!;
    expect(String(lastReply.payload.text)).not.toContain('finding');
    expect(s.audit.recent({ kind: 'place_unresolved' })).toHaveLength(1);
    await s.tracker.tick();
    expect(sends(s.take(), 'editMessageText')).toHaveLength(0); // done for good
  });

  it("matches the right validation: ignores a physical-card tap and another rider's scan", async () => {
    const s = await ticketEnv();
    const a = await issued(s, 5);
    const b = await issued(s, 6);
    s.state.foreignValidation(STUDENT_CARD_ID, { mode: 'Тролейбус', place: 'Площа Перемоги', atSec: Math.floor(s.clock.now() / 1000) - 60 });
    s.state.validate(a.ticket.kdTicketId, { mode: 'Метро', place: 'Лівобережна' });
    s.clock.advance(5 * SEC);
    s.state.validate(b.ticket.kdTicketId, { mode: 'Трамвай', place: 'Контрактова площа' });

    await s.tracker.tick();
    expect(s.tickets.get(a.ticket.id)).toMatchObject({ mode: 'Метро', place: 'Лівобережна' });
    expect(s.tickets.get(b.ticket.id)).toMatchObject({ mode: 'Трамвай', place: 'Контрактова площа' });
  });

  it("never steals another ticket's validation when its own is late in the feed", async () => {
    const s = await ticketEnv();
    const a = await issued(s, 5);
    const b = await issued(s, 6);
    s.state.validate(a.ticket.kdTicketId, { mode: 'Метро', place: 'Лівобережна' });
    s.clock.advance(5 * SEC);
    s.state.validate(b.ticket.kdTicketId, { mode: 'Метро', place: 'Хрещатик', feedDelaySec: 60 });

    await s.tracker.tick(); // A's event is visible and 5 s from B's used_at
    expect(s.tickets.get(a.ticket.id)?.place).toBe('Лівобережна');
    expect(s.tickets.get(b.ticket.id)?.place).toBeNull();

    s.clock.advance(60 * SEC);
    await s.tracker.tick();
    expect(s.tickets.get(b.ticket.id)?.place).toBe('Хрещатик');
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
