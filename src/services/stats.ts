import { and, asc, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { kyivDay, kyivDayMinus, type Clock } from '../core/clock.js';
import type { Db } from '../db/client.js';
import { tickets, users, type TicketRow, type UserRow } from '../db/schema.js';

export const PERIODS = ['today', 'week', 'month', 'all'] as const;
export type Period = (typeof PERIODS)[number];

export type UserStat = { tgId: number; issued: number; used: number; expired: number; active: number };
export type Totals = Omit<UserStat, 'tgId'>;

/** Read-only reporting queries over tickets. Periods are Kyiv calendar days, inclusive of today. */
export class StatsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** First Kyiv day of the period, or null for all time. */
  periodStart(period: Period): string | null {
    const today = kyivDay(this.clock.now());
    switch (period) {
      case 'today':
        return today;
      case 'week':
        return kyivDayMinus(today, 6);
      case 'month':
        return kyivDayMinus(today, 29);
      case 'all':
        return null;
    }
  }

  private since(day: string | null) {
    return day === null ? undefined : gte(tickets.kyivDay, day);
  }

  perUser(day: string | null, tgId?: number): UserStat[] {
    const n = (status: string) => sql<number>`sum(case when ${tickets.status} = ${status} then 1 else 0 end)`.mapWith(Number);
    return this.db
      .select({ tgId: tickets.userTgId, issued: count(), used: n('used'), expired: n('expired'), active: n('active') })
      .from(tickets)
      .where(and(this.since(day), tgId === undefined ? undefined : eq(tickets.userTgId, tgId)))
      .groupBy(tickets.userTgId)
      .orderBy(desc(count()))
      .all();
  }

  totals(rows: UserStat[]): Totals {
    return rows.reduce((t, r) => ({ issued: t.issued + r.issued, used: t.used + r.used, expired: t.expired + r.expired, active: t.active + r.active }), {
      issued: 0,
      used: 0,
      expired: 0,
      active: 0,
    });
  }

  topPlaces(day: string | null, limit = 5, tgId?: number): { mode: string | null; place: string; n: number }[] {
    return this.db
      .select({ mode: tickets.mode, place: sql<string>`${tickets.place}`, n: count() })
      .from(tickets)
      .where(and(this.since(day), isNotNull(tickets.place), tgId === undefined ? undefined : eq(tickets.userTgId, tgId)))
      .groupBy(tickets.mode, tickets.place)
      .orderBy(desc(count()))
      .limit(limit)
      .all();
  }

  /** Tickets with their owners since a Kyiv day (exports). */
  ticketsSince(day: string | null): { t: TicketRow; u: UserRow | null }[] {
    return this.db
      .select({ t: tickets, u: users })
      .from(tickets)
      .leftJoin(users, eq(users.tgId, tickets.userTgId))
      .where(this.since(day))
      .orderBy(asc(tickets.id))
      .all();
  }
}
