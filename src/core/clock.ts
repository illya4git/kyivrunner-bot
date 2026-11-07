/** All "day" logic in the bot is Kyiv-local, independent of the host TZ. */
export const KYIV_TZ = 'Europe/Kyiv';

export interface Clock {
  /** Current time, unix milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock shifted by a mutable offset — used by DEV_MODE `/dev clock`. */
export class OffsetClock implements Clock {
  offsetMs = 0;
  constructor(private readonly base: Clock = systemClock) {}
  now(): number {
    return this.base.now() + this.offsetMs;
  }
}

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' of the Kyiv calendar day containing `ms`. */
export function kyivDay(ms: number): string {
  return dayFmt.format(ms);
}

/** Last millisecond of the Kyiv calendar day containing `ms` (23:59:59.999 local). DST-safe. */
export function kyivDayEnd(ms: number): number {
  const today = kyivDay(ms);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const tomorrow = kyivDay(Date.UTC(y, m - 1, d + 1, 12));
  for (const offsetH of [2, 3]) {
    const midnight = Date.UTC(y, m - 1, d + 1) - offsetH * 3_600_000;
    if (kyivDay(midnight) === tomorrow && kyivDay(midnight - 1) === today) return midnight - 1;
  }
  throw new Error(`cannot find Kyiv midnight after ${today}`);
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: KYIV_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: KYIV_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 'HH:MM' Kyiv time. */
export function kyivTime(ms: number): string {
  return timeFmt.format(ms);
}

/** 'DD.MM.YYYY HH:MM' Kyiv time. */
export function kyivDateTime(ms: number): string {
  const parts = Object.fromEntries(dateTimeFmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}
