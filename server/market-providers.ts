import { httpText } from './connectors';
import { addDays, barCloseForDate } from './market-calendar';
import type { AssetInfo, CalendarId, ProviderId, ProviderInfo } from '../src/data/marketTypes';

export type Bar = {
  /** Daily bars: session date (YYYY-MM-DD). Hourly bars: bar start as an ISO instant. */
  t: string;
  closeAt: number;
  o: number; h: number; l: number; c: number;
  /** Unadjusted close where the provider supplies both (Tiingo). */
  rawClose: number | null;
};

export type FetchPlan = {
  asset: AssetInfo;
  granularity: '1h' | '1d';
  /** Latest stored bar, used to start an incremental request. null = first fetch. */
  lastT: string | null;
  now: Date;
  env: NodeJS.ProcessEnv;
  fetcher: typeof fetch;
  full?: boolean;
};

export type FetchResult = { bars: Bar[]; replaced: boolean };

export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'setup' | 'rate' | 'unavailable' = 'unavailable', readonly retryAfterMs?: number) { super(message); }
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'coinbase', name: 'Coinbase Exchange public market data', covers: 'Cryptocurrency USD pairs (hourly and daily candles)',
    credential: null,
    limits: 'Public endpoints, about 10 requests per second per IP; at most 300 candles per request. This app requests only incrementally and throttles to well below that.',
    license: 'Public market-data endpoint; the prices are those of the Coinbase Exchange order book, not a global average. Check Coinbase market-data terms before commercial redistribution.',
    attribution: 'Prices: Coinbase Exchange',
    delay: 'Near real time; bars are shown only once complete.',
    verified: 'Endpoint and candle format checked against the public documentation. Display terms for a public site were not confirmed.',
  },
  {
    id: 'tiingo', name: 'Tiingo end-of-day prices', covers: 'US-listed stocks and ETFs (daily, split- and dividend-adjusted)',
    credential: { envVar: 'TIINGO_API_TOKEN', configured: false, signupUrl: 'https://www.tiingo.com/account/api/token' },
    limits: 'Free tier is documented as roughly 50 requests per hour, 1,000 per day and a limited number of unique symbols per month. The app spaces requests and fetches only watched or linked assets.',
    license: 'Tiingo free and personal plans are for internal, non-commercial use. Redistributing prices on a public website needs a Tiingo commercial licence. Keep the app private or obtain permission.',
    attribution: 'End-of-day prices: Tiingo',
    delay: 'End of day: a session appears after the provider publishes it, typically some hours after the close.',
    verified: 'Endpoint, authorisation header and response fields checked against the documentation; licence summary is not legal advice.',
  },
  {
    id: 'fred', name: 'FRED (Federal Reserve Bank of St. Louis)', covers: 'Index levels (S&P 500, Nasdaq Composite, Dow Jones) and EIA spot oil prices (Brent, WTI), daily',
    credential: { envVar: 'FRED_API_KEY', configured: false, signupUrl: 'https://fred.stlouisfed.org/docs/api/api_key.html' },
    limits: 'About 120 requests per minute per key. This app makes one request per series per refresh.',
    license: 'FRED terms and the third-party redistribution limits on the equity-index series were not verified from this environment. Review them before using the index series publicly.',
    attribution: 'Source: FRED, Federal Reserve Bank of St. Louis; S&P Dow Jones Indices; NASDAQ OMX; U.S. Energy Information Administration',
    delay: 'Daily, published with a lag of at least a day. The S&P 500 series may cover only about the last ten years.',
    verified: 'Endpoint and response format checked against the documentation.',
  },
  {
    id: 'none', name: 'No provider configured', covers: 'Listings without a free price source that permits display',
    credential: null, limits: 'n/a', license: 'n/a', attribution: '', delay: 'n/a', verified: 'n/a',
  },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;

export function credentialName(provider: ProviderId): string | null {
  return providerInfo(provider).credential?.envVar ?? null;
}

/** Providers that need a key which is not set. */
export function missingKey(provider: ProviderId, env: NodeJS.ProcessEnv): string | null {
  const name = credentialName(provider);
  return name && !env[name]?.trim() ? name : null;
}

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// ---------------------------------------------------------------- Coinbase

/** Candle rows are [start seconds, low, high, open, close, volume], newest first. */
export function parseCoinbaseCandles(text: string, granularitySeconds: number, nowMs: number): Bar[] {
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) throw new ProviderError('Unexpected Coinbase response.');
  const bars: Bar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, low, high, open, close] = row.map(Number);
    if (![time, low, high, open, close].every(Number.isFinite) || close <= 0) continue;
    const start = time * 1000;
    const closeAt = start + granularitySeconds * 1000;
    if (closeAt > nowMs) continue; // incomplete bar
    const iso = new Date(start).toISOString();
    bars.push({ t: granularitySeconds === 86_400 ? iso.slice(0, 10) : iso, closeAt, o: open, h: high, l: low, c: close, rawClose: null });
  }
  return bars.sort((a, b) => a.closeAt - b.closeAt);
}

