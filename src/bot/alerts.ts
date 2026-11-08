import { kyivDate, kyivDay, kyivTime } from '../core/clock.js';
import type { BotDeps } from './deps.js';

/** Turn service events into admin notifications. */
export function wireAlerts(deps: BotDeps): void {
  const { credentials, tickets, tracker, maintenance, audit, clock, notifier, log } = deps;
  const send = (build: Parameters<typeof notifier.toAdmins>[0]) => {
    notifier.toAdmins(build).catch((err: unknown) => log.error({ err }, 'admin alert failed'));
  };

  credentials.on('invalid', ({ reason }) => send((t) => ({ text: t.alerts.credentialsInvalid(reason) })));
  credentials.on('restored', () => send((t) => ({ text: t.alerts.credentialsRestored })));
  credentials.on('expiring', ({ daysLeft, expiresAt }) =>
    send((t) => ({ text: daysLeft === 0 ? t.alerts.credentialsExpired : t.alerts.credentialsExpiring(daysLeft, kyivDate(expiresAt)) })),
  );

  // Once per Kyiv day each, even across restarts.
  const today = () => kyivDay(clock.now());
  tickets.on('lowBalance', ({ trips }) => {
    if (audit.claimAlert('low_balance', today())) send((t) => ({ text: t.alerts.lowBalance(trips) }));
  });
  tickets.on('generationBlocked', () => {
    if (audit.claimAlert('generation_blocked', today())) send((t) => ({ text: t.alerts.generationBlocked }));
  });

  // The nightly window is routine; only maintenance at an unusual hour is worth a message.
  maintenance.on('started', ({ at, until }) => {
    if (isUsualMaintenanceTime(at) || !audit.claimAlert('maintenance_unusual', today())) return;
    send((t) => ({ text: t.alerts.maintenanceUnusual(kyivTime(at), kyivTime(until)) }));
  });

  // The tracker itself fires these once per outage.
  tracker.on('degraded', ({ kind }) => send((t) => ({ text: t.alerts.apiDegraded(kind) })));
  tracker.on('recovered', () => send((t) => ({ text: t.alerts.apiRecovered })));
}

/** Kyiv Digital's maintenance normally starts between 00:00 and 01:00 and ends at 03:00 Kyiv time. */
export function isUsualMaintenanceTime(ms: number): boolean {
  const [h, m] = kyivTime(ms).split(':').map(Number) as [number, number];
  const minutes = h * 60 + m;
  return minutes >= 23 * 60 + 30 || minutes < 4 * 60;
}
