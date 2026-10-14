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

export function buildSources(pollIntervalMs: number): SourceDefinition[] {
  const minutes = Math.round(pollIntervalMs / 60000);
  const fast = `${minutes}-minute polling`;
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
      const response = await httpText(url, { fetcher, headers: { accept: 'application/json' }, attempts: 2 });
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
