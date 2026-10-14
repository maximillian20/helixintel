const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€',
};

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

/**
 * Publisher text as plain text. Some feeds (for example The Guardian) put HTML, sometimes entity-escaped, in the summary.
 * Tags are removed, entities decoded, "Continue reading…" links dropped and whitespace collapsed. The result is never HTML.
 */
export function plainText(value: string): string {
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|li|div|h\d|ul|ol|blockquote)>|<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
    text = decodeEntities(text);
    if (!/[<>]/.test(text)) break;
  }
  return text.replace(/\bContinue reading(…|\.\.\.)?\s*$/i, '').replace(/\s+/g, ' ').trim();
}
