import { findCountryCodes } from '../src/data/countries';
import { hazardTypeFrom } from '../src/data/mapLogic';
import { httpText } from './connectors';
import type { DatabaseHandle } from './source-store';

/**
 * Hazard events fetched straight from USGS and NASA EONET. They are stored separately from the article feed
 * (they are measurements and event records, not news) and keep every source-native field.
 */
export type GeoSource = 'usgs' | 'eonet';

export type GeoEvent = {
  source: GeoSource;
  id: string;
  title: string;
  url: string | null;
  /** Event time (origin time for earthquakes, latest geometry date for EONET). */
  time: string;
  lat: number;
  lng: number;
  /** Outer ring, [lng, lat] pairs, when the source supplies an area. */
  polygon: number[][] | null;
  hazardType: string | null;
  categoryLabel: string;
  native: Array<{ label: string; value: string }>;
  countryCodes: string[];
  summary: string;
};

export const GEO_SOURCES = {
  usgs: {
    name: 'USGS Earthquake Hazards Program', intervalMs: 5 * 60_000,
    attribution: 'U.S. Geological Survey, earthquake.usgs.gov. USGS-authored data is U.S. government public domain; credit USGS as the source.',
    termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    docsUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
  },
  eonet: {
    name: 'NASA EONET', intervalMs: 30 * 60_000,
    attribution: 'NASA Earth Observatory Natural Event Tracker (EONET). Event locations are not official precise data.',
    termsUrl: 'https://eonet.gsfc.nasa.gov/docs/v3',
    docsUrl: 'https://eonet.gsfc.nasa.gov/docs/v3',
  },
} as const;

const RETENTION_DAYS = 45;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** "10 km NE of Tokyo, Japan" -> Japan. Only the part after the last comma is read; US states and the like give nothing. */
function countryFromPlace(place: string) {
  const tail = place.includes(',') ? place.slice(place.lastIndexOf(',') + 1) : place.replace(/^.*\bof\s+/i, '');
  const codes = findCountryCodes(tail);
  return codes.length === 1 ? codes : [];
}

export function usgsFeedLevel(env: NodeJS.ProcessEnv) {
  const level = (env.USGS_FEED_LEVEL ?? '4.5').trim();
  return ['significant', '4.5', '2.5', '1.0'].includes(level) ? level : '4.5';
}

/** The smallest published feed that covers the time since the last success, so a fetch is incremental. */
export function usgsFeedPeriod(lastSuccessAt: string | null, now: number): 'hour' | 'day' | 'week' | 'month' {
  if (!lastSuccessAt) return 'week';
  const gapMin = (now - Date.parse(lastSuccessAt)) / 60_000;
  if (!(gapMin >= 0)) return 'day';
  if (gapMin < 50) return 'hour';
  if (gapMin < 20 * 60) return 'day';
  if (gapMin < 6 * 24 * 60) return 'week';
  return 'month';
}

export function usgsUrl(level: string, period: string) {
  return `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${level}_${period}.geojson`;
}

