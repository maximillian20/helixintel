import { countryCentroids } from '../src/data/centroids';
import { countryName, GLOBAL_CODE, UNKNOWN_CODE } from '../src/data/countries';
import { ASSESSMENT_METHOD_LABELS, SEVERITY_RANK, type Severity } from '../src/data/feedTypes';
import { distanceKm, hazardTypeFrom, linkDuplicates, meetsSeverity, placeContains } from '../src/data/mapLogic';
import { layerForSource, type BoundariesResponse, type CountryRiskResponse, type LayerStatus, type MapDataResponse, type MapFeature, type MapPlace, type PlaceInput, type UnlocatedItem } from '../src/data/mapTypes';
import { COUNTRY_CATEGORIES, RATING_RANK } from '../src/data/workspaceTypes';
import type { AnalysisStore } from './analysis-store';
import { countryDirectory } from './countries-service';
import { buildAllItems } from './feed-service';
import { GEO_SOURCES, type GeoSource, type GeoStore } from './map-geo';
import { marketCategory } from './market-links';
import type { DatabaseHandle, SourceStore } from './source-store';
import { randomUUID } from 'node:crypto';

export const MAX_FEATURES = 4000;
export const MAX_UNLOCATED = 150;

export type MapDeps = { store: SourceStore; analysis: AnalysisStore; geo: GeoStore; env: NodeJS.ProcessEnv; now: Date };

const CATEGORY_LABELS: Record<string, string> = {
  conflict: 'Conflict and security', political: 'Political', humanitarian: 'Humanitarian', cyber: 'Cyber', 'natural-hazard': 'Natural hazard', other: 'Other',
};
export { CATEGORY_LABELS };

const countryRefs = (codes: string[]) => codes.filter((c) => c !== GLOBAL_CODE && c !== UNKNOWN_CODE).map((code) => ({ code, name: countryName(code) }));

function sourceBasis(method: string, rationale: string, sourceId: string) {
  if (sourceId === 'gdacs') {
    return 'Mapped by the feed from the GDACS alert level (Red = Critical, Orange = High, Green = Low). An alert level describes the hazard, not business impact.';
  }
  return `${ASSESSMENT_METHOD_LABELS[method as keyof typeof ASSESSMENT_METHOD_LABELS] ?? method}. ${rationale}`.trim();
}

