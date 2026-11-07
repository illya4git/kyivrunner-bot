/** Escape text for Telegram parse_mode=HTML. */
export function esc(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
