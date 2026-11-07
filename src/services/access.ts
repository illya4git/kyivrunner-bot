import { and, asc, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, type Locale, type Role, type UserRow } from '../db/schema.js';
import type { Clock } from '../core/clock.js';
import type { AuditService } from './audit.js';
import type { SettingsService } from './settings.js';

export type TelegramFrom = {
  id: number;
  username?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  language_code?: string | undefined;
};

export function localeFromLanguageCode(code: string | undefined): Locale {
  return code?.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}

export type RoleChangeResult =
  | { ok: true; user: UserRow; prev: Role }
  | { ok: false; reason: 'not_found' | 'bootstrap' | 'last_admin' | 'unchanged' };

export type RequestResult =
  | { status: 'requested' }
  | { status: 'has_access' }
  | { status: 'banned' }
  | { status: 'pending' }
  | { status: 'cooldown'; until: number };

export type ResolveAction = 'grant' | 'ban' | 'ignore';
export type ResolveResult = { ok: true; user: UserRow } | { ok: false; reason: 'not_found' | 'not_pending' };

const ROLE_ORDER = sql`CASE ${users.role} WHEN 'admin' THEN 0 WHEN 'user' THEN 1 WHEN 'guest' THEN 2 ELSE 3 END`;

export class AccessService {
  private readonly bootstrap: ReadonlySet<number>;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    bootstrapAdminIds: readonly number[],
  ) {
    this.bootstrap = new Set(bootstrapAdminIds);
  }

  isBootstrapAdmin(tgId: number): boolean {
    return this.bootstrap.has(tgId);
  }

  /** Make sure every ADMIN_IDS entry exists and is an admin. Called at startup. */
  ensureBootstrapAdmins(): void {
    const now = this.clock.now();
    for (const tgId of this.bootstrap) {
      const existing = this.get(tgId);
      if (!existing) {
        this.db.insert(users).values({ tgId, role: 'admin', createdAt: now, roleChangedAt: now }).run();
      } else if (existing.role !== 'admin') {
        this.db.update(users).set({ role: 'admin', roleChangedAt: now, roleChangedBy: null }).where(eq(users.tgId, tgId)).run();
        this.audit.log({ kind: 'role_changed', tgId, role: 'admin', data: { from: existing.role, to: 'admin', by: 'ADMIN_IDS' } });
      }
    }
  }

  get(tgId: number): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.tgId, tgId)).get();
  }

  /** Resolve '123456' or '@username' (case-insensitive) to a known user. */
  findByRef(ref: string): UserRow | undefined {
    const r = ref.trim();
    if (/^\d+$/.test(r)) return this.get(Number(r));
    const name = r.replace(/^@/, '');
    if (!name) return undefined;
    return this.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${name})`)
      .get();
  }

  /** Upsert the user from a Telegram update, refresh profile fields and last-seen. */
  touch(from: TelegramFrom): UserRow {
    const now = this.clock.now();
    const profile = {
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      lastSeenAt: now,
    };
    const existing = this.get(from.id);
    if (!existing) {
      const role: Role = this.bootstrap.has(from.id) ? 'admin' : 'guest';
      return this.db
        .insert(users)
        .values({ tgId: from.id, ...profile, locale: localeFromLanguageCode(from.language_code), role, createdAt: now })
        .returning()
        .get();
    }
    const locale = existing.localeOverridden ? existing.locale : localeFromLanguageCode(from.language_code ?? undefined);
    return this.db
      .update(users)
      .set({ ...profile, locale: from.language_code === undefined ? existing.locale : locale })
      .where(eq(users.tgId, from.id))
      .returning()
      .get();
  }

  /** Create a placeholder row so admins can pre-grant someone who hasn't written yet. */
  ensureStub(tgId: number): UserRow {
    return (
      this.get(tgId) ??
      this.db.insert(users).values({ tgId, createdAt: this.clock.now() }).returning().get()
    );
  }

  setRole(tgId: number, role: Role, by: number | null): RoleChangeResult {
    const user = this.get(tgId);
    if (!user) return { ok: false, reason: 'not_found' };
    if (user.role === role) return { ok: false, reason: 'unchanged' };
    if (this.bootstrap.has(tgId) && role !== 'admin') return { ok: false, reason: 'bootstrap' };
    if (user.role === 'admin' && this.adminIds().length <= 1) return { ok: false, reason: 'last_admin' };

    const now = this.clock.now();
    const updated = this.db
      .update(users)
      .set({ role, roleChangedAt: now, roleChangedBy: by, accessRequestedAt: null })
      .where(eq(users.tgId, tgId))
      .returning()
      .get();
    this.audit.log({ kind: 'role_changed', tgId, role, data: { from: user.role, to: role, by } });
    return { ok: true, user: updated, prev: user.role };
  }

  setQuota(tgId: number, quota: number | null, by: number): UserRow | undefined {
    const user = this.get(tgId);
    if (!user) return undefined;
    const updated = this.db.update(users).set({ dailyQuota: quota }).where(eq(users.tgId, tgId)).returning().get();
    this.audit.log({ kind: 'quota_changed', tgId, role: user.role, data: { from: user.dailyQuota, to: quota, by } });
    return updated;
  }

  setLocale(tgId: number, locale: Locale): UserRow | undefined {
    const updated = this.db
      .update(users)
      .set({ locale, localeOverridden: true })
      .where(eq(users.tgId, tgId))
      .returning()
      .get();
    if (updated) this.audit.log({ kind: 'locale_changed', tgId, role: updated.role, data: { locale } });
    return updated;
  }

  effectiveQuota(user: UserRow): number {
    return user.dailyQuota ?? this.settings.get('default_daily_quota');
  }

  // --- access requests -----------------------------------------------------

  requestAccess(tgId: number): RequestResult {
    const user = this.get(tgId);
    if (!user) return { status: 'requested' }; // not reachable: middleware always touches first
    if (user.role === 'banned') return { status: 'banned' };
    if (user.role !== 'guest') return { status: 'has_access' };
    if (user.accessRequestedAt !== null) return { status: 'pending' };
    if (user.requestIgnoredAt !== null) {
      const until = user.requestIgnoredAt + this.settings.get('request_cooldown_hours') * 3_600_000;
      if (this.clock.now() < until) return { status: 'cooldown', until };
    }
    this.db.update(users).set({ accessRequestedAt: this.clock.now() }).where(eq(users.tgId, tgId)).run();
    this.audit.log({ kind: 'access_requested', tgId, role: user.role });
    return { status: 'requested' };
  }

  resolveRequest(tgId: number, action: ResolveAction, by: number): ResolveResult {
    const user = this.get(tgId);
    if (!user) return { ok: false, reason: 'not_found' };
    if (user.accessRequestedAt === null || user.role !== 'guest') return { ok: false, reason: 'not_pending' };

    if (action === 'ignore') {
      const updated = this.db
        .update(users)
        .set({ accessRequestedAt: null, requestIgnoredAt: this.clock.now() })
        .where(eq(users.tgId, tgId))
        .returning()
        .get();
      this.audit.log({ kind: 'access_request_ignored', tgId, role: user.role, data: { by } });
      return { ok: true, user: updated };
    }
    const res = this.setRole(tgId, action === 'grant' ? 'user' : 'banned', by);
    if (!res.ok) return { ok: false, reason: 'not_pending' };
    return { ok: true, user: res.user };
  }

  pendingRequests(): UserRow[] {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.role, 'guest'), isNotNull(users.accessRequestedAt)))
      .orderBy(asc(users.accessRequestedAt))
      .all();
  }

  // --- listings --------------------------------------------------------------

  adminIds(): number[] {
    return this.db
      .select({ id: users.tgId })
      .from(users)
      .where(eq(users.role, 'admin'))
      .all()
      .map((r) => r.id);
  }

  byRoles(roles: Role[]): UserRow[] {
    return this.db.select().from(users).where(inArray(users.role, roles)).all();
  }

  list(page: number, pageSize: number): { rows: UserRow[]; total: number } {
    const total = this.db.select({ n: count() }).from(users).get()?.n ?? 0;
    const rows = this.db
      .select()
      .from(users)
      .orderBy(ROLE_ORDER, desc(users.lastSeenAt), asc(users.tgId))
      .limit(pageSize)
      .offset(page * pageSize)
      .all();
    return { rows, total };
  }
}
