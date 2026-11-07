/** Tags Telegram accepts with parse_mode=HTML. */
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote', 'tg-emoji']);

/**
 * Approximates Telegram's HTML entity parser: rejects unknown tags, unbalanced tags and
 * bare `&` that isn't a known entity. Returns an error description like Telegram's, or null.
 */
export function telegramHtmlError(text: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([^\s>/]*)[^>]*>|&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)|<(?![/a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === '&') return `can't parse entities: bare & at offset ${m.index}`;
    if (m[0] === '<') return `can't parse entities: unescaped < at offset ${m.index}`;
    const [, closing, rawName] = m;
    const name = rawName!.toLowerCase();
    if (!ALLOWED.has(name)) return `can't parse entities: Unsupported start tag "${rawName}" at byte offset ${m.index}`;
    if (closing) {
      if (stack.pop() !== name) return `can't parse entities: unmatched end tag "${rawName}" at offset ${m.index}`;
    } else {
      stack.push(name);
    }
  }
  return stack.length ? `can't parse entities: unclosed tag "${stack.at(-1)}"` : null;
}
