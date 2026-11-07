import type { Clock } from '../../src/core/clock.js';
import { silentLogger } from '../../src/core/logger.js';
import { openDb } from '../../src/db/client.js';
import { AccessService } from '../../src/services/access.js';
import { AuditService } from '../../src/services/audit.js';
import { SettingsService } from '../../src/services/settings.js';

/** A controllable clock for tests. Starts at 2026-11-07 10:00 Kyiv (08:00 UTC). */
export class FakeClock implements Clock {
  constructor(public ms = Date.UTC(2026, 10, 7, 8, 0, 0)) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const ADMIN_ID = 1000;

export function makeServices(opts: { adminIds?: number[] } = {}) {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  const settings = new SettingsService(db, clock);
  const audit = new AuditService(db, clock);
  const access = new AccessService(db, clock, audit, settings, opts.adminIds ?? [ADMIN_ID]);
  access.ensureBootstrapAdmins();
  return { clock, db, settings, audit, access, log: silentLogger };
}
