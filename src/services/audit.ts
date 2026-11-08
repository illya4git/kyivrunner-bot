import { and, asc, desc, eq, gte, lt, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, type EventRow, type Role } from '../db/schema.js';
import type { Clock } from '../core/clock.js';

export const EVENT_KINDS = [
  'interaction',
  'denied',
  'access_requested',
  'access_request_ignored',
  'ticket_issued',
  'ticket_pointed',
  'ticket_resent',
  'ticket_used',
  'ticket_expired',
  'place_found',
  'place_unresolved',
  'quota_denied',
  'cap_denied',
  'role_changed',
  'quota_changed',
  'locale_changed',
  'setting_changed',
  'credentials_set',
  'credentials_cleared',
  'credentials_invalid',
  'credentials_expiring',
  'api_error',
  'foreign_code',
  'paused',
  'resumed',
  'admin_alert',
  'exported',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type AuditEntry = {
  kind: EventKind;
  tgId?: number | null;
  role?: Role | null;
  data?: Record<string, unknown>;
};

/** Append-only audit log. Never put credentials or QR payloads into `data`. */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  log(e: AuditEntry): void {
    this.db
      .insert(events)
      .values({
        ts: this.clock.now(),
        tgId: e.tgId ?? null,
        roleAtTime: e.role ?? null,
        kind: e.kind,
        data: e.data ?? null,
      })
      .run();
  }

  recent(opts: { tgId?: number; kind?: EventKind; exclude?: EventKind[]; limit?: number } = {}): EventRow[] {
    const conds = [];
    if (opts.tgId !== undefined) conds.push(eq(events.tgId, opts.tgId));
    if (opts.kind !== undefined) conds.push(eq(events.kind, opts.kind));
    if (opts.exclude?.length) conds.push(notInArray(events.kind, opts.exclude));
    return this.db
      .select()
      .from(events)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(events.id))
      .limit(opts.limit ?? 20)
      .all();
  }

  /** Events since `sinceMs`, oldest first (exports). */
  since(sinceMs: number): EventRow[] {
    return this.db.select().from(events).where(gte(events.ts, sinceMs)).orderBy(asc(events.id)).all();
  }

  /**
   * Record that an alert of `key` went out for `scope` (e.g. a Kyiv day); returns false if
   * it already had. Survives restarts, so admins aren't re-alerted after a redeploy.
   */
  claimAlert(key: string, scope: string): boolean {
    const seen = this.recent({ kind: 'admin_alert', limit: 200 }).some((e) => e.data?.key === key && e.data?.scope === scope);
    if (seen) return false;
    this.log({ kind: 'admin_alert', data: { key, scope } });
    return true;
  }

  /** Delete events older than `days`. Returns the number of deleted rows. */
  prune(days: number): number {
    const cutoff = this.clock.now() - days * 86_400_000;
    return this.db.delete(events).where(lt(events.ts, cutoff)).run().changes;
  }
}
