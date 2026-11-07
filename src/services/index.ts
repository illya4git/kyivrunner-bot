import type { Services } from '../bot/context.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { KyivClient, type KyivClientOptions } from '../kyiv/client.js';
import { AccessService } from './access.js';
import { AuditService } from './audit.js';
import { CredentialService } from './credentials.js';
import { SettingsService } from './settings.js';

export type ServiceConfig = {
  db: Db;
  clock: Clock;
  log: Logger;
  adminIds: readonly number[];
  encryptionKey: Buffer;
  kyivBaseUrl: string;
  /** Test hooks for the HTTP client (sleep, timeouts). */
  kyivClient?: Partial<KyivClientOptions>;
};

/** Wire all services together. Used by main.ts and by tests, so both run the same graph. */
export function buildServices(c: ServiceConfig): Services {
  const settings = new SettingsService(c.db, c.clock);
  const audit = new AuditService(c.db, c.clock);
  const access = new AccessService(c.db, c.clock, audit, settings, c.adminIds);

  // The client and the credential service reference each other: the client asks for the
  // current credentials, the service validates new ones through the client.
  let credentials: CredentialService | undefined;
  const kyiv = new KyivClient({
    baseUrl: c.kyivBaseUrl,
    credentials: () => credentials?.usable() ?? null,
    ratePerMin: () => settings.get('api_rate_per_min'),
    log: c.log.child({ mod: 'kyiv' }),
    onStoredCredentialsResult: (r) => credentials?.observe(r),
    ...c.kyivClient,
  });
  credentials = new CredentialService(c.db, c.clock, audit, c.encryptionKey, c.log, async (creds) => (await kyiv.listCards(creds)).cards);

  access.ensureBootstrapAdmins();
  return { clock: c.clock, log: c.log, settings, audit, access, credentials, kyiv };
}
