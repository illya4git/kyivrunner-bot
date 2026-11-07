import { loadConfig } from './core/config.js';
import { OffsetClock } from './core/clock.js';
import { createLogger } from './core/logger.js';
import { openDb } from './db/client.js';
import { AccessService } from './services/access.js';
import { AuditService } from './services/audit.js';
import { SettingsService } from './services/settings.js';
import { createBot } from './bot/bot.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const clock = new OffsetClock();

  const db = openDb(config.dbPath);
  const settings = new SettingsService(db, clock);
  const audit = new AuditService(db, clock);
  const access = new AccessService(db, clock, audit, settings, config.adminIds);
  access.ensureBootstrapAdmins();

  const { bot, deps } = createBot({
    token: config.botToken,
    devMode: config.devMode,
    services: { clock, log, access, audit, settings },
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    await bot.stop().catch((err) => log.error({ err }, 'bot.stop failed'));
    db.$client.close();
    log.info('bye');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.init();
  log.info({ bot: bot.botInfo.username, devMode: config.devMode, kyiv: config.kyivBaseUrl }, 'starting');
  void deps.menus
    .syncAll(access.byRoles(['user', 'admin']))
    .catch((err) => log.warn({ err }, 'command menu sync failed'));

  await bot.start({
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    onStart: () => log.info('polling'),
  });
}

main().catch((err) => {
  // Config errors are already human-readable.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
