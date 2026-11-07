import { Cron } from 'croner';
import { KYIV_TZ } from './core/clock.js';
import type { BotDeps } from './bot/deps.js';

/** Scheduled background work. Returns a handle to stop everything on shutdown. */
export function startJobs(deps: BotDeps): { stop: () => void } {
  const { credentials, tracker, audit, settings, log } = deps;
  const safe = (name: string, fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      log.error({ err, job: name }, 'job failed');
    }
  };

  const expiryCheck = safe('credentials-expiry', () => credentials.checkExpiry());
  const prune = safe('prune-events', () => {
    const n = audit.prune(settings.get('log_retention_days'));
    if (n) log.info({ deleted: n }, 'pruned old audit events');
  });
  const jobs = [
    new Cron('0 10 * * *', { timezone: KYIV_TZ, name: 'credentials-expiry' }, expiryCheck),
    new Cron('30 3 * * *', { timezone: KYIV_TZ, name: 'prune-events' }, prune),
  ];
  expiryCheck(); // also on startup, so a long downtime doesn't skip a warning

  // First pass right away: reconciles tickets that changed while the bot was down.
  tracker.start();

  return {
    stop: () => {
      tracker.stop();
      jobs.forEach((j) => j.stop());
    },
  };
}
