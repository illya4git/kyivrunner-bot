import { esc } from '../core/html.js';

// All strings are Telegram HTML. Interpolated user-provided values must go through esc().

export const uk = {
  roles: { guest: 'гість', user: 'користувач', admin: 'адміністратор', banned: 'заблокований' },

  common: {
    error: '⚠️ Щось пішло не так. Спробуйте трохи пізніше.',
    noAccess: '🔒 У вас немає доступу. Надішліть /request, щоб попросити його.',
    adminOnly: '🔒 Ця команда доступна лише адміністраторам.',
    unknownCommand: 'Невідома команда. Список команд: /help',
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
    cancel: 'Скасувати введення облікових даних',
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
    btnStats: '📊 Статистика',
    btnLogs: '📜 Журнал',
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

  kyivError: {
    no_credentials: '🔑 Облікові дані Київ Цифровий не налаштовані. Адміністратор: /credentials',
    unauthorized: '⛔ Київ Цифровий відхилив токен.',
    rate_limited: '⏳ Київ Цифровий просить зачекати. Спробуйте за хвилину.',
    unavailable: '📡 Київ Цифровий зараз недоступний. Спробуйте пізніше.',
    shape: '🧩 Київ Цифровий повернув неочікувані дані. Адміністраторам варто перевірити журнал.',
    rejected: (msg: string | undefined) => `⛔ Київ Цифровий відхилив запит${msg ? `: ${esc(msg)}` : '.'}`,
  },

  creds: {
    states: {
      missing: '⚪️ не налаштовані',
      ok: '✅ працюють',
      expiring: '🟡 скоро спливають',
      expired: '🔴 спливли',
      invalid: '🔴 відхилені Київ Цифровим',
    },
    view: (p: {
      state: string;
      token?: string | undefined;
      device?: string | undefined;
      subject?: string | null | undefined;
      expires?: string | undefined;
      added?: string | undefined;
      addedBy?: string | undefined;
      lastOk?: string | undefined;
      lastError?: string | undefined;
    }) =>
      `<b>🔑 Облікові дані Київ Цифровий</b>\n` +
      `Стан: ${p.state}\n` +
      (p.token ? `Токен: <code>${esc(p.token)}</code>\n` : '') +
      (p.device ? `Пристрій: <code>${esc(p.device)}</code>\n` : '') +
      (p.subject ? `Акаунт: <code>${esc(p.subject)}</code>\n` : '') +
      (p.expires ? `Дійсний до: ${esc(p.expires)}\n` : '') +
      (p.added ? `Додано: ${esc(p.added)}${p.addedBy ? ` (${p.addedBy})` : ''}\n` : '') +
      (p.lastOk ? `Остання успішна відповідь: ${esc(p.lastOk)}\n` : '') +
      (p.lastError ? `Остання помилка: ${esc(p.lastError)}\n` : ''),
    btnSet: '🔑 Ввести нові',
    btnCheck: '🔍 Перевірити',
    btnClear: '🗑 Видалити',
    btnClearConfirm: '🗑 Так, видалити',
    btnCancel: 'Скасувати',
    clearConfirm: 'Видалити облікові дані? Бот не зможе видавати квитки, доки їх не введуть знову.',
    cleared: '🗑 Облікові дані видалено.',
    askToken:
      '🔑 Надішліть <b>access token</b> (JWT, починається з <code>eyJ</code>).\n' +
      'Я видалю повідомлення одразу після прочитання. /cancel — скасувати.',
    askDevice: (exp: string) =>
      `✅ Токен прийнято (дійсний до ${esc(exp)}).\n` +
      `Тепер надішліть <b>device UUID</b> з того самого встановлення застосунку.`,
    tokenNoExp: 'дата невідома',
    badToken: '⚠️ Це не схоже на JWT-токен. Надішліть токен ще раз або /cancel.',
    expiredToken: '⚠️ Термін дії цього токена вже минув. Надішліть інший або /cancel.',
    badDevice: '⚠️ Це не схоже на UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Спробуйте ще раз або /cancel.',
    probing: '⏳ Перевіряю в Київ Цифровий…',
    probeUnauthorized: '⛔ Київ Цифровий відхилив цю пару токен + UUID. Переконайтеся, що обидва взято з одного встановлення. Почніть знову: /credentials',
    probeFailed: (err: string) => `⚠️ Не вдалося перевірити: ${err}\nНадішліть UUID ще раз, щоб повторити, або /cancel.`,
    saved: (n: number) => `✅ Облікові дані збережено. Карток в акаунті: ${n}.`,
    noCards: '⚠️ В акаунті немає транспортних карток — видавати квитки не буде з чого.',
    cancelled: 'Скасовано.',
    timedOut: '⌛ Введення облікових даних скасовано через бездіяльність.',
    checkOk: '✅ Облікові дані працюють.',
    tokenDeleted: '🧹 Схоже на токен — я видалив повідомлення. Щоб змінити облікові дані, адміністратор використовує /credentials.',
  },

  card: {
    pickPrompt: 'Оберіть картку, з якої видавати квитки:',
    picked: (name: string) => `✅ Активна картка: ${esc(name)}`,
    notSelected: '⚠️ Картку не обрано.',
    notFound: '⚠️ Обраної картки більше немає в акаунті. Оберіть іншу.',
    btnRefresh: '🔄 Оновити',
    btnChange: '🔁 Змінити картку',
    view: (p: {
      name: string;
      number: string;
      trips: number;
      validTo?: string | undefined;
      activeCodes: number;
      canGenerate: boolean;
      creds: string;
      tokenExp?: string | undefined;
      rate?: string | undefined;
    }) =>
      `<b>💳 ${esc(p.name)}</b> · <code>${esc(p.number)}</code>\n` +
      `Поїздок залишилось: <b>${p.trips}</b>${p.validTo ? ` (до ${esc(p.validTo)})` : ''}\n` +
      `Активних QR-квитків: ${p.activeCodes}\n` +
      `Генерація: ${p.canGenerate ? '✅ доступна' : '⛔ недоступна'}\n` +
      `Облікові дані: ${p.creds}${p.tokenExp ? `, до ${esc(p.tokenExp)}` : ''}` +
      (p.rate ? `\nЛіміт API: ${esc(p.rate)}` : ''),
  },

  tickets: {
    caption: (p: { label: string; until: string; date: string; used: number; limit: number; resent: boolean }) =>
      (p.resent ? '🔁 <i>Попереднє повідомлення було видалено — це той самий квиток.</i>\n\n' : '') +
      `🎫 <b>${esc(p.label)}</b>\n` +
      `Дійсний до ${esc(p.until)} (${esc(p.date)})\n` +
      `Сьогодні: ${p.used}/${p.limit}\n\n` +
      `Відскануйте QR-код на валідаторі.`,
    captionUsed: (p: { label: string; time: string; place?: string | undefined; until: string; resent: boolean }) =>
      (p.resent ? '🔁 <i>Надіслано повторно для перевірки.</i>\n\n' : '') +
      `✅ <b>${esc(p.label)}</b> — використано о ${esc(p.time)}` +
      (p.place ? `\n📍 ${esc(p.place)}` : '') +
      `\n\nПокажіть цей QR контролеру, якщо попросять (до ${esc(p.until)}).`,
    captionUsedFinal: (p: { label: string; date: string; time: string; place?: string | undefined }) =>
      `✅ <b>${esc(p.label)}</b> — використано ${esc(p.date)} о ${esc(p.time)}` + (p.place ? `\n📍 ${esc(p.place)}` : ''),
    captionExpired: (p: { label: string; date: string }) =>
      `⌛ <b>${esc(p.label)}</b> — не використано (${esc(p.date)}).\nПоїздка повернулася на картку.`,
    pointer: (until: string, quota: string) => `⬆️ Ваш активний QR-квиток — вище. Дійсний до ${esc(until)}.\n${quota}`,
    pointerUsed: (time: string, quota: string) => `⬆️ Ваш квиток використано о ${esc(time)}. Його можна показати контролеру.\n${quota}`,
    placePending: 'визначаю місце…',
    quotaLine: (used: number, limit: number) => `Сьогодні: ${used}/${limit}.`,
    usedReply: (time: string, place?: string) => `✅ Ваш QR-квиток використано о ${esc(time)}${place ? ` — ${esc(place)}` : ''}.`,
    expiredReply: '⌛ Ваш QR-квиток сплив невикористаним. Поїздка повернулася на картку.',
    btnRefresh: '🔄 Оновити статус',
    toastActive: 'Ще не використано.',
    toastUsed: (time: string) => `Використано о ${time}.`,
    toastExpired: 'Сплив невикористаним.',
    notYours: 'Це не ваш квиток.',
    noActive: (quota: string) => `Немає активного квитка. ${quota}\nНатисніть «🎫 QR», щоб отримати.`,
    denied: {
      paused: '⏸ Видачу квитків тимчасово призупинено адміністратором.',
      no_credentials: '🔧 Бот тимчасово не може видавати квитки. Адміністраторів уже повідомлено.',
      no_card: '🔧 Адміністратор ще не обрав картку для квитків.',
      quota: (used: number, limit: number) => `🚫 Ліміт на сьогодні вичерпано (${used}/${limit}). Новий день — нові квитки.`,
      global_cap: '🚫 Денний ліміт квитків для всіх користувачів вичерпано. Спробуйте завтра.',
      reserve: '🚫 На картці закінчуються поїздки — видачу зупинено.',
      card_blocked: '🚫 Картка зараз не дозволяє створювати QR-квитки.',
    },
    historyHeader: '<b>Ваші останні квитки</b>',
    historyEmpty: 'Ви ще не отримували квитків.',
    historyActive: (date: string, until: string) => `🎫 ${esc(date)} — активний до ${esc(until)}`,
    historyUsed: (date: string, time: string, place?: string) => `✅ ${esc(date)} ${esc(time)}${place ? ` — ${esc(place)}` : ''}`,
    historyExpired: (date: string) => `⌛ ${esc(date)} — не використано`,
  },

  settings: {
    header: '<b>⚙️ Налаштування</b>',
    footer: 'Змінити: <code>/set ключ значення</code>',
    line: (key: string, value: string, isDefault: boolean, desc: string) =>
      `<code>${esc(key)}</code> = <b>${esc(value)}</b>${isDefault ? ' · типово' : ''}\n<i>${esc(desc)}</i>`,
    desc: {
      default_daily_quota: 'Квитків на користувача на день',
      global_daily_cap: 'Квитків на день для всіх разом',
      reserve_trips: 'Не видавати квитки, якщо на картці стільки поїздок або менше',
      low_balance_alert: 'Попереджати адмінів, коли поїздок залишилося стільки або менше',
      active_card_id: 'Активна картка (змінюється через /card)',
      poll_interval_sec: 'Як часто перевіряти свіжі квитки, секунд',
      poll_idle_interval_sec: 'Як часто перевіряти, коли свіжих квитків немає, секунд',
      poll_fresh_window_min: 'Скільки хвилин після видачі невикористаний квиток вважається свіжим',
      place_match_window_sec: 'Макс. розбіжність часу при визначенні місця, секунд',
      api_rate_per_min: 'Ліміт запитів до Київ Цифровий за хвилину',
      request_cooldown_hours: 'Пауза перед повторним /request після ігнорування, годин',
      log_retention_days: 'Скільки днів зберігати журнал подій',
      paused: 'Видачу призупинено (/pause, /resume)',
    },
    unknownKey: (key: string) => `Невідомий ключ <code>${esc(key)}</code>. Список: /settings`,
    internalKey: (key: string) => `<code>${esc(key)}</code> змінюється окремо (див. /settings).`,
    invalid: (key: string, err: string) => `⚠️ Неприпустиме значення для <code>${esc(key)}</code>: ${esc(err)}`,
    changed: (key: string, from: string, to: string) => `✅ <code>${esc(key)}</code>: ${esc(from)} → <b>${esc(to)}</b>`,
  },

  pause: {
    paused: '⏸ Видачу квитків призупинено. Активні квитки працюють як і раніше. /resume — відновити.',
    resumed: '▶️ Видачу квитків відновлено.',
    alreadyPaused: 'Видачу вже призупинено.',
    notPaused: 'Видача не призупинена.',
    noticePaused: (by: string) => `⏸ ${by} призупинив(-ла) видачу квитків.`,
    noticeResumed: (by: string) => `▶️ ${by} відновив(-ла) видачу квитків.`,
  },

  stats: {
    periods: { today: 'сьогодні', week: '7 днів', month: '30 днів', all: 'весь час' },
    header: (period: string) => `<b>📊 Статистика — ${esc(period)}</b>`,
    userLine: (name: string, p: { issued: number; used: number; expired: number; active: number }) =>
      `• ${name}: ${p.issued} 🎫 · ${p.used} ✅ · ${p.expired} ⌛${p.active ? ` · ${p.active} активн.` : ''}`,
    total: (p: { issued: number; used: number; expired: number; active: number }) =>
      `<b>Разом:</b> ${p.issued} 🎫 · ${p.used} ✅ · ${p.expired} ⌛${p.active ? ` · ${p.active} активн.` : ''}`,
    empty: 'За цей період квитків не було.',
    placesHeader: '<b>Найчастіші місця</b>',
    placeLine: (place: string, n: number) => `• ${esc(place)} — ${n}`,
    card: (trips: number) => `💳 Поїздок на картці: <b>${trips}</b>`,
    cardUnavailable: '💳 Баланс картки зараз недоступний.',
    legend: '🎫 видано · ✅ використано · ⌛ сплило',
    usage: 'Використання: /stats [today|week|month|all]',
    userHeader: (name: string) => `<b>📊 ${name} — 30 днів</b>`,
    recentHeader: '<b>Останні квитки</b>',
  },

  logs: {
    header: (n: number, who?: string) => `<b>📜 Журнал</b> — останні ${n}${who ? ` · ${who}` : ' (без взаємодій)'}`,
    empty: 'Подій немає.',
    usage: 'Використання: /logs [id|@user] [кількість]',
  },

  export: {
    usage: 'Використання: /export [tickets|events] [днів]',
    caption: (what: string, days: string, n: number) => `📤 ${esc(what)} · ${esc(days)} · рядків: ${n}`,
    allTime: 'весь час',
    days: (n: number) => `${n} дн.`,
  },

  alerts: {
    lowBalance: (trips: number) => `🪫 На картці залишилося <b>${trips}</b> поїздок.`,
    generationBlocked: '⛔ Картка не дозволяє створювати QR-квитки (заблокована або вимкнено генерацію). /card',
    apiDegraded: (kind: string) => `📡 Київ Цифровий не відповідає вже кілька хвилин (${esc(kind)}). Статуси квитків оновляться, щойно зв’язок відновиться.`,
    apiRecovered: '✅ Зв’язок із Київ Цифровий відновлено.',
    credentialsInvalid: (reason: string) =>
      `🚨 <b>Київ Цифровий відхилив токен.</b> Видачу квитків зупинено.\nПричина: ${esc(reason)}\nВведіть нові облікові дані: /credentials`,
    credentialsRestored: '✅ Облікові дані знову працюють.',
    credentialsExpiring: (days: number, date: string) =>
      `⏰ Токен Київ Цифровий спливає через ${days} дн. (${esc(date)}). Оновіть його: /credentials`,
    credentialsExpired: '🔴 Термін дії токена Київ Цифровий минув. Видачу квитків зупинено. /credentials',
  },
};

export type Messages = typeof uk;
