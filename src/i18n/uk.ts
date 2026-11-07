import { esc } from '../core/html.js';

// All strings are Telegram HTML. Interpolated user-provided values must go through esc().

export const uk = {
  roles: { guest: 'гість', user: 'користувач', admin: 'адміністратор', banned: 'заблокований' },

  common: {
    error: '⚠️ Щось пішло не так. Спробуйте трохи пізніше.',
    noAccess: '🔒 У вас немає доступу. Надішліть /request, щоб попросити його.',
    adminOnly: '🔒 Ця команда доступна лише адміністраторам.',
    unknownCommand: 'Невідома команда. Список команд: /help',
    notImplemented: '🚧 Ця функція ще в розробці.',
    usage: (u: string) => `Використання: <code>${esc(u)}</code>`,
    userNotFound: (ref: string) => `Користувача <code>${esc(ref)}</code> не знайдено. Людина має спершу написати боту, або вкажіть числовий ID.`,
    back: '« Назад',
    yes: 'так',
    no: 'ні',
    never: 'ніколи',
  },

  /** Plain text (not HTML): used both in Telegram's command menu and, escaped, in /help. */
  cmd: {
    start: 'Почати',
    help: 'Довідка',
    whoami: 'Мій профіль і квота',
    lang: 'Мова / Language',
    request: 'Попросити доступ',
    qr: 'Отримати QR-квиток',
    status: 'Статус поточного квитка',
    history: 'Мої останні квитки',
    users: 'Користувачі',
    requests: 'Запити на доступ',
    grant: 'Надати роль: /grant <id|@user> [user|admin]',
    revoke: 'Забрати доступ: /revoke <id|@user>',
    quota: 'Квота: /quota <id|@user> <n|default>',
    settings: 'Налаштування',
    set: 'Змінити: /set <ключ> <значення>',
    stats: 'Статистика',
    logs: 'Журнал подій',
    export: 'Експорт CSV',
    card: 'Картка і баланс',
    credentials: 'Облікові дані Київ Цифровий',
    pause: 'Призупинити видачу',
    resume: 'Відновити видачу',
  },

  start: {
    guest: (id: number) =>
      `👋 Вітаю! Цей бот видає QR-квитки для проїзду, але лише схваленим людям.\n\n` +
      `Ваш ID: <code>${id}</code>\nЩоб попросити доступ, надішліть /request.`,
    user: (name: string) => `👋 Вітаю, ${esc(name)}! Натисніть «🎫 QR», щоб отримати квиток. Довідка: /help`,
    admin: (name: string) => `👋 Вітаю, ${esc(name)}! Ви адміністратор. Довідка: /help`,
  },

  help: {
    header: (role: string) => `<b>Доступні команди</b> (роль: ${esc(role)}):`,
  },

  keyboard: { qr: '🎫 QR' },

  whoami: (p: { id: number; role: string; username: string | null; quota: number; quotaIsDefault: boolean; locale: string }) =>
    `<b>Профіль</b>\n` +
    `ID: <code>${p.id}</code>\n` +
    (p.username ? `Username: @${esc(p.username)}\n` : '') +
    `Роль: ${esc(p.role)}\n` +
    `Денна квота: ${p.quota}${p.quotaIsDefault ? ' (типова)' : ''}\n` +
    `Мова: ${esc(p.locale)}`,

  lang: {
    prompt: 'Оберіть мову / Choose language:',
    changed: '✅ Мову змінено на українську.',
  },

  request: {
    sent: '📨 Запит надіслано адміністраторам. Ви отримаєте повідомлення, щойно його розглянуть.',
    hasAccess: '✅ У вас уже є доступ. Довідка: /help',
    pending: '⏳ Ваш запит уже очікує на розгляд.',
    cooldown: (until: string) => `⏳ Повторний запит можна надіслати після ${esc(until)}.`,
    granted: '🎉 Доступ надано! Натисніть «🎫 QR», щоб отримати квиток. Довідка: /help',
  },

  roleChangedNotice: (role: string) => `ℹ️ Вашу роль змінено: <b>${esc(role)}</b>.`,

  admin: {
    requestNotice: (user: string, id: number) => `📨 <b>Запит на доступ</b>\n${user}\nID: <code>${id}</code>`,
    requestGranted: (by: string) => `✅ Доступ надано (${esc(by)})`,
    requestBanned: (by: string) => `🚫 Заблоковано (${esc(by)})`,
    requestIgnored: (by: string) => `🙈 Проігноровано (${esc(by)})`,
    requestAlreadyHandled: 'Цей запит уже розглянуто.',
    btnGrant: '✅ Надати доступ',
    btnBan: '🚫 Заблокувати',
    btnIgnore: '🙈 Ігнорувати',
    noRequests: 'Немає запитів, що очікують.',
    requestsHeader: (n: number) => `<b>Запити на доступ</b>: ${n}`,

    usersHeader: (page: number, pages: number, total: number) => `<b>Користувачі</b> — ${total} (стор. ${page}/${pages})`,
    userCard: (p: {
      name: string;
      id: number;
      role: string;
      quota: number;
      quotaIsDefault: boolean;
      created: string;
      lastSeen: string;
      bootstrap: boolean;
      pending: boolean;
    }) =>
      `<b>${p.name}</b>\n` +
      `ID: <code>${p.id}</code>\n` +
      `Роль: ${esc(p.role)}${p.bootstrap ? ' (з ADMIN_IDS)' : ''}\n` +
      `Денна квота: ${p.quota}${p.quotaIsDefault ? ' (типова)' : ''}\n` +
      `Створено: ${esc(p.created)}\n` +
      `Востаннє: ${esc(p.lastSeen)}` +
      (p.pending ? '\n📨 Очікує на доступ' : ''),
    btnQuota: '🎚 Квота…',
    btnPrev: '‹',
    btnNext: '›',
    quotaPrompt: (name: string) => `Денна квота для <b>${name}</b>:`,
    quotaDefault: (n: number) => `Типова (${n})`,
    quotaDefaultWord: 'типова',
    quotaSet: (name: string, q: string) => `✅ Квота для ${name}: ${esc(q)}`,
    roleSet: (name: string, role: string) => `✅ ${name}: роль <b>${esc(role)}</b>`,
    refuseBootstrap: '⛔ Цей адміністратор заданий у ADMIN_IDS — його роль не можна змінити з бота.',
    refuseLastAdmin: '⛔ Не можна понизити останнього адміністратора.',
    refuseUnchanged: 'Роль не змінилась.',
    badQuota: 'Квота має бути цілим числом від 0 до 100 або «default».',
    badRole: 'Роль має бути user або admin.',
  },
};

export type Messages = typeof uk;
