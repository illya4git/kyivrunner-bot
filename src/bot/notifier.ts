import type { Api, RawApi } from 'grammy';
import type { InlineKeyboardMarkup, ReplyKeyboardMarkup, ReplyKeyboardRemove } from 'grammy/types';
import type { Logger } from '../core/logger.js';
import type { UserRow } from '../db/schema.js';
import { messages, type Messages } from '../i18n/index.js';
import type { AccessService } from '../services/access.js';

export type Outgoing = {
  text: string;
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;
};

/** Sends localized messages to users and admins. Delivery failures are logged, never thrown. */
export class Notifier {
  constructor(
    private readonly api: Api<RawApi>,
    private readonly access: AccessService,
    private readonly log: Logger,
  ) {}

  async toUser(user: Pick<UserRow, 'tgId' | 'locale'>, build: (t: Messages) => Outgoing): Promise<number | null> {
    const msg = build(messages(user.locale));
    try {
      const sent = await this.api.sendMessage(user.tgId, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {});
      return sent.message_id;
    } catch (err) {
      this.log.warn({ err, tgId: user.tgId }, 'failed to deliver message');
      return null;
    }
  }

  /** Send to every admin in their own language. Returns admins that received it. */
  async toAdmins(build: (t: Messages) => Outgoing): Promise<number[]> {
    const delivered: number[] = [];
    for (const id of this.access.adminIds()) {
      const admin = this.access.get(id);
      if (!admin) continue;
      if ((await this.toUser(admin, build)) !== null) delivered.push(id);
    }
    return delivered;
  }
}
