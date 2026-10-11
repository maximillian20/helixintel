import { boundsToCircle, distanceKm, inBounds, type Bounds } from '../src/data/mapLogic';
import type { Aircraft, AircraftResponse } from '../src/data/mapTypes';
import { httpText } from './connectors';

/**
 * ADSB.lol connector (community ADS-B network, data under ODbL).
 *
 * Request: GET {base}/v2/point/{lat}/{lon}/{radius_nm}, radius at most 250 nm, readsb-compatible JSON:
 *   { ac: [{ hex, flight, r, t, alt_baro, gs, track, baro_rate, squawk, lat, lon, seen_pos, ... }], now, total }
 * NOTE: ADSB.lol's documentation pages could not be opened from the build environment, so this request and response
 * format is taken from the readsb/ADS-B Exchange v2 convention that the service states it follows. Confirm it against
 * https://api.adsb.lol/docs before relying on it in production. The service asks to be contacted before production use.
 */
export const ADSB_MAX_RADIUS_NM = 250;
export const ADSB_DEFAULT_REFRESH_MS = 15_000;
export const ADSB_MIN_REFRESH_MS = 5_000;
export const ADSB_MAX_REFRESH_MS = 120_000;
export const ADSB_DOCS_URL = 'https://api.adsb.lol/docs';
export const ADSB_LICENCE = 'ODbL 1.0 (Open Database License). Attribution to ADSB.lol is required; derived databases must be shared alike.';

