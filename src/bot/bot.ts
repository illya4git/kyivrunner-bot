import { Bot, type Transformer } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { UserFromGetMe } from 'grammy/types';
import type { Services, BotContext } from './context.js';
import type { BotDeps } from './deps.js';
import { coreMiddleware } from './middleware/core.js';
import { CommandMenus } from './menus.js';
import { Notifier } from './notifier.js';
import { publicCommands } from './commands/public.js';
import { adminUserCommands } from './commands/admin-users.js';
import { ADMIN_PLACEHOLDERS, placeholders } from './commands/placeholders.js';
import { fallback } from './commands/fallback.js';
import { credentialFlows } from './commands/admin-credentials.js';
import { adminCardCommands } from './commands/admin-card.js';
import { wireAlerts } from './alerts.js';
import { TicketView } from './ticket-view.js';
import { userTicketCommands } from './commands/user-tickets.js';

export type CreateBotOptions = {
  token: string;
  services: Services;
  devMode: boolean;
  /** Talk to Telegram's test environment instead of production. */
  telegramTestEnv?: boolean;
  /** Skip getMe (tests). */
  botInfo?: UserFromGetMe;
  /** Extra API transformers, closest to the network (tests use one to fake Telegram). */
  transformers?: Transformer[];
  /** Disable network-related transformers like auto-retry/throttling (tests). */
  offline?: boolean;
};

/** Default every outgoing text to HTML with link previews off. */
const HTML_METHODS = new Set(['sendMessage', 'editMessageText', 'sendPhoto', 'editMessageCaption']);
const htmlDefaults: Transformer = (prev, method, payload, signal) => {
  if (HTML_METHODS.has(method)) {
    const p = payload as Record<string, unknown>;
    p.parse_mode ??= 'HTML';
    if (method === 'sendMessage' || method === 'editMessageText') p.link_preview_options ??= { is_disabled: true };
  }
  return prev(method, payload, signal);
};

export function createBot(opts: CreateBotOptions): { bot: Bot<BotContext>; deps: BotDeps } {
  const bot = new Bot<BotContext>(opts.token, {
    ...(opts.botInfo ? { botInfo: opts.botInfo } : {}),
    ...(opts.telegramTestEnv ? { client: { environment: 'test' as const } } : {}),
  });

  // grammY runs the most recently installed transformer first, so these extra ones
  // (tests: a fake Telegram) are installed first and sit closest to the network.
  for (const t of opts.transformers ?? []) bot.api.config.use(t);
  bot.api.config.use(htmlDefaults);
  if (!opts.offline) {
    bot.api.config.use(apiThrottler());
    bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  }

  const deps: BotDeps = {
    ...opts.services,
    menus: new CommandMenus(bot.api, opts.services.log),
    notifier: new Notifier(bot.api, opts.services.access, opts.services.log),
    ticketView: new TicketView(bot.api, opts.services.tickets, opts.services.access, opts.services.audit, opts.services.log),
    devMode: opts.devMode,
  };
  opts.services.tickets.setSink((tr) => deps.ticketView.applyTransition(tr));

  const creds = credentialFlows(deps);
  bot.use(coreMiddleware(deps));
  bot.use(creds.credentialEntry); // must see an admin's secret messages before anything else
  bot.use(creds.jwtGuard);
  bot.use(publicCommands(deps));

  const members = bot.filter((ctx) => ctx.user.role === 'user' || ctx.user.role === 'admin');
  members.use(userTicketCommands(deps, deps.ticketView));

  const admins = bot.filter((ctx) => ctx.user.role === 'admin');
  admins.use(adminUserCommands(deps));
  admins.use(creds.commands);
  admins.use(adminCardCommands(deps));
  admins.use(placeholders(ADMIN_PLACEHOLDERS));

  bot.use(fallback(deps));
  wireAlerts(deps);

  bot.catch(async (err) => {
    opts.services.log.error({ err: err.error, update: err.ctx.update.update_id }, 'unhandled error in update');
    try {
      if (err.ctx.callbackQuery) await err.ctx.answerCallbackQuery({ text: err.ctx.t?.common.error ?? 'Error' });
      else if (err.ctx.chat?.type === 'private') await err.ctx.reply(err.ctx.t?.common.error ?? 'Error');
    } catch {
      /* ignore secondary failures */
    }
  });

  return { bot, deps };
}
