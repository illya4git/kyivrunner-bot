import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KD_CLIENT_AUTH } from '../src/kyiv/envelope.js';
import { MockError, MockState } from './state.js';

/**
 * timeout: hang without processing; drop: close the connection without processing;
 * lost: PROCESS the request, then close the connection (the response never arrives).
 */
export const FAULT_KINDS = ['401', '423', '429', '500', '503', 'shape', 'timeout', 'drop', 'lost'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export type Fault = {
  id: number;
  kind: FaultKind;
  /** Times left to fire; undefined = unlimited (use with `rate`). */
  remaining?: number;
  /** Probability 0..1 per matching request (default 1). */
  rate?: number;
  /** Only requests whose path contains this. */
  path?: string;
  method?: 'GET' | 'POST';
};

export type RequestLogEntry = {
  at: number;
  method: string;
  path: string;
  status: number | 'timeout' | 'dropped';
  ms: number;
  note?: string;
};

type Ctx = {
  req: IncomingMessage;
  method: string;
  path: string;
  params: string[];
  query: URLSearchParams;
  rawBody: string;
  json: () => Record<string, unknown>;
};
type Handler = (ctx: Ctx) => unknown;
type Route = { method: string; re: RegExp; handler: Handler };

const RATE_LIMIT = 60;
const TIMEOUT_HANG_MS = 30_000;

/**
 * HTTP front for MockState. `/api/*` mirrors the real API (with strict envelope checks);
 * `/_mock/*` is the control plane for tests, dev tooling and (later) the panel.
 */
export class MockKyivServer {
  readonly state: MockState;
  faults: Fault[] = [];
  latencyMs = 0;
  readonly requests: RequestLogEntry[] = [];
  private nextFaultId = 1;
  private readonly hits = new Map<string, number[]>();
  private readonly routes: Route[] = [];
  private server: Server | null = null;

  constructor(state = new MockState()) {
    this.state = state;
    this.apiRoutes();
    this.controlRoutes();
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as AddressInfo;
    return `http://${host}:${addr.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  addFault(f: Omit<Fault, 'id'>): Fault {
    const fault = { ...f, id: this.nextFaultId++ };
    this.faults.push(fault);
    return fault;
  }

  // --- routes: real API ---------------------------------------------------------

  private apiRoutes(): void {
    const s = this.state;
    const cardOr404 = (id: string | undefined) => {
      const c = s.cardView(Number(id));
      if (!c) throw new MockError(404, 'Not found');
      return c;
    };

    this.route('GET', /^\/api\/v4\/card\/travel$/, () => ({
      qrs_total: s.codeList().filter((c) => c.expire_at > s.nowSec()).length,
      cards: s.cards.map((c) => s.cardView(c.id)),
    }));
    this.route('GET', /^\/api\/v4\/card\/travel\/(\d+)$/, ({ params }) => cardOr404(params[0]));
    this.route('GET', /^\/api\/v4\/card\/travel\/(\d+)\/feed$/, ({ params, query }) => {
      const card = cardOr404(params[0]);
      const page = Math.max(1, Number(query.get('page') ?? 1));
      const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30)));
      return { card, feed: { data: s.feed(card.id, page, perPage), current_page: page, per_page: perPage } };
    });
    this.route('POST', /^\/api\/v4\/card\/travel\/(\d+)\/qr-ticket$/, ({ params }) => {
      s.generate(Number(params[0]));
      return { codes: s.codeList() };
    });
    this.route('GET', /^\/api\/v4\/qr$/, () => ({
      codes: s.codeList(),
      version: s.qrVersion,
      active_qr_texts: { title: 'Активні квитки', link_text: null, link_url: null },
      used_qr_texts: { title: 'Використані квитки' },
    }));
  }

  // --- routes: control plane -----------------------------------------------------

  private controlRoutes(): void {
    const s = this.state;
    const num = (v: unknown, name: string): number | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new MockError(400, `${name} must be a number`);
      return v;
    };
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const defaultCard = () => s.cards[0]?.id ?? 0;

    this.route('GET', /^\/_mock\/?$/, () => ({
      endpoints: this.routes.filter((r) => r.re.source.includes('_mock')).map((r) => `${r.method} ${r.re.source}`),
    }));
    this.route('GET', /^\/_mock\/state$/, () => ({
      now: s.nowSec(),
      clock_offset_sec: s.clockOffsetSec,
      cards: s.cards.map((c) => s.cardView(c.id)),
      codes: s.codeList(),
      feed: Object.fromEntries(s.cards.map((c) => [c.id, s.feed(c.id, 1, 100)])),
      tokens: [...s.tokens.values()],
      faults: this.faults,
      latency_ms: this.latencyMs,
    }));
    this.route('GET', /^\/_mock\/requests$/, () => this.requests.slice(-100).reverse());
    this.route('POST', /^\/_mock\/reset$/, () => {
      s.reset();
      this.faults = [];
      this.latencyMs = 0;
      this.hits.clear();
      return { ok: true, dev_token: s.devToken };
    });
    this.route('POST', /^\/_mock\/tokens$/, ({ json }) => {
      const b = json();
      const expInDays = num(b.exp_in_days, 'exp_in_days');
      const t = s.issueToken({
        ...(num(b.sub, 'sub') !== undefined ? { sub: num(b.sub, 'sub')! } : {}),
        ...(str(b.device_uuid) ? { deviceUuid: str(b.device_uuid)! } : {}),
        ...(expInDays !== undefined ? { exp: s.nowSec() + Math.round(expInDays * 86_400) } : {}),
      });
      return t;
    });
    this.route('POST', /^\/_mock\/tokens\/revoke$/, ({ json }) => {
      const b = json();
      const targets = b.all === true ? [...s.tokens.values()] : [s.tokens.get(String(b.token))].filter((t) => t !== undefined);
      if (!targets.length) throw new MockError(404, 'no such token');
      for (const t of targets) t.revoked = true;
      return { revoked: targets.length };
    });
    this.route('POST', /^\/_mock\/codes\/(\d+)\/validate$/, ({ params, json }) => {
      const b = json();
      const delay = num(b.feed_delay_sec, 'feed_delay_sec');
      return s.validate(Number(params[0]), {
        ...(str(b.mode) ? { mode: str(b.mode)! } : {}),
        ...(str(b.place) ? { place: str(b.place)! } : {}),
        ...(delay !== undefined ? { feedDelaySec: delay } : {}),
      });
    });
    this.route('POST', /^\/_mock\/codes\/(\d+)\/expire$/, ({ params }) => s.expire(Number(params[0])));
    this.route('POST', /^\/_mock\/midnight$/, () => {
      s.midnight();
      return { now: s.nowSec() };
    });
    this.route('POST', /^\/_mock\/clock$/, ({ json }) => {
      const b = json();
      const advance = num(b.advance_sec, 'advance_sec');
      const offset = num(b.offset_sec, 'offset_sec');
      if (offset !== undefined) s.advance(offset - s.clockOffsetSec);
      else if (advance !== undefined) s.advance(advance);
      return { now: s.nowSec(), clock_offset_sec: s.clockOffsetSec };
    });
    this.route('POST', /^\/_mock\/owner-generate$/, ({ json }) => s.generate(num(json().card_id, 'card_id') ?? defaultCard()));
    this.route('POST', /^\/_mock\/foreign-validation$/, ({ json }) => {
      const b = json();
      const at = num(b.at_offset_sec, 'at_offset_sec');
      return s.foreignValidation(num(b.card_id, 'card_id') ?? defaultCard(), {
        ...(str(b.mode) ? { mode: str(b.mode)! } : {}),
        ...(str(b.place) ? { place: str(b.place)! } : {}),
        ...(at !== undefined ? { atSec: s.nowSec() + at } : {}),
      });
    });
    this.route('PATCH', /^\/_mock\/cards\/(\d+)$/, ({ params, json }) => {
      const b = json();
      const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
      const patch: Parameters<MockState['patchCard']>[1] = {};
      const trips = num(b.trips, 'trips');
      if (trips !== undefined) patch.trips = trips;
      if (bool(b.blocked) !== undefined) patch.blocked = bool(b.blocked)!;
      if (bool(b.generate_qr) !== undefined) patch.generate_qr = bool(b.generate_qr)!;
      if (bool(b.locked) !== undefined) patch.locked = bool(b.locked)!;
      return s.patchCard(Number(params[0]), patch);
    });
    this.route('POST', /^\/_mock\/cards$/, ({ json }) => {
      const b = json();
      return s.addCard({
        id: num(b.id, 'id') ?? Math.max(...s.cards.map((c) => c.id), 1_400_000) + 1,
        name: str(b.name) ?? 'Учнівський',
        type: num(b.type, 'type') ?? 1,
        code: str(b.code) ?? '300003700000',
        trips: num(b.trips, 'trips') ?? 20,
      });
    });
    this.route('POST', /^\/_mock\/faults$/, ({ json }) => {
      const b = json();
      const kind = String(b.kind) as FaultKind;
      if (!FAULT_KINDS.includes(kind)) throw new MockError(400, `kind must be one of ${FAULT_KINDS.join(', ')}`);
      const count = num(b.count, 'count');
      const rate = num(b.rate, 'rate');
      return this.addFault({
        kind,
        ...(count !== undefined ? { remaining: count } : rate === undefined ? { remaining: 1 } : {}),
        ...(rate !== undefined ? { rate } : {}),
        ...(str(b.path) ? { path: str(b.path)! } : {}),
        ...(b.method === 'GET' || b.method === 'POST' ? { method: b.method } : {}),
      });
    });
    this.route('DELETE', /^\/_mock\/faults$/, () => {
      this.faults = [];
      return { ok: true };
    });
    this.route('POST', /^\/_mock\/latency$/, ({ json }) => {
      this.latencyMs = Math.max(0, num(json().ms, 'ms') ?? 0);
      return { latency_ms: this.latencyMs };
    });
  }

  private route(method: string, re: RegExp, handler: Handler): void {
    this.routes.push({ method, re, handler });
  }

  // --- request pipeline -----------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const log = (status: RequestLogEntry['status'], note?: string) => {
      this.requests.push({ at: started, method, path: path + url.search, status, ms: Date.now() - started, ...(note ? { note } : {}) });
      if (this.requests.length > 500) this.requests.splice(0, this.requests.length - 500);
    };
    const send = (status: number, body: unknown, headers: Record<string, string> = {}, note?: string) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
      log(status, note);
    };

    try {
      const rawBody = await readBody(req);
      const isApi = path.startsWith('/api/');
      if (isApi && this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

      const route = this.routes.find((r) => r.method === method && r.re.test(path));
      if (!route) return send(404, { message: 'Not found' });
      const params = route.re.exec(path)!.slice(1);
      const ctx: Ctx = {
        req,
        method,
        path,
        params,
        query: url.searchParams,
        rawBody,
        json: () => {
          if (!rawBody) return {};
          const v = JSON.parse(rawBody) as unknown;
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new MockError(400, 'JSON object expected');
          return v as Record<string, unknown>;
        },
      };

      if (!isApi) return send(200, route.handler(ctx));

      // Real-API pipeline: envelope → auth → rate limit → faults → handler.
      const problems = envelopeProblems(req, method, path, rawBody);
      if (problems.length) return send(400, { message: `mock: bad request envelope: ${problems.join('; ')}` }, {}, problems.join('; '));

      const token = String(req.headers.authorization).slice('Bearer '.length);
      this.state.tick();
      this.state.authenticate(token, header(req, 'x-device-uuid'));

      const remaining = this.consumeRate(token);
      const rlHeaders = { 'x-ratelimit-limit': String(RATE_LIMIT), 'x-ratelimit-remaining': String(Math.max(0, remaining)) };
      if (remaining < 0) return send(429, { message: 'Too Many Attempts.' }, { ...rlHeaders, 'retry-after': '60' });

      const fault = this.takeFault(method, path);
      if (fault) {
        switch (fault.kind) {
          case 'timeout':
            log('timeout', `fault #${fault.id}`);
            setTimeout(() => res.destroy(), TIMEOUT_HANG_MS).unref();
            return;
          case 'drop':
            log('dropped', `fault #${fault.id}`);
            res.destroy();
            return;
          case 'lost':
            route.handler(ctx);
            log('dropped', `fault #${fault.id} (processed)`);
            res.destroy();
            return;
          case 'shape':
            return send(200, { unexpected: 'shape' }, rlHeaders, `fault #${fault.id}`);
          case '423':
            return send(423, { message: 'Error', recaptcha_link: 'https://kyiv.digital/recaptcha?c=mock' }, rlHeaders, `fault #${fault.id}`);
          case '429':
            return send(429, { message: 'Too Many Attempts.' }, { ...rlHeaders, 'retry-after': '1' }, `fault #${fault.id}`);
          default:
            return send(Number(fault.kind), { message: `mock fault ${fault.kind}` }, rlHeaders, `fault #${fault.id}`);
        }
      }

      return send(200, route.handler(ctx), rlHeaders);
    } catch (err) {
      if (err instanceof MockError) return send(err.status, { message: err.message });
      if (err instanceof SyntaxError) return send(400, { message: 'invalid JSON' });
      return send(500, { message: String(err) });
    }
  }

  private consumeRate(token: string): number {
    const now = Date.now();
    const list = (this.hits.get(token) ?? []).filter((t) => t > now - 60_000);
    list.push(now);
    this.hits.set(token, list);
    return RATE_LIMIT - list.length;
  }

  private takeFault(method: string, path: string): Fault | undefined {
    for (const f of this.faults) {
      if (f.method && f.method !== method) continue;
      if (f.path && !path.includes(f.path)) continue;
      if (f.remaining !== undefined && f.remaining <= 0) continue;
      if (f.rate !== undefined && Math.random() >= f.rate) continue;
      if (f.remaining !== undefined) f.remaining--;
      this.faults = this.faults.filter((x) => x.remaining === undefined || x.remaining > 0);
      return f;
    }
    return undefined;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Strict checks that catch client bugs the real server might punish silently. */
function envelopeProblems(req: IncomingMessage, method: string, path: string, rawBody: string): string[] {
  const p: string[] = [];
  const h = (n: string) => header(req, n);
  if (h('x-client-auth') !== KD_CLIENT_AUTH) p.push('X-Client-Auth missing or wrong');
  if (!h('accept')?.includes('application/json')) p.push('Accept must be application/json');
  if (!h('x-client-version')) p.push('X-Client-Version missing');
  if (h('x-client-platform') !== '0') p.push('X-Client-Platform must be 0');
  if (!h('x-client-locale')) p.push('X-Client-Locale missing');
  if (!h('x-device-uuid')) p.push('X-Device-UUID missing');
  if (!/^KD\/[\d.]+ Android\/\S+ User\/\S+$/.test(h('user-agent') ?? '')) p.push('User-Agent must look like "KD/4.0.0 Android/11 User/<id>"');
  if (!/^Bearer \S+$/.test(h('authorization') ?? '')) p.push('Authorization must be "Bearer <token>"');
  if (method === 'POST' && /\/qr-ticket$/.test(path)) {
    if (h('content-type') !== undefined) p.push('generate must not send Content-Type');
    if (rawBody.length) p.push('generate must have an empty body');
  }
  return p;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
