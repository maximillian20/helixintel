import { SEVERITIES, SEVERITY_RANK, type Severity } from './feedTypes';
import type { Aircraft, MapFeature, MapFilters, MapPlace } from './mapTypes';

// ---------------------------------------------------------------- geometry
const EARTH_KM = 6371.0088;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Bounds = [number, number, number, number]; // south, west, north, east

export function inBounds(lat: number, lng: number, b: Bounds) {
  if (lat < b[0] || lat > b[2]) return false;
  // A box that crosses the antimeridian has west > east.
  return b[1] <= b[3] ? lng >= b[1] && lng <= b[3] : lng >= b[1] || lng <= b[3];
}

const KM_PER_NM = 1.852;

/**
 * The smallest circle (centre = middle of the box, radius = distance to the farthest corner) that covers a box,
 * as ADSB.lol's point query takes a centre and a radius in nautical miles.
 */
export function boundsToCircle(b: Bounds, maxRadiusNm: number) {
  const lat = (b[0] + b[2]) / 2;
  let west = b[1];
  let east = b[3];
  if (west > east) east += 360;
  let lon = (west + east) / 2;
  if (lon > 180) lon -= 360;
  const corners: Array<[number, number]> = [[b[0], b[1]], [b[0], b[3]], [b[2], b[1]], [b[2], b[3]]];
  const km = Math.max(...corners.map(([cLat, cLng]) => distanceKm(lat, lon, cLat, cLng)));
  const radiusNm = Math.ceil(km / KM_PER_NM);
  return { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)), radiusNm, tooLarge: radiusNm > maxRadiusNm };
}

// ---------------------------------------------------------------- severity
export type SeverityCounts = Record<Severity, number>;
export function emptyCounts(): SeverityCounts { return { Critical: 0, High: 0, Medium: 0, Low: 0, Unassessed: 0 }; }
export function highestSeverity(counts: SeverityCounts): Severity { return SEVERITIES.find((s) => counts[s] > 0) ?? 'Unassessed'; }
export function countSeverities(features: Array<Pick<MapFeature, 'severity'>>): SeverityCounts {
  const counts = emptyCounts();
  for (const f of features) counts[f.severity] += 1;
  return counts;
}
export const meetsSeverity = (severity: Severity, min: Severity | 'Any') => min === 'Any' || SEVERITY_RANK[severity] >= SEVERITY_RANK[min as Severity];

// ---------------------------------------------------------------- time
const DAY = 86_400_000;
export type TimeRange = { from: string; to: string; includesNow: boolean; label: string };

/** Resolves the time-range controls. Custom dates are whole UTC days; the end day is inclusive. */
export function resolveRange(filters: Pick<MapFilters, 'preset' | 'customFrom' | 'customTo'>, now: number): TimeRange {
  if (filters.preset === '24h') return { from: new Date(now - DAY).toISOString(), to: new Date(now).toISOString(), includesNow: true, label: 'Last 24 hours' };
  if (filters.preset === '7d') return { from: new Date(now - 7 * DAY).toISOString(), to: new Date(now).toISOString(), includesNow: true, label: 'Last 7 days' };
  const start = Date.parse(`${filters.customFrom}T00:00:00Z`);
  const endDay = Date.parse(`${filters.customTo}T00:00:00Z`);
  const from = Number.isNaN(start) ? now - 7 * DAY : start;
  const to = Number.isNaN(endDay) ? now : Math.min(endDay + DAY - 1, now);
  return {
    from: new Date(Math.min(from, to)).toISOString(), to: new Date(to).toISOString(), includesNow: to >= now - 60_000,
    label: `${filters.customFrom || '…'} to ${filters.customTo || '…'} (UTC)`,
  };
}

// ---------------------------------------------------------------- filters
export function filterFeatures(features: MapFeature[], f: MapFilters): MapFeature[] {
  return features.filter((x) => {
    if (f.country && !x.countries.some((c) => c.code === f.country)) return false;
    if (f.category && x.category !== f.category) return false;
    if (f.severity !== 'All' && x.severity !== f.severity) return false;
    if (f.source && x.sourceId !== f.source) return false;
    if (f.review !== 'All' && x.reviewStatus !== f.review) return false;
    if (f.area && !inBounds(x.lat, x.lng, f.area)) return false;
    if (f.keywords && f.keywords.length > 0) {
      const text = `${x.title} ${x.summary}`.toLowerCase();
      if (!f.keywords.some((word) => text.includes(word))) return false;
    }
    return true;
  });
}

/** Number of records and of distinct events. Records that were linked as the same hazard count once as an event. */
export function eventCounts(features: MapFeature[]) {
  const events = new Set<string>();
  for (const f of features) events.add(f.groupId ?? f.id);
  return { records: features.length, events: events.size };
}

// ---------------------------------------------------------------- duplicate linking
export function hazardTypeFrom(text: string): string | null {
  const t = text.toLowerCase();
  if (/earthquake|seismic/.test(t)) return 'earthquake';
  if (/cyclone|hurricane|typhoon|tropical storm|severe storm/.test(t)) return 'cyclone';
  if (/flood/.test(t)) return 'flood';
  if (/volcan|eruption/.test(t)) return 'volcano';
  if (/wildfire|forest fire|fires?\b/.test(t)) return 'wildfire';
  if (/drought/.test(t)) return 'drought';
  if (/landslide/.test(t)) return 'landslide';
  return null;
}

