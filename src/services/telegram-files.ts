import { eq } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import type { Db } from '../db/client.js';
import { telegramFiles } from '../db/schema.js';

/**
 * Telegram file ids of media the bot uploads once and then reuses, saving the upload on
 * every later send. Ids are only valid for the bot that uploaded them; a rejected id is
 * forgotten and the file uploaded again (see TicketView).
 */
export class TelegramFileStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get(key: string): string | undefined {
    return this.db.select({ id: telegramFiles.fileId }).from(telegramFiles).where(eq(telegramFiles.key, key)).get()?.id;
  }

  set(key: string, fileId: string): void {
    const updatedAt = this.clock.now();
    this.db.insert(telegramFiles).values({ key, fileId, updatedAt }).onConflictDoUpdate({ target: telegramFiles.key, set: { fileId, updatedAt } }).run();
  }

  forget(key: string): void {
    this.db.delete(telegramFiles).where(eq(telegramFiles.key, key)).run();
  }
}
