import { kyivDate, kyivDay } from '../core/clock.js';
import type { BotDeps } from './deps.js';

/** Turn service events into admin notifications. */
export function wireAlerts(deps: BotDeps): void {
  const { credentials, tickets, tracker, audit, clock, notifier, log } = deps;
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

  // The tracker itself fires these once per outage.
  tracker.on('degraded', ({ kind }) => send((t) => ({ text: t.alerts.apiDegraded(kind) })));
  tracker.on('recovered', () => send((t) => ({ text: t.alerts.apiRecovered })));
}
