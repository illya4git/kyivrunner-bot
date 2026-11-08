import { EventEmitter } from 'node:events';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import { isKyivError } from '../kyiv/errors.js';
import type { AuditService } from './audit.js';
import type { CredentialService } from './credentials.js';
import type { SettingsService } from './settings.js';
import type { TicketRow } from '../db/schema.js';
import type { TicketService } from './tickets.js';

const MAX_BACKOFF_MS = 5 * 60_000;
/** Consecutive failed passes (≈12 min with backoff) before admins hear about it. */
export const DEGRADED_AFTER = 5;
/** Polling intervals vary by ±20% so the requests don't form an exact rhythm. */
export const JITTER = 0.2;

export type TrackerEvents = {
  /** Kyiv Digital has failed DEGRADED_AFTER passes in a row (not counting a rejected token). */
  degraded: [{ kind: string }];
  /** First successful pass after `degraded`. */
  recovered: [];
};

/**
 * Background loop that keeps tickets in sync without user action. Each pass:
 *  1. retires the QR image of used tickets past midnight (DB only, no API);
 *  2. if any ticket is active and /qr is due: one GET /qr → used/expired transitions
 *     (edit + reply); codes the bot didn't issue (the owner's phone app) are logged once as
 *     `foreign_code`;
 *  3. if a place search is due: one feed request per card for every used ticket still
 *     missing its place.
 * Nothing active or pending means no API calls. The first pass runs at start, which reconciles
 * anything that changed while the bot was down.
 *
 * Each endpoint has its own cadence, `poll_interval_sec` (30s) when fresh, otherwise
 * `poll_idle_interval_sec` (5 min):
 *  - /qr is fresh while a ticket issued within `poll_fresh_window_min` (15) is still unused;
 *  - the feed is searched from `place_search_delay_min` (5) after the scan (validations reach
 *    it minutes late) and is fresh until `poll_fresh_window_min` after the scan; the search
 *    gives up `place_give_up_hours` (6) after it.
 * Every interval varies by ±20% (JITTER), re-rolled after each request, so the calls don't
 * form an exact rhythm. The worst case is about one /qr and one feed request every 24–36 s. Issuing or a ticket turning
 * used wakes a sleeping tracker. Failure backoff is added on top.
 */
export class TicketTracker extends EventEmitter<TrackerEvents> {
  private timer: NodeJS.Timeout | null = null;
  /** When the scheduled pass fires (ms, real time). */
  private dueAt = 0;
  private stopped = true;
  private running: Promise<void> | null = null;
  private backoffMs = 0;
  private readonly seenForeign = new Set<number>();
  private failures = 0;
  /** Last /qr and feed requests made by the tracker (ms, real time). */
  private lastQrAt = 0;
  private lastFeedAt = 0;
  /** Jitter factors for the next /qr and feed intervals, re-rolled after each request. */
  private qrJitter = 1;
  private feedJitter = 1;
  /** End of the last pass (ms, real time) — the liveness heartbeat for /healthz. */
  lastPassAt: number | null = null;
  private degraded = false;

