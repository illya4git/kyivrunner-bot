import type { Logger } from '../core/logger.js';
import { isKyivError } from '../kyiv/errors.js';
import type { AuditService } from './audit.js';
import type { CredentialService } from './credentials.js';
import type { SettingsService } from './settings.js';
import type { TicketService } from './tickets.js';

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Background loop that keeps tickets in sync without user action. Each pass:
 *  1. retires the QR image of used tickets past midnight (DB only, no API);
 *  2. if any ticket is active: one GET /qr → used/expired transitions (edit + reply);
 *     codes the bot didn't issue (the owner's phone app) are logged once as `foreign_code`;
 *  3. retries the place lookup for used tickets still missing one.
 * Idle passes cost nothing: no API call is made unless something is active or pending.
 * The first pass runs at start, which reconciles anything that changed while the bot was down.
 */
export class TicketTracker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running: Promise<void> | null = null;
  private backoffMs = 0;
  private readonly seenForeign = new Set<number>();

  constructor(
    private readonly tickets: TicketService,
    private readonly credentials: CredentialService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly log: Logger,
  ) {}

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
    });
    return this.running;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(async () => {
      await this.tick();
      if (!this.stopped) this.schedule(this.settings.get('poll_interval_sec') * 1000 + this.backoffMs);
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
    } catch (err) {
      if (!isKyivError(err)) {
        this.log.error({ err }, 'tracker pass failed');
        return;
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
