import type { z } from 'zod';
import type { Logger } from '../core/logger.js';
import { envelopeHeaders, type KyivCredentials } from './envelope.js';
import { KyivError } from './errors.js';
import { RateLimiter, realSleep, type Sleep } from './rate-limit.js';
import {
  CardSchema,
  CardsResponseSchema,
  CodesResponseSchema,
  FeedResponseSchema,
  type Card,
  type Code,
  type FeedEvent,
} from './schemas.js';

export type KyivClientOptions = {
  baseUrl: string;
  /** Value of the app's static X-Client-Auth header (KYIV_CLIENT_AUTH). */
  clientAuth: string;
  /** Current credentials, or null when none are configured. Read on every request. */
  credentials: () => KyivCredentials | null;
  /** Self-imposed requests per minute (shared with the owner's phone app on the server side). */
  ratePerMin: () => number;
  log: Logger;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
  timeoutMs?: number;
  /** Retries for idempotent GETs on 5xx / network errors. */
  getRetries?: number;
  /**
   * Called after each request made with the stored credentials (not one-off ones):
   * lets the credential service track health (401 → invalid, success → last OK).
   */
  onStoredCredentialsResult?: (result: { ok: true } | { ok: false; error: KyivError }) => void;
};

export type RateLimitInfo = { limit: number | null; remaining: number | null; at: number };

type RequestOpts<S extends z.ZodType> = {
  method: 'GET' | 'POST';
  path: string;
  schema: S;
  /** Override for this call only: one-off credential validation before saving. */
  credentials?: KyivCredentials;
};

const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Typed client for the travel-card surface of the Kyiv Digital API.
 * One instance per process: it owns the rate-limit budget.
 *
 * Retry policy:
 *  - GET: retried on 5xx/network/timeout (with jitter) and once on 429 (honouring Retry-After).
 *  - POST (generate): never retried — a lost response may still have reserved a trip.
 *    Such failures carry `ambiguous: true` so the caller can reconcile via listCodes().
 */
export class KyivClient {
  private readonly limiter: RateLimiter;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  /** Last X-RateLimit-* headers seen. */
  rateLimit: RateLimitInfo = { limit: null, remaining: null, at: 0 };

  constructor(private readonly opts: KyivClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.limiter = new RateLimiter(opts.ratePerMin, this.now, this.sleep);
  }

  // --- endpoints ---------------------------------------------------------------

  async listCards(credentials?: KyivCredentials): Promise<{ qrsTotal: number | null; cards: Card[] }> {
    const r = await this.request({ method: 'GET', path: '/api/v4/card/travel', schema: CardsResponseSchema, ...(credentials ? { credentials } : {}) });
    return { qrsTotal: r.qrs_total ?? null, cards: r.cards };
  }

  getCard(cardId: number): Promise<Card> {
    return this.request({ method: 'GET', path: `/api/v4/card/travel/${cardId}`, schema: CardSchema });
  }

  /** All generated codes across cards, newest first. */
  async listCodes(): Promise<Code[]> {
    return (await this.request({ method: 'GET', path: '/api/v4/qr', schema: CodesResponseSchema })).codes;
  }

  /** Generate a code. Returns the new code (`codes[0]`) and the full list as returned. */
  async generateCode(cardId: number): Promise<{ code: Code; codes: Code[] }> {
    const r = await this.request({ method: 'POST', path: `/api/v4/card/travel/${cardId}/qr-ticket`, schema: CodesResponseSchema });
    const code = r.codes[0];
    if (!code) throw new KyivError('shape', 'generate returned no codes', { method: 'POST', path: `/api/v4/card/travel/${cardId}/qr-ticket` });
    return { code, codes: r.codes };
  }

  /** Card feed page (newest first). */
  async feed(cardId: number, page = 1, perPage = 30): Promise<FeedEvent[]> {
    const r = await this.request({
      method: 'GET',
      path: `/api/v4/card/travel/${cardId}/feed?page=${page}&per_page=${perPage}`,
      schema: FeedResponseSchema,
    });
    return r.feed.data;
  }