export function buildMapData(deps: MapDeps, clientId: string, from: string, to: string): MapDataResponse {
  const fromMs = Date.parse(from); const toMs = Date.parse(to);
  const features: MapFeature[] = [];
  const unlocated: UnlocatedItem[] = [];
  let unlocatedTotal = 0;

  // Incidents first, so each report can list the incidents that cite it.
  const incidentsByArticle = new Map<string, string[]>();
  const incidentDetails = deps.analysis.listIncidents(clientId, {}).map((summary) => deps.analysis.getIncident(clientId, summary.id));
  for (const incident of incidentDetails) {
    for (const link of incident.evidence) incidentsByArticle.set(link.articleId, [...(incidentsByArticle.get(link.articleId) ?? []), incident.id]);
  }

  for (const item of buildAllItems(deps.store, clientId)) {
    const t = Date.parse(item.publishedAt);
    if (!(t >= fromMs && t <= toMs)) continue;
    if (!item.location) {
      unlocatedTotal += 1;
      if (unlocated.length < MAX_UNLOCATED) {
        const reason = item.countryStatus === 'global' ? 'Global scope; no single place' : item.countryStatus === 'unknown' ? 'No place identified' : item.countries.length > 1 ? 'Several countries named; no single location' : 'No supported location';
        unlocated.push({ id: item.id, kind: 'report', title: item.headline, source: item.source, time: item.publishedAt, reason, url: item.url });
      }
      continue;
    }
    const layer = layerForSource(item.sourceId);
    const hazard = item.sourceId === 'gdacs';
    const precision = item.location.precision === 'event' ? 'source' : layer === 'gdelt' ? 'reported' : 'approximate';
    features.push({
      id: `article:${item.id}`, layer, kind: hazard ? 'hazard' : 'report', sourceId: item.sourceId, sourceName: item.source, title: item.headline, summary: item.summary,
      url: item.url, time: item.publishedAt, timeBasis: 'published', retrievedAt: item.retrievedAt, lat: item.location.lat, lng: item.location.lng, precision,
      locationLabel: item.location.label, polygon: null, category: marketCategory(item.categories, item.category),
      categoryLabel: item.categoryLabels[0] ?? item.category, hazardType: hazard ? hazardTypeFrom(item.category) : null,
      severity: item.severity, severityBasis: sourceBasis(item.assessmentMethod, item.severityRationale, item.sourceId),
      native: hazard ? [{ label: 'GDACS event type', value: item.category }] : [], countries: item.countries.filter((c) => c.code !== GLOBAL_CODE && c.code !== UNKNOWN_CODE),
      reviewStatus: item.reviewStatus, watchlisted: item.watchlisted, refId: item.id, groupId: null, incidentIds: incidentsByArticle.get(item.id) ?? [],
    });
  }

  for (const e of deps.geo.list(from, to)) {
    const def = GEO_SOURCES[e.source];
    const quake = e.source === 'usgs';
    features.push({
      id: `${e.source}:${e.id}`, layer: e.source, kind: 'hazard', sourceId: e.source, sourceName: def.name, title: e.title, summary: e.summary, url: e.url,
      time: e.time, timeBasis: 'event', retrievedAt: e.fetchedAt, lat: e.lat, lng: e.lng, precision: 'source',
      locationLabel: quake ? 'USGS epicentre' : e.polygon ? 'EONET area (centre shown)' : 'EONET reported position (not official precise data)', polygon: e.polygon,
      category: 'natural-hazard', categoryLabel: e.categoryLabel, hazardType: e.hazardType, severity: 'Unassessed',
      severityBasis: quake
        ? 'USGS publishes magnitude and a PAGER alert, which are not business-impact measures. No documented mapping exists, so this stays Unassessed.'
        : 'EONET publishes event records and optional magnitudes, not impact ratings. No documented mapping exists, so this stays Unassessed.',
      native: e.native, countries: countryRefs(e.countryCodes), reviewStatus: null, watchlisted: null, refId: e.id, groupId: null, incidentIds: [],
    });
  }

  for (const incident of incidentDetails) {
    const at = incident.eventAt ?? incident.createdAt;
    const t = Date.parse(at);
    if (!(t >= fromMs && t <= toMs)) continue;
    let lat = incident.lat; let lng = incident.lng; let precision: MapFeature['precision'] = 'analyst';
    let label = incident.locationText ? `${incident.locationText} (analyst-entered)` : 'Analyst-entered coordinates';
    if (lat === null || lng === null) {
      const codes = incident.countries.map((c) => c.code).filter((c) => c !== GLOBAL_CODE && c !== UNKNOWN_CODE);
      const centre = codes.length === 1 ? countryCentroids[codes[0]] : undefined;
      if (!centre) {
        unlocatedTotal += 1;
        if (unlocated.length < MAX_UNLOCATED) unlocated.push({ id: incident.id, kind: 'incident', title: incident.title, source: 'Incident', time: at, reason: 'No coordinates and not a single country', url: '' });
        continue;
      }
      [lat, lng] = centre; precision = 'approximate'; label = `${countryName(codes[0])} (country centre, approximate)`;
    }
    features.push({
      id: `incident:${incident.id}`, layer: 'incidents', kind: 'incident', sourceId: 'incidents', sourceName: 'Incident register', title: incident.title, summary: incident.summary,
      url: null, time: at, timeBasis: 'created', retrievedAt: null, lat, lng, precision, locationLabel: label, polygon: null,
      category: marketCategory([], incident.category), categoryLabel: incident.category || 'incident', hazardType: hazardTypeFrom(`${incident.category} ${incident.title}`),
      severity: incident.severity, severityBasis: `Analyst-assigned. ${incident.severityRationale}`.trim(),
      native: [{ label: 'Status', value: incident.status }, { label: 'Confidence', value: incident.confidence }, { label: 'Linked reports', value: String(incident.reportCount) }],
      countries: incident.countries, reviewStatus: null, watchlisted: null, refId: incident.id, groupId: null, incidentIds: [incident.id],
    });
  }

  let linked = linkDuplicates(features);
  linked.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.id.localeCompare(b.id));
  const truncated = Math.max(0, linked.length - MAX_FEATURES);
  if (truncated) linked = linked.slice(0, MAX_FEATURES);
  return { serverTime: deps.now.toISOString(), from, to, features: linked, truncated, unlocated, unlocatedTotal, geoStatus: geoStatuses(deps) };
}

