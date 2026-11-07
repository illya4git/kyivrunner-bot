import { Composer } from 'grammy';
import { kyivDateTime } from '../../core/clock.js';
import { LOCALES, type Locale } from '../../db/schema.js';
import { displayName, messages } from '../../i18n/index.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';
import { langKeyboard, mainKeyboard, requestKeyboard } from '../keyboards.js';
import { HELP_EXTRAS, MENUS } from '../menus.js';

/** Commands available to every non-banned role. */
export function publicCommands(deps: BotDeps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.command('start', async (ctx) => {
    const { user, t } = ctx;
    if (user.role === 'guest') return ctx.reply(t.start.guest(user.tgId));
    const name = user.firstName ?? user.username ?? String(user.tgId);
    await deps.menus.syncUser(user);
    return ctx.reply(user.role === 'admin' ? t.start.admin(name) : t.start.user(name), { reply_markup: mainKeyboard(t) });
  });

  c.command('help', (ctx) => {
    const { user, t } = ctx;
    const role = user.role === 'banned' ? 'guest' : user.role;
    const lines = [...MENUS[role], ...(HELP_EXTRAS[role] ?? [])].map((cmd) => `/${cmd} — ${t.cmd[cmd]}`);
    return ctx.reply([t.help.header(t.roles[user.role]), '', ...lines].join('\n'));
  });

  c.command('whoami', (ctx) => {
    const { user, t } = ctx;
    return ctx.reply(
      t.whoami({
        id: user.tgId,
        role: t.roles[user.role],
        username: user.username,
        quota: deps.access.effectiveQuota(user),
        quotaIsDefault: user.dailyQuota === null,
        locale: user.locale,
      }),
    );
  });

  c.command('lang', async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if ((LOCALES as readonly string[]).includes(arg)) return setLocale(ctx, arg as Locale);
    return ctx.reply(ctx.t.lang.prompt, { reply_markup: langKeyboard() });
  });

  c.callbackQuery(/^lang:(uk|en)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await setLocale(ctx, ctx.match[1] as Locale);
  });

  async function setLocale(ctx: BotContext, locale: Locale) {
    const updated = deps.access.setLocale(ctx.user.tgId, locale) ?? ctx.user;
    ctx.user = updated;
    ctx.t = messages(locale);
    await deps.menus.syncUser(updated);
    const hasAccess = updated.role === 'user' || updated.role === 'admin';
    // Re-send the reply keyboard so its label follows the language.
    await ctx.reply(ctx.t.lang.changed, hasAccess ? { reply_markup: mainKeyboard(ctx.t) } : {});
  }

  c.command('request', async (ctx) => {
    const { user, t } = ctx;
    const res = deps.access.requestAccess(user.tgId);
    switch (res.status) {
      case 'has_access':
        return ctx.reply(t.request.hasAccess);
      case 'pending':
        return ctx.reply(t.request.pending);
      case 'banned':
        return; // unreachable: banned users are dropped by middleware
      case 'cooldown':
        return ctx.reply(t.request.cooldown(kyivDateTime(res.until)));
      case 'requested':
        await deps.notifier.toAdmins((at) => ({
          text: at.admin.requestNotice(displayName(user), user.tgId),
          reply_markup: requestKeyboard(at, user.tgId),
        }));
        return ctx.reply(t.request.sent);
    }
  });

  return c;
}
