import { Composer } from 'grammy';
import type { BotContext } from '../context.js';

/** Commands planned for later phases. Replaced one by one as features land. */
export const ADMIN_PLACEHOLDERS = ['settings', 'set', 'stats', 'logs', 'export', 'pause', 'resume'] as const;

export function placeholders(commands: readonly string[]): Composer<BotContext> {
  const c = new Composer<BotContext>();
  c.command([...commands], (ctx) => ctx.reply(ctx.t.common.notImplemented));
  return c;
}
