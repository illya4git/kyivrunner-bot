import { and, count, desc, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import { kyivDay, type Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import { Mutex } from '../core/mutex.js';
import type { Db } from '../db/client.js';
import { tickets, type TicketRow, type UserRow } from '../db/schema.js';
import type { KyivClient } from '../kyiv/client.js';
import { KyivError, isKyivError } from '../kyiv/errors.js';
import { canGenerate, tripsLeft, type Code } from '../kyiv/schemas.js';
import type { AccessService } from './access.js';
import type { AuditService } from './audit.js';
import type { CredentialService } from './credentials.js';
import { MAX_PLACE_ATTEMPTS, type PlaceResolver } from './places.js';
import type { SettingsService } from './settings.js';

export type Quota = { used: number; limit: number };

export type DenyReason = 'paused' | 'no_credentials' | 'no_card' | 'quota' | 'global_cap' | 'reserve' | 'card_blocked';

export type IssueResult =
  | { kind: 'issued'; ticket: TicketRow; quota: Quota }
  /** The user already has an active ticket — point them to it, never generate another. */
  | { kind: 'existing'; ticket: TicketRow; quota: Quota }
  /** `inspectable`: today's used ticket that is still valid for a conductor's re-scan. */
  | { kind: 'denied'; reason: DenyReason; quota: Quota; inspectable?: TicketRow };

export type TicketTransition = { ticket: TicketRow; to: 'used' | 'expired' };

/** Renders ticket changes in Telegram. Implemented by the bot layer (TicketView). */
export interface TicketPresenter {
  /** active → used | expired: edit the ticket message and reply to it. */
  transition(t: TicketTransition): Promise<void>;
  /** The place was found (or the lookup gave up): update the caption and the status reply. */
  placeUpdated(ticket: TicketRow): Promise<void>;
  /** A used ticket passed midnight: swap the QR for a placeholder, silently. */
  retireImage(ticket: TicketRow): Promise<void>;
}

const NOOP_PRESENTER: TicketPresenter = {
  transition: async () => undefined,
  placeUpdated: async () => undefined,
  retireImage: async () => undefined,
};

/**
 * Issues QR tickets and tracks their lifecycle (active → used | expired).
 *
 * Rules (PLAN.md §4):
 *  - one active ticket per user: a repeat request returns the existing one;
 *  - quota counts tickets *issued* per Kyiv day; global cap and trip reserve protect the owner;
 *  - generation is serialized by a mutex, and the new code is identified against a snapshot
 *    of codes taken right before generating — robust to concurrent use of the phone app;
 *  - a generate whose response was lost is reconciled from the code list instead of retried.
 */
export class TicketService {
  private readonly mutex = new Mutex();
  private presenter: TicketPresenter = NOOP_PRESENTER;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
    private readonly credentials: CredentialService,
    private readonly kyiv: KyivClient,
    private readonly places: PlaceResolver,
    private readonly log: Logger,
  ) {}

  setPresenter(p: TicketPresenter): void {
    this.presenter = p;
  }

  // --- queries -------------------------------------------------------------------

  get(id: number): TicketRow | undefined {
    return this.db.select().from(tickets).where(eq(tickets.id, id)).get();
  }

  activeFor(tgId: number): TicketRow | undefined {
    return this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.userTgId, tgId), eq(tickets.status, 'active')))
      .orderBy(desc(tickets.id))
      .get();
  }

  /** Today's used ticket that is still within its validity (for a conductor's re-scan). */
  inspectableFor(tgId: number): TicketRow | undefined {
    return this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.userTgId, tgId), eq(tickets.status, 'used'), gt(tickets.expireAt, this.clock.now())))
      .orderBy(desc(tickets.id))
      .get();
  }

  quota(user: UserRow): Quota {
    const used =
      this.db
        .select({ n: count() })
        .from(tickets)
        .where(and(eq(tickets.userTgId, user.tgId), eq(tickets.kyivDay, kyivDay(this.clock.now()))))
        .get()?.n ?? 0;
    return { used, limit: this.access.effectiveQuota(user) };
  }

  issuedToday(): number {
    return this.db.select({ n: count() }).from(tickets).where(eq(tickets.kyivDay, kyivDay(this.clock.now()))).get()?.n ?? 0;
  }

  history(tgId: number, limit = 10): TicketRow[] {
    return this.db.select().from(tickets).where(eq(tickets.userTgId, tgId)).orderBy(desc(tickets.id)).limit(limit).all();
  }

  hasActive(): boolean {
    return this.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.status, 'active')).limit(1).get() !== undefined;
  }

  /** Used tickets whose place is still being looked up. */
  pendingPlaces(): TicketRow[] {
    return this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.status, 'used'), isNull(tickets.kdFeedEventId), lt(tickets.placeAttempts, MAX_PLACE_ATTEMPTS)))
      .all();
  }

  /** Used tickets past their validity whose QR image is still shown. */
  dueForRetirement(): TicketRow[] {
    return this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.status, 'used'), eq(tickets.imageRetired, false), lte(tickets.expireAt, this.clock.now())))
      .all();
  }

  /** Kyiv Digital code ids that belong to the bot's tickets, out of `ids`. */
  knownKdIds(ids: number[]): Set<number> {
    if (ids.length === 0) return new Set();
    return new Set(
      this.db
        .select({ kd: tickets.kdTicketId })
        .from(tickets)
        .where(inArray(tickets.kdTicketId, ids))
        .all()
        .map((r) => r.kd),
    );
  }

  // --- message bookkeeping (used by the view) --------------------------------------------

  setMessage(id: number, chatId: number, messageId: number, resent = false): void {
    const t = this.get(id);
    this.db
      .update(tickets)
      .set({ chatId, messageId, messageGone: false, resendCount: (t?.resendCount ?? 0) + (resent ? 1 : 0) })
      .where(eq(tickets.id, id))
      .run();
  }

  markMessageGone(id: number): void {
    this.db.update(tickets).set({ messageGone: true }).where(eq(tickets.id, id)).run();
  }

  setStatusReply(id: number, messageId: number | null): void {
    this.db.update(tickets).set({ statusReplyId: messageId }).where(eq(tickets.id, id)).run();
  }

  markImageRetired(id: number): void {
    this.db.update(tickets).set({ imageRetired: true }).where(eq(tickets.id, id)).run();
  }

  // --- issuing ----------------------------------------------------------------------------

  issue(user: UserRow): Promise<IssueResult> {
    return this.mutex.run(() => this.issueLocked(user));
  }

  private async issueLocked(user: UserRow): Promise<IssueResult> {
    const deny = (reason: DenyReason, extra: { inspectable?: TicketRow } = {}): IssueResult => ({ kind: 'denied', reason, quota: this.quota(user), ...extra });

    if (this.settings.get('paused')) return deny('paused');
    if (!this.credentials.usable()) return deny('no_credentials');
    const cardId = this.settings.get('active_card_id');
    if (cardId === null) return deny('no_card');

    // One list call: refreshes this user's active ticket and snapshots the known codes.
    const before = await this.kyiv.listCodes();
    await this.applyCodes(before);

    const active = this.activeFor(user.tgId);
    if (active) return { kind: 'existing', ticket: active, quota: this.quota(user) };

    const quota = this.quota(user);
    if (quota.used >= quota.limit) {
      this.audit.log({ kind: 'quota_denied', tgId: user.tgId, role: user.role, data: { ...quota } });
      const inspectable = this.inspectableFor(user.tgId);
      return deny('quota', inspectable ? { inspectable } : {});
    }
    const cap = this.settings.get('global_daily_cap');
    if (this.issuedToday() >= cap) {
      this.audit.log({ kind: 'cap_denied', tgId: user.tgId, role: user.role, data: { reason: 'global_cap', cap } });
      return deny('global_cap');
    }

    const card = await this.kyiv.getCard(cardId);
    if (!canGenerate(card)) return deny('card_blocked');
    const reserve = this.settings.get('reserve_trips');
    if (tripsLeft(card) <= reserve) {
      this.audit.log({ kind: 'cap_denied', tgId: user.tgId, role: user.role, data: { reason: 'reserve', trips: tripsLeft(card), reserve } });
      return deny('reserve');
    }

    const known = new Set(before.map((c) => c.id));
    const code = await this.generate(cardId, known);
    const now = this.clock.now();
    const ticket = this.db
      .insert(tickets)
      .values({
        kdTicketId: code.id,
        userTgId: user.tgId,
        cardId: code.card_id,
        code: code.code,
        kyivDay: kyivDay(now),
        label: code.qr_texts?.label?.text ?? card.name ?? null,
        status: 'active',
        issuedAt: now,
        expireAt: code.expire_at * 1000,
      })
      .returning()
      .get();
    this.audit.log({ kind: 'ticket_issued', tgId: user.tgId, role: user.role, data: { ticket: ticket.id, kd: code.id, card: code.card_id } });
    return { kind: 'issued', ticket, quota: { used: quota.used + 1, limit: quota.limit } };
  }

  /** Generate and identify our new code; on an ambiguous failure, look for it instead of retrying. */
  private async generate(cardId: number, known: Set<number>): Promise<Code> {
    try {
      const { codes } = await this.kyiv.generateCode(cardId);
      const found = this.findNewCode(codes, known, cardId);
      if (!found) throw new KyivError('shape', 'generate response contains no new code for the card');
      return found;
    } catch (err) {
      if (!isKyivError(err) || !err.details.ambiguous) throw err;
      this.log.warn({ kind: err.kind }, 'generate outcome unknown, reconciling from the code list');
      const found = this.findNewCode(await this.kyiv.listCodes(), known, cardId);
      this.audit.log({ kind: 'api_error', data: { op: 'generate', kind: err.kind, recovered: found !== undefined } });
      if (!found) throw err; // nothing was created: safe to report the failure
      return found;
    }
  }

  /** The newest usable code on `cardId` that wasn't in the snapshot and isn't ours already. */
  private findNewCode(codes: Code[], known: Set<number>, cardId: number): Code | undefined {
    const candidates = codes.filter((c) => !known.has(c.id) && c.card_id === cardId && c.used_at === null);
    if (candidates.length === 0) return undefined;
    const inDb = new Set(
      this.db
        .select({ kd: tickets.kdTicketId })
        .from(tickets)
        .where(inArray(tickets.kdTicketId, candidates.map((c) => c.id)))
        .all()
        .map((r) => r.kd),
    );
    const fresh = candidates.filter((c) => !inDb.has(c.id));
    if (fresh.length > 1) this.log.warn({ n: fresh.length }, 'several new codes after generate; taking the newest');
    return fresh.sort((a, b) => b.id - a.id)[0];
  }

  // --- tracking ---------------------------------------------------------------------------

  /** Refresh all active tickets from the API. No API call when nothing is active. */
  async sync(): Promise<TicketTransition[]> {
    if (!this.hasActive()) return [];
    return this.applyCodes(await this.kyiv.listCodes());
  }

  /**
   * Like sync(), but serialized with issuing, so a list taken mid-issue can't see our new
   * code before it's recorded. Returns the code list (null if nothing was active).
   */
  syncExclusive(): Promise<Code[] | null> {
    return this.mutex.run(async () => {
      if (!this.hasActive()) return null;
      const codes = await this.kyiv.listCodes();
      await this.applyCodes(codes);
      return codes;
    });
  }

  /**
   * Apply a code list to every active ticket. Each transition is claimed with a conditional
   * UPDATE, so concurrent callers (tracker, /status, 🔄) never report it twice.
   */
  async applyCodes(codes: Code[]): Promise<TicketTransition[]> {
    const byId = new Map(codes.map((c) => [c.id, c]));
    const now = this.clock.now();
    const out: TicketTransition[] = [];

    for (const t of this.db.select().from(tickets).where(eq(tickets.status, 'active')).all()) {
      const code = byId.get(t.kdTicketId);
      let to: TicketTransition['to'] | null = null;
      let usedAt: number | null = null;
      if (code?.used_at != null) {
        to = 'used';
        usedAt = code.used_at * 1000;
      } else if ((code ? code.expire_at * 1000 : t.expireAt) <= now) {
        to = 'expired';
      }
      if (!to) continue;

      const claimed = this.db
        .update(tickets)
        .set({ status: to, usedAt })
        .where(and(eq(tickets.id, t.id), eq(tickets.status, 'active')))
        .returning()
        .get();
      if (!claimed) continue;
      this.audit.log({ kind: to === 'used' ? 'ticket_used' : 'ticket_expired', tgId: t.userTgId, data: { ticket: t.id, kd: t.kdTicketId } });
      out.push({ ticket: claimed, to });
    }

    for (const tr of out) {
      // Try the place right away, so the first notification can already say where.
      if (tr.to === 'used') tr.ticket = (await this.tryResolvePlace(tr.ticket)).ticket;
      try {
        await this.presenter.transition(tr);
      } catch (err) {
        this.log.error({ err, ticket: tr.ticket.id }, 'failed to render a ticket transition');
      }
    }
    return out;
  }

  /** One more lookup for every used ticket whose place is still unknown. */
  async resolvePendingPlaces(): Promise<void> {
    for (const t of this.pendingPlaces()) {
      const r = await this.tryResolvePlace(t);
      if (r.outcome === 'retry') continue;
      try {
        await this.presenter.placeUpdated(r.ticket);
      } catch (err) {
        this.log.error({ err, ticket: t.id }, 'failed to render a resolved place');
      }
    }
  }

  /** Swap the QR image of used tickets that passed midnight (no API calls). */
  async retireDueImages(): Promise<number> {
    const due = this.dueForRetirement();
    for (const t of due) {
      try {
        await this.presenter.retireImage(t);
      } catch (err) {
        this.log.error({ err, ticket: t.id }, 'failed to retire a ticket image');
      }
      this.markImageRetired(t.id); // once: a failed edit isn't worth repeated attempts
    }
    return due.length;
  }

  private async tryResolvePlace(t: TicketRow): Promise<{ outcome: 'found' | 'retry' | 'gave_up'; ticket: TicketRow }> {
    try {
      return await this.places.resolve(t);
    } catch (err) {
      if (!isKyivError(err)) throw err;
      this.log.warn({ kind: err.kind, ticket: t.id }, 'feed unavailable; place stays pending');
      return { outcome: 'retry', ticket: t };
    }
  }
}
