import { InlineKeyboard, Keyboard } from 'grammy';
import type { ReplyKeyboardRemove } from 'grammy/types';
import type { Messages } from '../i18n/index.js';

/** Persistent keyboard for users and admins. */
export function mainKeyboard(t: Messages) {
  return new Keyboard().text(t.keyboard.qr).resized().persistent();
}

export const removeKeyboard: ReplyKeyboardRemove = { remove_keyboard: true };

export function langKeyboard() {
  return new InlineKeyboard().text('🇺🇦 Українська', 'lang:uk').text('🇬🇧 English', 'lang:en');
}

export function requestKeyboard(t: Messages, tgId: number) {
  return new InlineKeyboard()
    .text(t.admin.btnGrant, `rq:g:${tgId}`)
    .row()
    .text(t.admin.btnBan, `rq:b:${tgId}`)
    .text(t.admin.btnIgnore, `rq:i:${tgId}`);
}
