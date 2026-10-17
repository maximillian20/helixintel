import type { CountryRef, ReviewStatus, Severity } from './feedTypes';

/** Layers the Map can show. Event layers produce MapFeature records; the rest have their own data types. */
export const MAP_LAYERS = [
  { id: 'reports', label: 'News and agency reports', group: 'events' },
  { id: 'gdelt', label: 'GDELT news mentions', group: 'events' },
  { id: 'reliefweb', label: 'ReliefWeb reports', group: 'events' },
  { id: 'gdacs', label: 'GDACS disaster alerts', group: 'events' },
  { id: 'usgs', label: 'USGS earthquakes', group: 'events' },
  { id: 'eonet', label: 'NASA EONET natural events', group: 'events' },
  { id: 'incidents', label: 'Incidents', group: 'events' },
  { id: 'places', label: 'Saved places and areas', group: 'other' },
  { id: 'countries', label: 'Country risk shading', group: 'other' },
  { id: 'aircraft', label: 'Aircraft (ADSB.lol)', group: 'other' },
] as const;
export type LayerId = (typeof MAP_LAYERS)[number]['id'];
export type EventLayerId = Extract<LayerId, 'reports' | 'gdelt' | 'reliefweb' | 'gdacs' | 'usgs' | 'eonet' | 'incidents'>;
export const EVENT_LAYERS: EventLayerId[] = ['reports', 'gdelt', 'reliefweb', 'gdacs', 'usgs', 'eonet', 'incidents'];

/** Layer for a feed source id. Everything that is not GDACS, GDELT or ReliefWeb is a news/agency report. */
export function layerForSource(sourceId: string): EventLayerId {
  if (sourceId === 'gdacs') return 'gdacs';
  if (sourceId === 'gdelt') return 'gdelt';
  if (sourceId === 'reliefweb') return 'reliefweb';
  return 'reports';
}

/**
 * source    = coordinates supplied by the data provider for the event
 * analyst   = coordinates typed in by an analyst on an incident
 * reported  = a place named in news coverage (not a confirmed event coordinate); drawn at the country centre
 * approximate = a single affected country, drawn at the country centre
 */
export type Precision = 'source' | 'analyst' | 'reported' | 'approximate';
export const PRECISION_LABELS: Record<Precision, string> = {
  source: 'Source coordinates',
  analyst: 'Analyst-entered coordinates',
  reported: 'Reported location (country centre, approximate)',
  approximate: 'Country centre (approximate)',
};

export type TimeBasis = 'event' | 'published' | 'created';
export const TIME_BASIS_LABELS: Record<TimeBasis, string> = {
  event: 'Event time',
  published: 'Publication time',
  created: 'Incident date',
};

export type MapFeature = {
  id: string;
  layer: EventLayerId;
  kind: 'report' | 'hazard' | 'incident';
  sourceId: string;
  sourceName: string;
  title: string;
  summary: string;
  url: string | null;
  /** The timestamp the time filter uses for this record (see timeBasis). */
  time: string;
  timeBasis: TimeBasis;
  retrievedAt: string | null;
  lat: number;
  lng: number;
  precision: Precision;
  locationLabel: string;
  /** Outer ring of the source polygon as [lng, lat] pairs, when the source supplies area geometry. */
  polygon: number[][] | null;
  /** Business category id (conflict, political, humanitarian, cyber, natural-hazard, other). */
  category: string;
  categoryLabel: string;
  hazardType: string | null;
  severity: Severity;
  severityBasis: string;
  /** Source-native measurements, shown as supplied and never converted to a severity. */
  native: Array<{ label: string; value: string }>;
  countries: CountryRef[];
  reviewStatus: ReviewStatus | null;
  watchlisted: boolean | null;
  /** Article id, hazard id or incident id in the platform. */
  refId: string;
  /** Records from different providers that appear to describe the same hazard share a group id. */
  groupId: string | null;
  /** Incident ids that cite this report. */
  incidentIds: string[];
};

export type UnlocatedItem = { id: string; kind: 'report' | 'incident'; title: string; source: string; time: string; reason: string; url: string };

