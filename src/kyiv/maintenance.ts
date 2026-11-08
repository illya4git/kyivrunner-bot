import { EventEmitter } from 'node:events';
import { kyivAt, type Clock } from '../core/clock.js';

/** Kyiv Digital's refusal during its nightly maintenance (observed on generate, 422). */
const MAINTENANCE_RE = /технічні\s+роботи/i;
/** "… наново після 3:00." — the end time, Kyiv wall clock. */
const UNTIL_RE = /після\s+(\d{1,2})[:.](\d{2})/;
/** Used when the message names no time. */
const DEFAULT_END_HOUR = 3;

export function isMaintenanceMessage(message: string | undefined): boolean {
  return message !== undefined && MAINTENANCE_RE.test(message);
}

/** The end of the maintenance window announced in `message`, as the next such Kyiv time after `now`. */
export function maintenanceEnd(message: string | undefined, now: number): number {
  const m = message?.match(UNTIL_RE);
  const hour = m ? Number(m[1]) : DEFAULT_END_HOUR;
  const minute = m ? Number(m[2]) : 0;
  let end = kyivAt(now, hour, minute);
  if (end <= now) end = kyivAt(now + 24 * 3_600_000, hour, minute);
  return end;
}

export type MaintenanceEvents = {
  /** Maintenance was detected; requests are paused until `until` (service clock, ms). */
  started: [{ at: number; until: number; message: string | undefined }];
};

/**
 * Whether Kyiv Digital is in maintenance. Set when a response says so; while active, the
 * client makes no requests at all (see KyivClient), and it clears itself at `until`.
 */
export class MaintenanceState extends EventEmitter<MaintenanceEvents> {
  private untilMs: number | null = null;

  constructor(private readonly clock: Clock) {
    super();
  }

  /** End of the current maintenance, or null when there is none. */
  get until(): number | null {
    if (this.untilMs !== null && this.untilMs <= this.clock.now()) this.untilMs = null;
    return this.untilMs;
  }

  active(): boolean {
    return this.until !== null;
  }

  /** Record a maintenance response. Returns the end time. */
  enter(message: string | undefined): number {
    const now = this.clock.now();
    const until = maintenanceEnd(message, now);
    const fresh = !this.active();
    this.untilMs = Math.max(this.untilMs ?? 0, until);
    if (fresh) this.emit('started', { at: now, until: this.untilMs, message });
    return this.untilMs;
  }
}
