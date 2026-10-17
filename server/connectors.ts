import { XMLParser } from 'fast-xml-parser';
import { findCountryCodes } from '../src/data/countries';
import { canonicalizeArticleUrl, fetchRssSource, readBoundedBody, retryAfterMilliseconds, SourceFetchError, textValue } from './rss';
import type { FetchCheckpoint } from './rss';
import type { ArticleEnrichment, NormalizedArticle, SourceDefinition } from './source-store';

export type ConnectorContext = {
  fetcher: typeof fetch;
  env: NodeJS.ProcessEnv;
  checkpoint: FetchCheckpoint;
  now: Date;
};

export type ConnectorResult = {
  notModified?: boolean;
  articles: NormalizedArticle[];
  etag?: string | null;
  lastModified?: string | null;
};

const userAgent = 'Mozilla/5.0 (compatible; GlobalSecurityIntelligence/0.2; public-data monitor)';
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

/** Missing credentials mean a connector is "Setup required" and is never called. */
export function missingCredentials(source: SourceDefinition, env: NodeJS.ProcessEnv) {
  return (source.credential?.envVars ?? []).filter((name) => !env[name]?.trim());
}

type HttpOptions = {
  fetcher: typeof fetch;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
  attempts?: number;
  /** Response size cap in bytes (default 2 MB, the feed limit). */
  maxBytes?: number;
};

/** One request with a timeout and bounded exponential backoff on network errors, 429 and 5xx. */
export async function httpText(url: string, options: HttpOptions & { checkpoint?: FetchCheckpoint }) {
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const headers = new Headers({ 'user-agent': userAgent, ...options.headers });
    if (options.checkpoint?.etag) headers.set('if-none-match', options.checkpoint.etag);
    if (options.checkpoint?.lastModified) headers.set('if-modified-since', options.checkpoint.lastModified);
    try {
      const response = await options.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
      });
      const etag = response.headers.get('etag') ?? options.checkpoint?.etag ?? null;
      const lastModified = response.headers.get('last-modified') ?? options.checkpoint?.lastModified ?? null;
      if (response.status === 304) return { notModified: true as const, text: '', etag, lastModified };
      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response);
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < attempts - 1 && (retryAfterMs === undefined || retryAfterMs <= 5000)) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs ?? 500 * (2 ** attempt)));
          continue;
        }
        throw new SourceFetchError(`Source returned HTTP ${response.status}`, retryAfterMs);
      }
      return { notModified: false as const, text: await readBoundedBody(response, options.maxBytes), etag, lastModified };
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      if (attempt === attempts - 1) throw new SourceFetchError(error instanceof Error ? error.message : 'Source request failed.');
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw new SourceFetchError('Source request failed after bounded retries.');
}

