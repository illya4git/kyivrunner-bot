import { Composer } from 'grammy';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';
import { commandOf } from '../middleware/core.js';
import { ADMIN_COMMANDS } from '../menus.js';

/** Last in the chain: explains why nothing handled the update and logs denials. */
export function fallback(deps: BotDeps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.on('message', async (ctx) => {
    const { user, t } = ctx;
    const cmd = commandOf(ctx);
    if (user.role === 'guest') {
      deps.audit.log({ kind: 'denied', tgId: user.tgId, role: user.role, data: { command: cmd ?? null } });
      return ctx.reply(t.common.noAccess);
    }
    if (cmd && ADMIN_COMMANDS.has(cmd) && user.role !== 'admin') {
      deps.audit.log({ kind: 'denied', tgId: user.tgId, role: user.role, data: { command: cmd } });
      return ctx.reply(t.common.adminOnly);
    }
    return ctx.reply(t.common.unknownCommand);
  });

  c.on('callback_query', async (ctx) => {
    deps.audit.log({ kind: 'denied', tgId: ctx.user.tgId, role: ctx.user.role, data: { callback: ctx.callbackQuery.data ?? null } });
    await ctx.answerCallbackQuery({ text: ctx.user.role === 'guest' ? ctx.t.common.noAccess : ctx.t.common.adminOnly });
  });

  return c;
}
