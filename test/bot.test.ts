import { describe, expect, it } from 'vitest';
import { ADMIN_ID, makeServices } from './helpers/services.js';
import { makeTestBot } from './helpers/telegram.js';

const admin = { id: ADMIN_ID, first_name: 'Admin', language_code: 'en' };
const guest = { id: 5, first_name: 'Olena', username: 'olena', language_code: 'uk' };

function setup() {
  const services = makeServices();
  const t = makeTestBot(services);
  return { ...services, ...t };
}

describe('bot: guests', () => {
  it('greets a guest with their id and denies other commands', async () => {
    const s = setup();
    await s.text(guest, '/start');
    expect(s.textsTo(guest.id, s.take())[0]).toContain('<code>5</code>');

    await s.text(guest, '/qr');
    expect(s.textsTo(guest.id, s.take())[0]).toContain('/request');
    expect(s.audit.recent({ tgId: guest.id, kind: 'denied' })).toHaveLength(1);
    // every update is logged
    expect(s.audit.recent({ tgId: guest.id, kind: 'interaction' })).toHaveLength(2);
  });

  it('logs free text by length only', async () => {
    const s = setup();
    await s.text(guest, 'eyJsecret-looking-token');
    const ev = s.audit.recent({ tgId: guest.id, kind: 'interaction' })[0]!;
    expect(ev.data).toEqual({ type: 'text', len: 23 });
  });
});

describe('bot: access requests', () => {
  it('notifies admins on /request and grants via button', async () => {
    const s = setup();
    await s.text(admin, '/start');
    await s.text(guest, '/request');
    let batch = s.take();
    const notice = batch.find((c) => c.method === 'sendMessage' && c.payload.chat_id === ADMIN_ID && String(c.payload.text).includes('Access request'));
    expect(notice).toBeDefined();
    expect(JSON.stringify(notice!.payload.reply_markup)).toContain(`rq:g:${guest.id}`);
    expect(s.textsTo(guest.id, batch)[0]).toContain('📨');

    await s.press(admin, `rq:g:${guest.id}`, 'Access request');
    batch = s.take();
    expect(s.access.get(guest.id)?.role).toBe('user');
    expect(s.textsTo(guest.id, batch)[0]).toContain('🎉'); // in Ukrainian, with the keyboard
    expect(batch.some((c) => c.method === 'setMyCommands' && JSON.stringify(c.payload.scope).includes(String(guest.id)))).toBe(true);

    // a second press (e.g. another admin) is reported as already handled
    await s.press(admin, `rq:g:${guest.id}`);
    batch = s.take();
    expect(batch.find((c) => c.method === 'answerCallbackQuery')?.payload.show_alert).toBe(true);
  });

  it('does not let users press admin buttons', async () => {
    const s = setup();
    s.access.touch(guest);
    s.access.setRole(guest.id, 'user', ADMIN_ID);
    await s.press(guest, `ur:${guest.id}:admin`);
    expect(s.access.get(guest.id)?.role).toBe('user');
    expect(s.audit.recent({ tgId: guest.id, kind: 'denied' })).toHaveLength(1);
  });
});

describe('bot: admin user management', () => {
  it('/grant by @username, /quota and /revoke', async () => {
    const s = setup();
    await s.text(guest, '/start');
    await s.text(admin, '/grant @olena');
    expect(s.access.get(guest.id)?.role).toBe('user');

    await s.text(admin, '/quota @olena 4');
    expect(s.access.get(guest.id)?.dailyQuota).toBe(4);
    await s.text(admin, '/quota @olena default');
    expect(s.access.get(guest.id)?.dailyQuota).toBeNull();

    s.take();
    await s.text(admin, '/revoke 5');
    const batch = s.take();
    expect(s.access.get(guest.id)?.role).toBe('guest');
    expect(batch.some((c) => c.method === 'deleteMyCommands')).toBe(true);
  });

  it('/grant with an unknown numeric id pre-creates the user', async () => {
    const s = setup();
    await s.text(admin, '/grant 777 admin');
    expect(s.access.get(777)?.role).toBe('admin');
  });

  it('refuses to demote a bootstrap admin', async () => {
    const s = setup();
    await s.text(admin, `/revoke ${ADMIN_ID}`);
    expect(s.textsTo(ADMIN_ID, s.take()).join()).toContain('ADMIN_IDS');
    expect(s.access.get(ADMIN_ID)?.role).toBe('admin');
  });

  it('browses users and changes a role from the card', async () => {
    const s = setup();
    await s.text(guest, '/start');
    s.take();
    await s.text(admin, '/users');
    const list = s.take().find((c) => c.method === 'sendMessage')!;
    expect(JSON.stringify(list.payload.reply_markup)).toContain(`uv:${guest.id}`);

    await s.press(admin, `ur:${guest.id}:banned`);
    expect(s.access.get(guest.id)?.role).toBe('banned');

    // banned users are ignored but still logged
    s.take();
    await s.text(guest, '/start');
    expect(s.take()).toHaveLength(0);
    expect(s.audit.recent({ tgId: guest.id, kind: 'interaction', limit: 1 })[0]?.roleAtTime).toBe('banned');
  });

  it('tells users that admin commands are admin-only', async () => {
    const s = setup();
    s.access.touch(guest);
    s.access.setRole(guest.id, 'user', ADMIN_ID);
    await s.text(guest, '/users');
    expect(s.textsTo(guest.id, s.take())[0]).toContain('🔒');
  });
});

describe('bot: language', () => {
  it('switches language with /lang and keeps it', async () => {
    const s = setup();
    await s.text(guest, '/lang en');
    expect(s.textsTo(guest.id, s.take())[0]).toContain('English');
    await s.text(guest, '/whoami');
    expect(s.textsTo(guest.id, s.take())[0]).toContain('Role: guest');
  });
});

describe('bot: groups', () => {
  it('ignores group chats without creating users', async () => {
    const s = setup();
    await s.bot.handleUpdate({
      update_id: 999,
      message: { message_id: 1, date: 0, chat: { id: -100, type: 'group', title: 'g' }, from: { id: 55, is_bot: false, first_name: 'G' }, text: '/start' },
    });
    expect(s.access.get(55)).toBeUndefined();
    expect(s.take()).toHaveLength(0);
    expect(s.audit.recent({ tgId: 55 })[0]?.data).toMatchObject({ chat: 'group' });
  });
});
