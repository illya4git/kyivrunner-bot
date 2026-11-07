import { Composer } from 'grammy';
import { OffsetClock, kyivDateTime, kyivDayEnd } from '../../core/clock.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const USAGE =
  '<b>/dev clock</b> — show the bot clock\n' +
  '<code>/dev clock +2h</code> · <code>-30m</code> · <code>+1d</code> — shift it\n' +
  '<code>/dev clock midnight</code> — jump just past the next Kyiv midnight\n' +
  '<code>/dev clock reset</code> — back to real time\n' +
  '<code>/dev tick</code> — run a tracker pass now\n\n' +
  'Under <code>npm run dev:mock</code> the mock follows this clock.';

/**
 * DEV_MODE-only admin tools. Plain English on purpose: this never reaches real users.
 * Registered only when DEV_MODE=true.
 */
export function devCommands(deps: BotDeps): Composer<BotContext> {
  const c = new Composer<BotContext>();
  const clock = deps.clock;

  const show = () => {
    const offset = clock instanceof OffsetClock ? clock.offsetMs : 0;
    const h = offset / 3_600_000;
    return `🕰 Bot clock: <b>${kyivDateTime(clock.now())}</b> Kyiv${offset ? ` (offset ${h > 0 ? '+' : ''}${h.toFixed(2)} h)` : ' (real time)'}`;
  };

  c.command('dev', async (ctx) => {
    const [sub, arg] = ctx.match.trim().split(/\s+/);
    if (sub === 'tick') {
      await deps.tracker.tick();
      return ctx.reply('✅ Tracker pass done.');
    }
    if (sub !== 'clock') return ctx.reply(USAGE);
    if (!arg) return ctx.reply(show());
    if (!(clock instanceof OffsetClock)) return ctx.reply('This clock cannot be shifted.');

    if (arg === 'reset') {
      clock.offsetMs = 0;
    } else if (arg === 'midnight') {
      clock.offsetMs += kyivDayEnd(clock.now()) + 1 + 5_000 - clock.now();
    } else {
      const m = /^([+-])(\d+(?:\.\d+)?)([mhd])$/.exec(arg);
      if (!m) return ctx.reply(USAGE);
      clock.offsetMs += (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT_MS[m[3] as keyof typeof UNIT_MS];
    }
    deps.audit.log({ kind: 'setting_changed', tgId: ctx.user.tgId, role: ctx.user.role, data: { key: 'dev_clock_offset_ms', to: clock.offsetMs } });
    await ctx.reply(show());
    await deps.tracker.tick(); // let expiry/retirement happen right away
  });

  return c;
}
