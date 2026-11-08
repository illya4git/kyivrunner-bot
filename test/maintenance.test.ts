import { afterEach, describe, expect, it } from 'vitest';
import { kyivAt, kyivDateTime } from '../src/core/clock.js';
import { maintenanceEnd } from '../src/kyiv/maintenance.js';
import { isUsualMaintenanceTime } from '../src/bot/alerts.js';
import { MAINTENANCE_MESSAGE } from '../mock/state.js';
import { ADMIN_ID, FakeClock } from './helpers/services.js';
import { closeTicketEnvs, ticketEnv } from './helpers/ticket-env.js';

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
afterEach(closeTicketEnvs);

/** 2026-11-09 01:11 Kyiv (UTC+2), inside the nightly window. */
const NIGHT = Date.UTC(2026, 10, 8, 23, 11);
/** 03:00 Kyiv the same night. */
const NIGHT_END = Date.UTC(2026, 10, 9, 1, 0);

async function env(at = NIGHT) {
  const s = await ticketEnv({ clock: new FakeClock(at) });
  s.access.touch({ id: ADMIN_ID, first_name: 'Admin', language_code: 'en' });
  return s;
}

describe('maintenance window parsing', () => {
  it('reads the end time from the message, as the next such Kyiv time', () => {
    expect(maintenanceEnd(MAINTENANCE_MESSAGE, NIGHT)).toBe(NIGHT_END);
    expect(maintenanceEnd('Технічні роботи до ранку', NIGHT)).toBe(NIGHT_END); // no time: 03:00
    const evening = Date.UTC(2026, 10, 8, 21, 50); // 23:50 Kyiv
    expect(maintenanceEnd(MAINTENANCE_MESSAGE, evening)).toBe(NIGHT_END);
    expect(maintenanceEnd('… наново після 4.30', NIGHT)).toBe(NIGHT_END + 90 * MIN);
  });

  it('places Kyiv wall-clock times correctly in winter and summer', () => {
    expect(kyivAt(Date.UTC(2026, 10, 9, 12), 3)).toBe(Date.UTC(2026, 10, 9, 1)); // UTC+2
    expect(kyivAt(Date.UTC(2026, 6, 9, 12), 3)).toBe(Date.UTC(2026, 6, 9, 0)); // UTC+3
    expect(kyivDateTime(kyivAt(Date.UTC(2027, 2, 28, 12), 3, 30))).toContain('04:30'); // skipped by DST
  });

  it('treats 23:30–04:00 as the usual time', () => {
    expect(isUsualMaintenanceTime(NIGHT)).toBe(true);
    expect(isUsualMaintenanceTime(Date.UTC(2026, 10, 8, 21, 40))).toBe(true); // 23:40
    expect(isUsualMaintenanceTime(Date.UTC(2026, 10, 9, 8))).toBe(false); // 10:00
  });
});

describe('nightly maintenance', () => {
  it('denies /qr with a clear message, then makes no API requests until it ends', async () => {
    const s = await env();
    const u = s.user(5, 'en');
    await s.text(u, '/qr');
    let batch = s.take();
    const reply = s.textsTo(5, batch).at(-1)!;
    expect(reply).toContain('🌙');
    expect(reply).toContain('after 03:00');
    expect(batch.filter((c) => c.method === 'sendPhoto')).toHaveLength(0);
    expect(s.tickets.quota(s.row(5)).used).toBe(0); // not charged
    expect(s.audit.recent({ kind: 'cap_denied' })[0]?.data).toMatchObject({ reason: 'maintenance', until: NIGHT_END });
    expect(s.audit.recent({ kind: 'maintenance' })).toHaveLength(1);
    expect(s.mock.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(s.textsTo(ADMIN_ID, batch)).toHaveLength(0); // routine at night: no alert

    const sent = s.mock.requests.length;
    await s.text(u, '/qr');
    await s.text(u, '/status');
    await s.tracker.tick();
    batch = s.take();
    expect(s.mock.requests).toHaveLength(sent); // nothing sent at all
    expect(s.textsTo(5, batch).some((t) => t.includes('🌙'))).toBe(true);
    expect(s.audit.recent({ kind: 'maintenance' })).toHaveLength(1);
    expect(s.audit.recent({ kind: 'api_error' })).toHaveLength(0);

    s.clock.ms = NIGHT_END;
    await s.text(u, '/qr');
    expect(s.photosTo(5, s.take())).toHaveLength(1); // issued after 03:00
  });

  it('keeps the tracker passing (liveness) without API calls, resuming shortly after the end', async () => {
    const s = await env();
    s.maintenance.enter(MAINTENANCE_MESSAGE);
    await s.tracker.tick();
    expect(s.mock.requests).toHaveLength(0);
    expect(s.tracker.lastPassAt).not.toBeNull();
    expect(s.tracker.nextDelayMs()).toBe(300 * SEC); // idle cadence while far from the end
    s.clock.ms = NIGHT_END - 2 * MIN;
    expect(s.tracker.nextDelayMs()).toBe(2 * MIN + 30 * SEC); // the end plus jitter (random 0.5 → 30 s)
    s.clock.ms = NIGHT_END;
    expect(s.maintenance.active()).toBe(false);
  });

  it('pauses on maintenance announced at an unusual hour, and alerts admins once that day', async () => {
    const s = await env(Date.UTC(2026, 10, 9, 8)); // 10:00 Kyiv
    const a = s.user(5, 'en');
    await s.text(a, '/qr');
    const ticket = s.tickets.activeFor(5)!;
    s.take();

    s.mock.addFault({ kind: 'maintenance', remaining: 1, method: 'POST' });
    await s.text(s.user(6, 'en'), '/qr');
    const batch = s.take();
    expect(s.textsTo(6, batch).at(-1)).toContain('after 03:00');
    expect(s.textsTo(ADMIN_ID, batch).join()).toContain('unusual time (10:00)');
    expect(s.maintenance.until).toBe(kyivAt(s.clock.now() + 24 * HOUR, 3));

    const sent = s.mock.requests.length;
    s.state.validate(ticket.kdTicketId);
    await s.tracker.tick();
    expect(s.mock.requests).toHaveLength(sent); // tracking paused too
    expect(s.tickets.get(ticket.id)?.status).toBe('active');

    s.maintenance.enter(MAINTENANCE_MESSAGE); // a second report the same day: no second alert
    expect(s.textsTo(ADMIN_ID, s.take())).toHaveLength(0);
  });

  it('the mock refuses generate from 00:00 to 03:00 with the real body', async () => {
    const s = await env();
    s.state.patchCard(s.settings.get('active_card_id')!, {});
    expect(() => s.state.generate(s.settings.get('active_card_id')!)).toThrow(MAINTENANCE_MESSAGE);
    s.clock.ms = NIGHT_END;
    expect(s.state.generate(s.settings.get('active_card_id')!).id).toBeGreaterThan(0);
    s.state.nightlyMaintenance = false;
    s.clock.ms = NIGHT;
    expect(s.state.generate(s.settings.get('active_card_id')!).id).toBeGreaterThan(0);
  });
});
