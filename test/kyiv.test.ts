import { afterEach, describe, expect, it } from 'vitest';
import { kyivDayEnd } from '../src/core/clock.js';
import { decodeJwtClaims, envelopeHeaders, jwtSubject } from '../src/kyiv/envelope.js';
import { isKyivError, type KyivError } from '../src/kyiv/errors.js';
import { RateLimiter } from '../src/kyiv/rate-limit.js';
import { FEED_EVENT_TYPE, canGenerate, isUsable, tripsLeft } from '../src/kyiv/schemas.js';
import { DEV_USER_ID, STUDENT_CARD_ID } from '../mock/fixtures.js';
import { startMockKyiv } from './helpers/kyiv.js';

type Env = Awaited<ReturnType<typeof startMockKyiv>>;
let env: Env | undefined;
async function start(opts?: Parameters<typeof startMockKyiv>[0]) {
  env = await startMockKyiv(opts);
  return env;
}
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function kyivError(p: Promise<unknown>): Promise<KyivError> {
  try {
    await p;
  } catch (err) {
    if (isKyivError(err)) return err;
    throw err;
  }
  throw new Error('expected a KyivError');
}

describe('KyivClient ↔ mock: happy path', () => {
  it('lists cards through the strict envelope check', async () => {
    const { client } = await start();
    const { cards } = await client.listCards();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.id).toBe(STUDENT_CARD_ID);
    expect(tripsLeft(card)).toBe(36);
    expect(canGenerate(card)).toBe(true);
    expect(client.rateLimit.limit).toBe(60);
  });

  it('generates a code: reserves a trip, new code first, usable until Kyiv midnight', async () => {
    const { client, state } = await start();
    const { code, codes } = await client.generateCode(STUDENT_CARD_ID);
    expect(codes[0]).toEqual(code);
    expect(code.code).toMatch(/^\$\$\d{10}$/);
    expect(code.expire_at).toBe(Math.floor(kyivDayEnd(state.nowSec() * 1000) / 1000));
    expect(isUsable(code, state.nowSec())).toBe(true);
    expect(tripsLeft(await client.getCard(STUDENT_CARD_ID))).toBe(35);

    const second = await client.generateCode(STUDENT_CARD_ID);
    expect(second.codes.map((c) => c.id)).toEqual([second.code.id, code.id]);
  });

  it('shows validation in /qr and the place in the feed with matching timestamps', async () => {
    const { client, state } = await start();
    const { code } = await client.generateCode(STUDENT_CARD_ID);
    state.advance(600);
    state.validate(code.id, { mode: 'Метро', place: 'Хрещатик' });

    const listed = (await client.listCodes()).find((c) => c.id === code.id)!;
    expect(listed.used_at).toBe(state.nowSec());
    const feed = await client.feed(STUDENT_CARD_ID);
    const val = feed.find((e) => e.type === FEED_EVENT_TYPE.validation)!;
    expect(val).toMatchObject({ title: 'Метро', description: 'Хрещатик', created_at: listed.used_at });
    expect(val.id).toMatch(/^val_/);
    expect(feed.map((e) => e.type)).toEqual([FEED_EVENT_TYPE.validation, FEED_EVENT_TYPE.qrCreated]);
  });

  it('hides a delayed validation from the feed until it lands', async () => {
    const { client, state } = await start();
    const { code } = await client.generateCode(STUDENT_CARD_ID);
    state.validate(code.id, { feedDelaySec: 45 });
    expect((await client.feed(STUDENT_CARD_ID)).some((e) => e.type === 1)).toBe(false);
    state.advance(45);
    expect((await client.feed(STUDENT_CARD_ID)).some((e) => e.type === 1)).toBe(true);
  });

  it('returns the trip of an unused code at midnight', async () => {
    const { client, state } = await start();
    const { code } = await client.generateCode(STUDENT_CARD_ID);
    const used = await client.generateCode(STUDENT_CARD_ID);
    state.validate(used.code.id);
    expect(tripsLeft(await client.getCard(STUDENT_CARD_ID))).toBe(34);

    state.midnight();
    const after = await client.listCodes();
    expect(isUsable(after.find((c) => c.id === code.id)!, state.nowSec())).toBe(false);
    expect(tripsLeft(await client.getCard(STUDENT_CARD_ID))).toBe(35); // only the unused one came back
    expect((await client.feed(STUDENT_CARD_ID))[0]).toMatchObject({ type: FEED_EVENT_TYPE.qrExpired });
  });

  it('refuses generation on a blocked or empty card', async () => {
    const { client, state } = await start();
    state.patchCard(STUDENT_CARD_ID, { blocked: true });
    expect(canGenerate(await client.getCard(STUDENT_CARD_ID))).toBe(false);
    expect((await kyivError(client.generateCode(STUDENT_CARD_ID))).kind).toBe('rejected');

    state.patchCard(STUDENT_CARD_ID, { blocked: false, trips: 0 });
    const err = await kyivError(client.generateCode(STUDENT_CARD_ID));
    expect(err.kind).toBe('rejected');
    expect(err.details.status).toBe(422);
  });
});