export function parseUsgs(body: string): GeoEvent[] {
  let data: { features?: unknown };
  try { data = JSON.parse(body) as { features?: unknown }; } catch { throw new Error('USGS returned a response that is not valid GeoJSON.'); }
  if (!Array.isArray(data.features)) throw new Error('USGS response has no features array.');
  const events: GeoEvent[] = [];
  for (const raw of data.features as Array<Record<string, unknown>>) {
    const props = (raw.properties ?? {}) as Record<string, unknown>;
    const coords = ((raw.geometry as { coordinates?: unknown } | null)?.coordinates ?? []) as unknown[];
    const lng = num(coords[0]); const lat = num(coords[1]); const depth = num(coords[2]);
    const time = num(props.time);
    const id = text(raw.id);
    if (!id || lat === null || lng === null || time === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const mag = num(props.mag);
    const place = text(props.place);
    const magType = text(props.magType);
    const native: GeoEvent['native'] = [];
    native.push({ label: 'Magnitude', value: mag === null ? 'not supplied' : `${mag}${magType ? ` (${magType})` : ''}` });
    if (depth !== null) native.push({ label: 'Depth', value: `${depth} km` });
    native.push({ label: 'USGS PAGER alert', value: text(props.alert) || 'not issued' });
    if (num(props.sig) !== null) native.push({ label: 'USGS significance (0–1000)', value: String(props.sig) });
    native.push({ label: 'Tsunami flag', value: props.tsunami === 1 ? 'set' : 'not set' });
    native.push({ label: 'Review status', value: text(props.status) || 'not supplied' });
    if (num(props.felt) !== null) native.push({ label: '"Did you feel it?" reports', value: String(props.felt) });
    if (text(props.mmi) || num(props.mmi) !== null) native.push({ label: 'Max. instrumental intensity (MMI)', value: String(props.mmi) });
    events.push({
      source: 'usgs', id, title: text(props.title) || (mag === null ? place : `M ${mag} - ${place}`), url: text(props.url) || null,
      time: new Date(time).toISOString(), lat, lng, polygon: null, hazardType: 'earthquake', categoryLabel: 'earthquake', native,
      countryCodes: countryFromPlace(place), summary: place ? `Epicentre: ${place}.` : '',
    });
  }
  return events;
}

const EONET_HAZARDS: Record<string, string | null> = {
  drought: 'drought', earthquakes: 'earthquake', floods: 'flood', landslides: 'landslide', severeStorms: 'cyclone', volcanoes: 'volcano', wildfires: 'wildfire',
};

function ringCentre(ring: number[][]) {
  const lngs = ring.map((p) => p[0]); const lats = ring.map((p) => p[1]);
  return { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
}
function thin(ring: number[][], max = 80) {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out = ring.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
  return out;
}

export function parseEonet(body: string): GeoEvent[] {
  let data: { events?: unknown };
  try { data = JSON.parse(body) as { events?: unknown }; } catch { throw new Error('EONET returned a response that is not valid JSON.'); }
  if (!Array.isArray(data.events)) throw new Error('EONET response has no events array.');
  const events: GeoEvent[] = [];
  for (const raw of data.events as Array<Record<string, unknown>>) {
    const id = text(raw.id);
    const geometries = (Array.isArray(raw.geometry) ? raw.geometry : []) as Array<Record<string, unknown>>;
    const dated = geometries.filter((g) => Number.isFinite(Date.parse(text(g.date)))).sort((a, b) => Date.parse(text(b.date)) - Date.parse(text(a.date)));
    const latest = dated[0];
    if (!id || !latest) continue;
    let lat: number; let lng: number; let polygon: number[][] | null = null;
    const coordinates = latest.coordinates as unknown;
    if (latest.type === 'Point' && Array.isArray(coordinates) && num(coordinates[0]) !== null && num(coordinates[1]) !== null) {
      lng = coordinates[0] as number; lat = coordinates[1] as number;
    } else if (latest.type === 'Polygon' && Array.isArray(coordinates) && Array.isArray(coordinates[0]) && (coordinates[0] as unknown[]).length >= 3) {
      const ring = (coordinates[0] as unknown[]).filter((p): p is number[] => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null).map((p) => [p[0], p[1]]);
      if (ring.length < 3) continue;
      ({ lat, lng } = ringCentre(ring));
      polygon = thin(ring);
    } else continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const category = ((raw.categories as Array<{ id?: string; title?: string }> | undefined) ?? [])[0];
    const categoryLabel = (category?.title ?? 'natural event').toLowerCase();
    const native: GeoEvent['native'] = [];
    const mag = num(latest.magnitudeValue);
    if (mag !== null) native.push({ label: 'Magnitude (as supplied)', value: `${mag}${text(latest.magnitudeUnit) ? ` ${text(latest.magnitudeUnit)}` : ''}` });
    native.push({ label: 'EONET status', value: raw.closed ? `closed ${text(raw.closed)}` : 'open' });
    native.push({ label: 'Position reports', value: String(dated.length) });
    native.push({ label: 'Geometry', value: polygon ? 'area (centre shown as marker)' : 'point' });
    const links = (raw.sources as Array<{ url?: string }> | undefined) ?? [];
    events.push({
      source: 'eonet', id, title: text(raw.title) || id, url: text(raw.link) || links[0]?.url || null, time: new Date(text(latest.date)).toISOString(),
      lat, lng, polygon, hazardType: EONET_HAZARDS[category?.id ?? ''] ?? hazardTypeFrom(categoryLabel), categoryLabel, native,
      countryCodes: [], summary: text(raw.description),
    });
  }
  return events;
}

// ---------------------------------------------------------------- storage
export type GeoFetchState = {
  source: GeoSource; lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null; failCount: number;
  nextRunAt: string | null; lastCount: number;
};

export class GeoStore {
  constructor(private readonly db: DatabaseHandle) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS geo_events (
        source TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (source, id)
      );
      CREATE INDEX IF NOT EXISTS geo_events_time_idx ON geo_events(time);
      CREATE TABLE IF NOT EXISTS geo_fetch_state (
        source TEXT PRIMARY KEY, last_attempt_at TEXT, last_success_at TEXT, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT, last_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS geo_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
    `);
  }

  upsert(events: GeoEvent[], fetchedAt: string) {
    const stmt = this.db.prepare(`
      INSERT INTO geo_events (source, id, time, json, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, id) DO UPDATE SET time = excluded.time, json = excluded.json, fetched_at = excluded.fetched_at
    `);
    this.db.transaction(() => { for (const e of events) stmt.run(e.source, e.id, e.time, JSON.stringify(e), fetchedAt); })();
  }

  /** Drops events older than the retention window, measured from event time. */
  prune(now: Date) {
    this.db.prepare('DELETE FROM geo_events WHERE time < ?').run(new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString());
  }

  list(from: string, to: string): Array<GeoEvent & { fetchedAt: string }> {
    const rows = this.db.prepare('SELECT json, fetched_at FROM geo_events WHERE time >= ? AND time <= ? ORDER BY time DESC').all(from, to) as Array<{ json: string; fetched_at: string }>;
    return rows.map((r) => ({ ...(JSON.parse(r.json) as GeoEvent), fetchedAt: r.fetched_at }));
  }

  count(source: GeoSource) {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM geo_events WHERE source = ?').get(source) as { n: number }).n;
  }

  getState(source: GeoSource): GeoFetchState {
    const r = this.db.prepare('SELECT * FROM geo_fetch_state WHERE source = ?').get(source) as Record<string, unknown> | undefined;
    return {
      source, lastAttemptAt: (r?.last_attempt_at as string) ?? null, lastSuccessAt: (r?.last_success_at as string) ?? null, lastError: (r?.last_error as string) ?? null,
      failCount: Number(r?.fail_count ?? 0), nextRunAt: (r?.next_run_at as string) ?? null, lastCount: Number(r?.last_count ?? 0),
    };
  }

  saveState(state: GeoFetchState) {
    this.db.prepare(`
      INSERT INTO geo_fetch_state (source, last_attempt_at, last_success_at, last_error, fail_count, next_run_at, last_count) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = excluded.last_error,
        fail_count = excluded.fail_count, next_run_at = excluded.next_run_at, last_count = excluded.last_count
    `).run(state.source, state.lastAttemptAt, state.lastSuccessAt, state.lastError, state.failCount, state.nextRunAt, state.lastCount);
  }

  getCache(key: string) {
    const r = this.db.prepare('SELECT json, fetched_at FROM geo_cache WHERE key = ?').get(key) as { json: string; fetched_at: string } | undefined;
    return r ? { json: r.json, fetchedAt: r.fetched_at } : null;
  }

  setCache(key: string, json: string, fetchedAt: string) {
    this.db.prepare('INSERT INTO geo_cache (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at').run(key, json, fetchedAt);
  }
}

// ---------------------------------------------------------------- sync
const backoff = (failCount: number, intervalMs: number) => Math.min(6 * 3_600_000, intervalMs * 2 ** Math.min(failCount, 6));

export type GeoSyncDeps = { geo: GeoStore; env: NodeJS.ProcessEnv; fetcher: typeof fetch; now: () => Date };

/**
 * Fetches one source if it is due. A failure is recorded on that source only; the events already stored stay in place
 * and are served as Stale. Returns true when new data was stored.
 */
export async function syncGeoSource(deps: GeoSyncDeps, source: GeoSource, force = false): Promise<boolean> {
  const state = deps.geo.getState(source);
  const now = deps.now();
  if (!force && state.nextRunAt && Date.parse(state.nextRunAt) > now.getTime()) return false;
  const def = GEO_SOURCES[source];
  const url = source === 'usgs'
    ? usgsUrl(usgsFeedLevel(deps.env), usgsFeedPeriod(state.lastSuccessAt, now.getTime()))
    : `https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=${state.lastSuccessAt && now.getTime() - Date.parse(state.lastSuccessAt) < 5 * 86_400_000 ? 7 : 30}&limit=1000`;
  try {
    const response = await httpText(url, { fetcher: deps.fetcher, attempts: 2, maxBytes: 20 * 1024 * 1024, timeoutMs: 45_000 });
    if (response.notModified) throw new Error('Unexpected 304 response.');
    const events = source === 'usgs' ? parseUsgs(response.text) : parseEonet(response.text);
    const at = now.toISOString();
    deps.geo.upsert(events, at);
    deps.geo.prune(now);
    deps.geo.saveState({ source, lastAttemptAt: at, lastSuccessAt: at, lastError: null, failCount: 0, nextRunAt: new Date(now.getTime() + def.intervalMs).toISOString(), lastCount: events.length });
    return true;
  } catch (error) {
    const failCount = state.failCount + 1;
    const message = error instanceof Error ? error.message : 'Fetch failed.';
    deps.geo.saveState({ ...state, lastAttemptAt: now.toISOString(), lastError: message, failCount, nextRunAt: new Date(now.getTime() + backoff(failCount, def.intervalMs)).toISOString() });
    return false;
  }
}

export async function syncAllGeo(deps: GeoSyncDeps, force = false) {
  const results = await Promise.all((Object.keys(GEO_SOURCES) as GeoSource[]).map((s) => syncGeoSource(deps, s, force)));
  return results.some(Boolean);
}
