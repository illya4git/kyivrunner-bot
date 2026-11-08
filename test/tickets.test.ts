import { afterEach, describe, expect, it } from 'vitest';
import { isKyivError } from '../src/kyiv/errors.js';
import { STUDENT_CARD_ID } from '../mock/fixtures.js';
import { ADMIN_ID } from './helpers/services.js';
import { closeTicketEnvs, ticketEnv } from './helpers/ticket-env.js';

const HOUR = 3_600_000;
afterEach(closeTicketEnvs);
const setup = () => ticketEnv();

describe('TicketService', () => {
  it('issues one ticket and reserves one trip; a repeat request returns the same ticket', async () => {
    const s = await setup();
    s.user(5);
    const first = await s.tickets.issue(s.row(5));
    expect(first.kind).toBe('issued');
    expect(s.trips()).toBe(35);

    const again = await s.tickets.issue(s.row(5));
    expect(again).toMatchObject({ kind: 'existing', ticket: { id: first.kind === 'issued' ? first.ticket.id : -1 } });
    expect(s.state.codeList()).toHaveLength(1);
    expect(s.trips()).toBe(35);
  });

  it('attributes codes correctly when two users ask at the same moment', async () => {
    const s = await setup();
    s.user(5);
    s.user(6);
    const [a, b] = await Promise.all([s.tickets.issue(s.row(5)), s.tickets.issue(s.row(6))]);
    expect(a.kind).toBe('issued');
    expect(b.kind).toBe('issued');
    if (a.kind !== 'issued' || b.kind !== 'issued') return;
    expect(a.ticket.kdTicketId).not.toBe(b.ticket.kdTicketId);
    for (const t of [a.ticket, b.ticket]) {
      expect(s.state.codeList().find((c) => c.id === t.kdTicketId)?.code).toBe(t.code);
    }
    expect(s.trips()).toBe(34);
  });

  it('never double-issues on a double tap', async () => {
    const s = await setup();
    s.user(5);
    const results = await Promise.all([s.tickets.issue(s.row(5)), s.tickets.issue(s.row(5))]);
    expect(results.map((r) => r.kind).sort()).toEqual(['existing', 'issued']);
    expect(s.state.codeList()).toHaveLength(1);
  });

  it('allows the next ticket once the previous is used, enforces the daily quota, resets at Kyiv midnight', async () => {
    const s = await setup();
    s.user(5);
    const t1 = await s.tickets.issue(s.row(5));
    s.clock.advance(HOUR);
    s.state.validate(t1.kind === 'issued' ? t1.ticket.kdTicketId : 0);

    const t2 = await s.tickets.issue(s.row(5));
    expect(t2).toMatchObject({ kind: 'issued', quota: { used: 2, limit: 2 } });
    expect(s.tickets.get(t1.kind === 'issued' ? t1.ticket.id : 0)?.status).toBe('used');

    s.clock.advance(HOUR);
    s.state.validate(t2.kind === 'issued' ? t2.ticket.kdTicketId : 0);
    const t3 = await s.tickets.issue(s.row(5));
    expect(t3).toMatchObject({ kind: 'denied', reason: 'quota', quota: { used: 2, limit: 2 } });
    expect(t3.kind === 'denied' && t3.inspectable?.id).toBe(t2.kind === 'issued' ? t2.ticket.id : -1);

    s.clock.advance(14 * HOUR); // 02:00 next day in Kyiv
    expect((await s.tickets.issue(s.row(5))).kind).toBe('issued');
  });

  it('has no per-user quota for admins, but the global cap still applies', async () => {
    const s = await setup();
    s.access.touch({ id: ADMIN_ID, first_name: 'Admin' });
    s.settings.set('default_daily_quota', 1, ADMIN_ID);
    s.settings.set('global_daily_cap', 3, ADMIN_ID);
    for (let i = 0; i < 3; i++) {
      const r = await s.tickets.issue(s.row(ADMIN_ID));
      expect(r).toMatchObject({ kind: 'issued', quota: { used: i + 1, limit: null } });
      s.state.validate(r.kind === 'issued' ? r.ticket.kdTicketId : 0);
    }
    expect(await s.tickets.issue(s.row(ADMIN_ID))).toMatchObject({ kind: 'denied', reason: 'global_cap' });
  });

  it('enforces the global cap, the trip reserve, and card/paused/credential preconditions', async () => {
    const s = await setup();
    s.user(5);
    s.user(6);
    s.settings.set('global_daily_cap', 1, ADMIN_ID);
    expect((await s.tickets.issue(s.row(5))).kind).toBe('issued');
    expect(await s.tickets.issue(s.row(6))).toMatchObject({ kind: 'denied', reason: 'global_cap' });
    s.settings.set('global_daily_cap', 10, ADMIN_ID);

    s.state.patchCard(STUDENT_CARD_ID, { trips: 4 }); // reserve_trips defaults to 4
    expect(await s.tickets.issue(s.row(6))).toMatchObject({ kind: 'denied', reason: 'reserve' });
    s.state.patchCard(STUDENT_CARD_ID, { trips: 5, blocked: true });
    expect(await s.tickets.issue(s.row(6))).toMatchObject({ kind: 'denied', reason: 'card_blocked' });
    s.state.patchCard(STUDENT_CARD_ID, { blocked: false });

    s.settings.set('paused', true, ADMIN_ID);
    expect(await s.tickets.issue(s.row(6))).toMatchObject({ kind: 'denied', reason: 'paused' });
    s.settings.set('paused', false, ADMIN_ID);
    s.settings.set('active_card_id', null, ADMIN_ID);
    expect(await s.tickets.issue(s.row(6))).toMatchObject({ kind: 'denied', reason: 'no_card' });
    s.settings.set('active_card_id', STUDENT_CARD_ID, ADMIN_ID);
    s.credentials.clear(ADMIN_ID);
    expect(await s.tickets.issue(s.row(6))).toMatchObject({ kind: 'denied', reason: 'no_credentials' });
  });

  it('recovers a code whose generate response was lost, instead of generating another', async () => {
    const s = await setup();
    s.user(5);
    s.mock.addFault({ kind: 'lost', remaining: 1, method: 'POST' });
    const res = await s.tickets.issue(s.row(5));
    expect(res.kind).toBe('issued');
    expect(s.state.codeList()).toHaveLength(1);
    expect(res.kind === 'issued' && res.ticket.kdTicketId).toBe(s.state.codeList()[0]!.id);
    expect(s.audit.recent({ kind: 'api_error' })[0]?.data).toMatchObject({ op: 'generate', recovered: true });
  });

  it('reports a generate that never reached the server, without recording a ticket', async () => {
    const s = await setup();
    s.user(5);
    s.mock.addFault({ kind: 'drop', remaining: 1, method: 'POST' });
    await expect(s.tickets.issue(s.row(5))).rejects.toSatisfy((e) => isKyivError(e, 'unavailable'));
    expect(s.tickets.history(5)).toHaveLength(0);
    expect(s.trips()).toBe(36);
  });

  it("does not adopt the owner's own codes", async () => {
    const s = await setup();
    s.user(5);
    const owner = s.state.generate(STUDENT_CARD_ID); // from the phone app
    const res = await s.tickets.issue(s.row(5));
    expect(res.kind === 'issued' && res.ticket.kdTicketId).not.toBe(owner.id);
  });

  it('expires an unused ticket after Kyiv midnight and returns the trip', async () => {
    const s = await setup();
    s.user(5);
    await s.tickets.issue(s.row(5));
    s.clock.advance(14 * HOUR);
    const transitions = await s.tickets.sync();
    expect(transitions.map((t) => t.to)).toEqual(['expired']);
    expect(s.trips()).toBe(36);
    expect(await s.tickets.sync()).toEqual([]); // claimed once
  });
});