function toIso(value: unknown) {
  const text = textValue(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function list<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------- GDACS

const gdacsEventTypes: Record<string, string> = {
  EQ: 'earthquake', TC: 'tropical cyclone', FL: 'flood', VO: 'volcanic activity', DR: 'drought', WF: 'wildfire', TS: 'tsunami',
};
const gdacsSeverity = { Red: 'Critical', Orange: 'High', Green: 'Low' } as const;

function attributeValue(node: unknown, attribute: string) {
  if (node && typeof node === 'object') return String((node as Record<string, unknown>)[`@_${attribute}`] ?? '');
  return '';
}

export function parseGdacs(xml: string): NormalizedArticle[] {
  const channel = (xmlParser.parse(xml) as { rss?: { channel?: { item?: unknown } } }).rss?.channel;
  if (!channel) throw new SourceFetchError('GDACS response was not an RSS feed.');
  const articles: NormalizedArticle[] = [];
  for (const item of list(channel.item) as Array<Record<string, unknown>>) {
    const title = textValue(item.title);
    const publishedAt = toIso(item.pubDate) ?? toIso(item['gdacs:fromdate']);
    const eventType = textValue(item['gdacs:eventtype']);
    const eventId = textValue(item['gdacs:eventid']);
    const rawLink = textValue(item.link);
    if (!title || !publishedAt || (!rawLink && !(eventType && eventId))) continue;

    let canonicalUrl: string;
    try {
      canonicalUrl = eventType && eventId
        ? `https://www.gdacs.org/report.aspx?eventtype=${eventType}&eventid=${eventId}`
        : canonicalizeArticleUrl(new URL(rawLink, 'https://www.gdacs.org/').href);
    } catch {
      continue;
    }

    const level = textValue(item['gdacs:alertlevel']) as keyof typeof gdacsSeverity;
    const score = textValue(item['gdacs:alertscore']);
    const severityText = textValue(item['gdacs:severity']);
    const populationText = textValue(item['gdacs:population']);
    const countryText = textValue(item['gdacs:country']);
    const codes = countryText ? findCountryCodes(countryText) : [];

    const point = item['geo:Point'] as Record<string, unknown> | undefined;
    let lat = Number(textValue(point?.['geo:lat']));
    let lng = Number(textValue(point?.['geo:long']));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !textValue(point?.['geo:lat'])) {
      const [georssLat, georssLng] = textValue(item['georss:point']).split(/\s+/).map(Number);
      lat = georssLat;
      lng = georssLng;
    }
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    const enrichment: ArticleEnrichment = {
      category: gdacsEventTypes[eventType] ?? 'natural hazard',
      ...(codes.length > 0 ? { countryCodes: codes } : {}),
      ...(hasPoint ? { location: { lat, lng, label: countryText ? `${countryText} (event coordinates)` : 'Event coordinates' } } : {}),
    };
    if (level in gdacsSeverity) {
      enrichment.severity = {
        value: gdacsSeverity[level],
        method: 'source',
        reason: `GDACS ${level} alert${score ? ` (alert score ${Number(score).toFixed(2)})` : ''}${severityText ? `; ${severityText}` : ''}${populationText ? `; ${populationText}` : ''}. The alert level is assigned by GDACS (EC Joint Research Centre, UN OCHA), not by this app.`,
      };
    }

    articles.push({
      sourceRecordId: `${eventType}${eventId}` || canonicalUrl,
      canonicalUrl,
      headline: title,
      summary: [textValue(item.description), severityText, populationText].filter(Boolean).join(' — '),
      publishedAt,
      sourceModifiedAt: toIso(item['gdacs:datemodified']) ?? toIso(item['gdacs:dateModified']),
      enrichment,
    });
  }
  return articles;
}

// ---------------------------------------------------------------- CISA KEV

type KevEntry = {
  cveID?: string; vendorProject?: string; product?: string; vulnerabilityName?: string; dateAdded?: string;
  shortDescription?: string; requiredAction?: string; dueDate?: string; knownRansomwareCampaignUse?: string;
};

export function parseKev(text: string, now: Date, windowDays = 90, maxItems = 200): NormalizedArticle[] {
  let catalog: { vulnerabilities?: KevEntry[] };
  try {
    catalog = JSON.parse(text) as { vulnerabilities?: KevEntry[] };
  } catch {
    throw new SourceFetchError('CISA KEV response was not valid JSON.');
  }
  if (!Array.isArray(catalog.vulnerabilities)) throw new SourceFetchError('CISA KEV response had no vulnerabilities list.');
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const articles: NormalizedArticle[] = [];
  for (const entry of catalog.vulnerabilities) {
    if (!entry.cveID || !entry.dateAdded || !/^\d{4}-\d{2}-\d{2}$/.test(entry.dateAdded)) continue;
    // KEV gives a date only; the time of day is unknown, so the date is kept at 00:00 UTC.
    const publishedAt = `${entry.dateAdded}T00:00:00.000Z`;
    if (Date.parse(publishedAt) < cutoff) continue;
    const ransomware = entry.knownRansomwareCampaignUse === 'Known';
    const product = [entry.vendorProject, entry.product].filter(Boolean).join(' ');
    articles.push({
      sourceRecordId: entry.cveID,
      canonicalUrl: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(entry.cveID)}`,
      headline: `${product ? `${product}: ` : ''}${entry.vulnerabilityName ?? 'Known exploited vulnerability'} (${entry.cveID})`,
      summary: [
        entry.shortDescription,
        entry.requiredAction ? `Required action: ${entry.requiredAction}` : '',
        entry.dueDate ? `Federal remediation due: ${entry.dueDate}.` : '',
        ransomware ? 'Known use in ransomware campaigns.' : '',
        `Added to the CISA catalog on ${entry.dateAdded}.`,
      ].filter(Boolean).join(' '),
      publishedAt,
      sourceModifiedAt: null,
      enrichment: {
        category: 'known exploited vulnerability',
        global: true,
        severity: {
          value: ransomware ? 'High' : 'Medium',
          method: 'rules',
          reason: `Listed in CISA's Known Exploited Vulnerabilities catalog, which confirms exploitation in the wild (urgency: high). The catalog does not state how widely the product is used, so scope is unknown: Medium by default, High when ransomware use is known${ransomware ? ' (it is for this entry)' : ''}. Automated rules-based assessment.`,
        },
      },
    });
  }
  return articles
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, maxItems);
}