async function fetchCoinbase(plan: FetchPlan): Promise<FetchResult> {
  const seconds = plan.granularity === '1h' ? 3600 : 86_400;
  const nowMs = plan.now.getTime();
  const lookback = plan.granularity === '1h' ? 30 * 86_400_000 : 365 * 86_400_000;
  let start = plan.lastT ? Date.parse(plan.granularity === '1d' ? `${plan.lastT}T00:00:00Z` : plan.lastT) : nowMs - lookback;
  const all = new Map<string, Bar>();
  for (let guard = 0; guard < 8 && start < nowMs; guard += 1) {
    const end = Math.min(nowMs, start + 300 * seconds * 1000);
    const url = `https://api.exchange.coinbase.com/products/${plan.asset.providerSymbol}/candles?granularity=${seconds}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    let text: string;
    try { text = (await httpText(url, { fetcher: plan.fetcher, attempts: 2 })).text; } catch (error) { throw toProviderError(error); }
    for (const bar of parseCoinbaseCandles(text, seconds, nowMs)) all.set(bar.t, bar);
    start = end;
    if (start < nowMs) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { bars: [...all.values()].sort((a, b) => a.closeAt - b.closeAt), replaced: false };
}

// ---------------------------------------------------------------- Tiingo

type TiingoRow = { date?: string; open?: number; high?: number; low?: number; close?: number; adjOpen?: number; adjHigh?: number; adjLow?: number; adjClose?: number; divCash?: number; splitFactor?: number };

export function parseTiingoDaily(text: string, calendar: CalendarId, nowMs: number): Bar[] {
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) throw new ProviderError('Unexpected Tiingo response.');
  const bars: Bar[] = [];
  for (const row of rows as TiingoRow[]) {
    const date = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
    const c = finite(row.adjClose), o = finite(row.adjOpen), h = finite(row.adjHigh), l = finite(row.adjLow);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || c === null || o === null || h === null || l === null || c <= 0) continue;
    const closeAt = barCloseForDate(calendar, date);
    if (closeAt > nowMs) continue;
    bars.push({ t: date, closeAt, o, h, l, c, rawClose: finite(row.close) });
  }
  return bars.sort((a, b) => a.closeAt - b.closeAt);
}

async function fetchTiingo(plan: FetchPlan): Promise<FetchResult> {
  const token = plan.env.TIINGO_API_TOKEN?.trim();
  if (!token) throw new ProviderError('TIINGO_API_TOKEN is not set.', 'setup');
  const today = plan.now.toISOString().slice(0, 10);
  const startFull = addDays(today, -730);
  const run = async (startDate: string) => {
    const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(plan.asset.providerSymbol)}/prices?startDate=${startDate}&endDate=${today}&format=json`;
    try {
      return parseTiingoDaily((await httpText(url, { fetcher: plan.fetcher, attempts: 2, headers: { Authorization: `Token ${token}`, 'content-type': 'application/json' } })).text, plan.asset.calendar, plan.now.getTime());
    } catch (error) { throw toProviderError(error); }
  };
  if (plan.full || !plan.lastT) return { bars: await run(startFull), replaced: true };
  return { bars: await run(plan.lastT), replaced: false };
}

// ---------------------------------------------------------------- FRED

export function parseFredObservations(text: string, calendar: CalendarId, nowMs: number): Bar[] {
  const body = JSON.parse(text) as { observations?: Array<{ date?: string; value?: string }>; error_message?: string };
  if (!Array.isArray(body.observations)) throw new ProviderError(body.error_message ?? 'Unexpected FRED response.');
  const bars: Bar[] = [];
  for (const row of body.observations) {
    const value = Number(row.value);
    if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.value === undefined || row.value === '.' || !Number.isFinite(value) || value <= 0) continue; // "." marks a missing observation
    const closeAt = barCloseForDate(calendar, row.date);
    if (closeAt > nowMs) continue;
    bars.push({ t: row.date, closeAt, o: value, h: value, l: value, c: value, rawClose: null });
  }
  return bars.sort((a, b) => a.closeAt - b.closeAt);
}

async function fetchFred(plan: FetchPlan): Promise<FetchResult> {
  const key = plan.env.FRED_API_KEY?.trim();
  if (!key) throw new ProviderError('FRED_API_KEY is not set.', 'setup');
  const start = plan.lastT ? addDays(plan.lastT, -7) : addDays(plan.now.toISOString().slice(0, 10), -730);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(plan.asset.providerSymbol)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${start}`;
  try {
    return { bars: parseFredObservations((await httpText(url, { fetcher: plan.fetcher, attempts: 2 })).text, plan.asset.calendar, plan.now.getTime()), replaced: false };
  } catch (error) {
    // The key travels in the URL, so keep it out of any message that may be shown.
    const converted = toProviderError(error);
    throw new ProviderError(converted.message.split(key).join('[key]'), converted.kind, converted.retryAfterMs);
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : 'Provider request failed.';
  const retry = (error as { retryAfterMs?: number }).retryAfterMs;
  if (/HTTP 429/.test(message)) return new ProviderError('The provider rate limit was reached.', 'rate', retry);
  if (/HTTP 40[13]/.test(message)) return new ProviderError('The provider rejected the credentials or the request.', 'setup');
  return new ProviderError(message);
}

export async function fetchBars(plan: FetchPlan): Promise<FetchResult> {
  switch (plan.asset.provider) {
    case 'coinbase': return fetchCoinbase(plan);
    case 'tiingo': return fetchTiingo(plan);
    case 'fred': return fetchFred(plan);
    default: throw new ProviderError('No price provider is configured for this listing.', 'setup');
  }
}

/** Minimum spacing between requests to one provider, derived from the documented limits. */
export const PROVIDER_SPACING_MS: Record<ProviderId, number> = { coinbase: 400, tiingo: 75_000, fred: 1_000, none: 0 };
