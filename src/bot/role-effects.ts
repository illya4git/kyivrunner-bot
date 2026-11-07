import type { Role, UserRow } from '../db/schema.js';
import type { BotDeps } from './deps.js';
import { mainKeyboard, removeKeyboard } from './keyboards.js';

/**
 * Side effects after a role change: refresh the target's command menu and tell them.
 * Guest → user is announced as "access granted"; becoming banned is silent.
 */
export async function afterRoleChange(deps: BotDeps, user: UserRow, prev: Role): Promise<void> {
  await deps.menus.syncUser(user);
  if (user.role === 'banned') return;

  const hasAccess = user.role === 'user' || user.role === 'admin';
  await deps.notifier.toUser(user, (t) => ({
    text: prev === 'guest' && user.role === 'user' ? t.request.granted : t.roleChangedNotice(t.roles[user.role]),
    reply_markup: hasAccess ? mainKeyboard(t) : removeKeyboard,
  }));
}