// ---------------------------------------------------------------- GDELT

const defaultGdeltQuery = 'sourcelang:english (airstrike OR "armed conflict" OR earthquake OR "state of emergency" OR coup OR hostage OR "terror attack" OR cyberattack OR outbreak OR sanctions OR evacuation OR protesters)';

function gdeltDate(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z` : null;
}

export function parseGdelt(text: string): NormalizedArticle[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let payload: { articles?: Array<Record<string, string>> };
  try {
    payload = JSON.parse(trimmed) as { articles?: Array<Record<string, string>> };
  } catch {
    // GDELT answers query errors and throttling with plain text.
    throw new SourceFetchError(`GDELT returned a non-JSON response: ${trimmed.slice(0, 120)}`);
  }
  const seenTitles = new Set<string>();
  const articles: NormalizedArticle[] = [];
  for (const entry of payload.articles ?? []) {
    const title = (entry.title ?? '').replace(/\s+/g, ' ').trim();
    const seen = gdeltDate(entry.seendate ?? '');
    if (!title || !entry.url || !seen) continue;
    let canonicalUrl: string;
    try { canonicalUrl = canonicalizeArticleUrl(entry.url); } catch { continue; }
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue; // syndicated copies of one story
    seenTitles.add(titleKey);
    articles.push({
      sourceRecordId: canonicalUrl,
      canonicalUrl,
      headline: title,
      // GDELT reports when it first saw the article, which can be later than the publisher's own date.
      summary: `Publisher: ${entry.domain ?? 'unknown'}. Time shown is when GDELT first indexed the article.`,
      publishedAt: seen,
      sourceModifiedAt: null,
    });
  }
  return articles;
}

// ---------------------------------------------------------------- ReliefWeb

type ReliefWebReport = {
  fields?: {
    title?: string; url?: string; body?: string;
    date?: { original?: string; created?: string; changed?: string };
    country?: Array<{ name?: string }>;
    source?: Array<{ name?: string }>;
    disaster_type?: Array<{ name?: string }>;
  };
};

export function parseReliefWeb(text: string): NormalizedArticle[] {
  let payload: { data?: ReliefWebReport[] };
  try { payload = JSON.parse(text) as { data?: ReliefWebReport[] }; } catch { throw new SourceFetchError('ReliefWeb response was not valid JSON.'); }
  const articles: NormalizedArticle[] = [];
  for (const entry of payload.data ?? []) {
    const fields = entry.fields;
    const publishedAt = toIso(fields?.date?.original) ?? toIso(fields?.date?.created);
    if (!fields?.title || !fields.url || !publishedAt) continue;
    let canonicalUrl: string;
    try { canonicalUrl = canonicalizeArticleUrl(fields.url); } catch { continue; }
    const countryNames = (fields.country ?? []).map((country) => country.name ?? '').filter(Boolean);
    const sources = (fields.source ?? []).map((source) => source.name ?? '').filter(Boolean);
    const body = (fields.body ?? '').replace(/[#*_>`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 480);
    articles.push({
      sourceRecordId: canonicalUrl,
      canonicalUrl,
      headline: fields.title,
      summary: [body, sources.length ? `Original source: ${sources.join(', ')}.` : ''].filter(Boolean).join(' '),
      publishedAt,
      sourceModifiedAt: toIso(fields.date?.changed),
      enrichment: {
        category: fields.disaster_type?.[0]?.name?.toLowerCase() ?? 'humanitarian report',
        ...(countryNames.length > 0 && findCountryCodes(countryNames.join(', ')).length > 0 ? { countryCodes: findCountryCodes(countryNames.join(', ')) } : {}),
      },
    });
  }
  return articles;
}

