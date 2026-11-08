import { afterEach, describe, expect, it } from 'vitest';
import { looksLikeJwt, maskSecret, open, redactJwts, seal } from '../src/core/crypto.js';
import { silentLogger } from '../src/core/logger.js';
import { openDb } from '../src/db/client.js';
import { isKyivError } from '../src/kyiv/errors.js';
import { buildServices } from '../src/services/index.js';
import { MOCK_CLIENT_AUTH } from '../src/kyiv/envelope.js';
import { MockKyivServer } from '../mock/server.js';
import { PUPIL_CARD_ID, STUDENT_CARD_ID } from '../mock/fixtures.js';
import { ADMIN_ID, FakeClock, TEST_KEY, makeServices } from './helpers/services.js';
import { makeTestBot } from './helpers/telegram.js';

const DAY = 86_400_000;
let mock: MockKyivServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

/** Services wired to a fresh mock. The FakeClock is aligned with the mock's real clock. */
async function setup() {
  mock = new MockKyivServer();
  mock.state.nightlyMaintenance = false; // real clock
  const url = await mock.listen();
  const s = makeServices({ kyivUrl: url, clock: new FakeClock(Date.now()) });
  const dev = mock.state.devToken;
  return { ...s, mock, dev, devCreds: { accessToken: dev.token, deviceUuid: dev.deviceUuid } };
}

describe('crypto helpers', () => {
  it('seals and opens; a wrong key fails', () => {
    const sealed = seal(TEST_KEY, 'secret');
    expect(sealed.enc.toString('utf8')).not.toContain('secret');
    expect(open(TEST_KEY, sealed)).toBe('secret');
    expect(() => open(Buffer.alloc(32, 1), sealed)).toThrow();
  });
  it('detects, redacts and masks tokens', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl';
    expect(looksLikeJwt(`token: ${jwt}`)).toBe(true);
    expect(looksLikeJwt('hello')).toBe(false);
    expect(redactJwts(`/credentials set ${jwt} x`)).toBe('/credentials set [jwt] x');
    expect(maskSecret(jwt)).toBe('eyJhbG…dHVy'.slice(0, 7) + jwt.slice(-4));
  });
});

