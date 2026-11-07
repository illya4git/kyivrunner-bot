import type { Context } from 'grammy';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { UserRow } from '../db/schema.js';
import type { Messages } from '../i18n/index.js';
import type { AccessService } from '../services/access.js';
import type { AuditService } from '../services/audit.js';
import type { SettingsService } from '../services/settings.js';
import type { CredentialService } from '../services/credentials.js';
import type { KyivClient } from '../kyiv/client.js';
import type { TicketService } from '../services/tickets.js';
import type { TicketTracker } from '../services/tracker.js';

export type Services = {
  clock: Clock;
  log: Logger;
  access: AccessService;
  audit: AuditService;
  settings: SettingsService;
  credentials: CredentialService;
  kyiv: KyivClient;
  tickets: TicketService;
  tracker: TicketTracker;
};

/** Per-update context. `user` and `t` are set by the loadUser middleware before any handler runs. */
export type BotContext = Context & {
  user: UserRow;
  t: Messages;
};