/** Documented thresholds: records are linked only when type, distance and time all agree. */
export const DUPLICATE_RULES: Record<string, { km: number; hours: number }> = {
  earthquake: { km: 100, hours: 6 },
  cyclone: { km: 500, hours: 120 },
  default: { km: 300, hours: 168 },
};

/**
 * Links hazard records from different providers that probably describe one event. Only records with provider
 * coordinates are compared, and records from the same provider are never merged. Every record is kept.
 */
export function linkDuplicates(features: MapFeature[]): MapFeature[] {
  const candidates = features.filter((f) => f.kind === 'hazard' && f.hazardType && f.precision === 'source');
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const f of candidates) parent.set(f.id, f.id);
  const byType = new Map<string, MapFeature[]>();
  for (const f of candidates) byType.set(f.hazardType!, [...(byType.get(f.hazardType!) ?? []), f]);
  for (const list of byType.values()) {
    list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    for (let i = 0; i < list.length; i += 1) {
      const rule = DUPLICATE_RULES[list[i].hazardType!] ?? DUPLICATE_RULES.default;
      for (let j = i + 1; j < list.length; j += 1) {
        if (Date.parse(list[j].time) - Date.parse(list[i].time) > rule.hours * 3_600_000) break;
        if (list[i].sourceId === list[j].sourceId) continue;
        if (distanceKm(list[i].lat, list[i].lng, list[j].lat, list[j].lng) <= rule.km) parent.set(find(list[i].id), find(list[j].id));
      }
    }
  }
  const sizes = new Map<string, number>();
  for (const f of candidates) sizes.set(find(f.id), (sizes.get(find(f.id)) ?? 0) + 1);
  return features.map((f) => {
    if (!parent.has(f.id)) return f;
    const root = find(f.id);
    return (sizes.get(root) ?? 0) > 1 ? { ...f, groupId: `dup:${root}` } : f;
  });
}

// ---------------------------------------------------------------- clustering
export type Cluster = {
  key: string;
  lat: number;
  lng: number;
  features: MapFeature[];
  severity: Severity;
  counts: SeverityCounts;
  records: number;
  events: number;
  /** True when every member has provider or analyst coordinates. */
  allPrecise: boolean;
};

const TILE = 256;
export function project(lat: number, lng: number, zoom: number) {
  const scale = TILE * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const s = Math.sin(rad(Math.max(-85.0511, Math.min(85.0511, lat))));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/**
 * Greedy grid clustering in screen space. Records at the same coordinates always share a cluster. At or above
 * maxZoom nothing merges except identical coordinates, so a cluster can always be opened to its members.
 */
export function clusterFeatures(features: MapFeature[], zoom: number, cellPx = 56, maxZoom = 11): Cluster[] {
  const cells = new Map<string, MapFeature[]>();
  const effectiveCell = zoom >= maxZoom ? 0.5 : cellPx;
  for (const f of features) {
    const p = project(f.lat, f.lng, zoom);
    const key = `${Math.floor(p.x / effectiveCell)}:${Math.floor(p.y / effectiveCell)}`;
    const list = cells.get(key);
    if (list) list.push(f); else cells.set(key, [f]);
  }
  const out: Cluster[] = [];
  for (const [key, list] of cells) {
    const counts = countSeverities(list);
    const lat = list.reduce((s, f) => s + f.lat, 0) / list.length;
    const lng = list.reduce((s, f) => s + f.lng, 0) / list.length;
    const ev = eventCounts(list);
    out.push({
      key: `${zoom >= maxZoom ? 'z' : ''}${key}`, lat, lng, features: [...list].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Date.parse(b.time) - Date.parse(a.time)),
      severity: highestSeverity(counts), counts, records: ev.records, events: ev.events,
      allPrecise: list.every((f) => f.precision === 'source' || f.precision === 'analyst'),
    });
  }
  return out.sort((a, b) => b.records - a.records || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- aircraft
/** Position-age thresholds. The provider documents no freshness limit, so these are this app's own and are shown in the UI. */
export const AIRCRAFT_STALE_AFTER_SEC = 30;
export const AIRCRAFT_EXPIRE_AFTER_SEC = 120;

export type AircraftState = 'fresh' | 'stale' | 'expired';
/** Age is measured from the observation time to `now`, so a position keeps ageing between refreshes. */
export function aircraftAge(a: Pick<Aircraft, 'observedAt'>, now: number) {
  return Math.max(0, (now - Date.parse(a.observedAt)) / 1000);
}
export function aircraftState(ageSec: number): AircraftState {
  if (ageSec > AIRCRAFT_EXPIRE_AFTER_SEC) return 'expired';
  return ageSec > AIRCRAFT_STALE_AFTER_SEC ? 'stale' : 'fresh';
}
export function aircraftOpacity(ageSec: number) {
  const state = aircraftState(ageSec);
  if (state === 'expired') return 0;
  if (state === 'fresh') return 1;
  return Math.max(0.25, 1 - ((ageSec - AIRCRAFT_STALE_AFTER_SEC) / (AIRCRAFT_EXPIRE_AFTER_SEC - AIRCRAFT_STALE_AFTER_SEC)) * 0.75);
}

// ---------------------------------------------------------------- places
export function placeContains(place: MapPlace, lat: number, lng: number) {
  if (place.kind === 'bbox' && place.bbox) return inBounds(lat, lng, place.bbox);
  if (place.lat === null || place.lng === null) return false;
  const radius = place.radiusKm ?? 0; // a point (business location) uses its alert radius
  return distanceKm(place.lat, place.lng, lat, lng) <= radius;
}