// ---------------------------------------------------------------- source status
export function geoStatuses(deps: Pick<MapDeps, 'geo' | 'now'>): LayerStatus[] {
  return (Object.keys(GEO_SOURCES) as GeoSource[]).map((source) => {
    const def = GEO_SOURCES[source];
    const s = deps.geo.getState(source);
    let status: LayerStatus['status'];
    if (!s.lastSuccessAt) status = s.lastAttemptAt ? 'unavailable' : 'not_checked';
    else status = deps.now.getTime() - Date.parse(s.lastSuccessAt) > def.intervalMs * 3 ? 'stale' : 'healthy';
    return {
      id: source, name: def.name, layer: source, status, lastSuccessAt: s.lastSuccessAt, lastAttemptAt: s.lastAttemptAt, lastError: s.lastError,
      records: deps.geo.count(source), attribution: def.attribution, termsUrl: def.termsUrl,
      note: source === 'usgs'
        ? 'Earthquakes from the USGS summary feed (level set by USGS_FEED_LEVEL, default M4.5+). Refreshed about every 5 minutes; each refresh reads the smallest feed that covers the gap.'
        : 'Natural events from EONET v3 (open and recently closed). Refreshed about every 30 minutes.',
    };
  });
}

// ---------------------------------------------------------------- country risk
export function countryRisk(deps: MapDeps, clientId: string): CountryRiskResponse {
  const latest = deps.analysis.latestAssessments(clientId);
  const items: CountryRiskResponse['items'] = [];
  const centroids: CountryRiskResponse['centroids'] = {};
  for (const entry of countryDirectory(deps.store, deps.analysis, clientId, deps.now.getTime())) {
    if (entry.highestRating === 'Unassessed') continue;
    const version = latest.get(entry.code);
    const categories = COUNTRY_CATEGORIES.flatMap((c) => {
      const rating = version?.categories[c.id]?.rating;
      return rating && rating !== 'Unassessed' ? [{ label: c.label, rating }] : [];
    }).sort((a, b) => RATING_RANK[b.rating as keyof typeof RATING_RANK] - RATING_RANK[a.rating as keyof typeof RATING_RANK]);
    items.push({ code: entry.code, name: entry.name, rating: entry.highestRating, assessedAt: entry.assessedAt ?? '', categories });
    const c = countryCentroids[entry.code];
    if (c) centroids[entry.code] = c;
  }
  return { items, centroids };
}