// ---------------------------------------------------------------- ACLED

type AcledEvent = {
  event_id_cnty?: string; event_date?: string; event_type?: string; sub_event_type?: string;
  actor1?: string; actor2?: string; country?: string; admin1?: string; location?: string;
  latitude?: string | number; longitude?: string | number; fatalities?: string | number; notes?: string; source?: string;
};

export function parseAcled(text: string): NormalizedArticle[] {
  let payload: { data?: AcledEvent[] };
  try { payload = JSON.parse(text) as { data?: AcledEvent[] }; } catch { throw new SourceFetchError('ACLED response was not valid JSON.'); }
  const articles: NormalizedArticle[] = [];
  for (const event of payload.data ?? []) {
    const publishedAt = toIso(event.event_date);
    if (!event.event_id_cnty || !event.event_type || !publishedAt) continue;
    const place = [event.location, event.admin1, event.country].filter(Boolean).join(', ');
    const fatalities = Number(event.fatalities);
    const lat = Number(event.latitude);
    const lng = Number(event.longitude);
    const codes = event.country ? findCountryCodes(event.country) : [];
    const actors = [event.actor1, event.actor2].filter(Boolean).join(' / ');
    const canonicalUrl = canonicalizeArticleUrl(`https://acleddata.com/?event_id_cnty=${encodeURIComponent(event.event_id_cnty)}`);
    articles.push({
      sourceRecordId: event.event_id_cnty,
      canonicalUrl,
      headline: `${event.sub_event_type || event.event_type}${place ? ` in ${place}` : ''}`,
      summary: [
        event.notes?.replace(/\s+/g, ' ').trim().slice(0, 600),
        actors ? `Actors: ${actors}.` : '',
        Number.isFinite(fatalities) ? `Reported fatalities: ${fatalities}.` : '',
        `ACLED event ${event.event_id_cnty}${event.source ? `; original sources: ${event.source}` : ''}.`,
      ].filter(Boolean).join(' '),
      publishedAt,
      sourceModifiedAt: null,
      enrichment: {
        category: event.event_type.toLowerCase(),
        ...(codes.length > 0 ? { countryCodes: codes } : {}),
        ...(Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) ? { location: { lat, lng, label: place || 'ACLED event location' } } : {}),
      },
    });
  }
  return articles;
}

// ---------------------------------------------------------------- EIA

export function parseEia(text: string): NormalizedArticle[] {
  let payload: { response?: { data?: Array<Record<string, string>> } };
  try { payload = JSON.parse(text) as typeof payload; } catch { throw new SourceFetchError('EIA response was not valid JSON.'); }
  const names: Record<string, string> = { RBRTE: 'Brent crude oil spot price', RWTC: 'WTI crude oil spot price' };
  const articles: NormalizedArticle[] = [];
  for (const row of payload.response?.data ?? []) {
    const series = row.series ?? '';
    if (!names[series] || !/^\d{4}-\d{2}-\d{2}$/.test(row.period ?? '') || row.value === undefined || row.value === null) continue;
    const price = Number(row.value);
    if (!Number.isFinite(price)) continue;
    articles.push({
      sourceRecordId: `${series}:${row.period}`,
      canonicalUrl: `https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=${series}&f=D&period=${row.period}`,
      headline: `${names[series]}: $${price.toFixed(2)} per barrel (${row.period})`,
      summary: `US Energy Information Administration daily spot price for ${row.period}. Market data, not a security event.`,
      // The date is the price date at 00:00 UTC; EIA does not publish a precise release time in this dataset.
      publishedAt: `${row.period}T00:00:00.000Z`,
      sourceModifiedAt: null,
      enrichment: { category: 'energy market data', global: true },
    });
  }
  return articles;
}

// ---------------------------------------------------------------- registry

const MAX_EXTRA_FEEDS = 12;

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')
    || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.startsWith('[');
}

/**
 * Extra feeds the site administrator lists in the EXTRA_FEEDS setting, as JSON: [{"name":"...","url":"https://..."}].
 * They are read like any other RSS/Atom feed (YouTube channel feeds work: https://www.youtube.com/feeds/videos.xml?channel_id=...).
 * Visitors cannot add feeds; only the server setting can, so the server never fetches an address a stranger chose.
 */
