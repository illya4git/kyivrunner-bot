import { EventEmitter } from 'node:events';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { maskSecret, open, seal } from '../core/crypto.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { credentials, type CredentialRow } from '../db/schema.js';
import { decodeJwtClaims, type KyivCredentials } from '../kyiv/envelope.js';
import type { KyivError } from '../kyiv/errors.js';
import type { Card } from '../kyiv/schemas.js';
import type { AuditService } from './audit.js';

const DAY = 86_400_000;
/** Warn admins when this many days (or fewer) are left. 0 = expired. */
export const EXPIRY_THRESHOLDS = [14, 7, 3, 1, 0] as const;
const EXPIRING_DAYS = 14;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAST_OK_WRITE_INTERVAL = 60_000;

export type CredentialState = 'missing' | 'ok' | 'expiring' | 'expired' | 'invalid';

export type CredentialHealth = {
  state: CredentialState;
  id?: number;
  maskedToken?: string;
  maskedDevice?: string;
  subject?: string | null;
  expiresAt?: number | null;
  addedAt?: number;
  addedBy?: number;
  lastOkAt?: number | null;
  lastErrorAt?: number | null;
  lastError?: string | null;
};

export type TokenCheck =
  | { ok: true; exp: number | null; sub: string | null }
  | { ok: false; reason: 'format' | 'expired' };

export type CredentialEvents = {
  /** Stored credentials stopped working (one emit per transition). */
  invalid: [{ reason: string }];
  /** Previously invalid credentials work again. */
  restored: [];
  /** Expiry is near (days left, per threshold) or passed (0). */
  expiring: [{ daysLeft: number; expiresAt: number }];
};

/**
 * Owns the Kyiv Digital credentials: encrypted storage (AES-256-GCM), health tracking
 * from live API results, and expiry warnings. Exactly one row is 'active' at a time;
 * older rows are kept as history with status 'replaced'.
 */
