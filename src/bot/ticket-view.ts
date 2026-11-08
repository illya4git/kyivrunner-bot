import { GrammyError, InlineKeyboard, InputFile, type Api, type RawApi } from 'grammy';
import { kyivDate, kyivTime } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { TicketRow, UserRow } from '../db/schema.js';
import { messages, type Messages } from '../i18n/index.js';
import { placeholderPng } from '../qr/placeholder.js';
import { renderQr } from '../qr/render.js';
import type { AccessService } from '../services/access.js';
import type { AuditService } from '../services/audit.js';
import { placePending } from '../services/places.js';
import { formatPlace } from './place.js';
import type { Quota, TicketPresenter, TicketService, TicketTransition } from '../services/tickets.js';

const REPLY_TARGET_GONE = /message to be replied not found|replied message not found/i;
const EDIT_TARGET_GONE = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i;
const NOT_MODIFIED = /message is not modified/i;

const NO_BUTTONS = { inline_keyboard: [] };

/**
 * Owns the single Telegram message of each ticket (PLAN.md D10, D12, D14):
 *  - send once; a repeat request replies to it; re-send only if the user deleted it;
 *  - status changes edit that message AND reply to it (edits alone don't notify);
 *  - "used" keeps the QR image (conductors may re-scan); "expired" swaps in a placeholder.
 */
export class TicketView implements TicketPresenter {
  constructor(
    private readonly api: Api<RawApi>,
    private readonly tickets: TicketService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly log: Logger,
  ) {}

  private t(tgId: number): Messages {
    return messages(this.access.get(tgId)?.locale ?? 'uk');
  }

  private label(ticket: TicketRow): string {
    return ticket.label ?? 'QR';
  }

  /** Caption + keyboard for the ticket's current state. */
  private present(t: Messages, ticket: TicketRow, opts: { quota?: Quota; resent?: boolean } = {}) {
    const until = kyivTime(ticket.expireAt);
    if (ticket.status === 'used') {
      return {
        caption: t.tickets.captionUsed({
          label: this.label(ticket),
          time: kyivTime(ticket.usedAt ?? ticket.issuedAt),
          place: placeOrPending(t, ticket),
          until,
          resent: opts.resent ?? false,
        }),
        reply_markup: undefined,
      };
    }
    const quota = opts.quota ?? { used: 0, limit: 0 };
    return {
      caption: t.tickets.caption({
        label: this.label(ticket),
        until,
        date: kyivDate(ticket.expireAt),
        used: quota.used,
        limit: quota.limit,
        resent: opts.resent ?? false,
      }),
      reply_markup: new InlineKeyboard().text(t.tickets.btnRefresh, `tk:r:${ticket.id}`),
    };
  }

  /** Send the QR as a new message and remember it as the ticket's message. */
  async send(user: UserRow, ticket: TicketRow, quota: Quota, resent = false): Promise<void> {
    const t = messages(user.locale);
    const { caption, reply_markup } = this.present(t, ticket, { quota, resent });
    const msg = await this.api.sendPhoto(user.tgId, new InputFile(await renderQr(ticket.code), 'ticket.png'), {
      caption,
      protect_content: true,
      ...(reply_markup ? { reply_markup } : {}),
    });
    this.tickets.setMessage(ticket.id, msg.chat.id, msg.message_id, resent);
    if (resent) this.audit.log({ kind: 'ticket_resent', tgId: user.tgId, role: user.role, data: { ticket: ticket.id } });
  }

  /**
   * Point the user at the ticket's existing message by replying to it. Telegram doesn't
   * report deletions in private chats, so the reply attempt doubles as the existence check:
   * if the message is gone, re-send the QR once.
   */
  async point(user: UserRow, ticket: TicketRow, quota: Quota): Promise<void> {
    const t = messages(user.locale);
    const quotaLine = t.tickets.quotaLine(quota.used, quota.limit);
    const text =
      ticket.status === 'used'
        ? t.tickets.pointerUsed(kyivTime(ticket.usedAt ?? ticket.issuedAt), quotaLine)
        : t.tickets.pointer(kyivTime(ticket.expireAt), quotaLine);

    if (ticket.messageId !== null && !ticket.messageGone) {
      try {
        await this.api.sendMessage(user.tgId, text, { reply_parameters: { message_id: ticket.messageId, allow_sending_without_reply: false } });
        this.audit.log({ kind: 'ticket_pointed', tgId: user.tgId, role: user.role, data: { ticket: ticket.id } });
        return;
      } catch (err) {
        if (!isTelegramError(err, REPLY_TARGET_GONE)) throw err;
        this.tickets.markMessageGone(ticket.id);
      }
    }
    await this.send(user, ticket, quota, true);
  }