  // --- transport ---------------------------------------------------------------

  private async request<S extends z.ZodType>(req: RequestOpts<S>): Promise<z.output<S>> {
    const report = req.credentials ? undefined : this.opts.onStoredCredentialsResult;
    try {
      const result = await this.requestWithRetries(req);
      report?.({ ok: true });
      return result;
    } catch (err) {
      if (err instanceof KyivError && err.kind !== 'no_credentials') report?.({ ok: false, error: err });
      throw err;
    }
  }

  private async requestWithRetries<S extends z.ZodType>(req: RequestOpts<S>): Promise<z.output<S>> {
    const isGet = req.method === 'GET';
    const maxAttempts = isGet ? 1 + (this.opts.getRetries ?? 2) : 1;
    let rateLimitedOnce = false;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        if (!(err instanceof KyivError)) throw err;
        if (err.kind === 'rate_limited' && isGet && !rateLimitedOnce) {
          rateLimitedOnce = true;
          await this.sleep(Math.min(err.details.retryAfterMs ?? 5_000, MAX_RETRY_AFTER_MS));
          attempt--; // a 429 wait doesn't consume a 5xx retry
          continue;
        }
        if (err.kind === 'unavailable' && attempt < maxAttempts) {
          await this.sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
          continue;
        }
        throw err;
      }
    }
  }

  private async once<S extends z.ZodType>(req: RequestOpts<S>): Promise<z.output<S>> {
    const creds = req.credentials ?? this.opts.credentials();
    const where = { method: req.method, path: req.path };
    if (!creds) throw new KyivError('no_credentials', 'Kyiv Digital credentials are not configured', where);

    await this.limiter.acquire();
    const started = this.now();
    let res: Response;
    try {
      res = await this.fetchFn(this.opts.baseUrl + req.path, {
        method: req.method,
        headers: envelopeHeaders(creds, this.opts.clientAuth),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (cause) {
      this.opts.log.warn({ ...where, ms: this.now() - started, err: String(cause) }, 'kyiv request failed');
      throw new KyivError('unavailable', `network error on ${req.method} ${req.path}`, { ...where, cause, ambiguous: req.method === 'POST' });
    }

    this.captureRateLimit(res.headers);
    const text = await res.text();
    this.opts.log.debug({ ...where, status: res.status, ms: this.now() - started }, 'kyiv request');
    const body = safeJson(text);

    if (res.ok) {
      const parsed = req.schema.safeParse(body);
      if (!parsed.success) {
        this.opts.log.error({ ...where, issues: parsed.error.issues.slice(0, 5) }, 'kyiv response shape mismatch');
        throw new KyivError('shape', `unexpected response shape from ${req.path}`, { ...where, status: res.status });
      }
      return parsed.data;
    }

    const details = { ...where, status: res.status, serverMessage: serverMessage(body) };
    switch (true) {
      case res.status === 401 || res.status === 423:
        throw new KyivError('unauthorized', `token rejected (${res.status})`, details);
      case res.status === 429:
        throw new KyivError('rate_limited', 'rate limited by Kyiv Digital', { ...details, retryAfterMs: retryAfterMs(res.headers) });
      case res.status >= 500:
        throw new KyivError('unavailable', `server error ${res.status}`, { ...details, ambiguous: req.method === 'POST' });
      default:
        throw new KyivError('rejected', `request rejected (${res.status})`, details);
    }
  }

  private captureRateLimit(h: Headers): void {
    const limit = h.get('x-ratelimit-limit');
    const remaining = h.get('x-ratelimit-remaining');
    if (limit === null && remaining === null) return;
    this.rateLimit = { limit: limit ? Number(limit) : null, remaining: remaining ? Number(remaining) : null, at: this.now() };
  }
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
}

function serverMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') return body.message.slice(0, 200);
  return undefined;
}

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get('retry-after');
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return sec * 1000;
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