export function adsbSettings(env: NodeJS.ProcessEnv) {
  const configured = Number(env.ADSB_REFRESH_MS);
  const refreshMs = Number.isFinite(configured) && configured > 0 ? Math.min(ADSB_MAX_REFRESH_MS, Math.max(ADSB_MIN_REFRESH_MS, configured)) : ADSB_DEFAULT_REFRESH_MS;
  return {
    enabled: env.ADSB_DISABLED !== '1',
    base: (env.ADSB_API_BASE?.trim() || 'https://api.adsb.lol').replace(/\/+$/, ''),
    refreshMs,
    contactConfirmed: env.ADSB_CONTACT_CONFIRMED === '1',
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function parseAdsb(body: string, receivedAt: Date): { aircraft: Aircraft[]; total: number } {
  let data: { ac?: unknown; total?: unknown };
  try { data = JSON.parse(body) as { ac?: unknown; total?: unknown }; } catch { throw new Error('ADSB.lol returned a response that is not valid JSON.'); }
  if (!Array.isArray(data.ac)) throw new Error('ADSB.lol response has no aircraft list.');
  const aircraft: Aircraft[] = [];
  for (const raw of data.ac as Array<Record<string, unknown>>) {
    const hex = str(raw.hex);
    const lat = num(raw.lat); const lng = num(raw.lon);
    if (!hex || lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const seen = num(raw.seen_pos) ?? num(raw.seen);
    const alt = raw.alt_baro === 'ground' ? 'ground' as const : num(raw.alt_baro);
    aircraft.push({
      hex, callsign: str(raw.flight), registration: str(raw.r), type: str(raw.t), lat, lng, altitudeFt: alt, speedKt: num(raw.gs),
      headingDeg: num(raw.track), verticalRateFpm: num(raw.baro_rate), squawk: str(raw.squawk), positionAgeSec: seen,
      observedAt: new Date(receivedAt.getTime() - (seen ?? 0) * 1000).toISOString(),
    });
  }
  return { aircraft, total: typeof data.total === 'number' ? data.total : aircraft.length };
}

type CacheEntry = { at: number; expires: number; aircraft: Aircraft[]; total: number; fetchedAt: string; circle: { lat: number; lon: number; radiusNm: number } };

/** True when every corner of the box lies inside the circle, so the circle's response contains everything in the box. */
function covers(c: { lat: number; lon: number; radiusNm: number }, b: Bounds) {
  return ([[b[0], b[1]], [b[0], b[3]], [b[2], b[1]], [b[2], b[3]]] as Array<[number, number]>).every(([lat, lng]) => distanceKm(c.lat, c.lon, lat, lng) <= c.radiusNm * 1.852);
}

/**
 * One upstream request is shared by every browser: results are cached per query circle (centre rounded to 0.25 degrees,
 * radius rounded up to 25 nm) and concurrent requests for the same circle wait for one fetch. If the upstream fails, the
 * last good response for that circle is kept for up to ten minutes and the response says it is stale.
 */
export class AdsbClient {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry>>();
  upstreamRequests = 0;
  lastSuccessAt: string | null = null;
  lastAttemptAt: string | null = null;
  lastError: string | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly fetcher: typeof fetch, private readonly now: () => Date) {}

  status() {
    return { lastSuccessAt: this.lastSuccessAt, lastAttemptAt: this.lastAttemptAt, lastError: this.lastError };
  }

  async query(bounds: Bounds): Promise<AircraftResponse> {
    const settings = adsbSettings(this.env);
    const base = { aircraft: [] as Aircraft[], fetchedAt: this.now().toISOString(), cached: false, query: null, providerTotal: 0 };
    if (!settings.enabled) return { ...base, status: 'disabled', message: 'The aircraft layer is switched off on this server (ADSB_DISABLED=1).' };
    const circle = boundsToCircle(bounds, ADSB_MAX_RADIUS_NM);
    if (circle.tooLarge) {
      return { ...base, status: 'too_large', message: `The visible area is larger than the provider's ${ADSB_MAX_RADIUS_NM} nm query limit. Zoom in to load aircraft.` };
    }
    const lat = Math.round(circle.lat * 4) / 4; const lon = Math.round(circle.lon * 4) / 4;
    const radius = Math.min(ADSB_MAX_RADIUS_NM, Math.ceil((circle.radiusNm + 20) / 25) * 25);
    const key = `${lat}:${lon}:${radius}`;
    const query = { lat, lon, radiusNm: radius };
    const ttl = Math.max(ADSB_MIN_REFRESH_MS, settings.refreshMs - 1000);
    const cached = this.cache.get(key);
    const nowMs = this.now().getTime();
    const cut = (entry: CacheEntry, isCached: boolean, message: string | null, status: AircraftResponse['status']): AircraftResponse => ({
      aircraft: entry.aircraft.filter((a) => inBounds(a.lat, a.lng, bounds)), fetchedAt: entry.fetchedAt, cached: isCached, status, message, query, providerTotal: entry.total,
    });
    if (cached && cached.expires > nowMs) return cut(cached, true, null, 'ok');
    // Any still-valid response whose circle covers the whole box can serve it (panning inside a loaded area costs nothing).
    for (const entry of this.cache.values()) if (entry.expires > nowMs && covers(entry.circle, bounds)) return cut(entry, true, null, 'ok');
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchCircle(settings.base, query, ttl).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      const entry = await pending;
      this.cache.set(key, entry);
      this.trim(nowMs);
      return cut(entry, false, null, 'ok');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ADSB.lol could not be reached.';
      if (cached && nowMs - cached.at < 10 * 60_000) return cut(cached, true, `${message} Showing the last positions received (${cached.fetchedAt}); they are ageing and will expire.`, 'ok');
      return { ...base, status: 'unavailable', message, query, fetchedAt: this.now().toISOString() };
    }
  }

  private async fetchCircle(baseUrl: string, q: { lat: number; lon: number; radiusNm: number }, ttl: number): Promise<CacheEntry> {
    this.upstreamRequests += 1;
    const at = this.now();
    this.lastAttemptAt = at.toISOString();
    try {
      const response = await httpText(`${baseUrl}/v2/point/${q.lat}/${q.lon}/${q.radiusNm}`, { fetcher: this.fetcher, attempts: 1, timeoutMs: 12_000 });
      if (response.notModified) throw new Error('Unexpected 304 response.');
      const parsed = parseAdsb(response.text, at);
      this.lastSuccessAt = at.toISOString();
      this.lastError = null;
      return { at: at.getTime(), expires: at.getTime() + ttl, aircraft: parsed.aircraft, total: parsed.total, fetchedAt: at.toISOString(), circle: q };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Fetch failed.';
      throw error;
    }
  }

  private trim(nowMs: number) {
    for (const [key, entry] of this.cache) if (nowMs - entry.at > 10 * 60_000) this.cache.delete(key);
  }
}
