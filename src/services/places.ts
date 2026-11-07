import { eq, inArray } from 'drizzle-orm';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { tickets, type TicketRow } from '../db/schema.js';
import type { KyivClient } from '../kyiv/client.js';
import { FEED_EVENT_TYPE } from '../kyiv/schemas.js';
import type { AuditService } from './audit.js';
import type { SettingsService } from './settings.js';

/** One immediate attempt when the ticket turns "used", then three more tracker cycles. */
export const MAX_PLACE_ATTEMPTS = 4;

export type PlaceOutcome = { outcome: 'found' | 'retry' | 'gave_up'; ticket: TicketRow };

/**
 * Finds where a used ticket was validated (docs/travel-cards.md §6): the feed's `val_`
 * events carry mode + station but not the code, so we match the code's `used_at` to the
 * event's `created_at`. Each feed event is linked to at most one ticket (unique column),
 * which keeps physical-card taps and other riders' validations from being claimed twice.
 *
 * Only the matched event's id, mode and place are stored — never the raw feed, which may
 * contain personal data.
 */
export class PlaceResolver {
  constructor(
    private readonly db: Db,
    private readonly kyiv: KyivClient,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly log: Logger,
  ) {}

  /** Throws KyivError if the feed can't be fetched; such failures don't consume an attempt. */
  async resolve(ticket: TicketRow): Promise<PlaceOutcome> {
    if (ticket.usedAt === null || ticket.kdFeedEventId !== null) return { outcome: 'found', ticket };

    const feed = await this.kyiv.feed(ticket.cardId, 1, 30);
    const windowMs = this.settings.get('place_match_window_sec') * 1000;
    const validations = feed.filter((e) => e.type === FEED_EVENT_TYPE.validation);
    const linked = this.linkedEventIds(validations.map((e) => e.id));

    const best = validations
      .filter((e) => !linked.has(e.id))
      .map((e) => ({ e, diff: Math.abs(e.created_at * 1000 - ticket.usedAt!) }))
      .filter((x) => x.diff <= windowMs)
      .sort((a, b) => a.diff - b.diff)[0];

    const attempts = ticket.placeAttempts + 1;
    if (best) {
      try {
        const updated = this.db
          .update(tickets)
          .set({ place: best.e.description ?? null, mode: best.e.title ?? null, kdFeedEventId: best.e.id, placeAttempts: attempts })
          .where(eq(tickets.id, ticket.id))
          .returning()
          .get();
        return { outcome: 'found', ticket: updated };
      } catch (err) {
        // Another ticket claimed the same event in the meantime: treat as not found yet.
        this.log.warn({ err: String(err), ticket: ticket.id }, 'feed event already linked');
      }
    }

    const updated = this.db.update(tickets).set({ placeAttempts: attempts }).where(eq(tickets.id, ticket.id)).returning().get();
    if (attempts >= MAX_PLACE_ATTEMPTS) {
      this.audit.log({ kind: 'place_unresolved', tgId: ticket.userTgId, data: { ticket: ticket.id, attempts } });
      return { outcome: 'gave_up', ticket: updated };
    }
    return { outcome: 'retry', ticket: updated };
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
export function placePending(t: Pick<TicketRow, 'status' | 'place' | 'kdFeedEventId' | 'placeAttempts'>): boolean {
  return t.status === 'used' && t.kdFeedEventId === null && t.placeAttempts < MAX_PLACE_ATTEMPTS;
}
