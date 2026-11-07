import { kyivDate } from '../core/clock.js';
import type { BotDeps } from './deps.js';

/** Turn service events into admin notifications. */
export function wireAlerts(deps: BotDeps): void {
  const { credentials, notifier, log } = deps;
  const send = (build: Parameters<typeof notifier.toAdmins>[0]) => {
    notifier.toAdmins(build).catch((err: unknown) => log.error({ err }, 'admin alert failed'));
  };

  credentials.on('invalid', ({ reason }) => send((t) => ({ text: t.alerts.credentialsInvalid(reason) })));
  credentials.on('restored', () => send((t) => ({ text: t.alerts.credentialsRestored })));
  credentials.on('expiring', ({ daysLeft, expiresAt }) =>
    send((t) => ({ text: daysLeft === 0 ? t.alerts.credentialsExpired : t.alerts.credentialsExpiring(daysLeft, kyivDate(expiresAt)) })),
  );
}
