import type { MiddlewareFn } from 'grammy';
import { redactJwts } from '../../core/crypto.js';
import { messages } from '../../i18n/index.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';

const MAX_LOGGED_ARGS = 100;

/** Name of the bot command in this message (without @botname), if any. */
export function commandOf(ctx: BotContext): string | undefined {
  const text = ctx.message?.text;
  if (!text?.startsWith('/')) return undefined;
  return text.slice(1).split(/[\s@]/, 1)[0]?.toLowerCase() || undefined;
}

/**
 * Loads the user, records the interaction in the audit log, then drops anything that
 * isn't a private chat or comes from a banned user. Every update is logged, even dropped ones.
 */
export function coreMiddleware(deps: BotDeps): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;

    const chatType = ctx.chat?.type;
    if (chatType !== undefined && chatType !== 'private') {
      // Groups/channels: log only, never create user rows for group members.
      const known = deps.access.get(from.id);
      deps.audit.log({ kind: 'interaction', tgId: from.id, role: known?.role ?? null, data: describeUpdate(ctx, chatType) });
      return;
    }

    const user = deps.access.touch(from);
    ctx.user = user;
    ctx.t = messages(user.locale);
    deps.audit.log({ kind: 'interaction', tgId: user.tgId, role: user.role, data: describeUpdate(ctx, chatType) });

    if (user.role === 'banned') return;
    await next();
  };
}

/**
 * What goes into the audit log for an update. Commands and button presses are recorded;
 * free text is recorded by length only, because it may carry credentials.
 */
function describeUpdate(ctx: BotContext, chatType: string | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = chatType && chatType !== 'private' ? { chat: chatType } : {};
  if (ctx.callbackQuery) return { ...base, type: 'callback', data: ctx.callbackQuery.data ?? null };
  const msg = ctx.message;
  if (msg?.text !== undefined) {
    if (msg.text.startsWith('/')) return { ...base, type: 'command', text: redactJwts(msg.text).slice(0, MAX_LOGGED_ARGS) };
    return { ...base, type: 'text', len: msg.text.length };
  }
  if (msg) return { ...base, type: 'message', kinds: Object.keys(msg).filter((k) => !STANDARD_MSG_KEYS.has(k)) };
  return { ...base, type: Object.keys(ctx.update).find((k) => k !== 'update_id') ?? 'unknown' };
}

const STANDARD_MSG_KEYS = new Set(['message_id', 'from', 'chat', 'date', 'edit_date', 'entities']);
