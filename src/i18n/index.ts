import type { Locale, UserRow } from '../db/schema.js';
import { esc } from '../core/html.js';
import { en } from './en.js';
import { uk, type Messages } from './uk.js';

export type { Messages };

const MESSAGES: Record<Locale, Messages> = { uk, en };

export function messages(locale: Locale): Messages {
  return MESSAGES[locale];
}

/** HTML-escaped human label: "First Last (@username)" or the numeric id. */
export function displayName(u: Pick<UserRow, 'tgId' | 'firstName' | 'lastName' | 'username'>): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  const handle = u.username ? `@${u.username}` : '';
  if (name && handle) return `${esc(name)} (${esc(handle)})`;
  return esc(name || handle || String(u.tgId));
}
