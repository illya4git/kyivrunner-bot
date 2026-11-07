import { describe, expect, it } from 'vitest';
import { ADMIN_ID, makeServices } from './helpers/services.js';

describe('SettingsService', () => {
  it('returns defaults, persists and validates', () => {
    const { settings } = makeServices();
    expect(settings.get('default_daily_quota')).toBe(2);
    expect(settings.get('paused')).toBe(false);
    expect(settings.get('active_card_id')).toBeNull();

    const q = settings.parse('default_daily_quota', '3');
    expect(q).toEqual({ ok: true, value: 3 });
    settings.set('default_daily_quota', 3, ADMIN_ID);
    expect(settings.get('default_daily_quota')).toBe(3);

    expect(settings.parse('default_daily_quota', '-1').ok).toBe(false);
    expect(settings.parse('default_daily_quota', '').ok).toBe(false);
    expect(settings.parse('paused', 'yes')).toEqual({ ok: true, value: true });
    expect(settings.parse('active_card_id', 'null')).toEqual({ ok: true, value: null });
  });
});

describe('AccessService', () => {
  it('creates bootstrap admins and new users as guests with a locale', () => {
    const { access } = makeServices();
    expect(access.get(ADMIN_ID)?.role).toBe('admin');
    const u = access.touch({ id: 5, first_name: 'Olena', language_code: 'uk' });
    expect(u.role).toBe('guest');
    expect(u.locale).toBe('uk');
    expect(access.touch({ id: 6, language_code: 'de' }).locale).toBe('en');
  });

  it('keeps a manually chosen locale', () => {
    const { access } = makeServices();
    access.touch({ id: 5, language_code: 'uk' });
    access.setLocale(5, 'en');
    expect(access.touch({ id: 5, language_code: 'uk' }).locale).toBe('en');
  });

  it('protects bootstrap and last admins', () => {
    const { access } = makeServices();
    expect(access.setRole(ADMIN_ID, 'guest', ADMIN_ID)).toEqual({ ok: false, reason: 'bootstrap' });

    access.touch({ id: 7 });
    expect(access.setRole(7, 'admin', ADMIN_ID).ok).toBe(true);
    expect(access.setRole(7, 'admin', ADMIN_ID)).toEqual({ ok: false, reason: 'unchanged' });
    expect(access.setRole(7, 'user', ADMIN_ID).ok).toBe(true); // two admins → fine
  });

  it('refuses to demote the last admin', () => {
    const { access, db } = makeServices({ adminIds: [] });
    access.touch({ id: 7 });
    access.setRole(7, 'admin', null);
    expect(access.setRole(7, 'user', 7)).toEqual({ ok: false, reason: 'last_admin' });
    void db;
  });

  it('runs the access request flow with cooldown', () => {
    const { access, clock, audit } = makeServices();
    access.touch({ id: 5 });
    expect(access.requestAccess(5)).toEqual({ status: 'requested' });
    expect(access.requestAccess(5)).toEqual({ status: 'pending' });
    expect(access.pendingRequests().map((u) => u.tgId)).toEqual([5]);

    expect(access.resolveRequest(5, 'ignore', ADMIN_ID).ok).toBe(true);
    expect(access.resolveRequest(5, 'grant', ADMIN_ID)).toEqual({ ok: false, reason: 'not_pending' });
    const r = access.requestAccess(5);
    expect(r.status).toBe('cooldown');

    clock.advance(24 * 3_600_000 + 1);
    expect(access.requestAccess(5)).toEqual({ status: 'requested' });
    const granted = access.resolveRequest(5, 'grant', ADMIN_ID);
    expect(granted.ok && granted.user.role).toBe('user');
    expect(access.requestAccess(5)).toEqual({ status: 'has_access' });

    const kinds = audit.recent({ tgId: 5, limit: 50 }).map((e) => e.kind);
    expect(kinds).toContain('access_requested');
    expect(kinds).toContain('access_request_ignored');
    expect(kinds).toContain('role_changed');
  });

  it('resolves users by id or @username and computes quotas', () => {
    const { access, settings } = makeServices();
    access.touch({ id: 9, username: 'Petro' });
    expect(access.findByRef('@petro')?.tgId).toBe(9);
    expect(access.findByRef('9')?.tgId).toBe(9);
    expect(access.findByRef('@nobody')).toBeUndefined();

    const u = access.get(9)!;
    expect(access.effectiveQuota(u)).toBe(settings.get('default_daily_quota'));
    expect(access.effectiveQuota(access.setQuota(9, 5, ADMIN_ID)!)).toBe(5);
  });
});
