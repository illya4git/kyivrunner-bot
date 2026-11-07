import type { Services } from './context.js';
import type { CommandMenus } from './menus.js';
import type { Notifier } from './notifier.js';
import type { TicketView } from './ticket-view.js';

/** Everything handlers need. Built once in createBot(). */
export type BotDeps = Services & {
  menus: CommandMenus;
  notifier: Notifier;
  ticketView: TicketView;
  devMode: boolean;
};
