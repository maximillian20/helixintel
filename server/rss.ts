import { XMLParser } from 'fast-xml-parser';
import type { NormalizedArticle, SourceDefinition } from './source-store';
import { plainText } from './text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});
const maxFeedBytes = 2 * 1024 * 1024;
const maxAttempts = 3;

export type FetchCheckpoint = {
  etag: string | null;
  lastModified: string | null;
};

export type FetchRssResult = {
  notModified: boolean;
  articles: NormalizedArticle[];
  etag: string | null;
  lastModified: string | null;
};

export class SourceFetchError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

export function textValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as { '#text': unknown })['#text'] ?? '').trim();
  }
  return '';
}

function linkValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const links = value as Array<Record<string, unknown>>;
    const selected = links.find((link) => link['@_rel'] === 'alternate') ?? links[0];
    return String(selected?.['@_href'] ?? '').trim();
  }
  if (value && typeof value === 'object') {
    const link = value as Record<string, unknown>;
    return String(link['@_href'] ?? link['#text'] ?? '').trim();
  }
  return '';
}

export function canonicalizeArticleUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Article URL must be an HTTP(S) URL without embedded credentials.');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|at_medium|at_campaign|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function dateValue(...values: unknown[]) {
  for (const value of values) {
    const text = textValue(value);
    if (!text) continue;
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

export function parseRssArticles(xml: string, source: SourceDefinition): NormalizedArticle[] {
  if (Buffer.byteLength(xml, 'utf8') > maxFeedBytes) throw new Error('Feed exceeds the 2 MB size limit.');
  const document = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown | unknown[] } };
    feed?: { entry?: unknown | unknown[] };
  };
  const rssEntries = document.rss?.channel?.item;
  const atomEntries = document.feed?.entry;
  const entries = rssEntries !== undefined
    ? (Array.isArray(rssEntries) ? rssEntries : [rssEntries])
    : (Array.isArray(atomEntries) ? atomEntries : atomEntries ? [atomEntries] : []);

  return (entries as Array<Record<string, unknown>>).flatMap((entry) => {
    const headline = plainText(textValue(entry.title)).slice(0, 500);
    const mediaGroup = entry['media:group'] as Record<string, unknown> | undefined;
    const summary = plainText(textValue(entry.description ?? entry.summary ?? entry.content ?? mediaGroup?.['media:description'])).slice(0, 4000);
    const rawUrl = linkValue(entry.link) || textValue(entry.guid ?? entry.id);
    const publishedAt = dateValue(entry.pubDate, entry.published, entry.date, entry.updated);
    if (!headline || !rawUrl || !publishedAt) return [];

    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeArticleUrl(rawUrl);
    } catch {
      return [];
    }

    return [{
      sourceRecordId: textValue(entry.guid ?? entry.id) || canonicalUrl,
      canonicalUrl,
      headline,
      summary,
      publishedAt,
      sourceModifiedAt: dateValue(entry.updated, entry.modified),
    }];
  });
}

export async function readBoundedBody(response: Response, maxBytes = maxFeedBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SourceFetchError(`Feed exceeds the ${Math.round(maxBytes / 1048576)} MB size limit.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new SourceFetchError(`Feed exceeds the ${Math.round(maxBytes / 1048576)} MB size limit.`);
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function retryAfterMilliseconds(response: Response) {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchRssSource(
  source: SourceDefinition,
  checkpoint: FetchCheckpoint,
  fetcher: typeof fetch = fetch,
): Promise<FetchRssResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers = new Headers({
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; GlobalSecurityIntelligence/0.2; RSS monitor)',
    });
    if (checkpoint.etag) headers.set('if-none-match', checkpoint.etag);
    if (checkpoint.lastModified) headers.set('if-modified-since', checkpoint.lastModified);

    try {
      const response = await fetcher(source.url, { headers, signal: AbortSignal.timeout(25000) });
      const etag = response.headers.get('etag') ?? checkpoint.etag;
      const lastModified = response.headers.get('last-modified') ?? checkpoint.lastModified;
      if (response.status === 304) return { notModified: true, articles: [], etag, lastModified };

      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response);
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxAttempts - 1 && (retryAfterMs === undefined || retryAfterMs <= 5000)) {
          await wait(retryAfterMs ?? 500 * (2 ** attempt));
          continue;
        }
        throw new SourceFetchError(`Source returned HTTP ${response.status}`, retryAfterMs);
      }

      const xml = await readBoundedBody(response);
      return {
        notModified: false,
        articles: parseRssArticles(xml, source),
        etag,
        lastModified,
      };
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      if (attempt === maxAttempts - 1) {
        throw new SourceFetchError(error instanceof Error ? error.message : 'Source request failed.');
      }
      await wait(500 * (2 ** attempt));
    }
  }

  throw new SourceFetchError('Source request failed after bounded retries.');
}