export function parseExtraFeeds(raw: string | undefined, pollIntervalMs: number): { sources: SourceDefinition[]; problems: string[] } {
  const problems: string[] = [];
  if (!raw || !raw.trim()) return { sources: [], problems };
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return { sources: [], problems: ['EXTRA_FEEDS is not valid JSON; no extra feeds were added.'] }; }
  if (!Array.isArray(list)) return { sources: [], problems: ['EXTRA_FEEDS must be a JSON list; no extra feeds were added.'] };
  const minutes = Math.round(pollIntervalMs / 60000);
  const sources: SourceDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    if (sources.length >= MAX_EXTRA_FEEDS) { problems.push(`Only the first ${MAX_EXTRA_FEEDS} extra feeds are used.`); break; }
    const name = typeof (entry as { name?: unknown })?.name === 'string' ? (entry as { name: string }).name.trim().slice(0, 60) : '';
    const url = typeof (entry as { url?: unknown })?.url === 'string' ? (entry as { url: string }).url.trim() : '';
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!name || !parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateHost(parsed.hostname)) {
      problems.push(`Extra feed #${index + 1} was skipped: it needs a name and a public https address.`);
      continue;
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `feed-${index + 1}`;
    let id = `extra-${slug}`;
    for (let n = 2; seen.has(id); n += 1) id = `extra-${slug}-${n}`;
    seen.add(id);
    const youtube = parsed.hostname.endsWith('youtube.com');
    sources.push({
      id, name, url: parsed.toString(), format: youtube ? 'Atom (YouTube channel)' : 'RSS / Atom',
      coverage: youtube ? 'Videos published by this YouTube channel (titles and descriptions only; video content is not analysed)' : 'Feed added by the site administrator',
      cadence: `${minutes}-minute polling; 15-minute article cache`,
      attribution: name, termsUrl: youtube ? 'https://www.youtube.com/t/terms' : parsed.origin, connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    });
  }
  return { sources, problems };
}

export function buildSources(pollIntervalMs: number, env: NodeJS.ProcessEnv = process.env): SourceDefinition[] {
  return [...buildBuiltInSources(pollIntervalMs), ...parseExtraFeeds(env.EXTRA_FEEDS, pollIntervalMs).sources];
}

