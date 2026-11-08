import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { tickets, type TicketRow } from '../db/schema.js';
import type { KyivClient } from '../kyiv/client.js';
import { FEED_EVENT_TYPE, type FeedEvent } from '../kyiv/schemas.js';
import type { AuditService } from './audit.js';
import type { SettingsService } from './settings.js';

export type PlaceOutcome = { outcome: 'found' | 'retry' | 'gave_up'; ticket: TicketRow };

/**
 * Finds where a used ticket was validated (docs/travel-cards.md §6). The feed's `val_` events
 * carry mode + station/vehicle but not the code; their `created_at` equals the code's `used_at`
 * to the second. Validations reach the feed minutes after the scan, so the tracker searches on
 * a schedule (see TicketTracker) until `place_give_up_hours` after the scan.
 *
 * A ticket whose code left /qr before the bot saw it used has no `used_at`: it takes the
 * earliest unclaimed validation between its issue and the moment the code was missed.
 * Each feed event is linked to at most one ticket (unique column), so physical-card taps
 * and other riders' validations are not claimed twice.
 *
 * Only the matched event's id, mode and place are stored, never the raw feed, which may
 * contain personal data.
 */
export class PlaceResolver {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly kyiv: KyivClient,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly log: Logger,
  ) {}

  /**
   * One feed request per card for all the given tickets. Throws KyivError if a feed can't be
   * fetched; tickets on cards fetched before the failure keep their results.
   */
  async resolve(pending: TicketRow[], onResult: (r: PlaceOutcome) => Promise<void>): Promise<void> {
    const byCard = new Map<number, TicketRow[]>();
    for (const t of pending) byCard.set(t.cardId, [...(byCard.get(t.cardId) ?? []), t]);

    for (const [cardId, list] of byCard) {
      const feed = await this.kyiv.feed(cardId, 1, 30);
      const validations = feed.filter((e) => e.type === FEED_EVENT_TYPE.validation);
      const claimed = this.linkedEventIds(validations.map((e) => e.id));
      // Known scan times first: they match exactly, and must not lose their event to a guess.
      const ordered = [...list].sort((a, b) => Number(a.usedAt === null) - Number(b.usedAt === null) || a.id - b.id);
      for (const t of ordered) {
        const r = this.resolveOne(t, validations, claimed);
        if (r.outcome === 'found') claimed.add(r.ticket.kdFeedEventId!);
        await onResult(r);
      }
    }
  }

  private resolveOne(ticket: TicketRow, validations: FeedEvent[], claimed: Set<string>): PlaceOutcome {
    const now = this.clock.now();
    const free = validations.filter((e) => !claimed.has(e.id));
    const match = ticket.usedAt !== null ? this.byTime(free, ticket.usedAt) : this.firstAfterIssue(free, ticket);
    const attempts = ticket.placeAttempts + 1;

    if (match) {
      const usedAt = ticket.usedAt ?? match.created_at * 1000;
      try {
        const updated = this.db
          .update(tickets)
          .set({ place: match.description ?? null, mode: match.title ?? null, kdFeedEventId: match.id, usedAt, placeAttempts: attempts })
          .where(and(eq(tickets.id, ticket.id), isNull(tickets.kdFeedEventId)))
          .returning()
          .get();
        if (updated) {
          this.audit.log({
            kind: 'place_found',
            tgId: ticket.userTgId,
            data: { ticket: ticket.id, attempts, foundAfterSec: Math.round((now - usedAt) / 1000), ...(ticket.usedAt === null ? { usedAtFromFeed: true } : {}) },
          });
          return { outcome: 'found', ticket: updated };
        }
      } catch (err) {
        // Another ticket claimed the same event in the meantime: treat as not found yet.
        this.log.warn({ err: String(err), ticket: ticket.id }, 'feed event already linked');
      }
    }

    const giveUpAt = (ticket.placeSearchFrom ?? now) + this.settings.get('place_give_up_hours') * 3_600_000;
    const gaveUp = now >= giveUpAt;
    const updated = this.db
      .update(tickets)
      .set({ placeAttempts: attempts, ...(gaveUp ? { placeGaveUpAt: now } : {}) })
      .where(eq(tickets.id, ticket.id))
      .returning()
      .get()!;
    if (!gaveUp) return { outcome: 'retry', ticket: updated };
    this.audit.log({ kind: 'place_unresolved', tgId: ticket.userTgId, data: { ticket: ticket.id, attempts } });
    return { outcome: 'gave_up', ticket: updated };
  }

  private byTime(events: FeedEvent[], usedAt: number): FeedEvent | undefined {
    const windowMs = this.settings.get('place_match_window_sec') * 1000;
    return events
      .map((e) => ({ e, diff: Math.abs(e.created_at * 1000 - usedAt) }))
      .filter((x) => x.diff <= windowMs)
      .sort((a, b) => a.diff - b.diff)[0]?.e;
  }

  private firstAfterIssue(events: FeedEvent[], ticket: TicketRow): FeedEvent | undefined {
    const until = ticket.placeSearchFrom ?? this.clock.now();
    return events
      .filter((e) => e.created_at * 1000 >= ticket.issuedAt && e.created_at * 1000 <= until)
      .sort((a, b) => a.created_at - b.created_at)[0];
  }

  private linkedEventIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    return new Set(
      this.db
        .select({ id: tickets.kdFeedEventId })
        .from(tickets)
        .where(inArray(tickets.kdFeedEventId, ids))
        .all()
        .map((r) => r.id!),
    );
  }
}

/** Is the place for this used ticket still being looked up? */
export function placePending(t: Pick<TicketRow, 'status' | 'kdFeedEventId' | 'placeSearchFrom' | 'placeGaveUpAt'>): boolean {
  return t.status === 'used' && t.kdFeedEventId === null && t.placeSearchFrom !== null && t.placeGaveUpAt === null;
}
