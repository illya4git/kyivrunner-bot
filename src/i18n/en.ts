import { esc } from '../core/html.js';
import type { Messages } from './uk.js';

export const en: Messages = {
  roles: { guest: 'guest', user: 'user', admin: 'admin', banned: 'banned' },

  common: {
    error: '⚠️ Something went wrong. Please try again a bit later.',
    noAccess: '🔒 You have no access. Send /request to ask for it.',
    adminOnly: '🔒 This command is for administrators only.',
    unknownCommand: 'Unknown command. See /help',
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
    cancel: 'Cancel credential entry',
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
    `Daily quota: ${p.quota === null ? 'no limit (admin)' : `${p.quota}${p.quotaIsDefault ? ' (default)' : ''}`}\n` +
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
      `Daily quota: ${p.quota === null ? 'no limit (admin)' : `${p.quota}${p.quotaIsDefault ? ' (default)' : ''}`}\n` +
      `Created: ${esc(p.created)}\n` +
      `Last seen: ${esc(p.lastSeen)}` +
      (p.pending ? '\n📨 Access request pending' : ''),
    btnStats: '📊 Stats',
    btnLogs: '📜 Log',
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

  kyivError: {
    no_credentials: '🔑 Kyiv Digital credentials are not set up. Admin: /credentials',
    unauthorized: '⛔ Kyiv Digital rejected the token.',
    rate_limited: '⏳ Kyiv Digital asks to slow down. Try again in a minute.',
    unavailable: '📡 Kyiv Digital is unavailable right now. Try again later.',
    shape: '🧩 Kyiv Digital returned unexpected data. Admins should check the log.',
    rejected: (msg) => `⛔ Kyiv Digital refused the request${msg ? `: ${esc(msg)}` : '.'}`,
    maintenance: (until) => `🌙 Kyiv Digital is under nightly maintenance until ${esc(until)}. Try again after that.`,
  },

  creds: {
    states: {
      missing: '⚪️ not set',
      ok: '✅ working',
      expiring: '🟡 expiring soon',
      expired: '🔴 expired',
      invalid: '🔴 rejected by Kyiv Digital',
    },
    view: (p) =>
      `<b>🔑 Kyiv Digital credentials</b>\n` +
      `State: ${p.state}\n` +
      (p.token ? `Token: <code>${esc(p.token)}</code>\n` : '') +
      (p.device ? `Device: <code>${esc(p.device)}</code>\n` : '') +
      (p.subject ? `Account: <code>${esc(p.subject)}</code>\n` : '') +
      (p.expires ? `Valid until: ${esc(p.expires)}\n` : '') +
      (p.added ? `Added: ${esc(p.added)}${p.addedBy ? ` (${p.addedBy})` : ''}\n` : '') +
      (p.lastOk ? `Last successful response: ${esc(p.lastOk)}\n` : '') +
      (p.lastError ? `Last error: ${esc(p.lastError)}\n` : ''),
    btnSet: '🔑 Enter new',
    btnCheck: '🔍 Check',
    btnClear: '🗑 Remove',
    btnClearConfirm: '🗑 Yes, remove',
    btnCancel: 'Cancel',
    clearConfirm: 'Remove the credentials? The bot cannot issue tickets until they are entered again.',
    cleared: '🗑 Credentials removed.',
    askToken:
      '🔑 Send the <b>access token</b> (a JWT starting with <code>eyJ</code>).\n' +
      'I will delete the message right after reading it. /cancel to abort.',
    askDevice: (exp) =>
      `✅ Token accepted (valid until ${esc(exp)}).\n` + `Now send the <b>device UUID</b> from the same app install.`,
    tokenNoExp: 'unknown date',
    badToken: '⚠️ That does not look like a JWT. Send the token again, or /cancel.',
    expiredToken: '⚠️ This token has already expired. Send another one, or /cancel.',
    badDevice: '⚠️ That does not look like a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Try again, or /cancel.',
    probing: '⏳ Checking with Kyiv Digital…',
    probeUnauthorized: '⛔ Kyiv Digital rejected this token + UUID pair. Make sure both come from the same app install. Start over: /credentials',
    probeFailed: (err) => `⚠️ Could not verify: ${err}\nSend the UUID again to retry, or /cancel.`,
    saved: (n) => `✅ Credentials saved. Cards on the account: ${n}.`,
    noCards: '⚠️ The account has no travel cards — there is nothing to issue tickets from.',
    cancelled: 'Cancelled.',
    timedOut: '⌛ Credential entry cancelled due to inactivity.',
    checkOk: '✅ The credentials work.',
    tokenDeleted: '🧹 That looked like a token, so I deleted the message. Admins change credentials with /credentials.',
  },

  card: {
    pickPrompt: 'Choose the card to issue tickets from:',
    picked: (name) => `✅ Active card: ${esc(name)}`,
    notSelected: '⚠️ No card selected.',
    notFound: '⚠️ The selected card is no longer on the account. Choose another one.',
    btnRefresh: '🔄 Refresh',
    btnChange: '🔁 Change card',
    view: (p) =>
      `<b>💳 ${esc(p.name)}</b> · <code>${esc(p.number)}</code>\n` +
      `Trips left: <b>${p.trips}</b>${p.validTo ? ` (until ${esc(p.validTo)})` : ''}\n` +
      `Active QR tickets: ${p.activeCodes}\n` +
      `Generation: ${p.canGenerate ? '✅ available' : '⛔ unavailable'}\n` +
      `Credentials: ${p.creds}${p.tokenExp ? `, until ${esc(p.tokenExp)}` : ''}` +
      (p.rate ? `\nAPI limit: ${esc(p.rate)}` : ''),
  },

  tickets: {
    caption: (p) =>
      (p.resent ? '🔁 <i>The previous message was deleted — this is the same ticket.</i>\n\n' : '') +
      `🎫 <b>${esc(p.label)}</b>\n` +
      `Valid until ${esc(p.until)} (${esc(p.date)})\n` +
      `Today: ${p.used}${p.limit === null ? '' : `/${p.limit}`}\n\n` +
      `Scan the QR code at the validator.`,
    captionUsed: (p) =>
      (p.resent ? '🔁 <i>Re-sent for inspection.</i>\n\n' : '') +
      `✅ <b>${esc(p.label)}</b> — used at ${esc(p.time)}` +
      (p.place ? `\n${esc(p.place)}` : '') +
      `\n\nShow this QR to a conductor if asked (until ${esc(p.until)}).`,
    captionUsedFinal: (p) => `✅ <b>${esc(p.label)}</b> — used ${esc(p.date)} at ${esc(p.time)}` + (p.place ? `\n${esc(p.place)}` : ''),
    captionExpired: (p) => `⌛ <b>${esc(p.label)}</b> — not used (${esc(p.date)}).\nThe trip went back to the card.`,
    pointer: (until, quota) => `⬆️ Your active QR ticket is above. Valid until ${esc(until)}.\n${quota}`,
    pointerUsed: (time, quota) => `⬆️ Your ticket was used at ${esc(time)}. You can show it to a conductor.\n${quota}`,
    placePending: 'finding the place…',
    quotaLine: (used, limit) => `Today: ${used}${limit === null ? '' : `/${limit}`}.`,
    usedReply: (time, place) => `✅ Your QR ticket was used at ${esc(time)}${place ? ` — ${esc(place)}` : ''}.`,
    expiredReply: '⌛ Your QR ticket expired unused. The trip went back to the card.',
    btnRefresh: '🔄 Refresh status',
    toastActive: 'Not used yet.',
    toastUsed: (time) => `Used at ${time}.`,
    toastExpired: 'Expired unused.',
    notYours: 'This is not your ticket.',
    noActive: (quota) => `No active ticket. ${quota}\nTap “🎫 QR” to get one.`,
    denied: {
      paused: '⏸ Ticket issuing is paused by an administrator.',
      no_credentials: '🔧 The bot cannot issue tickets right now. The administrators have been notified.',
      no_card: '🔧 An administrator has not chosen the card for tickets yet.',
      quota: (used, limit) => `🚫 Today’s limit is used up (${used}/${limit}). New day, new tickets.`,
      global_cap: '🚫 Today’s ticket limit for all users is used up. Try again tomorrow.',
      reserve: '🚫 The card is running out of trips — issuing is stopped.',
      card_blocked: '🚫 The card does not allow QR tickets right now.',
      maintenance: (until) => `🌙 Kyiv Digital is under nightly maintenance: QR tickets can be created again after ${esc(until)}.`,
    },
    historyHeader: '<b>Your recent tickets</b>',
    historyEmpty: 'You have not received any tickets yet.',
    historyActive: (date, until) => `🎫 ${esc(date)} — active until ${esc(until)}`,
    historyUsed: (date, time, place) => `✅ ${esc(date)} ${esc(time)}${place ? ` — ${esc(place)}` : ''}`,
    historyExpired: (date) => `⌛ ${esc(date)} — not used`,
  },

  settings: {
    header: '<b>⚙️ Settings</b>',
    footer: 'Change: <code>/set key value</code>',
    line: (key, value, isDefault, desc) => `<code>${esc(key)}</code> = <b>${esc(value)}</b>${isDefault ? ' · default' : ''}\n<i>${esc(desc)}</i>`,
    desc: {
      default_daily_quota: 'Tickets per user per day',
      global_daily_cap: 'Tickets per day for everyone combined',
      reserve_trips: 'Stop issuing when the card has this many trips or fewer',
      low_balance_alert: 'Warn admins when this many trips or fewer are left',
      active_card_id: 'Active card (change it with /card)',
      poll_interval_sec: 'How often fresh tickets and places are checked, seconds',
      poll_idle_interval_sec: 'How often to check otherwise, seconds',
      poll_fresh_window_min: 'Minutes a ticket counts as fresh: after issue (while unused) and after the scan (place search)',
      place_match_window_sec: 'Max time difference when finding the place, seconds',
      place_search_delay_min: 'Start looking for the place this many minutes after the scan',
      place_give_up_hours: 'Stop looking for the place this many hours after the scan',
      api_rate_per_min: 'Kyiv Digital requests per minute',
      request_cooldown_hours: 'Wait before another /request after an ignore, hours',
      log_retention_days: 'How many days the event log is kept',
      paused: 'Issuing paused (/pause, /resume)',
    },
    unknownKey: (key) => `Unknown key <code>${esc(key)}</code>. See /settings`,
    internalKey: (key) => `<code>${esc(key)}</code> is changed elsewhere (see /settings).`,
    invalid: (key, err) => `⚠️ Invalid value for <code>${esc(key)}</code>: ${esc(err)}`,
    changed: (key, from, to) => `✅ <code>${esc(key)}</code>: ${esc(from)} → <b>${esc(to)}</b>`,
  },

  pause: {
    paused: '⏸ Ticket issuing is paused. Active tickets keep working. /resume to continue.',
    resumed: '▶️ Ticket issuing resumed.',
    alreadyPaused: 'Issuing is already paused.',
    notPaused: 'Issuing is not paused.',
    noticePaused: (by) => `⏸ ${by} paused ticket issuing.`,
    noticeResumed: (by) => `▶️ ${by} resumed ticket issuing.`,
  },

  stats: {
    periods: { today: 'today', week: '7 days', month: '30 days', all: 'all time' },
    header: (period) => `<b>📊 Statistics — ${esc(period)}</b>`,
    userLine: (name, p) => `• ${name}: ${p.issued} 🎫 · ${p.used} ✅ · ${p.expired} ⌛${p.active ? ` · ${p.active} active` : ''}`,
    total: (p) => `<b>Total:</b> ${p.issued} 🎫 · ${p.used} ✅ · ${p.expired} ⌛${p.active ? ` · ${p.active} active` : ''}`,
    empty: 'No tickets in this period.',
    placesHeader: '<b>Top places</b>',
    placeLine: (place, n) => `• ${esc(place)} — ${n}`,
    card: (trips) => `💳 Trips on the card: <b>${trips}</b>`,
    cardUnavailable: '💳 Card balance is unavailable right now.',
    legend: '🎫 issued · ✅ used · ⌛ expired',
    usage: 'Usage: /stats [today|week|month|all]',
    userHeader: (name) => `<b>📊 ${name} — 30 days</b>`,
    recentHeader: '<b>Recent tickets</b>',
  },

  logs: {
    header: (n, who) => `<b>📜 Log</b> — last ${n}${who ? ` · ${who}` : ' (interactions hidden)'}`,
    empty: 'No events.',
    usage: 'Usage: /logs [id|@user] [count]',
  },

  export: {
    usage: 'Usage: /export [tickets|events] [days]',
    caption: (what, days, n) => `📤 ${esc(what)} · ${esc(days)} · rows: ${n}`,
    allTime: 'all time',
    days: (n) => `${n} days`,
  },

  alerts: {
    lowBalance: (trips) => `🪫 Only <b>${trips}</b> trips left on the card.`,
    generationBlocked: '⛔ The card does not allow QR tickets (blocked, or generation is off). /card',
    apiDegraded: (kind) => `📡 Kyiv Digital has not been responding for several minutes (${esc(kind)}). Ticket statuses will update once it is back.`,
    apiRecovered: '✅ Kyiv Digital is reachable again.',
    maintenanceUnusual: (at, until) => `🌙 Kyiv Digital reported maintenance at an unusual time (${esc(at)}). Requests are paused until ${esc(until)}.`,
    credentialsInvalid: (reason) =>
      `🚨 <b>Kyiv Digital rejected the token.</b> Ticket issuing is stopped.\nReason: ${esc(reason)}\nEnter new credentials: /credentials`,
    credentialsRestored: '✅ The credentials work again.',
    credentialsExpiring: (days, date) => `⏰ The Kyiv Digital token expires in ${days} day(s) (${esc(date)}). Renew it: /credentials`,
    credentialsExpired: '🔴 The Kyiv Digital token has expired. Ticket issuing is stopped. /credentials',
  },
};