  /** Render a status change: edit the ticket message, then reply to it for a notification. */
  async transition(tr: TicketTransition): Promise<void> {
    const { ticket } = tr;
    const t = this.t(ticket.userTgId);

    let edited = false;
    if (ticket.chatId !== null && ticket.messageId !== null && !ticket.messageGone) {
      edited = await this.editForStatus(t, ticket);
      if (!edited) this.tickets.markMessageGone(ticket.id);
    }

    const text = tr.to === 'used' ? this.usedReply(t, ticket) : t.tickets.expiredReply;
    const reply = await this.api.sendMessage(
      ticket.userTgId,
      text,
      edited ? { reply_parameters: { message_id: ticket.messageId!, allow_sending_without_reply: true } } : {},
    );
    this.tickets.setStatusReply(ticket.id, reply.message_id);
  }

  /** The place lookup finished (found or gave up): refresh the caption and the status reply. */
  async placeUpdated(ticket: TicketRow): Promise<void> {
    const t = this.t(ticket.userTgId);
    if (ticket.chatId !== null && ticket.messageId !== null && !ticket.messageGone) {
      const caption = ticket.imageRetired ? this.finalCaption(t, ticket) : this.present(t, ticket).caption;
      const ok = await this.quietEdit(() => this.api.editMessageCaption(ticket.chatId!, ticket.messageId!, { caption, reply_markup: NO_BUTTONS }));
      if (!ok) this.tickets.markMessageGone(ticket.id);
    }
    if (ticket.statusReplyId !== null) {
      await this.quietEdit(() => this.api.editMessageText(ticket.userTgId, ticket.statusReplyId!, this.usedReply(t, ticket)));
    }
  }

  /** After midnight a used QR is worthless: swap it for the placeholder, without notifying. */
  async retireImage(ticket: TicketRow): Promise<void> {
    if (ticket.chatId === null || ticket.messageId === null || ticket.messageGone) return;
    const t = this.t(ticket.userTgId);
    const ok = await this.quietEdit(() =>
      this.api.editMessageMedia(
        ticket.chatId!,
        ticket.messageId!,
        { type: 'photo', media: new InputFile(placeholderPng('used'), 'used.png'), caption: this.finalCaption(t, ticket), parse_mode: 'HTML' },
        { reply_markup: NO_BUTTONS },
      ),
    );
    if (!ok) this.tickets.markMessageGone(ticket.id);
  }

  private usedReply(t: Messages, ticket: TicketRow): string {
    return t.tickets.usedReply(kyivTime(ticket.usedAt ?? ticket.issuedAt), placeOrPending(t, ticket));
  }

  private finalCaption(t: Messages, ticket: TicketRow): string {
    const at = ticket.usedAt ?? ticket.issuedAt;
    return t.tickets.captionUsedFinal({ label: this.label(ticket), date: kyivDate(at), time: kyivTime(at), place: placeText(ticket) });
  }

  /** Run an edit; "not modified" counts as success. Returns false only if the message is gone. */
  private async quietEdit(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      if (isTelegramError(err, NOT_MODIFIED)) return true;
      if (isTelegramError(err, EDIT_TARGET_GONE)) return false;
      this.log.error({ err }, 'failed to edit a ticket message');
      return true;
    }
  }

  /** Returns false if the message no longer exists. */
  private async editForStatus(t: Messages, ticket: TicketRow): Promise<boolean> {
    const chat = ticket.chatId!;
    const msg = ticket.messageId!;
    try {
      if (ticket.status === 'used') {
        // Keep the QR image: conductors may need to re-scan it until midnight.
        await this.api.editMessageCaption(chat, msg, { caption: this.present(t, ticket).caption, reply_markup: NO_BUTTONS });
      } else {
        await this.api.editMessageMedia(
          chat,
          msg,
          {
            type: 'photo',
            media: new InputFile(placeholderPng('expired'), 'expired.png'),
            caption: t.tickets.captionExpired({ label: this.label(ticket), date: kyivDate(ticket.expireAt) }),
            parse_mode: 'HTML',
          },
          { reply_markup: NO_BUTTONS },
        );
      }
      return true;
    } catch (err) {
      if (isTelegramError(err, NOT_MODIFIED)) return true;
      if (isTelegramError(err, EDIT_TARGET_GONE)) return false;
      this.log.error({ err, ticket: ticket.id }, 'failed to edit a ticket message');
      return true; // unknown failure: still reply to the message rather than dropping the notice
    }
  }
}

function placeOrPending(t: Messages, ticket: TicketRow): string | undefined {
  return placeText(ticket) ?? (placePending(ticket) ? `📍 ${t.tickets.placePending}` : undefined);
}

function placeText(ticket: TicketRow): string | undefined {
  return formatPlace(ticket.mode, ticket.place);
}

function isTelegramError(err: unknown, re: RegExp): boolean {
  return err instanceof GrammyError && re.test(err.description);
}
