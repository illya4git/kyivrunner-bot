import { sql } from 'drizzle-orm';
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// All timestamps are unix milliseconds unless the column name says otherwise.

export const ROLES = ['guest', 'user', 'admin', 'banned'] as const;
export type Role = (typeof ROLES)[number];

export const LOCALES = ['uk', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const TICKET_STATUSES = ['active', 'used', 'expired'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const users = sqliteTable(
  'users',
  {
    tgId: integer('tg_id').primaryKey({ autoIncrement: false }),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    locale: text('locale', { enum: LOCALES }).notNull().default('uk'),
    localeOverridden: integer('locale_overridden', { mode: 'boolean' }).notNull().default(false),
    role: text('role', { enum: ROLES }).notNull().default('guest'),
    /** NULL = use the `default_daily_quota` setting. */
    dailyQuota: integer('daily_quota'),
    accessRequestedAt: integer('access_requested_at'),
    requestIgnoredAt: integer('request_ignored_at'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    roleChangedAt: integer('role_changed_at'),
    roleChangedBy: integer('role_changed_by'),
  },
  (t) => [
    check('users_role_chk', sql`${t.role} IN ('guest','user','admin','banned')`),
    check('users_locale_chk', sql`${t.locale} IN ('uk','en')`),
    index('users_username_idx').on(t.username),
    index('users_role_idx').on(t.role),
  ],
);

export const credentials = sqliteTable('credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenEnc: blob('token_enc', { mode: 'buffer' }).notNull(),
  tokenIv: blob('token_iv', { mode: 'buffer' }).notNull(),
  tokenTag: blob('token_tag', { mode: 'buffer' }).notNull(),
  deviceUuid: text('device_uuid').notNull(),
  tokenSub: text('token_sub'),
  /** JWT `exp`, unix ms. */
  tokenExp: integer('token_exp'),
  /** ok | invalid | replaced */
  status: text('status').notNull(),
  addedBy: integer('added_by').notNull(),
  addedAt: integer('added_at').notNull(),
  lastOkAt: integer('last_ok_at'),
  lastErrorAt: integer('last_error_at'),
  lastError: text('last_error'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: integer('updated_by'),
  updatedAt: integer('updated_at').notNull(),
});

/** Telegram file ids of media the bot uploaded once and reuses (e.g. placeholder images). */
export const telegramFiles = sqliteTable('telegram_files', {
  /** What the file is, including a hash of its bytes (see qr/placeholder.ts). */
  key: text('key').primaryKey(),
  fileId: text('file_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const tickets = sqliteTable(
  'tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kdTicketId: integer('kd_ticket_id').notNull().unique(),
    userTgId: integer('user_tg_id')
      .notNull()
      .references(() => users.tgId),
    cardId: integer('card_id').notNull(),
    /** Raw QR payload. Needed for a one-time re-send; valid for one day at most. */
    code: text('code').notNull(),
    kyivDay: text('kyiv_day').notNull(),
    /** Card class label shown with the QR (from code.qr_texts.label.text). */
    label: text('label'),
    status: text('status', { enum: TICKET_STATUSES }).notNull().default('active'),
    issuedAt: integer('issued_at').notNull(),
    expireAt: integer('expire_at').notNull(),
    usedAt: integer('used_at'),
    place: text('place'),
    mode: text('mode'),
    kdFeedEventId: text('kd_feed_event_id').unique(),
    /** Feed lookups made so far (informational). */
    placeAttempts: integer('place_attempts').notNull().default(0),
    /**
     * When the place search starts counting from: the code's used_at, or, for a code that left
     * /qr before the bot saw it used, the time that was noticed. Null when no search is due.
     */
    placeSearchFrom: integer('place_search_from'),
    /** The place search gave up at this time. */
    placeGaveUpAt: integer('place_gave_up_at'),
    chatId: integer('chat_id'),
    messageId: integer('message_id'),
    messageGone: integer('message_gone', { mode: 'boolean' }).notNull().default(false),
    resendCount: integer('resend_count').notNull().default(0),
    statusReplyId: integer('status_reply_id'),
    /** Set once a used ticket's QR image was swapped for the placeholder at expiry. */
    imageRetired: integer('image_retired', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    check('tickets_status_chk', sql`${t.status} IN ('active','used','expired')`),
    index('tickets_user_day_idx').on(t.userTgId, t.kyivDay),
    index('tickets_status_idx').on(t.status),
    index('tickets_day_idx').on(t.kyivDay),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    tgId: integer('tg_id'),
    roleAtTime: text('role_at_time'),
    kind: text('kind').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [
    index('events_ts_idx').on(t.ts),
    index('events_tg_ts_idx').on(t.tgId, t.ts),
    index('events_kind_ts_idx').on(t.kind, t.ts),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
