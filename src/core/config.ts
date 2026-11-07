import { z } from 'zod';

const PROD_KYIV_URL = 'https://kyiv.digital';

const EnvSchema = z
  .object({
    BOT_TOKEN: z.string().min(20, 'BOT_TOKEN is required'),
    ADMIN_IDS: z
      .string()
      .min(1, 'ADMIN_IDS is required (comma-separated Telegram user ids)')
      .transform((s, ctx) => {
        const ids = s.split(',').map((p) => p.trim()).filter(Boolean).map(Number);
        if (ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
          ctx.addIssue({ code: 'custom', message: 'ADMIN_IDS must be positive integers' });
          return z.NEVER;
        }
        return ids;
      }),
    ENCRYPTION_KEY: z
      .string()
      .transform((s, ctx) => {
        const key = Buffer.from(s, 'base64');
        if (key.length !== 32) {
          ctx.addIssue({ code: 'custom', message: 'ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)' });
          return z.NEVER;
        }
        return key;
      }),
    DB_PATH: z.string().default('./data/bot.sqlite'),
    KYIV_BASE_URL: z.url().default(PROD_KYIV_URL).transform((u) => u.replace(/\/+$/, '')),
    DEV_MODE: z.stringbool().default(false),
    /** Use Telegram's separate test environment (needs a bot registered there). */
    TELEGRAM_TEST_ENV: z.stringbool().default(false),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .refine((c) => c.DEV_MODE || c.KYIV_BASE_URL === PROD_KYIV_URL, {
    message: `KYIV_BASE_URL other than ${PROD_KYIV_URL} requires DEV_MODE=true`,
    path: ['KYIV_BASE_URL'],
  });

export type Config = {
  botToken: string;
  adminIds: readonly number[];
  encryptionKey: Buffer;
  dbPath: string;
  kyivBaseUrl: string;
  devMode: boolean;
  telegramTestEnv: boolean;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    botToken: e.BOT_TOKEN,
    adminIds: e.ADMIN_IDS,
    encryptionKey: e.ENCRYPTION_KEY,
    dbPath: e.DB_PATH,
    kyivBaseUrl: e.KYIV_BASE_URL,
    devMode: e.DEV_MODE,
    telegramTestEnv: e.TELEGRAM_TEST_ENV,
    logLevel: e.LOG_LEVEL,
  };
}
