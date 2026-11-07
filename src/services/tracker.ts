import { EventEmitter } from 'node:events';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import { isKyivError } from '../kyiv/errors.js';
import type { AuditService } from './audit.js';
import type { CredentialService } from './credentials.js';
import type { SettingsService } from './settings.js';
import type { TicketService } from './tickets.js';

const MAX_BACKOFF_MS = 5 * 60_000;
/** Consecutive failed passes (≈12 min with backoff) before admins hear about it. */
export const DEGRADED_AFTER = 5;

export type TrackerEvents = {
  /** Kyiv Digital has failed DEGRADED_AFTER passes in a row (not counting a rejected token). */
  degraded: [{ kind: string }];
  /** First successful pass after `degraded`. */
  recovered: [];
};

/**
 * Background loop that keeps tickets in sync without user action. Each pass:
 *  1. retires the QR image of used tickets past midnight (DB only, no API);
 *  2. if any ticket is active: one GET /qr → used/expired transitions (edit + reply);
 *     codes the bot didn't issue (the owner's phone app) are logged once as `foreign_code`;
 *  3. retries the place lookup for used tickets still missing one.
 * Idle passes cost nothing: no API call is made unless something is active or pending.
 * The first pass runs at start, which reconciles anything that changed while the bot was down.
 *
 * Cadence: `poll_interval_sec` while a ticket issued within the last `poll_fresh_window_min`
 * is still unused, or a place lookup is pending; otherwise `poll_idle_interval_sec`. An older
 * unused ticket is rarely scanned, and the user can always press 🔄 or send /status. Issuing a
 * ticket wakes a sleeping tracker into the fast cadence. Failure backoff is added on top.
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
  ) {
    super();
    tickets.on('issued', () => this.wake());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run a pass now (coalesces with one already in progress). Used by tests and /dev clock. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
      this.lastPassAt = Date.now();
    });
    return this.running;
  }

  /** Is there something worth the fast cadence: a fresh unused ticket or a pending place? */
  isBusy(): boolean {
    const windowMs = this.settings.get('poll_fresh_window_min') * 60_000;
    return this.tickets.hasActiveIssuedSince(this.clock.now() - windowMs) || this.tickets.pendingPlaces().length > 0;
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

  /** Delay until the next pass. */
  nextDelayMs(): number {
    const key = this.isBusy() ? 'poll_interval_sec' : 'poll_idle_interval_sec';
    return this.settings.get(key) * 1000 + this.backoffMs;
  }

  /** Bring a pass sleeping on the idle cadence forward to the fast one (not during backoff). */
  private wake(): void {
    if (this.stopped || !this.timer || this.backoffMs > 0) return;
    const fastMs = this.settings.get('poll_interval_sec') * 1000;
    if (this.dueAt - Date.now() > fastMs) this.schedule(fastMs);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = Date.now() + ms;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      if (!this.stopped) this.schedule(this.nextDelayMs());
    }, ms);
  }

  private async pass(): Promise<void> {
    try {
      await this.tickets.retireDueImages();
      if (!this.credentials.usable()) return;

      const codes = await this.tickets.syncExclusive();
      if (codes) this.noteForeignCodes(codes.map((c) => ({ id: c.id, card: c.card_id })));
      await this.tickets.resolvePendingPlaces();
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
