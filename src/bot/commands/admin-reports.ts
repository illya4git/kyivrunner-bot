import { Composer, InputFile } from 'grammy';
import { toCsv } from '../../core/csv.js';
import { kyivDate, kyivDateTime, kyivDay, kyivDayMinus, kyivIso, kyivTime } from '../../core/clock.js';
import { esc } from '../../core/html.js';
import type { EventRow, UserRow } from '../../db/schema.js';
import { displayName, type Messages } from '../../i18n/index.js';
import { tripsLeft } from '../../kyiv/schemas.js';
import { INTERNAL_SETTINGS, SETTINGS, isSettingKey, type SettingKey } from '../../services/settings.js';
import { PERIODS, type Period } from '../../services/stats.js';
import type { BotContext } from '../context.js';
import type { BotDeps } from '../deps.js';

const MAX_TEXT = 3900; // Telegram's limit is 4096; leave room for markup
const MAX_LOG_LINES = 30;

/**
 * Admin reporting and tuning: /settings, /set, /pause, /resume, /stats, /logs, /export,
 * and the Stats / Log buttons on a user's card (ust:<id>, ulg:<id>).
 */
export function adminReportCommands(deps: BotDeps): Composer<BotContext> {
  const c = new Composer<BotContext>();
  const { settings, stats, audit, access } = deps;

  const nameOf = (tgId: number | null): string => {
    if (tgId === null) return '—';
    const u = access.get(tgId);
    return u ? displayName(u) : String(tgId);
  };

  // --- settings -----------------------------------------------------------------------

  c.command('settings', (ctx) => {
    const t = ctx.t;
    const all = settings.all();
    const lines = (Object.keys(SETTINGS) as SettingKey[]).map((k) =>
      t.settings.line(k, show(all[k]), all[k] === SETTINGS[k].default, t.settings.desc[k]),
    );
    return ctx.reply([t.settings.header, '', lines.join('\n\n'), '', t.settings.footer].join('\n'));
  });

  c.command('set', async (ctx) => {
    const t = ctx.t;
    const [key, ...rest] = ctx.match.trim().split(/\s+/);
    if (!key || rest.length === 0) return ctx.reply(t.settings.footer);
    if (!isSettingKey(key)) return ctx.reply(t.settings.unknownKey(key));
    if (INTERNAL_SETTINGS.has(key)) return ctx.reply(t.settings.internalKey(key));
    if (key === 'paused') return setPaused(ctx, settings.parse('paused', rest.join(' ')));
    const parsed = settings.parse(key, rest.join(' '));
    if (!parsed.ok) return ctx.reply(t.settings.invalid(key, parsed.error));
    const prev = settings.set(key, parsed.value, ctx.user.tgId);
    audit.log({ kind: 'setting_changed', tgId: ctx.user.tgId, role: ctx.user.role, data: { key, from: prev, to: parsed.value } });
    return ctx.reply(t.settings.changed(key, show(prev), show(parsed.value)));
  });

  // --- pause / resume --------------------------------------------------------------------

  async function setPaused(ctx: BotContext, parsed: ReturnType<typeof settings.parse<'paused'>>) {
    if (!parsed.ok) return ctx.reply(ctx.t.settings.invalid('paused', parsed.error));
    const paused = parsed.value;
    const t = ctx.t;
    if (settings.get('paused') === paused) return ctx.reply(paused ? t.pause.alreadyPaused : t.pause.notPaused);
    settings.set('paused', paused, ctx.user.tgId);
    audit.log({ kind: paused ? 'paused' : 'resumed', tgId: ctx.user.tgId, role: ctx.user.role });
    await ctx.reply(paused ? t.pause.paused : t.pause.resumed);
    const by = displayName(ctx.user);
    for (const id of access.adminIds().filter((id) => id !== ctx.user.tgId)) {
      const admin = access.get(id);
      if (admin) await deps.notifier.toUser(admin, (at) => ({ text: paused ? at.pause.noticePaused(by) : at.pause.noticeResumed(by) }));
    }
  }

  c.command('pause', (ctx) => setPaused(ctx, { ok: true, value: true }));
  c.command('resume', (ctx) => setPaused(ctx, { ok: true, value: false }));

  // --- stats ------------------------------------------------------------------------------

  c.command('stats', async (ctx) => {
    const t = ctx.t;
    const arg = (ctx.match.trim().toLowerCase() || 'today') as Period;
    if (!PERIODS.includes(arg)) return ctx.reply(t.stats.usage);
    const since = stats.periodStart(arg);
    const rows = stats.perUser(since);
    const out = [t.stats.header(t.stats.periods[arg]), ''];
    if (rows.length === 0) out.push(t.stats.empty);
    else {
      out.push(...rows.map((r) => t.stats.userLine(nameOf(r.tgId), r)), '', t.stats.total(stats.totals(rows)));
      const places = stats.topPlaces(since);
      if (places.length) out.push('', t.stats.placesHeader, ...places.map((p) => t.stats.placeLine(placeLabel(p), p.n)));
    }
    out.push('', await cardLine(t), t.stats.legend);
    return ctx.reply(clip(out.join('\n')));
  });

  async function cardLine(t: Messages): Promise<string> {
    const id = settings.get('active_card_id');
    if (id === null || !deps.credentials.usable()) return t.stats.cardUnavailable;
    try {
      return t.stats.card(tripsLeft(await deps.kyiv.getCard(id)));
    } catch {
      return t.stats.cardUnavailable;
    }
  }

  c.callbackQuery(/^ust:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgId = Number(ctx.match[1]);
    const t = ctx.t;
    const rows = stats.perUser(stats.periodStart('month'), tgId);
    const out = [t.stats.userHeader(nameOf(tgId)), ''];
    out.push(rows[0] ? t.stats.total(rows[0]) : t.stats.empty);
    const places = stats.topPlaces(stats.periodStart('month'), 3, tgId);
    if (places.length) out.push('', t.stats.placesHeader, ...places.map((p) => t.stats.placeLine(placeLabel(p), p.n)));
    const recent = deps.tickets.history(tgId, 5);
    if (recent.length) {
      out.push('', t.stats.recentHeader);
      for (const r of recent) {
        const place = r.place ? ` — ${esc(placeLabel(r))}` : '';
        out.push(`${r.status === 'used' ? '✅' : r.status === 'expired' ? '⌛' : '🎫'} ${kyivDate(r.issuedAt)} ${r.usedAt ? kyivTime(r.usedAt) : ''}${place}`);
      }
    }
    await ctx.reply(clip(out.join('\n')));
  });

  // --- logs --------------------------------------------------------------------------------

  function logView(t: Messages, tgId: number | undefined, n: number): string {
    const rows = audit.recent({ ...(tgId !== undefined ? { tgId } : { exclude: ['interaction'] }), limit: n });
    if (rows.length === 0) return t.logs.empty;
    const lines = rows.map((e) => logLine(e, nameOf));
    return clip([t.logs.header(rows.length, tgId !== undefined ? nameOf(tgId) : undefined), '', ...lines].join('\n'));
  }

  c.command('logs', (ctx) => {
    // /logs [id|@user] [count]: with two arguments the first is the user; with one,
    // a short number is a count (Telegram ids are much longer) and anything else a user.
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    const isCount = (a: string) => /^\d{1,3}$/.test(a);
    let userRef: string | undefined;
    let countArg: string | undefined;
    if (args.length >= 2) [userRef, countArg] = args;
    else if (args[0] !== undefined) {
      if (isCount(args[0])) countArg = args[0];
      else userRef = args[0];
    }
    if (countArg !== undefined && !isCount(countArg)) return ctx.reply(ctx.t.logs.usage);
    const n = countArg === undefined ? 20 : Math.min(MAX_LOG_LINES, Math.max(1, Number(countArg)));
    let tgId: number | undefined;
    if (userRef !== undefined) {
      const u = access.findByRef(userRef);
      if (!u) return ctx.reply(ctx.t.common.userNotFound(userRef));
      tgId = u.tgId;
    }
    return ctx.reply(logView(ctx.t, tgId, n));
  });

  c.callbackQuery(/^ulg:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(logView(ctx.t, Number(ctx.match[1]), 15));
  });

  // --- export ------------------------------------------------------------------------------

  c.command('export', async (ctx) => {
    const t = ctx.t;
    const [whatArg = 'tickets', daysArg = '30'] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if ((whatArg !== 'tickets' && whatArg !== 'events') || !/^(\d{1,4}|all)$/.test(daysArg)) return ctx.reply(t.export.usage);
    const days = daysArg === 'all' ? null : Math.max(1, Number(daysArg));
    const today = kyivDay(deps.clock.now());
    const sinceDay = days === null ? null : kyivDayMinus(today, days - 1);

    let csv: Buffer;
    let n: number;
    if (whatArg === 'tickets') {
      const rows = stats.ticketsSince(sinceDay);
      n = rows.length;
      csv = toCsv(
        ['id', 'kd_ticket_id', 'user_id', 'username', 'name', 'day', 'status', 'issued_at', 'expire_at', 'used_at', 'mode', 'place', 'resends'],
        rows.map(({ t: r, u }) => [
          r.id,
          r.kdTicketId,
          r.userTgId,
          u?.username ?? '',
          plainName(u),
          r.kyivDay,
          r.status,
          kyivIso(r.issuedAt),
          kyivIso(r.expireAt),
          r.usedAt ? kyivIso(r.usedAt) : '',
          r.mode ?? '',
          r.place ?? '',
          r.resendCount,
        ]),
      );
    } else {
      // Events since the start of the Kyiv day `days` ago (approximate is fine for an export).
      const since = days === null ? 0 : deps.clock.now() - days * 86_400_000;
      const rows = audit.since(since);
      n = rows.length;
      csv = toCsv(
        ['id', 'time', 'user_id', 'role', 'kind', 'data'],
        rows.map((e) => [e.id, kyivIso(e.ts), e.tgId ?? '', e.roleAtTime ?? '', e.kind, e.data ? JSON.stringify(e.data) : '']),
      );
    }
    audit.log({ kind: 'exported', tgId: ctx.user.tgId, role: ctx.user.role, data: { what: whatArg, days: daysArg, rows: n } });
    const name = `${whatArg}-${today}${days === null ? '-all' : `-${days}d`}.csv`;
    await ctx.replyWithDocument(new InputFile(csv, name), { caption: t.export.caption(whatArg, days === null ? t.export.allTime : t.export.days(days), n) });
  });

  return c;
}

function show(v: unknown): string {
  return v === null || v === undefined ? '—' : String(v);
}

function clip(s: string): string {
  return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT).replace(/\n[^\n]*$/, '')}\n…`;
}

function placeLabel(p: { mode: string | null; place: string | null }): string {
  return p.mode ? `${p.mode}, ${p.place}` : (p.place ?? '');
}

function plainName(u: UserRow | null): string {
  if (!u) return '';
  return [u.firstName, u.lastName].filter(Boolean).join(' ');
}

/** One audit event as a compact, escaped line. */
function logLine(e: EventRow, nameOf: (id: number | null) => string): string {
  const data = e.data ? JSON.stringify(e.data) : '';
  const summary = data.length > 90 ? `${data.slice(0, 90)}…` : data;
  return `<code>${kyivDateTime(e.ts)}</code> · <b>${esc(e.kind)}</b> · ${nameOf(e.tgId)}${summary ? ` · <code>${esc(summary)}</code>` : ''}`;
}