describe('KyivClient ↔ mock: auth', () => {
  it('maps 401 for unknown, revoked, expired and device-mismatched tokens', async () => {
    const e = await start();
    const dev = e.state.devToken;

    e.setCredentials({ accessToken: 'nope', deviceUuid: dev.deviceUuid });
    expect((await kyivError(e.client.listCards())).kind).toBe('unauthorized');

    e.setCredentials({ accessToken: dev.token, deviceUuid: crypto.randomUUID() });
    expect((await kyivError(e.client.listCards())).kind).toBe('unauthorized');

    const short = e.state.issueToken({ exp: e.state.nowSec() + 60 });
    e.setCredentials({ accessToken: short.token, deviceUuid: short.deviceUuid });
    await e.client.listCards();
    e.state.advance(61);
    expect((await kyivError(e.client.listCards())).kind).toBe('unauthorized');

    e.setCredentials({ accessToken: dev.token, deviceUuid: dev.deviceUuid });
    dev.revoked = true;
    expect((await kyivError(e.client.listCards())).kind).toBe('unauthorized');
  });

  it('treats 423 (challenge) as unauthorized', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: '423', remaining: 1 });
    expect((await kyivError(client.listCards())).kind).toBe('unauthorized');
  });

  it('fails fast without credentials', async () => {
    const e = await start();
    e.setCredentials(null);
    expect((await kyivError(e.client.listCards())).kind).toBe('no_credentials');
    expect(e.mock.requests).toHaveLength(0);
  });

  it('accepts one-off credentials for validation before saving', async () => {
    const e = await start();
    e.setCredentials(null);
    const t = e.state.issueToken();
    const { cards } = await e.client.listCards({ accessToken: t.token, deviceUuid: t.deviceUuid });
    expect(cards).toHaveLength(1);
  });
});

describe('KyivClient ↔ mock: failures and retries', () => {
  it('retries GET on 503 and succeeds', async () => {
    const { client, mock, sleeps } = await start();
    mock.addFault({ kind: '503', remaining: 2 });
    await expect(client.listCodes()).resolves.toEqual([]);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up on GET after the retry budget', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: '500', remaining: 5 });
    const err = await kyivError(client.listCodes());
    expect(err.kind).toBe('unavailable');
    expect(err.details.ambiguous).toBe(false);
    expect(mock.requests).toHaveLength(3);
  });

  it('never retries generate, and flags the outcome as ambiguous', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: '503', remaining: 1, method: 'POST' });
    const err = await kyivError(client.generateCode(STUDENT_CARD_ID));
    expect(err).toMatchObject({ kind: 'unavailable', details: { ambiguous: true } });
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('times out a hanging request', async () => {
    const { client, mock } = await start({ timeoutMs: 150 });
    mock.addFault({ kind: 'timeout', remaining: 1, method: 'POST' });
    const err = await kyivError(client.generateCode(STUDENT_CARD_ID));
    expect(err).toMatchObject({ kind: 'unavailable', details: { ambiguous: true } });
  });

  it('treats a dropped connection as unavailable and retries GETs', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: 'drop', remaining: 1 });
    await expect(client.listCards()).resolves.toBeDefined();
  });

  it('waits out a 429 on GET once, honouring Retry-After', async () => {
    const { client, mock, sleeps } = await start();
    mock.addFault({ kind: '429', remaining: 1 });
    await client.listCards();
    expect(sleeps).toEqual([1000]);
  });

  it('does not retry 429 on generate', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: '429', remaining: 1, method: 'POST' });
    expect((await kyivError(client.generateCode(STUDENT_CARD_ID))).kind).toBe('rate_limited');
  });

  it('rejects a response with an unexpected shape', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: 'shape', remaining: 1 });
    expect((await kyivError(client.listCards())).kind).toBe('shape');
  });

  it('only fires faults on matching paths', async () => {
    const { client, mock } = await start();
    mock.addFault({ kind: '401', remaining: 1, path: '/feed' });
    await client.listCards();
    expect((await kyivError(client.feed(STUDENT_CARD_ID))).kind).toBe('unauthorized');
    await client.feed(STUDENT_CARD_ID); // fault consumed
  });
});

describe('mock envelope strictness', () => {
  it('rejects a generate that sends Content-Type or a body', async () => {
    const { url, state } = await start();
    const headers = envelopeHeaders({ accessToken: state.devToken.token, deviceUuid: state.devToken.deviceUuid }, { json: true });
    const res = await fetch(`${url}/api/v4/card/travel/${STUDENT_CARD_ID}/qr-ticket`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(400);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain('Content-Type');
    expect(message).toContain('empty body');
  });

  it('rejects a request without X-Client-Auth', async () => {
    const { url, state } = await start();
    const headers = envelopeHeaders({ accessToken: state.devToken.token, deviceUuid: state.devToken.deviceUuid });
    delete headers['X-Client-Auth'];
    expect((await fetch(`${url}/api/v4/qr`, { headers })).status).toBe(400);
  });
});

describe('envelope helpers', () => {
  it('decodes the mock JWT and builds the User-Agent from sub', async () => {
    const { state } = await start();
    const claims = decodeJwtClaims(state.devToken.token)!;
    expect(claims.sub).toBe(String(DEV_USER_ID));
    expect(claims.exp).toBe(state.devToken.exp);
    expect(jwtSubject('not-a-jwt')).toBe('me');
    const h = envelopeHeaders({ accessToken: state.devToken.token, deviceUuid: 'u' });
    expect(h['User-Agent']).toBe(`KD/4.0.0 Android/11 User/${DEV_USER_ID}`);
    expect(h['Content-Type']).toBeUndefined();
  });

  it('keeps the dev token stable across mock restarts', async () => {
    const a = (await start()).state.devToken.token;
    await env!.close();
    const b = (await start()).state.devToken.token;
    expect(a).toBe(b);
  });
});

describe('RateLimiter', () => {
  it('allows N per window and waits for the oldest slot to free', async () => {
    let now = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(
      () => 2,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await rl.acquire();
    now = 10_000;
    await rl.acquire();
    await rl.acquire(); // must wait until t=60_000
    expect(waits).toEqual([50_000]);
    expect(now).toBe(60_000);
  });
});
