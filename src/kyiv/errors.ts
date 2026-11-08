export type KyivErrorKind =
  /** No credentials configured. */
  | 'no_credentials'
  /** 401, or 423 (challenge) — the token is no longer accepted. */
  | 'unauthorized'
  /** 429 from the server. */
  | 'rate_limited'
  /** 5xx, network failure or timeout. */
  | 'unavailable'
  /** 200 with a body that doesn't match the documented shape. */
  | 'shape'
  /** Any other non-2xx (e.g. 4xx refusing an action). */
  | 'rejected'
  /** Nightly maintenance: announced by the server, or a request skipped while it lasts. */
  | 'maintenance';

export class KyivError extends Error {
  override readonly name = 'KyivError';

  constructor(
    readonly kind: KyivErrorKind,
    message: string,
    readonly details: {
      status?: number;
      method?: string;
      path?: string;
      /** For rate_limited: suggested wait. */
      retryAfterMs?: number;
      /** POST whose outcome is unknown (timeout/5xx): the server may have acted on it. */
      ambiguous?: boolean;
      /** For maintenance: when it ends (service clock, ms). */
      until?: number;
      /** For maintenance: true when no request was sent because maintenance was already known. */
      skipped?: boolean;
      /** Server message, if any (never contains our token). */
      serverMessage?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
  }
}

export function isKyivError(err: unknown, kind?: KyivErrorKind): err is KyivError {
  return err instanceof KyivError && (kind === undefined || err.kind === kind);
}