describe('bot: /qr and the single ticket message', () => {
  it('sends a protected QR photo once, then replies to it on repeat requests', async () => {
    const s = await setup();
    const u = s.user(5);
    await s.text(u, '/qr');
    let batch = s.take();
    const photos = s.photosTo(5, batch);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.payload).toMatchObject({ protect_content: true });
    expect(String(photos[0]!.payload.caption)).toContain('Today: 1/2');
    expect(JSON.stringify(photos[0]!.payload.reply_markup)).toContain('tk:r:');
    const photoId = s.tickets.history(5)[0]!.messageId;

    await s.text(u, '🎫 QR');
    batch = s.take();
    expect(s.photosTo(5, batch)).toHaveLength(0);
    const pointer = batch.find((c) => c.method === 'sendMessage')!;
    expect(pointer.payload.reply_parameters).toMatchObject({ message_id: photoId, allow_sending_without_reply: false });
    expect(String(pointer.payload.text)).toContain('above');
  });

  it('re-sends the QR only when the user deleted the message', async () => {
    const s = await setup();
    const u = s.user(5);
    await s.text(u, '/qr');
    s.deleted.add(s.tickets.history(5)[0]!.messageId!);
    s.take();

    await s.text(u, '/qr');
    const batch = s.take();
    const photos = s.photosTo(5, batch);
    expect(photos).toHaveLength(1);
    expect(String(photos[0]!.payload.caption)).toContain('previous message was deleted');
    expect(s.tickets.history(5)[0]).toMatchObject({ resendCount: 1, messageGone: false });
    expect(s.state.codeList()).toHaveLength(1); // same code, nothing new generated

    await s.text(u, '/qr');
    expect(s.photosTo(5, s.take())).toHaveLength(0); // points to the re-sent one
  });

  it('on use: edits only the caption (QR stays for conductors) and replies for a notification', async () => {
    const s = await setup();
    const u = s.user(5, 'uk');
    await s.text(u, '/qr');
    const t = s.tickets.history(5)[0]!;
    s.take();

    s.clock.advance(HOUR);
    s.state.validate(t.kdTicketId);
    await s.press(u, `tk:r:${t.id}`);
    const batch = s.take();
    expect(batch.some((c) => c.method === 'editMessageMedia')).toBe(false);
    const edit = batch.find((c) => c.method === 'editMessageCaption')!;
    expect(edit.payload).toMatchObject({ message_id: t.messageId });
    expect(String(edit.payload.caption)).toContain('використано о 11:00');
    const reply = batch.find((c) => c.method === 'sendMessage')!;
    expect(reply.payload.reply_parameters).toMatchObject({ message_id: t.messageId });
    expect(String(reply.payload.text)).toContain('✅');
    expect(batch.find((c) => c.method === 'answerCallbackQuery')?.payload.text).toContain('11:00');
  });

  it('on expiry: swaps the image for a placeholder and replies', async () => {
    const s = await setup();
    const u = s.user(5);
    await s.text(u, '/qr');
    const t = s.tickets.history(5)[0]!;
    s.take();

    s.clock.advance(14 * HOUR);
    await s.text(u, '/status');
    const batch = s.take();
    const media = batch.find((c) => c.method === 'editMessageMedia')!;
    expect(media.payload).toMatchObject({ message_id: t.messageId, media: { type: 'photo' } });
    expect(String((media.payload.media as { caption: string }).caption)).toContain('not used');
    const reply = batch.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('⌛'))!;
    expect(reply.payload.reply_parameters).toMatchObject({ message_id: t.messageId });
  });

  it('notifies with a standalone message when the ticket message is gone', async () => {
    const s = await setup();
    const u = s.user(5);
    await s.text(u, '/qr');
    const t = s.tickets.history(5)[0]!;
    s.deleted.add(t.messageId!);
    s.take();

    s.state.validate(t.kdTicketId);
    await s.tickets.sync();
    const batch = s.take();
    const reply = batch.find((c) => c.method === 'sendMessage')!;
    expect(reply.payload.reply_parameters).toBeUndefined();
    expect(String(reply.payload.text)).toContain('was used');
    expect(s.tickets.get(t.id)?.messageGone).toBe(true);
  });

  it('after the quota is used up, points to the used ticket for inspection', async () => {
    const s = await setup();
    const u = s.user(5);
    s.access.setQuota(5, 1, ADMIN_ID);
    await s.text(u, '/qr');
    const t = s.tickets.history(5)[0]!;
    s.state.validate(t.kdTicketId);
    s.take();

    await s.text(u, '/qr');
    const texts = s.textsTo(5, s.take());
    expect(texts.some((x) => x.includes('was used at') && x.includes('conductor'))).toBe(true);
    expect(texts.some((x) => x.includes('limit is used up (1/1)'))).toBe(true);
  });

  it('shows history and protects the refresh button', async () => {
    const s = await setup();
    const u = s.user(5);
    await s.text(u, '/qr');
    const t = s.tickets.history(5)[0]!;
    s.state.validate(t.kdTicketId);
    await s.tickets.sync();
    await s.text(u, '/qr');
    s.take();

    await s.text(u, '/history');
    const text = s.textsTo(5, s.take())[0]!;
    expect(text).toContain('🎫');
    expect(text).toContain('✅');

    const other = s.user(6);
    await s.press(other, `tk:r:${t.id}`);
    expect(s.take().find((c) => c.method === 'answerCallbackQuery')?.payload).toMatchObject({ show_alert: true, text: 'This is not your ticket.' });
  });

  it('explains API failures', async () => {
    const s = await setup();
    const u = s.user(5);
    s.mock.addFault({ kind: '503', remaining: 1 });
    await s.text(u, '/qr');
    expect(s.textsTo(5, s.take()).join()).toContain('unavailable');
    expect(s.audit.recent({ kind: 'api_error' })[0]?.data).toMatchObject({ op: 'issue', kind: 'unavailable' });
  });
});
