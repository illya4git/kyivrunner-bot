import { Composer, InlineKeyboard } from 'grammy';
import { kyivDateTime } from '../../core/clock.js';
import { esc } from '../../core/html.js';
import type { Role, UserRow } from '../../db/schema.js';
import { displayName, type Messages } from '../../i18n/index.js';
import type { RoleChangeResult } from '../../services/access.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';
import { requestKeyboard } from '../keyboards.js';
import { afterRoleChange } from '../role-effects.js';

const PAGE_SIZE = 8;
const QUOTA_CHOICES = [0, 1, 2, 3, 4, 5, 10];
const ROLE_ICON: Record<Role, string> = { admin: '👑', user: '👤', guest: '👻', banned: '🚫' };

/**
 * Admin user management: /users (inline browser), /requests, /grant, /revoke, /quota,
 * and the access-request buttons. Callback data:
 *   ul:<page>            user list page
 *   uv:<id>              user card
 *   ur:<id>:<role>       set role
 *   uq:<id>              quota picker
 *   us:<id>:<n|d>        set quota (d = default)
 *   ust:<id> / ulg:<id>  user stats / log (admin-reports.ts)
 *   rq:<g|b|i>:<id>      resolve access request (grant / ban / ignore)
 */
export function adminUserCommands(deps: BotDeps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  // --- views ------------------------------------------------------------------

  function listView(t: Messages, page: number) {
    const { rows, total } = deps.access.list(page, PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const kb = new InlineKeyboard();
    for (const u of rows) kb.text(`${ROLE_ICON[u.role]} ${plainName(u)}`, `uv:${u.tgId}`).row();
    if (pages > 1) {
      if (page > 0) kb.text(t.admin.btnPrev, `ul:${page - 1}`);
      if (page < pages - 1) kb.text(t.admin.btnNext, `ul:${page + 1}`);
    }
    return { text: t.admin.usersHeader(page + 1, pages, total), reply_markup: kb };
  }

  function cardView(t: Messages, u: UserRow) {
    const text = t.admin.userCard({
      name: displayName(u),
      id: u.tgId,
      role: t.roles[u.role],
      quota: deps.access.effectiveQuota(u),
      quotaIsDefault: u.dailyQuota === null,
      created: kyivDateTime(u.createdAt),
      lastSeen: u.lastSeenAt ? kyivDateTime(u.lastSeenAt) : t.common.never,
      bootstrap: deps.access.isBootstrapAdmin(u.tgId),
      pending: u.role === 'guest' && u.accessRequestedAt !== null,
    });
    const roleBtn = (r: Role) => `${u.role === r ? '• ' : ''}${ROLE_ICON[r]} ${t.roles[r]}`;
    const kb = new InlineKeyboard()
      .text(roleBtn('user'), `ur:${u.tgId}:user`)
      .text(roleBtn('admin'), `ur:${u.tgId}:admin`)
      .row()
      .text(roleBtn('guest'), `ur:${u.tgId}:guest`)
      .text(roleBtn('banned'), `ur:${u.tgId}:banned`)
      .row()
      .text(t.admin.btnQuota, `uq:${u.tgId}`)
      .row()
      .text(t.admin.btnStats, `ust:${u.tgId}`)
      .text(t.admin.btnLogs, `ulg:${u.tgId}`)
      .row()
      .text(t.common.back, 'ul:0');
    return { text, reply_markup: kb };
  }

  function quotaView(t: Messages, u: UserRow) {
    const kb = new InlineKeyboard().text(t.admin.quotaDefault(deps.settings.get('default_daily_quota')), `us:${u.tgId}:d`).row();
    for (const n of QUOTA_CHOICES) kb.text(`${u.dailyQuota === n ? '• ' : ''}${n}`, `us:${u.tgId}:${n}`);
    kb.row().text(t.common.back, `uv:${u.tgId}`);
    return { text: t.admin.quotaPrompt(displayName(u)), reply_markup: kb };
  }

  function refusal(t: Messages, reason: Exclude<RoleChangeResult, { ok: true }>['reason']): string {
    switch (reason) {
      case 'bootstrap':
        return t.admin.refuseBootstrap;
      case 'last_admin':
        return t.admin.refuseLastAdmin;
      case 'unchanged':
        return t.admin.refuseUnchanged;
      case 'not_found':
        return t.common.userNotFound('?');
    }
  }

  /** Change a role and run the side effects. Returns a message for the acting admin. */
  async function changeRole(t: Messages, target: UserRow, role: Role, by: number): Promise<{ ok: boolean; text: string }> {
    const res = deps.access.setRole(target.tgId, role, by);
    if (!res.ok) return { ok: false, text: refusal(t, res.reason) };
    await afterRoleChange(deps, res.user, res.prev);
    return { ok: true, text: t.admin.roleSet(displayName(res.user), t.roles[role]) };
  }

  // --- /users browser ---------------------------------------------------------

  c.command('users', (ctx) => {
    const v = listView(ctx.t, 0);
    return ctx.reply(v.text, { reply_markup: v.reply_markup });
  });

  c.callbackQuery(/^ul:(\d+)$/, async (ctx) => {
    const v = listView(ctx.t, Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
  });

  c.callbackQuery(/^uv:(\d+)$/, async (ctx) => {
    const u = deps.access.get(Number(ctx.match[1]));
    if (!u) return ctx.answerCallbackQuery({ text: ctx.t.common.userNotFound(ctx.match[1]!), show_alert: true });
    const v = cardView(ctx.t, u);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
  });

  c.callbackQuery(/^ur:(\d+):(guest|user|admin|banned)$/, async (ctx) => {
    const target = deps.access.get(Number(ctx.match[1]));
    if (!target) return ctx.answerCallbackQuery({ text: ctx.t.common.userNotFound(ctx.match[1]!), show_alert: true });
    const res = await changeRole(ctx.t, target, ctx.match[2] as Role, ctx.user.tgId);
    await ctx.answerCallbackQuery({ text: stripHtml(res.text), show_alert: !res.ok });
    if (res.ok) {
      const v = cardView(ctx.t, deps.access.get(target.tgId)!);
      await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
    }
  });

  c.callbackQuery(/^uq:(\d+)$/, async (ctx) => {
    const u = deps.access.get(Number(ctx.match[1]));
    if (!u) return ctx.answerCallbackQuery({ text: ctx.t.common.userNotFound(ctx.match[1]!), show_alert: true });
    const v = quotaView(ctx.t, u);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
  });

  c.callbackQuery(/^us:(\d+):(d|\d+)$/, async (ctx) => {
    const quota = ctx.match[2] === 'd' ? null : Number(ctx.match[2]);
    const u = deps.access.setQuota(Number(ctx.match[1]), quota, ctx.user.tgId);
    if (!u) return ctx.answerCallbackQuery({ text: ctx.t.common.userNotFound(ctx.match[1]!), show_alert: true });
    await ctx.answerCallbackQuery({ text: stripHtml(ctx.t.admin.quotaSet(displayName(u), quotaLabel(ctx.t, quota))) });
    const v = cardView(ctx.t, u);
    await ctx.editMessageText(v.text, { reply_markup: v.reply_markup });
  });

  // --- text shortcuts -----------------------------------------------------------

  /** Resolve a user reference; a bare numeric id that isn't known yet gets a stub row. */
  function resolveTarget(ref: string, createStub: boolean): UserRow | undefined {
    const found = deps.access.findByRef(ref);
    if (found || !createStub || !/^\d+$/.test(ref)) return found;
    return deps.access.ensureStub(Number(ref));
  }

  c.command('grant', async (ctx) => {
    const [ref, roleArg = 'user'] = ctx.match.trim().split(/\s+/);
    if (!ref) return ctx.reply(ctx.t.common.usage('/grant <id|@user> [user|admin]'));
    if (roleArg !== 'user' && roleArg !== 'admin') return ctx.reply(ctx.t.admin.badRole);
    const target = resolveTarget(ref, true);
    if (!target) return ctx.reply(ctx.t.common.userNotFound(ref));
    return ctx.reply((await changeRole(ctx.t, target, roleArg, ctx.user.tgId)).text);
  });

  c.command('revoke', async (ctx) => {
    const ref = ctx.match.trim();
    if (!ref) return ctx.reply(ctx.t.common.usage('/revoke <id|@user>'));
    const target = resolveTarget(ref, false);
    if (!target) return ctx.reply(ctx.t.common.userNotFound(ref));
    return ctx.reply((await changeRole(ctx.t, target, 'guest', ctx.user.tgId)).text);
  });

  c.command('quota', (ctx) => {
    const [ref, value] = ctx.match.trim().split(/\s+/);
    if (!ref || !value) return ctx.reply(ctx.t.common.usage('/quota <id|@user> <n|default>'));
    let quota: number | null;
    if (value === 'default') quota = null;
    else if (/^\d+$/.test(value) && Number(value) <= 100) quota = Number(value);
    else return ctx.reply(ctx.t.admin.badQuota);
    const target = resolveTarget(ref, false);
    if (!target) return ctx.reply(ctx.t.common.userNotFound(ref));
    const u = deps.access.setQuota(target.tgId, quota, ctx.user.tgId)!;
    return ctx.reply(ctx.t.admin.quotaSet(displayName(u), quotaLabel(ctx.t, quota)));
  });

  // --- access requests ------------------------------------------------------------

  c.command('requests', async (ctx) => {
    const pending = deps.access.pendingRequests();
    if (pending.length === 0) return ctx.reply(ctx.t.admin.noRequests);
    await ctx.reply(ctx.t.admin.requestsHeader(pending.length));
    for (const u of pending) {
      await ctx.reply(ctx.t.admin.requestNotice(displayName(u), u.tgId), { reply_markup: requestKeyboard(ctx.t, u.tgId) });
    }
  });

  c.callbackQuery(/^rq:([gbi]):(\d+)$/, async (ctx) => {
    const action = ({ g: 'grant', b: 'ban', i: 'ignore' } as const)[ctx.match[1] as 'g' | 'b' | 'i'];
    const tgId = Number(ctx.match[2]);
    const before = deps.access.get(tgId);
    const res = deps.access.resolveRequest(tgId, action, ctx.user.tgId);
    const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';

    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: ctx.t.admin.requestAlreadyHandled, show_alert: true });
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }
    const by = plainName(ctx.user);
    const outcome = { grant: ctx.t.admin.requestGranted, ban: ctx.t.admin.requestBanned, ignore: ctx.t.admin.requestIgnored }[action](by);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`${esc(original ?? '')}\n\n${outcome}`);
    if (action !== 'ignore' && before) await afterRoleChange(deps, res.user, before.role);
  });

  return c;
}

function plainName(u: Pick<UserRow, 'tgId' | 'firstName' | 'lastName' | 'username'>): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return name || (u.username ? `@${u.username}` : String(u.tgId));
}

function quotaLabel(t: Messages, quota: number | null): string {
  return quota === null ? t.admin.quotaDefaultWord : String(quota);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