// ---------------------------------------------------------------- country boundaries
export const DEFAULT_BOUNDARIES_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_110m_admin_0_countries.geojson';
const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseBoundaries(body: string): BoundariesResponse['shapes'] {
  let data: { features?: Array<{ properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }> };
  try { data = JSON.parse(body); } catch { throw new Error('Boundary file is not valid JSON.'); }
  if (!Array.isArray(data.features)) throw new Error('Boundary file is not a GeoJSON FeatureCollection.');
  const shapes: BoundariesResponse['shapes'] = {};
  const roundDeep = (v: unknown): unknown => (Array.isArray(v) ? (typeof v[0] === 'number' ? v.map((n) => round2(n as number)) : v.map(roundDeep)) : v);
  for (const f of data.features) {
    const p = f.properties ?? {};
    const code = [p.ISO_A2_EH, p.ISO_A2, p.iso_a2, p['ISO3166-1-Alpha-2']].find((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c));
    if (!code || (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon')) continue;
    shapes[code] = { type: f.geometry.type, coordinates: roundDeep(f.geometry.coordinates) };
  }
  if (Object.keys(shapes).length < 20) throw new Error('Boundary file has too few countries with ISO codes.');
  return shapes;
}

let boundaryAttempt = 0;
export async function getBoundaries(geo: GeoStore, env: NodeJS.ProcessEnv, fetcher: typeof fetch, now: Date): Promise<BoundariesResponse> {
  const url = env.MAP_COUNTRY_BOUNDARIES_URL?.trim() || DEFAULT_BOUNDARIES_URL;
  const base = { source: url, attribution: 'Country outlines: Natural Earth (public domain) unless MAP_COUNTRY_BOUNDARIES_URL points elsewhere.' };
  const cached = geo.getCache('boundaries');
  const usable = cached && JSON.parse(cached.json).url === url ? cached : null;
  const age = usable ? now.getTime() - Date.parse(usable.fetchedAt) : Infinity;
  if (usable && age < 30 * 86_400_000) return { ...base, status: 'ok', message: null, fetchedAt: usable.fetchedAt, shapes: JSON.parse(usable.json).shapes };
  if (now.getTime() - boundaryAttempt > 30 * 60_000) {
    boundaryAttempt = now.getTime();
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'GlobalSecurityIntelligence/0.2' } });
      if (!response.ok) throw new Error(`Boundary source returned HTTP ${response.status}`);
      const shapes = parseBoundaries(await response.text());
      geo.setCache('boundaries', JSON.stringify({ url, shapes }), now.toISOString());
      return { ...base, status: 'ok', message: null, fetchedAt: now.toISOString(), shapes };
    } catch (error) {
      if (usable) return { ...base, status: 'ok', message: `Refresh failed (${error instanceof Error ? error.message : 'error'}); using the stored copy.`, fetchedAt: usable.fetchedAt, shapes: JSON.parse(usable.json).shapes };
      return { ...base, status: 'unavailable', message: error instanceof Error ? error.message : 'Could not load country outlines.', fetchedAt: null, shapes: {} };
    }
  }
  if (usable) return { ...base, status: 'ok', message: null, fetchedAt: usable.fetchedAt, shapes: JSON.parse(usable.json).shapes };
  return { ...base, status: 'unavailable', message: 'Country outlines could not be loaded recently; the server will retry shortly.', fetchedAt: null, shapes: {} };
}
export function resetBoundaryThrottle() { boundaryAttempt = 0; }

