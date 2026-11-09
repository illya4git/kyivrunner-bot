import { UK_LANGUAGE_CODES } from '../services/access.js';
import type { Api, RawApi } from 'grammy';
import type { Logger } from '../core/logger.js';
import type { Role, UserRow } from '../db/schema.js';
import { messages, type Messages } from '../i18n/index.js';

export type CommandName = keyof Messages['cmd'];

const USER_MENU: CommandName[] = ['qr', 'status', 'history', 'whoami', 'lang', 'help'];

/** Commands shown in Telegram's "/" menu, per role. */
export const MENUS: Record<Exclude<Role, 'banned'>, CommandName[]> = {
  guest: ['start', 'request', 'whoami', 'lang', 'help'],
  user: USER_MENU,
  admin: [
    ...USER_MENU,
    'users',
    'requests',
    'settings',
    'stats',
    'logs',
    'export',
    'card',
    'credentials',
    'pause',
    'resume',
  ],
};

/** Commands that exist but are only listed in /help (they take arguments). */
export const HELP_EXTRAS: Partial<Record<Role, CommandName[]>> = {
  admin: ['grant', 'revoke', 'quota', 'set', 'cancel'],
};

/** Every command an admin may run — used to answer "admins only" instead of "unknown". */
export const ADMIN_COMMANDS: ReadonlySet<string> = new Set([...MENUS.admin, ...(HELP_EXTRAS.admin ?? [])].filter((c) => !USER_MENU.includes(c)));

function commandsFor(role: Exclude<Role, 'banned'>, t: Messages) {
  // The "/" menu shows short descriptions; strip the usage hints that /help keeps.
  return MENUS[role].map((c) => ({ command: c, description: t.cmd[c].split(':')[0]!.trim() }));
}

/** Keeps Telegram's per-chat command menus in sync with roles and locales. */
export class CommandMenus {
  constructor(
    private readonly api: Api<RawApi>,
    private readonly log: Logger,
  ) {}

  /** Default menu (guests and anyone without a per-chat menu), in both languages. */
  async syncDefault(): Promise<void> {
    await this.api.setMyCommands(commandsFor('guest', messages('en')));
    for (const language_code of UK_LANGUAGE_CODES) {
      await this.api.setMyCommands(commandsFor('guest', messages('uk')), { language_code });
    }
  }

  async syncUser(user: Pick<UserRow, 'tgId' | 'role' | 'locale'>): Promise<void> {
    const scope = { type: 'chat' as const, chat_id: user.tgId };
    try {
      if (user.role === 'user' || user.role === 'admin') {
        await this.api.setMyCommands(commandsFor(user.role, messages(user.locale)), { scope });
      } else {
        await this.api.deleteMyCommands({ scope });
      }
    } catch (err) {
      // e.g. a pre-granted user who has never opened the chat yet
      this.log.warn({ err, tgId: user.tgId }, 'failed to sync command menu');
    }
  }

  async syncAll(users: Pick<UserRow, 'tgId' | 'role' | 'locale'>[]): Promise<void> {
    await this.syncDefault();
    for (const u of users) await this.syncUser(u);
  }
}
