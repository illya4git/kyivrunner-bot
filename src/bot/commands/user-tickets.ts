import { Composer } from 'grammy';
import { kyivDate, kyivTime } from '../../core/clock.js';
import type { TicketRow } from '../../db/schema.js';
import type { Messages } from '../../i18n/index.js';
import { isKyivError } from '../../kyiv/errors.js';
import type { IssueResult } from '../../services/tickets.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';
import { kyivErrorText } from '../kyiv-errors.js';
import type { TicketView } from '../ticket-view.js';
import { uk } from '../../i18n/uk.js';
import { en } from '../../i18n/en.js';
import { formatPlace } from '../place.js';

/** The reply-keyboard button, in every language. */
const QR_BUTTONS = [...new Set([uk.keyboard.qr, en.keyboard.qr])];

/**
 * /qr (and the 🎫 button), /status, /history, and the 🔄 button on ticket messages (tk:r:<id>).
 */
export function userTicketCommands(deps: BotDeps, view: TicketView): Composer<BotContext> {
  const c = new Composer<BotContext>();
  const { tickets } = deps;

  async function apiFailure(ctx: BotContext, err: unknown, op: string) {
    if (!isKyivError(err)) throw err;
    deps.audit.log({ kind: 'api_error', tgId: ctx.user.tgId, role: ctx.user.role, data: { op, kind: err.kind, status: err.details.status ?? null } });
    await ctx.reply(kyivErrorText(ctx.t, err));
  }

  async function qr(ctx: BotContext) {
    await ctx.replyWithChatAction('upload_photo').catch(() => undefined);
    let res: IssueResult;
    try {
      res = await tickets.issue(ctx.user);
    } catch (err) {
      return apiFailure(ctx, err, 'issue');
    }
    switch (res.kind) {
      case 'issued':
        return view.send(ctx.user, res.ticket, res.quota);
      case 'existing':
        return view.point(ctx.user, res.ticket, res.quota);
      case 'denied':
        if (res.inspectable) await view.point(ctx.user, res.inspectable, res.quota);
        return ctx.reply(deniedText(ctx.t, res));
    }
  }

  c.command('qr', qr);
  c.hears(QR_BUTTONS, qr);

  c.command('status', async (ctx) => {
    try {
      await tickets.sync();
    } catch (err) {
      if (!isKyivError(err)) throw err;
      deps.log.warn({ kind: err.kind }, 'status refresh failed; showing stored state');
    }
    const quota = tickets.quota(ctx.user);
    const ticket = tickets.activeFor(ctx.user.tgId) ?? tickets.inspectableFor(ctx.user.tgId);
    if (ticket) return view.point(ctx.user, ticket, quota);
    return ctx.reply(ctx.t.tickets.noActive(ctx.t.tickets.quotaLine(quota.used, quota.limit)));
  });

  c.command('history', (ctx) => {
    const rows = tickets.history(ctx.user.tgId, 10);
    const t = ctx.t;
    if (rows.length === 0) return ctx.reply(t.tickets.historyEmpty);
    return ctx.reply([t.tickets.historyHeader, '', ...rows.map((r) => historyLine(t, r))].join('\n'));
  });

  c.callbackQuery(/^tk:r:(\d+)$/, async (ctx) => {
    const ticket = tickets.get(Number(ctx.match[1]));
    if (!ticket || ticket.userTgId !== ctx.user.tgId) return ctx.answerCallbackQuery({ text: ctx.t.tickets.notYours, show_alert: true });
    if (ticket.status === 'active') {
      try {
        await tickets.sync(); // a transition edits the message and replies on its own
      } catch (err) {
        if (!isKyivError(err)) throw err;
        return ctx.answerCallbackQuery({ text: kyivErrorText(ctx.t, err), show_alert: true });
      }
    }
    const now = tickets.get(ticket.id)!;
    const t = ctx.t.tickets;
    await ctx.answerCallbackQuery({
      text: now.status === 'used' ? t.toastUsed(kyivTime(now.usedAt ?? now.issuedAt)) : now.status === 'expired' ? t.toastExpired : t.toastActive,
    });
  });

  return c;
}

function deniedText(t: Messages, res: Extract<IssueResult, { kind: 'denied' }>): string {
  if (res.reason === 'quota') return t.tickets.denied.quota(res.quota.used, res.quota.limit ?? 0);
  return t.tickets.denied[res.reason];
}

function historyLine(t: Messages, r: TicketRow): string {
  const date = kyivDate(r.issuedAt);
  if (r.status === 'active') return t.tickets.historyActive(date, kyivTime(r.expireAt));
  if (r.status === 'expired') return t.tickets.historyExpired(date);
  const place = formatPlace(r.mode, r.place);
  return t.tickets.historyUsed(date, kyivTime(r.usedAt ?? r.issuedAt), place);
}
