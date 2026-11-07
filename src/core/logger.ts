import { pino, type Logger } from 'pino';

export type { Logger };

/** Paths that may carry credentials. pino replaces them with "[redacted]". */
const REDACT = [
  'token',
  'accessToken',
  'access_token',
  'authorization',
  'headers.authorization',
  'headers.Authorization',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.authorization',
  '*.Authorization',
];

/** Pretty output only for interactive development; pino-pretty isn't in the production image. */
export function createLogger(level: string, pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production'): Logger {
  return pino({
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = pino({ level: 'silent' });
