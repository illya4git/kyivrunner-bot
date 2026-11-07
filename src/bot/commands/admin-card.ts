import { Composer, InlineKeyboard } from 'grammy';
import { kyivDate } from '../../core/clock.js';
import type { Messages } from '../../i18n/index.js';
import { canGenerate, tripsLeft, type Card } from '../../kyiv/schemas.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';
import { kyivErrorText } from '../kyiv-errors.js';

const RATE_INFO_MAX_AGE_MS = 10 * 60_000;

/** Inline keyboard listing cards: cp:<id>. */
export function cardPicker(cards: Card[], activeId: number | null) {
  const kb = new InlineKeyboard();
  for (const c of cards) {
    kb.text(`${c.id === activeId ? '• ' : ''}💳 ${c.name ?? c.id} · ${maskCardNumber(c.code)} · ${tripsLeft(c)}`, `cp:${c.id}`).row();
  }
  return kb;
}

function maskCardNumber(code: string | null | undefined): string {
  return code ? `•••• ${code.slice(-4)}` : '—';
}

/**
 * /card — live card status from Kyiv Digital. Callback data:
 *   cd:r      refresh
 *   cd:c      show the card picker
 *   cp:<id>   make <id> the active card
 */
export function adminCardCommands(deps: BotDeps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  type View = { text: string; reply_markup?: InlineKeyboard };

  async function view(t: Messages): Promise<View> {
    const health = deps.credentials.health();
    if (health.state === 'missing' || health.state === 'invalid' || health.state === 'expired') {
      return { text: `${t.creds.states[health.state]}\n/credentials` };
    }
    let cards: Card[];
    try {
      cards = (await deps.kyiv.listCards()).cards;
    } catch (err) {
      return { text: kyivErrorText(t, err), reply_markup: new InlineKeyboard().text(t.card.btnRefresh, 'cd:r') };
    }
    const activeId = deps.settings.get('active_card_id');
    const card = cards.find((x) => x.id === activeId);
    if (!card) {
      return { text: `${activeId === null ? t.card.notSelected : t.card.notFound}\n${t.card.pickPrompt}`, reply_markup: cardPicker(cards, activeId) };
    }

    const rl = deps.kyiv.rateLimit;
    const rateFresh = rl.remaining !== null && deps.clock.now() - rl.at < RATE_INFO_MAX_AGE_MS;
    const validTo = card.monthly_tickets?.[0]?.valid_to;
    const kb = new InlineKeyboard().text(t.card.btnRefresh, 'cd:r');
    if (cards.length > 1) kb.text(t.card.btnChange, 'cd:c');
    return {
      text: t.card.view({
        name: card.name ?? String(card.id),
        number: maskCardNumber(card.code),
        trips: tripsLeft(card),
        validTo: validTo ? kyivDate(validTo * 1000) : undefined,
        activeCodes: card.qrs_count ?? 0,
        canGenerate: canGenerate(card),
        creds: t.creds.states[health.state],
        tokenExp: health.expiresAt ? kyivDate(health.expiresAt) : undefined,
        rate: rateFresh ? `${rl.remaining}/${rl.limit ?? '?'}` : undefined,
      }),
      reply_markup: kb,
    };
  }

  const opts = (v: View) => (v.reply_markup ? { reply_markup: v.reply_markup } : {});

  c.command('card', async (ctx) => {
    const v = await view(ctx.t);
    await ctx.reply(v.text, opts(v));
  });

  c.callbackQuery('cd:r', async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = await view(ctx.t);
    // "message is not modified" is fine: nothing changed since the last look.
    await ctx.editMessageText(v.text, opts(v)).catch(() => undefined);
  });

  c.callbackQuery('cd:c', async (ctx) => {
    try {
      const { cards } = await deps.kyiv.listCards();
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(ctx.t.card.pickPrompt, { reply_markup: cardPicker(cards, deps.settings.get('active_card_id')) });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: kyivErrorText(ctx.t, err), show_alert: true });
    }
  });

  c.callbackQuery(/^cp:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    let card: Card | undefined;
    try {
      card = (await deps.kyiv.listCards()).cards.find((x) => x.id === id);
    } catch (err) {
      return ctx.answerCallbackQuery({ text: kyivErrorText(ctx.t, err), show_alert: true });
    }
    if (!card) return ctx.answerCallbackQuery({ text: ctx.t.card.notFound, show_alert: true });
    const prev = deps.settings.set('active_card_id', id, ctx.user.tgId);
    deps.audit.log({ kind: 'setting_changed', tgId: ctx.user.tgId, role: ctx.user.role, data: { key: 'active_card_id', from: prev, to: id } });
    await ctx.answerCallbackQuery({ text: ctx.t.card.picked(card.name ?? String(id)) });
    const v = await view(ctx.t);
    await ctx.editMessageText(v.text, opts(v));
  });

  return c;
}
