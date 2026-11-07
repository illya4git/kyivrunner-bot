import { Composer, InlineKeyboard } from 'grammy';
import { kyivDate, kyivDateTime } from '../../core/clock.js';
import { looksLikeJwt } from '../../core/crypto.js';
import { displayName, type Messages } from '../../i18n/index.js';
import { isKyivError } from '../../kyiv/errors.js';
import type { Card } from '../../kyiv/schemas.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';
import { kyivErrorText } from '../kyiv-errors.js';
import { cardPicker } from './admin-card.js';

const ENTRY_TTL_MS = 10 * 60_000;

type Entry = { step: 'token' | 'device'; token?: string; exp?: number | null; touchedAt: number };

/**
 * Credential entry and management.
 *
 *  - credentialEntry(): runs right after the core middleware. While an admin is entering
 *    credentials, it consumes their text messages and deletes each one immediately.
 *  - jwtGuard(): deletes any other message that contains something JWT-shaped.
 *  - adminCredentialCommands(): /credentials [set|check|clear], /cancel and buttons:
 *      cr:set  cr:check  cr:clear  cr:clear!  cr:back
 */
export function credentialFlows(deps: BotDeps) {
  const entries = new Map<number, Entry>();

  function entryFor(tgId: number): Entry | undefined {
    const e = entries.get(tgId);
    if (e && deps.clock.now() - e.touchedAt > ENTRY_TTL_MS) {
      entries.delete(tgId);
      return undefined;
    }
    return e;
  }

  async function deleteQuietly(ctx: BotContext) {
    await ctx.deleteMessage().catch((err: unknown) => deps.log.warn({ err }, 'could not delete a message with a secret'));
  }

  // --- views ---------------------------------------------------------------------

  function view(t: Messages) {
    const h = deps.credentials.health();
    const by = h.addedBy !== undefined ? deps.access.get(h.addedBy) : undefined;
    const text = t.creds.view({
      state: t.creds.states[h.state],
      token: h.maskedToken,
      device: h.maskedDevice,
      subject: h.subject,
      expires: h.expiresAt ? kyivDate(h.expiresAt) : undefined,
      added: h.addedAt ? kyivDateTime(h.addedAt) : undefined,
      addedBy: by ? displayName(by) : undefined,
      lastOk: h.lastOkAt ? kyivDateTime(h.lastOkAt) : undefined,
      lastError: h.lastError ? `${h.lastErrorAt ? kyivDateTime(h.lastErrorAt) + ' — ' : ''}${h.lastError}` : undefined,
    });
    const kb = new InlineKeyboard().text(t.creds.btnSet, 'cr:set');
    if (h.state !== 'missing') kb.text(t.creds.btnCheck, 'cr:check').row().text(t.creds.btnClear, 'cr:clear');
    return { text, reply_markup: kb };
  }

  async function startEntry(ctx: BotContext) {
    entries.set(ctx.user.tgId, { step: 'token', touchedAt: deps.clock.now() });
    await ctx.reply(ctx.t.creds.askToken);
  }

  /** After saving: keep the active card if still present, auto-pick a single card, else ask. */
  async function afterSave(ctx: BotContext, cards: Card[]) {
    const t = ctx.t;
    if (cards.length === 0) return ctx.reply(t.creds.noCards);
    const active = deps.settings.get('active_card_id');
    const current = cards.find((c) => c.id === active);
    if (current) return ctx.reply(t.card.picked(current.name ?? String(current.id)));
    if (cards.length === 1) {
      const only = cards[0]!;
      deps.settings.set('active_card_id', only.id, ctx.user.tgId);
      deps.audit.log({ kind: 'setting_changed', tgId: ctx.user.tgId, role: ctx.user.role, data: { key: 'active_card_id', from: active, to: only.id } });
      return ctx.reply(t.card.picked(only.name ?? String(only.id)));
    }
    return ctx.reply(t.card.pickPrompt, { reply_markup: cardPicker(cards, active) });
  }

  // --- entry state machine ---------------------------------------------------------

  const credentialEntry = new Composer<BotContext>();
  credentialEntry.on('message:text', async (ctx, next) => {
    if (ctx.user.role !== 'admin') return next();
    const e = entryFor(ctx.user.tgId);
    if (!e) return next();
    const text = ctx.message.text.trim();
    if (text.startsWith('/') && !looksLikeJwt(text)) {
      // Any command ends the flow; /cancel is answered by its own handler.
      entries.delete(ctx.user.tgId);
      return next();
    }

    await deleteQuietly(ctx);
    const t = ctx.t;
    e.touchedAt = deps.clock.now();

    if (e.step === 'token') {
      const check = deps.credentials.checkToken(text);
      if (!check.ok) return ctx.reply(check.reason === 'expired' ? t.creds.expiredToken : t.creds.badToken);
      Object.assign(e, { step: 'device', token: text, exp: check.exp });
      return ctx.reply(t.creds.askDevice(check.exp ? kyivDate(check.exp) : t.creds.tokenNoExp));
    }

    if (!deps.credentials.checkDeviceUuid(text)) return ctx.reply(t.creds.badDevice);
    const status = await ctx.reply(t.creds.probing);
    const edit = (s: string) => ctx.api.editMessageText(status.chat.id, status.message_id, s);
    const creds = { accessToken: e.token!, deviceUuid: text };
    let cards: Card[];
    try {
      cards = await deps.credentials.probe(creds);
    } catch (err) {
      if (isKyivError(err, 'unauthorized')) {
        entries.delete(ctx.user.tgId);
        return edit(t.creds.probeUnauthorized);
      }
      deps.audit.log({ kind: 'api_error', tgId: ctx.user.tgId, role: ctx.user.role, data: { op: 'credentials_probe', kind: isKyivError(err) ? err.kind : 'unknown' } });
      return edit(t.creds.probeFailed(kyivErrorText(t, err)));
    }
    entries.delete(ctx.user.tgId);
    deps.credentials.save(creds, ctx.user.tgId);
    await edit(t.creds.saved(cards.length));
    await afterSave(ctx, cards);
  });

  // --- token guard ---------------------------------------------------------------------

  const jwtGuard = new Composer<BotContext>();
  jwtGuard.on(['message:text', 'message:caption'], async (ctx, next) => {
    const text = ctx.message.text ?? ctx.message.caption ?? '';
    if (!looksLikeJwt(text)) return next();
    await deleteQuietly(ctx);
    await ctx.reply(ctx.t.creds.tokenDeleted);
  });

  // --- commands ------------------------------------------------------------------------

  const commands = new Composer<BotContext>();

  commands.command('credentials', async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (arg === 'set') return startEntry(ctx);
    if (arg === 'check') return check(ctx);
    if (arg === 'clear') return ctx.reply(ctx.t.creds.clearConfirm, { reply_markup: clearConfirm(ctx.t) });
    const v = view(ctx.t);
    return ctx.reply(v.text, { reply_markup: v.reply_markup });
  });

  commands.command('cancel', (ctx) => {
    entries.delete(ctx.user.tgId);
    return ctx.reply(ctx.t.creds.cancelled);
  });

  commands.callbackQuery('cr:set', async (ctx) => {
    await ctx.answerCallbackQuery();
    await startEntry(ctx);
  });

  commands.callbackQuery('cr:check', async (ctx) => {
    await ctx.answerCallbackQuery();
    await check(ctx);
    const v = view(ctx.t);
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup }).catch(() => undefined);
  });

  commands.callbackQuery('cr:clear', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ctx.t.creds.clearConfirm, { reply_markup: clearConfirm(ctx.t) });
  });

  commands.callbackQuery('cr:clear!', async (ctx) => {
    deps.credentials.clear(ctx.user.tgId);
    await ctx.answerCallbackQuery({ text: ctx.t.creds.cleared });
    const v = view(ctx.t);
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
  });

  commands.callbackQuery('cr:back', async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = view(ctx.t);
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
  });

  async function check(ctx: BotContext) {
    if (deps.credentials.health().state === 'missing') return ctx.reply(ctx.t.creds.states.missing);
    try {
      const cards = await deps.credentials.recheck(ctx.user.tgId);
      await ctx.reply(ctx.t.creds.checkOk);
      await afterSave(ctx, cards);
    } catch (err) {
      await ctx.reply(kyivErrorText(ctx.t, err));
    }
  }

  function clearConfirm(t: Messages) {
    return new InlineKeyboard().text(t.creds.btnClearConfirm, 'cr:clear!').text(t.creds.btnCancel, 'cr:back');
  }

  return { credentialEntry, jwtGuard, commands };
}