export class CredentialService extends EventEmitter<CredentialEvents> {
  private cached: { id: number; creds: KyivCredentials } | null | undefined;
  private lastOkWrite = 0;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly key: Buffer,
    private readonly log: Logger,
    /** Lists cards with one-off credentials (KyivClient.listCards). */
    private readonly fetchCards: (c: KyivCredentials) => Promise<Card[]>,
  ) {
    super();
  }

  // --- input checks ----------------------------------------------------------

  checkToken(token: string): TokenCheck {
    const t = token.trim();
    const claims = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t) ? decodeJwtClaims(t) : null;
    if (!claims) return { ok: false, reason: 'format' };
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    if (exp !== null && exp <= this.clock.now()) return { ok: false, reason: 'expired' };
    return { ok: true, exp, sub: claims.sub !== undefined ? String(claims.sub) : null };
  }

  checkDeviceUuid(uuid: string): boolean {
    return UUID_RE.test(uuid.trim());
  }

  /** Validate against the live API without storing anything. Throws KyivError. */
  async probe(c: KyivCredentials): Promise<Card[]> {
    return this.fetchCards({ accessToken: c.accessToken.trim(), deviceUuid: c.deviceUuid.trim().toLowerCase() });
  }

  // --- storage -----------------------------------------------------------------

  private activeRow(): CredentialRow | undefined {
    return this.db
      .select()
      .from(credentials)
      .where(inArray(credentials.status, ['ok', 'invalid']))
      .orderBy(desc(credentials.id))
      .get();
  }

  /** Store new credentials (already probed). Replaces the active ones. */
  save(c: KyivCredentials, by: number): CredentialRow {
    const token = c.accessToken.trim();
    const check = this.checkToken(token);
    const sealed = seal(this.key, token);
    const now = this.clock.now();
    const row = this.db.transaction((tx) => {
      tx.update(credentials).set({ status: 'replaced' }).where(inArray(credentials.status, ['ok', 'invalid'])).run();
      return tx
        .insert(credentials)
        .values({
          tokenEnc: sealed.enc,
          tokenIv: sealed.iv,
          tokenTag: sealed.tag,
          deviceUuid: c.deviceUuid.trim().toLowerCase(),
          tokenSub: check.ok ? check.sub : null,
          tokenExp: check.ok ? check.exp : null,
          status: 'ok',
          addedBy: by,
          addedAt: now,
          lastOkAt: now,
        })
        .returning()
        .get();
    });
    this.cached = undefined;
    this.audit.log({ kind: 'credentials_set', tgId: by, data: { id: row.id, sub: row.tokenSub, exp: row.tokenExp } });
    return row;
  }

  clear(by: number): boolean {
    const n = this.db.update(credentials).set({ status: 'replaced' }).where(inArray(credentials.status, ['ok', 'invalid'])).run().changes;
    this.cached = undefined;
    if (n) this.audit.log({ kind: 'credentials_cleared', tgId: by });
    return n > 0;
  }

  /** Decrypted active credentials regardless of health (for /credentials check). */
  private stored(): { id: number; creds: KyivCredentials } | null {
    if (this.cached !== undefined) return this.cached;
    const row = this.activeRow();
    if (!row) return (this.cached = null);
    try {
      const accessToken = open(this.key, { enc: row.tokenEnc, iv: row.tokenIv, tag: row.tokenTag });
      this.cached = { id: row.id, creds: { accessToken, deviceUuid: row.deviceUuid } };
    } catch (err) {
      this.log.error({ err: String(err), id: row.id }, 'cannot decrypt stored credentials (ENCRYPTION_KEY changed?)');
      this.setInvalid(row, 'cannot decrypt stored token — was ENCRYPTION_KEY changed?');
      this.cached = null;
    }
    return this.cached;
  }

  /** Credentials for regular API calls: only when healthy (ok/expiring). */
  usable(): KyivCredentials | null {
    const s = this.health().state;
    return s === 'ok' || s === 'expiring' ? (this.stored()?.creds ?? null) : null;
  }

  // --- health --------------------------------------------------------------------

  health(): CredentialHealth {
    const row = this.activeRow();
    if (!row) return { state: 'missing' };
    const now = this.clock.now();
    let state: CredentialState = 'ok';
    if (row.status === 'invalid') state = 'invalid';
    else if (row.tokenExp !== null && row.tokenExp <= now) state = 'expired';
    else if (row.tokenExp !== null && row.tokenExp - now < EXPIRING_DAYS * DAY) state = 'expiring';
    return {
      state,
      id: row.id,
      maskedToken: this.maskedToken(row),
      maskedDevice: `${row.deviceUuid.slice(0, 8)}…${row.deviceUuid.slice(-4)}`,
      subject: row.tokenSub,
      expiresAt: row.tokenExp,
      addedAt: row.addedAt,
      addedBy: row.addedBy,
      lastOkAt: row.lastOkAt,
      lastErrorAt: row.lastErrorAt,
      lastError: row.lastError,
    };
  }

  private maskedToken(row: CredentialRow): string {
    try {
      return maskSecret(open(this.key, { enc: row.tokenEnc, iv: row.tokenIv, tag: row.tokenTag }));
    } catch {
      return '???';
    }
  }

  /** Feed from KyivClient.onStoredCredentialsResult. */
  observe(result: { ok: true } | { ok: false; error: KyivError }): void {
    const row = this.activeRow();
    if (!row) return;
    if (result.ok) {
      if (row.status === 'invalid') {
        this.markOk(row);
      } else if (this.clock.now() - this.lastOkWrite > LAST_OK_WRITE_INTERVAL) {
        this.lastOkWrite = this.clock.now();
        this.db.update(credentials).set({ lastOkAt: this.clock.now() }).where(eq(credentials.id, row.id)).run();
      }
      return;
    }
    if (result.error.kind === 'unauthorized') {
      this.setInvalid(row, `${result.error.details.status ?? ''} ${result.error.details.serverMessage ?? result.error.message}`.trim());
    }
  }

  /** Re-test the stored credentials (even if marked invalid). Throws KyivError on failure. */
  async recheck(by: number): Promise<Card[]> {
    const s = this.stored();
    const row = this.activeRow();
    if (!s || !row) throw new Error('no stored credentials');
    try {
      const cards = await this.probe(s.creds);
      this.markOk(row);
      return cards;
    } catch (err) {
      if ((err as KyivError).kind === 'unauthorized') this.setInvalid(row, (err as KyivError).message);
      this.audit.log({ kind: 'api_error', tgId: by, data: { op: 'credentials_check', kind: (err as KyivError).kind } });
      throw err;
    }
  }

  private markOk(row: CredentialRow): void {
    const wasInvalid = row.status === 'invalid';
    this.db.update(credentials).set({ status: 'ok', lastOkAt: this.clock.now() }).where(eq(credentials.id, row.id)).run();
    this.cached = undefined;
    if (wasInvalid) this.emit('restored');
  }

  private setInvalid(row: CredentialRow, reason: string): void {
    const now = this.clock.now();
    const transition = row.status !== 'invalid';
    this.db
      .update(credentials)
      .set({ status: 'invalid', lastErrorAt: now, lastError: reason.slice(0, 300) })
      .where(eq(credentials.id, row.id))
      .run();
    if (transition) {
      this.audit.log({ kind: 'credentials_invalid', data: { id: row.id, reason } });
      this.emit('invalid', { reason });
    }
  }

  /**
   * Emit 'expiring' once per threshold crossed (14, 7, 3, 1 days; 0 = expired).
   * Called by a daily job and at startup. Returns the threshold warned about, if any.
   */
  checkExpiry(): number | null {
    const row = this.activeRow();
    if (!row || row.tokenExp === null) return null;
    const daysLeft = Math.max(0, Math.ceil((row.tokenExp - this.clock.now()) / DAY));
    const threshold = [...EXPIRY_THRESHOLDS].reverse().find((t) => daysLeft <= t);
    if (threshold === undefined) return null;
    const already = this.audit
      .recent({ kind: 'credentials_expiring', limit: 50 })
      .some((e) => e.data?.id === row.id && e.data?.threshold === threshold);
    if (already) return null;
    this.audit.log({ kind: 'credentials_expiring', data: { id: row.id, threshold, daysLeft } });
    this.emit('expiring', { daysLeft, expiresAt: row.tokenExp });
    return threshold;
  }
}
