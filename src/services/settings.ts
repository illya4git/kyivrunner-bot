import { z } from 'zod';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { Clock } from '../core/clock.js';

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = z.stringbool();

/**
 * Registry of admin-tunable settings. `schema` parses the stored/entered string;
 * the default is used until an admin changes the value.
 */
export const SETTINGS = {
  default_daily_quota: { schema: int(0, 100), default: 2 },
  global_daily_cap: { schema: int(0, 1000), default: 6 },
  reserve_trips: { schema: int(0, 1000), default: 4 },
  low_balance_alert: { schema: int(0, 1000), default: 8 },
  active_card_id: { schema: z.coerce.number().int().positive().nullable(), default: null },
  poll_interval_sec: { schema: int(5, 3600), default: 30 },
  poll_idle_interval_sec: { schema: int(5, 3600), default: 300 },
  poll_fresh_window_min: { schema: int(0, 1440), default: 15 },
  place_match_window_sec: { schema: int(5, 3600), default: 120 },
  api_rate_per_min: { schema: int(1, 60), default: 20 },
  request_cooldown_hours: { schema: int(0, 24 * 365), default: 24 },
  log_retention_days: { schema: int(1, 3650), default: 365 },
  paused: { schema: bool, default: false },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown }>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;
export type SettingsSnapshot = { [K in SettingKey]: SettingValue<K> };

export function isSettingKey(k: string): k is SettingKey {
  return Object.hasOwn(SETTINGS, k);
}

/** Keys that admins change through dedicated flows rather than `/set`. */
export const INTERNAL_SETTINGS: ReadonlySet<SettingKey> = new Set(['active_card_id']);

export class SettingsService {
  private cache: Partial<Record<SettingKey, unknown>> | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private load(): Partial<Record<SettingKey, unknown>> {
    if (this.cache) return this.cache;
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const row of this.db.select().from(settings).all()) {
      if (!isSettingKey(row.key)) continue;
      const parsed = this.parse(row.key, row.value);
      if (parsed.ok) out[row.key] = parsed.value;
    }
    this.cache = out;
    return out;
  }

  get<K extends SettingKey>(key: K): SettingValue<K> {
    const stored = this.load()[key];
    return (stored === undefined ? SETTINGS[key].default : stored) as SettingValue<K>;
  }

  all(): SettingsSnapshot {
    const out = {} as Record<string, unknown>;
    for (const k of Object.keys(SETTINGS) as SettingKey[]) out[k] = this.get(k);
    return out as SettingsSnapshot;
  }

  /** Parse a raw string for `key`. 'null' / '' map to null where the setting allows it. */
  parse<K extends SettingKey>(key: K, raw: string): { ok: true; value: SettingValue<K> } | { ok: false; error: string } {
    const trimmed = raw.trim();
    const nullish = trimmed === '' || trimmed.toLowerCase() === 'null';
    const nullable = SETTINGS[key].default === null;
    if (nullish && !nullable) return { ok: false, error: 'value required' };
    const input = nullish ? null : trimmed;
    const res = (SETTINGS[key].schema as z.ZodType).safeParse(input);
    if (!res.success) return { ok: false, error: res.error.issues[0]?.message ?? 'invalid value' };
    return { ok: true, value: res.data as SettingValue<K> };
  }

  /** Persist a value (already validated or raw string). Returns the previous value. */
  set<K extends SettingKey>(key: K, value: SettingValue<K>, by: number | null): SettingValue<K> {
    const prev = this.get(key);
    const stored = value === null ? 'null' : String(value);
    this.db
      .insert(settings)
      .values({ key, value: stored, updatedBy: by, updatedAt: this.clock.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedBy: by, updatedAt: this.clock.now() } })
      .run();
    this.cache = null;
    return prev;
  }
}
