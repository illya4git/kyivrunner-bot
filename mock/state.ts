import { randomInt } from 'node:crypto';
import { kyivDayEnd, kyivTime } from '../src/core/clock.js';
import {
  DEFAULT_CARDS,
  DEV_DEVICE_UUID,
  DEV_TOKEN_EXP_SEC,
  DEV_USER_ID,
  LABELS,
  QR_TEXTS,
  STATIONS,
  type CardSeed,
} from './fixtures.js';
import { fakeJwt } from './jwt.js';

// Shapes mirror docs/travel-cards.md exactly (snake_case, unix seconds).

export type MockCard = {
  id: number;
  name: string;
  type: number;
  code: string;
  locked_at: number | null;
  balance: number;
  balance_wallet: number;
  monthly_tickets: { balance: number; valid_from: number; valid_to: number }[];
  monthly_tickets_balance: number;
  future_monthly_tickets_balance: number;
  qrs_count: number;
  qr_generate_blocked: boolean;
  actions: { generate_qr: boolean; generate_qr_always: boolean; show_balance: boolean; [k: string]: boolean };
};

export type MockCode = {
  id: number;
  code: string;
  type: number;
  card_id: number;
  card_type: null;
  name: null;
  description: string;
  icon_url: null;
  shared: boolean;
  shared_at: null;
  used_at: number | null;
  expire_at: number;
  qr_texts: typeof QR_TEXTS & { label: (typeof LABELS)[number] };
};

export type MockFeedEvent = {
  id: string;
  type: 1 | 2 | 3 | 4;
  icon: string | null;
  sub_icon: string | null;
  title: string;
  description: string | null;
  value_sum: number | null;
  value_text: string | null;
  passengers: number | null;
  rating: null;
  read: boolean;
  clickable: boolean;
  created_at: number;
};

type StoredEvent = { cardId: number; event: MockFeedEvent; /** hidden from /feed until (sec) */ visibleAt: number };
type StoredCode = MockCode & { /** trip already returned to the card at expiry */ returned: boolean };

export type MockToken = { token: string; sub: number; deviceUuid: string; exp: number; revoked: boolean };

export class MockError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * In-memory Kyiv Digital account. All domain rules of the real service that the bot
 * depends on live here: trip reservation on generate, midnight return of unused trips,
 * validation feed events, and code expiry.
 */
export class MockState {
  /** Shift of the mock's clock relative to real time, seconds. */
  clockOffsetSec = 0;
  tokens = new Map<string, MockToken>();
  cards: MockCard[] = [];
  private codes: StoredCode[] = []; // newest first
  private events: StoredEvent[] = []; // newest first
  private nextCodeId = 230_270_218;
  private nextEventId = 51_000_000;
  qrVersion = 102;

  constructor(private readonly realNowMs: () => number = Date.now) {
    this.reset();
  }

  nowSec(): number {
    return Math.floor(this.realNowMs() / 1000) + this.clockOffsetSec;
  }

  reset(cards: CardSeed[] = DEFAULT_CARDS): void {
    this.clockOffsetSec = 0;
    this.tokens.clear();
    this.cards = cards.map((c) => this.makeCard(c));
    this.codes = [];
    this.events = [];
    this.issueToken({ sub: DEV_USER_ID, deviceUuid: DEV_DEVICE_UUID, exp: DEV_TOKEN_EXP_SEC, seed: 'dev' });
  }

  /** The stable dev token (see fixtures). */
  get devToken(): MockToken {
    return [...this.tokens.values()].find((t) => t.deviceUuid === DEV_DEVICE_UUID && t.sub === DEV_USER_ID)!;
  }

  issueToken(o: { sub?: number; deviceUuid?: string; exp?: number; seed?: string } = {}): MockToken {
    const sub = o.sub ?? DEV_USER_ID;
    const deviceUuid = o.deviceUuid ?? crypto.randomUUID();
    const exp = o.exp ?? this.nowSec() + 186 * 86_400;
    const token = fakeJwt({ sub, exp, d: deviceUuid }, o.seed);
    const t: MockToken = { token, sub, deviceUuid, exp, revoked: false };
    this.tokens.set(token, t);
    return t;
  }

