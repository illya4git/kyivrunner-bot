import type { Services } from './context.js';
import type { CommandMenus } from './menus.js';
import type { Notifier } from './notifier.js';

/** Everything handlers need. Built once in createBot(). */
export type BotDeps = Services & {
  menus: CommandMenus;
  notifier: Notifier;
  devMode: boolean;
};
