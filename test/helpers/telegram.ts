import type { Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../../src/bot/bot.js';
import { telegramHtmlError } from './telegram-html.js';
import type { Services } from '../../src/bot/context.js';

export type ApiCall = { method: string; payload: Record<string, unknown> };

export const BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

/**
 * A bot wired to a fake Telegram API. Every outgoing call is recorded in `calls`
 * and answered with a plausible result, so handlers run end-to-end without network.
 */
export function makeTestBot(services: Services) {
  const calls: ApiCall[] = [];
  let nextMessageId = 1;
  let nextUpdateId = 1;
  let nextFileId = 1;
  /** Methods to fail on purpose: method → Telegram error description. */
  const failures = new Map<string, string>();
  /** Targeted failures: return a Telegram error description to fail that call. */
  const failIf: ((method: string, payload: Record<string, unknown>) => string | null)[] = [];
  /** Message ids the "user" deleted: replies to / edits of them fail like in Telegram. */
  const deleted = new Set<number>();

  const fake: Transformer = async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, payload: p });
    const failure = failures.get(method) ?? failIf.map((f) => f(method, p)).find((x) => x) ?? simulateDeleted(method, p);
    if (failure) return { ok: false, error_code: 400, description: failure } as never;
    // Validate HTML exactly where Telegram would, so markup bugs fail tests instead of production.
    const checks: [string, unknown, unknown][] = [
      ['text', p.text, p.parse_mode],
      ['caption', p.caption, p.parse_mode],
      ['media.caption', (p.media as Record<string, unknown> | undefined)?.caption, (p.media as Record<string, unknown> | undefined)?.parse_mode],
    ];
    for (const [field, value, mode] of checks) {
      const err = mode === 'HTML' && typeof value === 'string' ? telegramHtmlError(value) : null;
      if (err) throw new Error(`Telegram would reject ${method}.${field}: ${err}\n---\n${value}`);
    }
    const chat = { id: Number(p.chat_id ?? 0), type: 'private' as const };
    // Photos get a file id: the one sent (a reuse), or a new one for an upload.
    const media = p.media as Record<string, unknown> | undefined;
    const sentPhoto = method === 'sendPhoto' ? p.photo : method === 'editMessageMedia' ? media?.media : undefined;
    const photo =
      sentPhoto === undefined ? undefined : [{ file_id: typeof sentPhoto === 'string' ? sentPhoto : `file-${nextFileId++}`, file_unique_id: 'u', width: 640, height: 640 }];
    const message = photo
      ? { message_id: method === 'sendPhoto' ? nextMessageId++ : Number(p.message_id), date: 0, chat, photo, caption: p.caption ?? media?.caption }
      : { message_id: nextMessageId++, date: 0, chat, text: p.text };
    const result = method.startsWith('send') || method.startsWith('edit') ? message : true;
    return { ok: true, result } as never;
  };

  function simulateDeleted(method: string, p: Record<string, unknown>): string | null {
    const reply = (p.reply_parameters as { message_id?: number; allow_sending_without_reply?: boolean } | undefined) ?? undefined;
    if (reply?.message_id !== undefined && deleted.has(reply.message_id) && !reply.allow_sending_without_reply) {
      return 'Bad Request: message to be replied not found';
    }
    if (method.startsWith('edit') && typeof p.message_id === 'number' && deleted.has(p.message_id)) {
      return 'Bad Request: message to edit not found';
    }
    return null;
  }

  const { bot, deps } = createBot({ token: 'test:token-0000000000000000', services, devMode: true, botInfo: BOT_INFO, offline: true, transformers: [fake] });
  // Production swallows handler errors (logs + "something went wrong"); tests must see them.
  bot.catch((e) => {
    throw e.error;
  });

  type From = { id: number; first_name?: string; username?: string; language_code?: string };
  const user = (f: From) => ({ is_bot: false, first_name: f.first_name ?? `U${f.id}`, ...f });

  async function text(from: From, text: string): Promise<void> {
    const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/, 1)[0]!.length }] : undefined;
    const update: Update = {
      update_id: nextUpdateId++,
      message: { message_id: nextMessageId++, date: 0, chat: { id: from.id, type: 'private', first_name: 'x' }, from: user(from), text, ...(entities ? { entities } : {}) },
    };
    await bot.handleUpdate(update);
  }

  async function press(from: From, data: string, messageText = ''): Promise<void> {
    const update: Update = {
      update_id: nextUpdateId++,
      callback_query: {
        id: String(nextUpdateId),
        from: user(from),
        chat_instance: '1',
        data,
        message: { message_id: nextMessageId++, date: 0, chat: { id: from.id, type: 'private', first_name: 'x' }, text: messageText },
      },
    };
    await bot.handleUpdate(update);
  }

  /** Calls since the last `take()`. */
  let cursor = 0;
  function take(): ApiCall[] {
    const out = calls.slice(cursor);
    cursor = calls.length;
    return out;
  }
  /** Texts sent/edited to `chatId` since the last take(). */
  function textsTo(chatId: number, batch: ApiCall[]): string[] {
    return batch
      .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && Number(c.payload.chat_id) === chatId)
      .map((c) => String(c.payload.text));
  }

  /** Photos sent to `chatId` in a batch. */
  function photosTo(chatId: number, batch: ApiCall[]): ApiCall[] {
    return batch.filter((c) => c.method === 'sendPhoto' && Number(c.payload.chat_id) === chatId);
  }

  return { bot, deps, calls, failures, failIf, deleted, text, press, take, textsTo, photosTo };
}
