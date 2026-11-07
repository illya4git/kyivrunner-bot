import type { Clock } from '../../src/core/clock.js';
import { silentLogger } from '../../src/core/logger.js';
import { openDb } from '../../src/db/client.js';
import { buildServices } from '../../src/services/index.js';

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
export const TEST_KEY = Buffer.alloc(32, 7);

/**
 * The real service graph over an in-memory DB. `kyivUrl` defaults to an address nothing
 * listens on, so tests that don't start the mock fail fast if they touch the API.
 */
export function makeServices(opts: { adminIds?: number[]; kyivUrl?: string; clock?: FakeClock } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const db = openDb(':memory:');
  const services = buildServices({
    db,
    clock,
    log: silentLogger,
    adminIds: opts.adminIds ?? [ADMIN_ID],
    encryptionKey: TEST_KEY,
    kyivBaseUrl: opts.kyivUrl ?? 'http://127.0.0.1:9',
    kyivClient: { sleep: async () => undefined, getRetries: 0 },
  });
  return { ...services, clock, db };
}