  /** Returns the token record if it's accepted for this device, else throws 401. */
  authenticate(token: string, deviceUuid: string | undefined): MockToken {
    const t = this.tokens.get(token);
    if (!t || t.revoked) throw new MockError(401, 'Unauthenticated.');
    if (t.exp <= this.nowSec()) throw new MockError(401, 'Token has expired');
    if (deviceUuid !== t.deviceUuid) throw new MockError(401, 'Unauthenticated. (device mismatch)');
    return t;
  }

  // --- time ------------------------------------------------------------------

  /**
   * Apply everything that "happened" up to now: unused codes past expire_at return
   * their trip to the card (an `eqr_` event). Called before every request.
   */
  tick(): void {
    const now = this.nowSec();
    for (const c of this.codes) {
      if (c.used_at === null && !c.returned && c.expire_at <= now) {
        c.returned = true;
        const card = this.card(c.card_id);
        if (card) this.adjustTrips(card, +1);
        this.pushEvent(c.card_id, 4, 'Сплив термін QR-квитка', 'Поїздка повернулася на карту', null, c.expire_at + 1);
      }
    }
  }

  advance(sec: number): void {
    this.clockOffsetSec += sec;
    this.tick();
  }

  // --- reads (API shapes) ---------------------------------------------------------

  card(id: number): MockCard | undefined {
    return this.cards.find((c) => c.id === id);
  }

  cardView(id: number): MockCard | undefined {
    const c = this.card(id);
    if (!c) return undefined;
    const now = this.nowSec();
    return { ...c, qrs_count: this.codes.filter((q) => q.card_id === id && q.expire_at > now).length };
  }

  codeList(): MockCode[] {
    return this.codes.map(({ returned: _r, ...c }) => c);
  }

  feed(cardId: number, page: number, perPage: number): MockFeedEvent[] {
    const now = this.nowSec();
    return this.events
      .filter((e) => e.cardId === cardId && e.visibleAt <= now)
      .slice((page - 1) * perPage, page * perPage)
      .map((e) => e.event);
  }

  // --- actions ------------------------------------------------------------------

  generate(cardId: number): MockCode {
    const card = this.card(cardId);
    if (!card) throw new MockError(404, 'Not found');
    if (card.locked_at || card.qr_generate_blocked || !card.actions.generate_qr) throw new MockError(422, 'Генерація QR-квитків недоступна');
    if (card.monthly_tickets_balance <= 0) throw new MockError(422, 'Недостатньо поїздок');

    const now = this.nowSec();
    this.adjustTrips(card, -1);
    const code: StoredCode = {
      id: this.nextCodeId++,
      code: `$$${String(randomInt(0, 10 ** 10)).padStart(10, '0')}`,
      type: 1,
      card_id: card.id,
      card_type: null,
      name: null,
      description: 'Дійсний до опівночі',
      icon_url: null,
      shared: false,
      shared_at: null,
      used_at: null,
      expire_at: Math.floor(kyivDayEnd(now * 1000) / 1000),
      qr_texts: { ...QR_TEXTS, label: LABELS[card.type] ?? LABELS[2]! },
      returned: false,
    };
    this.codes.unshift(code);
    this.qrVersion++;
    this.pushEvent(card.id, 3, 'Ви створили QR-квиток', null, null, now);
    return this.codeList()[0]!;
  }

  /** A validator scanned the code. The place appears in the feed after `feedDelaySec`. */
  validate(codeId: number, o: { mode?: string; place?: string; feedDelaySec?: number } = {}): { code: MockCode; event: MockFeedEvent } {
    const code = this.codes.find((c) => c.id === codeId);
    if (!code) throw new MockError(404, `no code ${codeId}`);
    if (code.used_at !== null) throw new MockError(409, 'code already used');
    const now = this.nowSec();
    if (code.expire_at <= now) throw new MockError(409, 'code expired');

    const station = pickStation(o);
    code.used_at = now;
    this.qrVersion++;
    const event = this.pushEvent(code.card_id, 1, station.mode, station.place, kyivTime(now * 1000), now, now + (o.feedDelaySec ?? 0));
    return { code: this.codeList().find((c) => c.id === codeId)!, event };
  }