export type LayerStatus = {
  id: string;
  name: string;
  layer: LayerId | null;
  status: 'healthy' | 'stale' | 'unavailable' | 'not_checked' | 'setup_required';
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  records: number;
  note: string;
  attribution: string;
  termsUrl: string;
  setup?: string;
};

export type MapDataResponse = {
  serverTime: string;
  from: string;
  to: string;
  features: MapFeature[];
  /** Number of matching records that were left out because of the response cap. */
  truncated: number;
  unlocated: UnlocatedItem[];
  unlocatedTotal: number;
  geoStatus: LayerStatus[];
};

export type MapConfig = {
  tiles: { url: string; attribution: string; maxZoom: number; provider: string; productionNote: string | null };
  adsb: {
    enabled: boolean; refreshMs: number; minRefreshMs: number; maxRadiusNm: number; base: string;
    contactConfirmed: boolean; licence: string; docsUrl: string;
  };
  aircraft: { staleAfterSec: number; expireAfterSec: number };
  boundaries: { enabled: boolean };
  serverTime: string;
};

export type Aircraft = {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  lat: number;
  lng: number;
  /** Barometric altitude in feet, 'ground' when the transponder reports ground, null when not supplied. */
  altitudeFt: number | 'ground' | null;
  speedKt: number | null;
  headingDeg: number | null;
  verticalRateFpm: number | null;
  squawk: string | null;
  /** Seconds since the last position update, as supplied by the provider. */
  positionAgeSec: number | null;
  /** Time the position was observed: response time minus positionAgeSec. */
  observedAt: string;
};

export type AircraftResponse = {
  aircraft: Aircraft[];
  fetchedAt: string;
  cached: boolean;
  status: 'ok' | 'too_large' | 'unavailable' | 'disabled';
  message: string | null;
  query: { lat: number; lon: number; radiusNm: number } | null;
  /** Total returned by the provider for the query circle, before cutting to the visible box. */
  providerTotal: number;
};

export type PlaceKind = 'point' | 'radius' | 'bbox';
export type PlaceAlertRule = {
  enabled: boolean;
  minSeverity: Severity | 'Any';
  /** Empty = every category. */
  categories: string[];
  cooldownHours: number;
  /** Only events with a time after this are considered, so enabling alerts never back-fills old events. */
  since: string | null;
};
export type MapPlace = {
  id: string;
  name: string;
  kind: PlaceKind;
  lat: number | null;
  lng: number | null;
  radiusKm: number | null;
  /** [south, west, north, east] */
  bbox: [number, number, number, number] | null;
  notes: string;
  alert: PlaceAlertRule;
  createdAt: string;
  updatedAt: string;
};
export type PlaceInput = Omit<MapPlace, 'id' | 'createdAt' | 'updatedAt'>;

export type CountryRiskEntry = {
  code: string;
  name: string;
  rating: 'Low' | 'Moderate' | 'Elevated' | 'High' | 'Severe';
  assessedAt: string;
  categories: Array<{ label: string; rating: string }>;
};
export type CountryRiskResponse = { items: CountryRiskEntry[]; centroids: Record<string, [number, number]> };

export type BoundariesResponse = {
  status: 'ok' | 'unavailable';
  message: string | null;
  fetchedAt: string | null;
  source: string;
  attribution: string;
  /** ISO-3166 alpha-2 code to GeoJSON Polygon/MultiPolygon geometry. */
  shapes: Record<string, { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }>;
};

/** Saved view state, restored after a refresh. */
export type MapView = { lat: number; lng: number; zoom: number };

export type TimePreset = '24h' | '7d' | 'custom';
export type MapFilters = {
  country: string;
  category: string;
  severity: 'All' | Severity;
  source: string;
  review: 'All' | ReviewStatus;
  preset: TimePreset;
  /** yyyy-mm-dd, UTC, used when preset = custom */
  customFrom: string;
  customTo: string;
  /** Show only records inside the map's bounds when the person pressed "Search this area". */
  area: [number, number, number, number] | null;
  /** Plain words from the plain-language search; a record must mention at least one in its title or summary. */
  keywords?: string[];
};