function buildBuiltInSources(pollIntervalMs: number): SourceDefinition[] {
  const minutes = Math.round(pollIntervalMs / 60000);
  const fast = `${minutes}-minute polling`;
  const slowCadence = `${minutes * 2}-minute polling`;
  return [
    {
      id: 'bbc-world', name: 'BBC News World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', format: 'RSS 2.0',
      coverage: 'International news, English-language world desk', cadence: `${fast}; 15-minute article cache`,
      attribution: 'BBC News World', termsUrl: 'https://www.bbc.co.uk/usingthebbc/terms-of-use/#15metadataandrssfeeds',
      connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'un-news', name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', format: 'RSS 2.0',
      coverage: 'Global affairs and United Nations reporting, English-language feed', cadence: `${fast}; 15-minute article cache`,
      attribution: 'UN News', termsUrl: 'https://news.un.org/en/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'aljazeera', name: 'Al Jazeera English', url: 'https://www.aljazeera.com/xml/rss/all.xml', format: 'RSS 2.0',
      coverage: 'International news, English-language, strong Middle East, Africa and Asia coverage', cadence: `${fast}; 15-minute article cache`,
      attribution: 'Al Jazeera English', termsUrl: 'https://www.aljazeera.com/terms/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'guardian-world', name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', format: 'RSS 2.0',
      coverage: 'International news, English-language world desk', cadence: `${fast}; 15-minute article cache`,
      attribution: 'The Guardian', termsUrl: 'https://www.theguardian.com/help/terms-of-service', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'who-news', name: 'WHO News', url: 'https://www.who.int/rss-feeds/news-english.xml', format: 'RSS 2.0',
      coverage: 'Official World Health Organization news and statements, including public-health emergencies and outbreak updates', cadence: `${fast}; 15-minute article cache`,
      attribution: 'World Health Organization', termsUrl: 'https://www.who.int/about/policies/terms-of-use', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'uk-fcdo-travel', name: 'UK Foreign Office travel advice', url: 'https://www.gov.uk/foreign-travel-advice.atom', format: 'Atom',
      coverage: 'Official UK government travel advice updates by country (security, entry rules and local risks)', cadence: `${fast}; 15-minute article cache`,
      attribution: 'UK Foreign, Commonwealth & Development Office', termsUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'us-state-travel', name: 'US State Department travel advisories', url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', format: 'RSS 2.0',
      coverage: 'Official US travel advisories and alerts by country (levels 1 to 4 with risk indicators)', cadence: `${fast}; 15-minute article cache`,
      attribution: 'U.S. Department of State, Bureau of Consular Affairs', termsUrl: 'https://travel.state.gov/content/travel/en/rss.html', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'ncsc-uk', name: 'UK NCSC (National Cyber Security Centre)', url: 'https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml', format: 'RSS 2.0',
      coverage: 'Official UK government cyber security guidance, advisories and news', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'UK National Cyber Security Centre', termsUrl: 'https://www.ncsc.gov.uk/section/about-this-website/terms-and-conditions', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'the-hacker-news', name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', format: 'RSS 2.0',
      coverage: 'Cyber security news: breaches, vulnerabilities, malware and threat actors', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'The Hacker News', termsUrl: 'https://thehackernews.com/p/about-us.html', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'krebs', name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', format: 'RSS 2.0',
      coverage: 'Investigative cyber crime reporting', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'Krebs on Security', termsUrl: 'https://krebsonsecurity.com/about/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'the-record', name: 'The Record (Recorded Future News)', url: 'https://therecord.media/feed', format: 'RSS 2.0',
      coverage: 'Cyber security, cyber crime and state-linked cyber activity news', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'The Record from Recorded Future News', termsUrl: 'https://therecord.media/about', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'schneier', name: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/', format: 'Atom',
      coverage: 'Security and cryptography analysis and commentary', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'Schneier on Security', termsUrl: 'https://www.schneier.com/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'dark-reading', name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml', format: 'RSS 2.0',
      coverage: 'Enterprise cyber security news and analysis', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'Dark Reading', termsUrl: 'https://www.darkreading.com/about-us', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'securityweek', name: 'SecurityWeek', url: 'https://www.securityweek.com/feed/', format: 'RSS 2.0',
      coverage: 'Cyber security news, including industrial control systems and threat reports', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'SecurityWeek', termsUrl: 'https://www.securityweek.com/about-us/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'africanews', name: 'Africanews', url: 'https://www.africanews.com/feed/rss', format: 'RSS 2.0',
      coverage: 'News from across Africa, English-language', cadence: `${fast}; 15-minute article cache`,
      attribution: 'Africanews', termsUrl: 'https://www.africanews.com/terms-and-conditions', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'anadolu-world', name: 'Anadolu Agency (world)', url: 'https://www.aa.com.tr/en/rss/default?cat=world', format: 'RSS 2.0',
      coverage: 'World news with strong coverage of the Middle East, Türkiye, Balkans and Africa', cadence: `${fast}; 15-minute article cache`,
      attribution: 'Anadolu Agency', termsUrl: 'https://www.aa.com.tr/en/p/terms-of-use', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'gcaptain', name: 'gCaptain', url: 'https://gcaptain.com/feed/', format: 'RSS 2.0',
      coverage: 'Maritime, shipping and offshore industry news, including sea-lane disruption', cadence: `${slowCadence}; 15-minute article cache`,
      attribution: 'gCaptain', termsUrl: 'https://gcaptain.com/about/', connector: 'rss', kind: 'news', intervalMs: pollIntervalMs * 2,
    },
    {
      id: 'gdacs', name: 'GDACS', url: 'https://www.gdacs.org/xml/rss.xml', format: 'RSS 2.0 + GDACS/GeoRSS',
      coverage: 'Earthquakes, cyclones, floods, volcanoes, droughts and wildfires with alert levels and coordinates',
      cadence: fast, attribution: 'Global Disaster Alert and Coordination System (EC-JRC / UN OCHA), CC BY 4.0',
      termsUrl: 'https://www.gdacs.org/About/termsofuse.aspx', connector: 'gdacs', kind: 'hazard', intervalMs: pollIntervalMs,
    },
    {
      id: 'gdelt', name: 'GDELT Project', url: 'https://api.gdeltproject.org/api/v2/doc/doc', format: 'JSON (DOC 2.0 API)',
      coverage: 'Worldwide online news matching security-related keywords; headlines only, English-language',
      cadence: `${fast}; one request per run (provider asks for at most one per 5 seconds)`,
      attribution: 'The GDELT Project', termsUrl: 'https://www.gdeltproject.org/about.html#termsofuse',
      connector: 'gdelt', kind: 'news', intervalMs: pollIntervalMs,
    },
    {
      id: 'cisa-kev', name: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
      format: 'JSON', coverage: 'Vulnerabilities with confirmed exploitation in the wild (additions from the last 90 days)',
      cadence: 'Checked every 6 hours; the catalog changes a few times a week', attribution: 'CISA Known Exploited Vulnerabilities Catalog',
      termsUrl: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog', connector: 'cisa-kev', kind: 'cyber', intervalMs: 6 * 60 * 60 * 1000,
    },
    {
      id: 'reliefweb', name: 'ReliefWeb', url: 'https://api.reliefweb.int/v2/reports', format: 'JSON (API v2)',
      coverage: 'Humanitarian reports from UN OCHA and partner organisations', cadence: 'Checked hourly',
      attribution: 'ReliefWeb (UN OCHA); each report credits its original publisher', termsUrl: 'https://reliefweb.int/terms-conditions',
      connector: 'reliefweb', kind: 'humanitarian', intervalMs: 60 * 60 * 1000,
      credential: {
        envVars: ['RELIEFWEB_APPNAME'],
        signupUrl: 'https://apidoc.reliefweb.int/',
        instructions: 'ReliefWeb requires a pre-approved application name. Request one at https://apidoc.reliefweb.int/ (free), then set RELIEFWEB_APPNAME on the server.',
      },
    },
    {
      id: 'acled', name: 'ACLED conflict events', url: 'https://acleddata.com/api/acled/read', format: 'JSON (API)',
      coverage: 'Geolocated political violence, protest and strategic-development events worldwide (last 7 days)', cadence: 'Checked hourly',
      attribution: 'ACLED (Armed Conflict Location & Event Data); each event credits its original sources', termsUrl: 'https://acleddata.com/terms-and-conditions',
      connector: 'acled', kind: 'news', intervalMs: 60 * 60 * 1000,
      credential: {
        envVars: ['ACLED_EMAIL', 'ACLED_PASSWORD'],
        signupUrl: 'https://acleddata.com/',
        instructions: 'ACLED needs a free myACLED account. Register at https://acleddata.com/, read its terms of use (they limit some commercial use), then set ACLED_EMAIL and ACLED_PASSWORD on the server. What data a free account can read depends on ACLED\'s access level for your account.',
      },
    },
    {
      id: 'eia', name: 'US EIA (oil spot prices)', url: 'https://api.eia.gov/v2/petroleum/pri/spt/data/', format: 'JSON (API v2)',
      coverage: 'Daily Brent and WTI crude spot prices; market context, not security events', cadence: 'Checked every 12 hours',
      attribution: 'U.S. Energy Information Administration', termsUrl: 'https://www.eia.gov/about/copyrights_reuse.php',
      connector: 'eia', kind: 'energy', intervalMs: 12 * 60 * 60 * 1000,
      credential: {
        envVars: ['EIA_API_KEY'],
        signupUrl: 'https://www.eia.gov/opendata/register.php',
        instructions: 'Register for a free key at https://www.eia.gov/opendata/register.php, then set EIA_API_KEY on the server.',
      },
    },
  ];
}