  /** A trip validated without a QR (e.g. the physical card) — a decoy for place matching. */
  foreignValidation(cardId: number, o: { mode?: string; place?: string; atSec?: number } = {}): MockFeedEvent {
    if (!this.card(cardId)) throw new MockError(404, 'Not found');
    const station = pickStation(o);
    const at = o.atSec ?? this.nowSec();
    return this.pushEvent(cardId, 1, station.mode, station.place, kyivTime(at * 1000), at);
  }

  /** Expire one unused code right now (its trip returns to the card). */
  expire(codeId: number): MockCode {
    const code = this.codes.find((c) => c.id === codeId);
    if (!code) throw new MockError(404, `no code ${codeId}`);
    if (code.used_at !== null) throw new MockError(409, 'code already used');
    code.expire_at = Math.min(code.expire_at, this.nowSec() - 1);
    this.tick();
    return this.codeList().find((c) => c.id === codeId)!;
  }

  /** Jump the clock to just after the next Kyiv midnight. */
  midnight(): void {
    const end = Math.floor(kyivDayEnd(this.nowSec() * 1000) / 1000);
    this.advance(end + 1 - this.nowSec());
  }

  patchCard(id: number, p: { trips?: number; blocked?: boolean; generate_qr?: boolean; locked?: boolean }): MockCard {
    const card = this.card(id);
    if (!card) throw new MockError(404, 'Not found');
    if (p.trips !== undefined) this.adjustTrips(card, p.trips - card.monthly_tickets_balance);
    if (p.blocked !== undefined) card.qr_generate_blocked = p.blocked;
    if (p.generate_qr !== undefined) card.actions.generate_qr = p.generate_qr;
    if (p.locked !== undefined) card.locked_at = p.locked ? this.nowSec() : null;
    return this.cardView(id)!;
  }

  addCard(seed: CardSeed): MockCard {
    if (this.card(seed.id)) throw new MockError(409, 'card exists');
    this.cards.push(this.makeCard(seed));
    return this.cardView(seed.id)!;
  }

  // --- internals ------------------------------------------------------------------

  private makeCard(c: CardSeed): MockCard {
    const now = this.nowSec();
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      code: c.code,
      locked_at: null,
      balance: 0,
      balance_wallet: 0,
      monthly_tickets: [{ balance: c.trips, valid_from: now - 7 * 86_400, valid_to: now + 23 * 86_400 }],
      monthly_tickets_balance: c.trips,
      future_monthly_tickets_balance: 0,
      qrs_count: 0,
      qr_generate_blocked: false,
      actions: { generate_qr: true, generate_qr_always: false, show_balance: true, replenishment: true, buy_monthly: true },
    };
  }

  private adjustTrips(card: MockCard, delta: number): void {
    card.monthly_tickets_balance = Math.max(0, card.monthly_tickets_balance + delta);
    const bundle = card.monthly_tickets[0];
    if (bundle) bundle.balance = card.monthly_tickets_balance;
  }

  private pushEvent(
    cardId: number,
    type: MockFeedEvent['type'],
    title: string,
    description: string | null,
    valueText: string | null,
    createdAt: number,
    visibleAt = createdAt,
  ): MockFeedEvent {
    const prefix = { 1: 'val', 2: 'pch', 3: 'qrt', 4: 'eqr' }[type];
    const event: MockFeedEvent = {
      id: `${prefix}_${this.nextEventId++}`,
      type,
      icon: `https://kyiv.digital/i/feed/${prefix}.png`,
      sub_icon: null,
      title,
      description,
      value_sum: null,
      value_text: valueText,
      passengers: type === 1 ? 1 : null,
      rating: null,
      read: true,
      clickable: false,
      created_at: createdAt,
    };
    this.events.unshift({ cardId, event, visibleAt }); // newest first; stable sort keeps it ahead of same-second events
    this.events.sort((a, b) => b.event.created_at - a.event.created_at);
    return event;
  }
}

function pickStation(o: { mode?: string; place?: string }): { mode: string; place: string } {
  const random = STATIONS[randomInt(0, STATIONS.length)]!;
  return { mode: o.mode ?? random.mode, place: o.place ?? random.place };
}