  constructor(
    private readonly tickets: TicketService,
    private readonly credentials: CredentialService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {
    super();
    tickets.on('issued', () => {
      this.lastQrAt = Date.now(); // issuing just listed the codes
      this.qrJitter = this.jitter();
      this.wake();
    });
    tickets.on('used', () => this.wake());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0, true); // the first pass reconciles everything
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Run a pass now (coalesces with one already in progress). By default every endpoint with
   * work is called regardless of its cadence (tests, /dev tick); the timer passes `false`.
   */
  tick(force = true): Promise<void> {
    this.running ??= this.pass(force).finally(() => {
      this.running = null;
      this.lastPassAt = Date.now();
    });
    return this.running;
  }

  /** When the next scheduled pass fires (ms, real time), or null when none is scheduled. */
  get nextPassAt(): number | null {
    return this.timer ? this.dueAt : null;
  }

  /**
   * Liveness for /healthz: a pass ended within the longest gap the settings allow
   * (the slower cadence plus maximum backoff), with 5 minutes of slack.
   */
  isLive(now = Date.now()): boolean {
    if (this.lastPassAt === null) return false;
    const cadenceMs = Math.max(this.settings.get('poll_interval_sec'), this.settings.get('poll_idle_interval_sec')) * 1000;
    return now - this.lastPassAt < cadenceMs + MAX_BACKOFF_MS + 5 * 60_000;
  }

  private ms(key: 'poll_interval_sec' | 'poll_idle_interval_sec'): number {
    return this.settings.get(key) * 1000;
  }

  /** A factor in [1 - JITTER, 1 + JITTER]. */
  private jitter(): number {
    return 1 - JITTER + 2 * JITTER * this.random();
  }

  /** /qr cadence: fast while a recently issued ticket is unused. */
  qrIntervalMs(): number {
    const fresh = this.tickets.hasActiveIssuedSince(this.clock.now() - this.settings.get('poll_fresh_window_min') * 60_000);
    return this.ms(fresh ? 'poll_interval_sec' : 'poll_idle_interval_sec') * this.qrJitter;
  }

  /** Pending places split into those searchable now, and when (service clock) the next one becomes so. */
  private placeSearch(): { searchable: TicketRow[]; nextAt: number | null } {
    const now = this.clock.now();
    const delayMs = this.settings.get('place_search_delay_min') * 60_000;
    const searchable: TicketRow[] = [];
    let nextAt: number | null = null;
    for (const t of this.tickets.pendingPlaces()) {
      const from = t.placeSearchFrom! + delayMs;
      if (from <= now) searchable.push(t);
      else nextAt = Math.min(nextAt ?? from, from);
    }
    return { searchable, nextAt };
  }

  /** Feed cadence: fast while a searchable ticket was scanned within the fresh window. */
  feedIntervalMs(searchable: TicketRow[]): number {
    const freshSince = this.clock.now() - this.settings.get('poll_fresh_window_min') * 60_000;
    return this.ms(searchable.some((t) => t.placeSearchFrom! >= freshSince) ? 'poll_interval_sec' : 'poll_idle_interval_sec') * this.feedJitter;
  }

  /** Delay until the next pass: the earlier of the two endpoints' due times, at most the idle cadence. */
  nextDelayMs(): number {
    const now = Date.now();
    const due = [now + this.ms('poll_idle_interval_sec') * this.jitter()];
    if (this.tickets.hasActive()) due.push(this.lastQrAt + this.qrIntervalMs());
    const { searchable, nextAt } = this.placeSearch();
    if (searchable.length > 0) due.push(this.lastFeedAt + this.feedIntervalMs(searchable));
    if (nextAt !== null) due.push(now + (nextAt - this.clock.now()));
    return Math.max(1000, Math.min(...due) - now) + this.backoffMs;
  }

  /** Bring a sleeping pass forward if something became due sooner (not during backoff). */
  private wake(): void {
    if (this.stopped || !this.timer || this.backoffMs > 0) return;
    const delay = this.nextDelayMs();
    if (this.dueAt - Date.now() > delay) this.schedule(delay);
  }

  private schedule(ms: number, force = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = Date.now() + ms;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick(force);
      if (!this.stopped) this.schedule(this.nextDelayMs());
    }, ms);
  }

  private async pass(force: boolean): Promise<void> {
    // Timers may fire a little early; don't skip a request over a few milliseconds.
    const isDue = (last: number, interval: number) => force || Date.now() - last >= interval - 500;
    try {
      await this.tickets.retireDueImages();
      if (!this.credentials.usable()) return;

      if (this.tickets.hasActive() && isDue(this.lastQrAt, this.qrIntervalMs())) {
        this.lastQrAt = Date.now();
        this.qrJitter = this.jitter();
        const codes = await this.tickets.syncExclusive();
        if (codes) this.noteForeignCodes(codes.map((c) => ({ id: c.id, card: c.card_id })));
      }
      const { searchable } = this.placeSearch();
      if (searchable.length > 0 && isDue(this.lastFeedAt, this.feedIntervalMs(searchable))) {
        this.lastFeedAt = Date.now();
        this.feedJitter = this.jitter();
        await this.tickets.resolvePlaces(searchable);
      }
      this.backoffMs = 0;
      this.failures = 0;
      if (this.degraded) {
        this.degraded = false;
        this.emit('recovered');
      }
    } catch (err) {
      if (!isKyivError(err)) {
        this.log.error({ err }, 'tracker pass failed');
        return;
      }
      // A rejected token has its own alert (credentials); don't double up.
      if (err.kind !== 'unauthorized' && ++this.failures >= DEGRADED_AFTER && !this.degraded) {
        this.degraded = true;
        this.emit('degraded', { kind: err.kind });
      }
      this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(30_000, this.backoffMs * 2));
      this.log.warn({ kind: err.kind, backoffMs: this.backoffMs }, 'tracker: Kyiv Digital call failed, backing off');
    }
  }

  private noteForeignCodes(codes: { id: number; card: number }[]): void {
    const unseen = codes.filter((c) => !this.seenForeign.has(c.id));
    if (unseen.length === 0) return;
    const ours = this.tickets.knownKdIds(unseen.map((c) => c.id));
    for (const c of unseen) {
      this.seenForeign.add(c.id);
      if (!ours.has(c.id)) this.audit.log({ kind: 'foreign_code', data: { kd: c.id, card: c.card } });
    }
  }
}