export async function fetchSource(source: SourceDefinition, context: ConnectorContext): Promise<ConnectorResult> {
  const { fetcher, env, checkpoint, now } = context;
  switch (source.connector ?? 'rss') {
    case 'rss': {
      const result = await fetchRssSource(source, checkpoint, fetcher);
      return result;
    }
    case 'gdacs': {
      const response = await httpText(source.url, { fetcher, checkpoint, headers: { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } });
      if (response.notModified) return { notModified: true, articles: [], etag: response.etag, lastModified: response.lastModified };
      return { articles: parseGdacs(response.text), etag: response.etag, lastModified: response.lastModified };
    }
    case 'cisa-kev': {
      const response = await httpText(source.url, { fetcher, checkpoint, headers: { accept: 'application/json' } });
      if (response.notModified) return { notModified: true, articles: [], etag: response.etag, lastModified: response.lastModified };
      return { articles: parseKev(response.text, now), etag: response.etag, lastModified: response.lastModified };
    }
    case 'gdelt': {
      const query = env.GDELT_QUERY?.trim() || defaultGdeltQuery;
      const url = `${source.url}?${new URLSearchParams({ query, mode: 'artlist', format: 'json', maxrecords: '75', timespan: '1h', sort: 'datedesc' })}`;
      // One try per run: GDELT allows one request every 5 seconds, so a quick retry would only break its rule. The next scheduled check is the retry.
      const response = await httpText(url, { fetcher, headers: { accept: 'application/json' }, attempts: 1 })
        .catch((error: unknown) => {
          if (error instanceof SourceFetchError && /HTTP 429/.test(error.message)) throw new SourceFetchError('GDELT asked us to slow down (it allows one request every 5 seconds across everyone using the same network address). The next scheduled check tries again.');
          throw error;
        });
      return { articles: parseGdelt(response.text) };
    }
    case 'reliefweb': {
      const url = `${source.url}?${new URLSearchParams({ appname: env.RELIEFWEB_APPNAME ?? '' })}`;
      const body = JSON.stringify({
        preset: 'latest', limit: 40, sort: ['date.created:desc'],
        fields: { include: ['title', 'url', 'body', 'date.original', 'date.created', 'date.changed', 'country.name', 'source.name', 'disaster_type.name'] },
      });
      const response = await httpText(url, { fetcher, method: 'POST', body, headers: { accept: 'application/json', 'content-type': 'application/json' } });
      return { articles: parseReliefWeb(response.text) };
    }
    case 'acled': {
      const form = new URLSearchParams({ username: env.ACLED_EMAIL ?? '', password: env.ACLED_PASSWORD ?? '', grant_type: 'password', client_id: 'acled', scope: 'authenticated' });
      const auth = await httpText('https://acleddata.com/oauth/token', { fetcher, method: 'POST', body: form.toString(), headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, attempts: 1 })
        .catch((error: unknown) => { throw new SourceFetchError(`ACLED sign-in failed (${error instanceof Error ? error.message : 'request failed'}). Check ACLED_EMAIL and ACLED_PASSWORD, and that the account is confirmed.`); });
      let token: string | undefined;
      try { token = (JSON.parse(auth.text) as { access_token?: string }).access_token; } catch { /* handled below */ }
      if (!token) throw new SourceFetchError('ACLED sign-in did not return a token. Check ACLED_EMAIL and ACLED_PASSWORD.');
      const day = 86_400_000;
      const from = new Date(now.getTime() - 7 * day).toISOString().slice(0, 10);
      const to = now.toISOString().slice(0, 10);
      const query = new URLSearchParams({ _format: 'json', limit: '500', event_date: `${from}|${to}`, event_date_where: 'BETWEEN' });
      const response = await httpText(`${source.url}?${query}`, { fetcher, headers: { accept: 'application/json', authorization: `Bearer ${token}` }, attempts: 2 })
        .catch((error: unknown) => { throw new SourceFetchError(`ACLED accepted the sign-in but refused the data request (${error instanceof Error ? error.message : 'request failed'}). The account's access level may not include API data.`); });
      return { articles: parseAcled(response.text) };
    }
    case 'eia': {
      const params = new URLSearchParams({ api_key: env.EIA_API_KEY ?? '', frequency: 'daily', 'data[0]': 'value', length: '6' });
      params.append('facets[series][]', 'RBRTE');
      params.append('facets[series][]', 'RWTC');
      params.append('sort[0][column]', 'period');
      params.append('sort[0][direction]', 'desc');
      const response = await httpText(`${source.url}?${params}`, { fetcher, headers: { accept: 'application/json' } });
      return { articles: parseEia(response.text) };
    }
    default:
      throw new SourceFetchError(`Unknown connector for ${source.id}.`);
  }
}
