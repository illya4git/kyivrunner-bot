import { esc } from '../core/html.js';
import type { Messages } from './uk.js';

export const en: Messages = {
  roles: { guest: 'guest', user: 'user', admin: 'admin', banned: 'banned' },

  common: {
    error: '⚠️ Something went wrong. Please try again a bit later.',
    noAccess: '🔒 You have no access. Send /request to ask for it.',
    adminOnly: '🔒 This command is for administrators only.',
    unknownCommand: 'Unknown command. See /help',
    notImplemented: '🚧 This feature is not ready yet.',
    usage: (u) => `Usage: <code>${esc(u)}</code>`,
    userNotFound: (ref) => `User <code>${esc(ref)}</code> not found. They must message the bot first, or use their numeric ID.`,
    back: '« Back',
    yes: 'yes',
    no: 'no',
    never: 'never',
  },

  cmd: {
    start: 'Start',
    help: 'Help',
    whoami: 'My profile and quota',
    lang: 'Language / Мова',
    request: 'Request access',
    qr: 'Get a QR ticket',
    status: 'Current ticket status',
    history: 'My recent tickets',
    users: 'Users',
    requests: 'Access requests',
    grant: 'Grant a role: /grant <id|@user> [user|admin]',
    revoke: 'Revoke access: /revoke <id|@user>',
    quota: 'Quota: /quota <id|@user> <n|default>',
    settings: 'Settings',
    set: 'Change: /set <key> <value>',
    stats: 'Statistics',
    logs: 'Event log',
    export: 'CSV export',
    card: 'Card and balance',
    credentials: 'Kyiv Digital credentials',
    pause: 'Pause issuing',
    resume: 'Resume issuing',
  },

  start: {
    guest: (id) =>
      `👋 Hi! This bot issues transit QR tickets, but only to approved people.\n\n` +
      `Your ID: <code>${id}</code>\nTo ask for access, send /request.`,
    user: (name) => `👋 Hi, ${esc(name)}! Tap “🎫 QR” to get a ticket. Help: /help`,
    admin: (name) => `👋 Hi, ${esc(name)}! You are an administrator. Help: /help`,
  },

  help: {
    header: (role) => `<b>Available commands</b> (role: ${esc(role)}):`,
  },

  keyboard: { qr: '🎫 QR' },

  whoami: (p) =>
    `<b>Profile</b>\n` +
    `ID: <code>${p.id}</code>\n` +
    (p.username ? `Username: @${esc(p.username)}\n` : '') +
    `Role: ${esc(p.role)}\n` +
    `Daily quota: ${p.quota}${p.quotaIsDefault ? ' (default)' : ''}\n` +
    `Language: ${esc(p.locale)}`,

  lang: {
    prompt: 'Choose language / Оберіть мову:',
    changed: '✅ Language set to English.',
  },

  request: {
    sent: '📨 Your request was sent to the administrators. You will be notified once it is reviewed.',
    hasAccess: '✅ You already have access. Help: /help',
    pending: '⏳ Your request is already pending.',
    cooldown: (until) => `⏳ You can request again after ${esc(until)}.`,
    granted: '🎉 Access granted! Tap “🎫 QR” to get a ticket. Help: /help',
  },

  roleChangedNotice: (role) => `ℹ️ Your role was changed to <b>${esc(role)}</b>.`,

  admin: {
    requestNotice: (user, id) => `📨 <b>Access request</b>\n${user}\nID: <code>${id}</code>`,
    requestGranted: (by) => `✅ Access granted (${esc(by)})`,
    requestBanned: (by) => `🚫 Banned (${esc(by)})`,
    requestIgnored: (by) => `🙈 Ignored (${esc(by)})`,
    requestAlreadyHandled: 'This request was already handled.',
    btnGrant: '✅ Grant access',
    btnBan: '🚫 Ban',
    btnIgnore: '🙈 Ignore',
    noRequests: 'No pending requests.',
    requestsHeader: (n) => `<b>Access requests</b>: ${n}`,

    usersHeader: (page, pages, total) => `<b>Users</b> — ${total} (page ${page}/${pages})`,
    userCard: (p) =>
      `<b>${p.name}</b>\n` +
      `ID: <code>${p.id}</code>\n` +
      `Role: ${esc(p.role)}${p.bootstrap ? ' (from ADMIN_IDS)' : ''}\n` +
      `Daily quota: ${p.quota}${p.quotaIsDefault ? ' (default)' : ''}\n` +
      `Created: ${esc(p.created)}\n` +
      `Last seen: ${esc(p.lastSeen)}` +
      (p.pending ? '\n📨 Access request pending' : ''),
    btnQuota: '🎚 Quota…',
    btnPrev: '‹',
    btnNext: '›',
    quotaPrompt: (name) => `Daily quota for <b>${name}</b>:`,
    quotaDefault: (n) => `Default (${n})`,
    quotaDefaultWord: 'default',
    quotaSet: (name, q) => `✅ Quota for ${name}: ${esc(q)}`,
    roleSet: (name, role) => `✅ ${name}: role <b>${esc(role)}</b>`,
    refuseBootstrap: '⛔ This admin is set in ADMIN_IDS — their role cannot be changed from the bot.',
    refuseLastAdmin: '⛔ The last administrator cannot be demoted.',
    refuseUnchanged: 'Role unchanged.',
    badQuota: 'Quota must be an integer from 0 to 100, or “default”.',
    badRole: 'Role must be user or admin.',
  },
};