describe('CredentialService', () => {
  it('validates token format and expiry', async () => {
    const { credentials, dev, mock: m } = await setup();
    expect(credentials.checkToken('nope')).toEqual({ ok: false, reason: 'format' });
    expect(credentials.checkToken(dev.token)).toMatchObject({ ok: true, exp: dev.exp * 1000, sub: String(dev.sub) });
    const old = m.state.issueToken({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(credentials.checkToken(old.token)).toEqual({ ok: false, reason: 'expired' });
    expect(credentials.checkDeviceUuid(dev.deviceUuid)).toBe(true);
    expect(credentials.checkDeviceUuid('123')).toBe(false);
  });

  it('stores the token encrypted and serves it while healthy', async () => {
    const { credentials, devCreds, db } = await setup();
    expect(credentials.health().state).toBe('missing');
    expect(credentials.usable()).toBeNull();

    credentials.save(devCreds, ADMIN_ID);
    expect(credentials.health()).toMatchObject({ state: 'ok', maskedToken: maskSecret(devCreds.accessToken) });
    expect(credentials.usable()).toEqual(devCreds);

    const raw = JSON.stringify(db.$client.prepare('SELECT * FROM credentials').all());
    expect(raw).not.toContain(devCreds.accessToken.split('.')[2]);
  });

  it('turns invalid on a 401, alerts once, blocks use, and recovers on recheck', async () => {
    const { credentials, kyiv, devCreds, dev } = await setup();
    credentials.save(devCreds, ADMIN_ID);
    const invalid: string[] = [];
    let restored = 0;
    credentials.on('invalid', ({ reason }) => invalid.push(reason));
    credentials.on('restored', () => restored++);

    dev.revoked = true;
    await expect(kyiv.listCodes()).rejects.toSatisfy((e) => isKyivError(e, 'unauthorized'));
    expect(credentials.health().state).toBe('invalid');
    expect(invalid).toHaveLength(1);
    // no more calls with a known-bad token
    await expect(kyiv.listCodes()).rejects.toSatisfy((e) => isKyivError(e, 'no_credentials'));
    await expect(credentials.recheck(ADMIN_ID)).rejects.toSatisfy((e) => isKyivError(e, 'unauthorized'));
    expect(invalid).toHaveLength(1);

    dev.revoked = false;
    await credentials.recheck(ADMIN_ID);
    expect(credentials.health().state).toBe('ok');
    expect(restored).toBe(1);
  });

  it('warns once per expiry threshold, then reports expired', async () => {
    const { credentials, mock: m, clock } = await setup();
    const t = m.state.issueToken({ exp: Math.floor(clock.now() / 1000) + 10 * 86_400 });
    credentials.save({ accessToken: t.token, deviceUuid: t.deviceUuid }, ADMIN_ID);
    const warnings: number[] = [];
    credentials.on('expiring', ({ daysLeft }) => warnings.push(daysLeft));

    expect(credentials.health().state).toBe('expiring');
    expect(credentials.checkExpiry()).toBe(14);
    expect(credentials.checkExpiry()).toBeNull();
    clock.advance(4 * DAY);
    expect(credentials.checkExpiry()).toBe(7);
    clock.advance(6 * DAY + 1);
    expect(credentials.health().state).toBe('expired');
    expect(credentials.usable()).toBeNull();
    expect(credentials.checkExpiry()).toBe(0);
    expect(warnings).toEqual([10, 6, 0]);
  });

  it('reports undecryptable credentials after an ENCRYPTION_KEY change', async () => {
    const db = openDb(':memory:');
    const base = { db, clock: new FakeClock(), log: silentLogger, adminIds: [ADMIN_ID], kyivBaseUrl: 'http://127.0.0.1:9', kyivClientAuth: MOCK_CLIENT_AUTH };
    const a = buildServices({ ...base, encryptionKey: TEST_KEY });
    a.credentials.save({ accessToken: 'eyJhbGciOi.eyJzdWIiOiIxIn0.c2ln', deviceUuid: crypto.randomUUID() }, ADMIN_ID);
    const b = buildServices({ ...base, encryptionKey: Buffer.alloc(32, 9) });
    expect(b.credentials.usable()).toBeNull();
    expect(b.credentials.health()).toMatchObject({ state: 'invalid', lastError: expect.stringContaining('ENCRYPTION_KEY') });
  });
});

describe('bot: credential entry', () => {
  const admin = { id: ADMIN_ID, first_name: 'Admin', language_code: 'en' };

  async function botSetup() {
    const s = await setup();
    const t = makeTestBot(s);
    return { ...s, ...t };
  }

  it('walks token → uuid → probe → save, deleting both secrets and auto-picking the only card', async () => {
    const s = await botSetup();
    await s.text(admin, '/credentials set');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('access token');

    await s.text(admin, s.dev.token);
    let batch = s.take();
    expect(batch.filter((c) => c.method === 'deleteMessage')).toHaveLength(1);
    expect(s.textsTo(ADMIN_ID, batch)[0]).toContain('device UUID');

    await s.text(admin, s.dev.deviceUuid);
    batch = s.take();
    expect(batch.filter((c) => c.method === 'deleteMessage')).toHaveLength(1);
    const texts = s.textsTo(ADMIN_ID, batch);
    expect(texts.some((x) => x.includes('Credentials saved. Cards on the account: 1'))).toBe(true);
    expect(texts.some((x) => x.includes('Active card'))).toBe(true);

    expect(s.credentials.health().state).toBe('ok');
    expect(s.settings.get('active_card_id')).toBe(STUDENT_CARD_ID);
    // nothing secret reached the audit log or any outgoing message
    const secret = s.dev.token.split('.')[2]!;
    expect(JSON.stringify(s.db.$client.prepare('SELECT * FROM events').all())).not.toContain(secret);
    expect(JSON.stringify(s.calls)).not.toContain(secret);
  });

  it('re-asks on malformed input and stops on a rejected pair', async () => {
    const s = await botSetup();
    await s.text(admin, '/credentials set');
    await s.text(admin, 'not a token');
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('does not look like a JWT');

    await s.text(admin, s.dev.token);
    await s.text(admin, 'not-a-uuid');
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('does not look like a UUID');

    await s.text(admin, crypto.randomUUID()); // wrong device → 401
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('rejected this token');
    expect(s.credentials.health().state).toBe('missing');

    // flow is over: plain text is just text again
    await s.text(admin, 'hello');
    expect(s.textsTo(ADMIN_ID, s.take())[0]).toContain('Unknown command');
  });

  it('lets the admin retry the UUID when Kyiv Digital is down', async () => {
    const s = await botSetup();
    await s.text(admin, '/credentials set');
    await s.text(admin, s.dev.token);
    s.mock.addFault({ kind: '503', remaining: 1 });
    await s.text(admin, s.dev.deviceUuid);
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('Could not verify');
    await s.text(admin, s.dev.deviceUuid);
    expect(s.credentials.health().state).toBe('ok');
  });

  it('/cancel ends the flow', async () => {
    const s = await botSetup();
    await s.text(admin, '/credentials set');
    await s.text(admin, '/cancel');
    s.take();
    await s.text(admin, s.dev.token); // now caught by the guard instead
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('looked like a token');
    expect(s.credentials.health().state).toBe('missing');
  });

  it('deletes tokens pasted anywhere else, by anyone, and redacts them from the log', async () => {
    const s = await botSetup();
    const user = { id: 77, first_name: 'U' };
    await s.text(user, `here: ${s.dev.token}`);
    let batch = s.take();
    expect(batch.some((c) => c.method === 'deleteMessage')).toBe(true);
    expect(s.textsTo(77, batch)[0]).toContain('looked like a token');

    await s.text(admin, `/credentials set ${s.dev.token}`);
    batch = s.take();
    expect(batch.some((c) => c.method === 'deleteMessage')).toBe(true);
    const logged = s.audit.recent({ tgId: ADMIN_ID, kind: 'interaction', limit: 1 })[0]!;
    expect(logged.data).toEqual({ type: 'command', text: '/credentials set [jwt]' });
  });

  it('is admin-only', async () => {
    const s = await botSetup();
    s.access.touch({ id: 5 });
    s.access.setRole(5, 'user', ADMIN_ID);
    await s.text({ id: 5 }, '/credentials');
    expect(s.textsTo(5, s.take())[0]).toContain('🔒');
  });
});

describe('bot: /card and alerts', () => {
  const admin = { id: ADMIN_ID, first_name: 'Admin', language_code: 'en' };

  it('shows live card status', async () => {
    const s = await setup();
    const b = makeTestBot(s);
    s.credentials.save(s.devCreds, ADMIN_ID);
    s.settings.set('active_card_id', STUDENT_CARD_ID, ADMIN_ID);
    s.mock.state.generate(STUDENT_CARD_ID);

    await b.text(admin, '/card');
    const text = b.textsTo(ADMIN_ID, b.take())[0]!;
    expect(text).toContain('Студентський');
    expect(text).toContain('Trips left: <b>35</b>');
    expect(text).toContain('Active QR tickets: 1');
    expect(text).toContain('✅ available');
    expect(text).toMatch(/API limit: \d+\/60/);
  });

  it('asks to pick a card when the account has several', async () => {
    const s = await setup();
    const b = makeTestBot(s);
    s.mock.state.addCard({ id: PUPIL_CARD_ID, name: 'Учнівський', type: 1, code: '300003799999', trips: 20 });
    s.credentials.save(s.devCreds, ADMIN_ID);

    await b.text(admin, '/card');
    const picker = b.take().find((c) => c.method === 'sendMessage')!;
    expect(JSON.stringify(picker.payload.reply_markup)).toContain(`cp:${PUPIL_CARD_ID}`);

    await b.press(admin, `cp:${PUPIL_CARD_ID}`);
    expect(s.settings.get('active_card_id')).toBe(PUPIL_CARD_ID);
    expect(b.textsTo(ADMIN_ID, b.take()).join()).toContain('Учнівський');
  });

  it('alerts every admin once when the token gets rejected', async () => {
    const s = await setup();
    const b = makeTestBot(s);
    s.access.touch({ id: 2000 });
    s.access.setRole(2000, 'admin', ADMIN_ID);
    s.credentials.save(s.devCreds, ADMIN_ID);
    s.settings.set('active_card_id', STUDENT_CARD_ID, ADMIN_ID);

    s.dev.revoked = true;
    await b.text(admin, '/card');
    await new Promise((r) => setTimeout(r, 10)); // alerts are fire-and-forget
    const batch = b.take();
    for (const id of [ADMIN_ID, 2000]) {
      expect(b.textsTo(id, batch).filter((x) => x.startsWith('🚨'))).toHaveLength(1);
    }
    // the admin who ran /card also gets the plain error as the command's answer
    expect(b.textsTo(ADMIN_ID, batch)).toContain('⛔ Kyiv Digital rejected the token.');

    await b.text(admin, '/card');
    expect(b.textsTo(ADMIN_ID, b.take())[0]).toContain('rejected by Kyiv Digital');
  });
});