// ---------------------------------------------------------------- saved places and areas
export class PlaceStore {
  constructor(private readonly db: DatabaseHandle) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS map_places (
        client_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (client_id, id)
      );
      CREATE TABLE IF NOT EXISTS map_alert_state (client_id TEXT NOT NULL, place_id TEXT NOT NULL, last_alert_at TEXT NOT NULL, PRIMARY KEY (client_id, place_id));
    `);
  }
  list(clientId: string): MapPlace[] {
    return (this.db.prepare('SELECT json FROM map_places WHERE client_id = ? ORDER BY created_at').all(clientId) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as MapPlace);
  }
  get(clientId: string, id: string): MapPlace | null {
    const r = this.db.prepare('SELECT json FROM map_places WHERE client_id = ? AND id = ?').get(clientId, id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as MapPlace) : null;
  }
  create(clientId: string, input: PlaceInput, now: string): MapPlace {
    const place: MapPlace = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    if (place.alert.enabled && !place.alert.since) place.alert = { ...place.alert, since: now };
    this.db.prepare('INSERT INTO map_places (client_id, id, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(clientId, place.id, JSON.stringify(place), now, now);
    return place;
  }
  update(clientId: string, id: string, input: PlaceInput, now: string): MapPlace | null {
    const current = this.get(clientId, id);
    if (!current) return null;
    const next: MapPlace = { ...current, ...input, updatedAt: now };
    // Turning alerts on starts a fresh baseline so older events never back-fill.
    if (next.alert.enabled && (!current.alert.enabled || !next.alert.since)) next.alert = { ...next.alert, since: now };
    this.db.prepare('UPDATE map_places SET json = ?, updated_at = ? WHERE client_id = ? AND id = ?').run(JSON.stringify(next), now, clientId, id);
    return next;
  }
  remove(clientId: string, id: string) {
    this.db.prepare('DELETE FROM map_alert_state WHERE client_id = ? AND place_id = ?').run(clientId, id);
    return this.db.prepare('DELETE FROM map_places WHERE client_id = ? AND id = ?').run(clientId, id).changes > 0;
  }
  alertClients(): string[] {
    return (this.db.prepare('SELECT DISTINCT client_id FROM map_places').all() as Array<{ client_id: string }>).map((r) => r.client_id);
  }
  lastAlert(clientId: string, placeId: string) {
    const r = this.db.prepare('SELECT last_alert_at FROM map_alert_state WHERE client_id = ? AND place_id = ?').get(clientId, placeId) as { last_alert_at: string } | undefined;
    return r?.last_alert_at ?? null;
  }
  markAlert(clientId: string, placeId: string, at: string) {
    this.db.prepare('INSERT INTO map_alert_state (client_id, place_id, last_alert_at) VALUES (?, ?, ?) ON CONFLICT(client_id, place_id) DO UPDATE SET last_alert_at = excluded.last_alert_at').run(clientId, placeId, at);
  }
}

const ALERT_LOOKBACK_MS = 24 * 3_600_000;
const MAX_ALERTS_PER_PLACE_TICK = 5;
const alertSeverity = (s: Severity) => (s === 'Critical' ? 'critical' as const : s === 'High' ? 'warning' as const : 'info' as const);

/**
 * In-app alerts for new events that fall inside a saved place with alerts switched on. Only records with provider or
 * analyst coordinates can match (country-centre markers never do). Each place and event gets one alert (dedupe key), and
 * a place stays quiet for its cooldown after alerting. These are geographic matches, not confirmed business impact.
 */
export function evaluatePlaceAlerts(deps: MapDeps, places: PlaceStore): { created: number } {
  let created = 0;
  for (const clientId of places.alertClients()) {
    const mine = places.list(clientId).filter((p) => p.alert.enabled);
    if (mine.length === 0) continue;
    const from = new Date(deps.now.getTime() - ALERT_LOOKBACK_MS).toISOString();
    const data = buildMapData(deps, clientId, from, deps.now.toISOString());
    for (const place of mine) {
      const last = places.lastAlert(clientId, place.id);
      if (last && deps.now.getTime() - Date.parse(last) < place.alert.cooldownHours * 3_600_000) continue;
      const since = place.alert.since ? Date.parse(place.alert.since) : 0;
      const seen = new Set<string>();
      const matches = data.features
        .filter((f) => (f.precision === 'source' || f.precision === 'analyst') && Date.parse(f.time) > since
          && meetsSeverity(f.severity, place.alert.minSeverity) && (place.alert.categories.length === 0 || place.alert.categories.includes(f.category))
          && placeContains(place, f.lat, f.lng))
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Date.parse(b.time) - Date.parse(a.time))
        .filter((f) => { const key = f.groupId ?? f.id; if (seen.has(key)) return false; seen.add(key); return true; })
        .slice(0, MAX_ALERTS_PER_PLACE_TICK);
      let made = 0;
      for (const f of matches) {
        const km = place.lat !== null && place.lng !== null ? Math.round(distanceKm(place.lat, place.lng, f.lat, f.lng)) : null;
        const ok = deps.analysis.createAlert(clientId, {
          kind: 'map-aoi', dedupeKey: `map-aoi:${place.id}:${f.groupId ?? f.id}`, severity: alertSeverity(f.severity),
          title: `Geographic match near ${place.name}: ${f.title}`.slice(0, 200),
          detail: `${f.sourceName} reports this inside "${place.name}"${km === null ? '' : `, about ${km} km from its centre`}. Severity: ${f.severity}. This is a geographic match, not confirmed business impact.`,
          link: { view: 'Map', id: f.id },
        }, deps.now.toISOString());
        if (ok) made += 1;
      }
      if (made > 0) { places.markAlert(clientId, place.id, deps.now.toISOString()); created += made; }
    }
  }
  return { created };
}
