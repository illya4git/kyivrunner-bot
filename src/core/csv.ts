/** RFC 4180 CSV with a UTF-8 BOM so spreadsheet apps detect the encoding (Cyrillic places). */
export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][]): Buffer {
  const cell = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(cell).join(','));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}
