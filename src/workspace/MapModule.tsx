import { MapAiSearch } from './AiPanels.tsx';
import L from 'leaflet';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, GeoJSON, MapContainer, Marker, Polygon, Popup, Rectangle, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { sortedCountries } from '../data/countries.ts';
import { saveItemState } from '../data/feedApi.ts';
import { SEVERITIES, SEVERITY_RANK } from '../data/feedTypes.ts';
import { mapFetch, useAircraft, useMapData, useMapResource } from '../data/mapApi.ts';
import {
  aircraftAge, aircraftOpacity, aircraftState, clusterFeatures, eventCounts, filterFeatures, resolveRange, type Bounds, type Cluster,
} from '../data/mapLogic.ts';
import {
  EVENT_LAYERS, MAP_LAYERS, PRECISION_LABELS, TIME_BASIS_LABELS, type BoundariesResponse, type CountryRiskResponse, type LayerId, type LayerStatus, type MapConfig, type MapFeature,
  type MapFilters, type MapPlace, type MapView,
} from '../data/mapTypes.ts';
import { wsFetch } from '../data/workspaceApi.ts';
import { IncidentLinkDialog } from './IncidentsModule.tsx';
import { AIRCRAFT_COLOR, aircraftIcon, eventIcon, placeIcon } from './mapIcons.ts';
import { BreakdownText, CATEGORY_OPTIONS, CategoryTag, FeatureDetails, Legend, PlacesTab, RISK_COLORS, SeverityChip, categoryLabel } from './MapPanels.tsx';
import { STATUS_LABEL, Notice, ago, fmt, useNow, usePersistentState, useSourceStatus, type Navigate, type SourceStatusItem } from './shared.tsx';

const DEFAULT_VIEW: MapView = { lat: 25, lng: 20, zoom: 2 };
const DEFAULT_FILTERS: MapFilters = { country: '', category: '', severity: 'All', source: '', review: 'All', preset: '7d', customFrom: '', customTo: '', area: null };
const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  reports: true, gdelt: true, reliefweb: true, gdacs: true, usgs: true, eonet: true, incidents: true, places: true, countries: false, aircraft: false,
};
const DEFAULT_UI = { tab: 'results' as 'results' | 'places', layersOpen: typeof window === 'undefined' || window.innerWidth > 680, legendCollapsed: true, panelOpen: true };
const countryOptions = sortedCountries.filter((c) => c.code !== 'GLOBAL' && c.code !== 'UNKNOWN');
const CLUSTER_STOP_ZOOM = 16;
const WORLD_BOUNDS: L.LatLngBoundsLiteral = [[-55, -170], [75, 170]];
const LIST_PAGE = 120;
const SOURCE_IDS: Record<string, string[]> = { gdacs: ['gdacs'], gdelt: ['gdelt'], reliefweb: ['reliefweb'] };

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
type LayerInfo = { label: string; tone: Tone; lastSuccessAt: string | null; detail: string };
const BAD: Record<SourceStatusItem['status'], number> = { healthy: 0, not_checked: 1, stale: 2, unavailable: 3, setup_required: 3 };
const toneOf = (s: SourceStatusItem['status']): Tone => (s === 'healthy' ? 'ok' : s === 'stale' || s === 'not_checked' ? 'warn' : 'bad');

const clampBounds = (b: Bounds): Bounds => [Math.max(-85, b[0]), Math.max(-180, b[1]), Math.min(85, b[2]), Math.min(180, b[3])];

// ------------------------------------------------------------------ map children

function ViewSync({ onView }: { onView: (view: MapView, bounds: Bounds) => void }) {
  const map = useMap();
  const emit = useCallback(() => {
    const c = map.getCenter();
    const b = map.getBounds();
    onView({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }, clampBounds([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]));
  }, [map, onView]);
  useMapEvents({ moveend: emit, zoomend: emit, resize: emit });
  useEffect(() => { emit(); }, [emit]);
  return null;
}

function PickHandler({ active, onPick }: { active: boolean; onPick: (p: { lat: number; lng: number }) => void }) {
  useMapEvents({ click: (e) => { if (active) onPick({ lat: e.latlng.lat, lng: e.latlng.lng }); } });
  return null;
}

const ClusterMarker = memo(function ClusterMarker({ c, selected, hovered, onCluster, onHover }: {
  c: Cluster; selected: boolean; hovered: boolean; onCluster: (c: Cluster) => void; onHover: (ids: string[]) => void;
}) {
  const single = c.features.length === 1 ? c.features[0] : null;
  const label = single
    ? `${single.severity} severity, ${categoryLabel(single.category)}: ${single.title}`
    : `${c.records} records (${c.events} distinct events), highest severity ${c.severity}`;
  const breakdown = SEVERITIES.filter((s) => c.counts[s] > 0).map((s) => `${c.counts[s]} ${s}`).join(', ');
  const icon = useMemo(() => eventIcon({
    key: single?.id ?? c.key, severity: c.severity, category: single?.category ?? null, count: c.records, events: c.events, approximate: !c.allPrecise, selected, hovered, label,
  }), [c, single, selected, hovered, label]);
  return (
    <Marker
      position={[c.lat, c.lng]}
      icon={icon}
      title={single ? `${single.title}\n${single.severity} · ${PRECISION_LABELS[single.precision]}` : `${label}\n${breakdown}${c.allPrecise ? '' : '\nIncludes approximate country-centre positions'}`}
      zIndexOffset={selected ? 1000 : SEVERITY_RANK[c.severity] * 10}
      eventHandlers={{ click: () => onCluster(c), mouseover: () => onHover(c.features.map((f) => f.id)), mouseout: () => onHover([]) }}
    />
  );
});

function EventMarkers({ clusters, selectedId, hover, onCluster, onHover }: {
  clusters: Cluster[]; selectedId: string; hover: string[]; onCluster: (c: Cluster) => void; onHover: (ids: string[]) => void;
}) {
  return (
    <>
      {clusters.map((c) => (
        <ClusterMarker key={c.key} c={c} selected={c.features.some((f) => f.id === selectedId)} hovered={c.features.some((f) => hover.includes(f.id))} onCluster={onCluster} onHover={onHover} />
      ))}
    </>
  );
}

function AircraftLayer({ aircraft, selectedHex, onSelect }: { aircraft: NonNullable<ReturnType<typeof useAircraft>['data']>['aircraft']; selectedHex: string; onSelect: (hex: string) => void }) {
  const now = useNow(2000);
  return (
    <>
      {aircraft.map((a) => {
        const age = aircraftAge(a, now);
        if (aircraftState(age) === 'expired') return null;
        const opacity = aircraftOpacity(age);
        return (
          <Marker key={a.hex} position={[a.lat, a.lng]} icon={aircraftIcon(a, opacity, a.hex === selectedHex)} zIndexOffset={-500} eventHandlers={{ click: () => onSelect(a.hex) }}>
            <Popup>
              <div className="mp-ac-popup" data-testid="aircraft-popup">
                <strong>{a.callsign ?? `ICAO ${a.hex.toUpperCase()}`}</strong>
                <dl>
                  {a.callsign && <><dt>ICAO 24-bit</dt><dd>{a.hex.toUpperCase()}</dd></>}
                  {a.registration && <><dt>Registration</dt><dd>{a.registration}</dd></>}
                  {a.type && <><dt>Type code</dt><dd>{a.type}</dd></>}
                  {a.altitudeFt !== null && <><dt>Altitude (barometric)</dt><dd>{a.altitudeFt === 'ground' ? 'on ground' : `${a.altitudeFt.toLocaleString('en-GB')} ft`}</dd></>}
                  {a.speedKt !== null && <><dt>Ground speed</dt><dd>{Math.round(a.speedKt)} kt</dd></>}
                  {a.headingDeg !== null && <><dt>Track</dt><dd>{Math.round(a.headingDeg)}°</dd></>}
                  {a.verticalRateFpm !== null && <><dt>Vertical rate</dt><dd>{a.verticalRateFpm} ft/min</dd></>}
                  {a.squawk && <><dt>Squawk</dt><dd>{a.squawk}</dd></>}
                  <dt>Position observed</dt><dd>{fmt(a.observedAt)} ({Math.round(age)} s ago){aircraftState(age) === 'stale' ? ' · stale' : ''}</dd>
                </dl>
                <small>Airline, origin, destination and route are not provided by this data and are not inferred. Source: ADSB.lol community receivers (ODbL).</small>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

function PlacesLayer({ places, selectedId, onSelect }: { places: MapPlace[]; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <>
      {places.map((p) => {
        const sel = p.id === selectedId;
        const style = { color: sel ? '#38bdf8' : '#60a5fa', weight: sel ? 3 : 2, dashArray: '6 5', fillOpacity: 0.06 };
        return (
          <span key={p.id}>
            {p.kind === 'bbox' && p.bbox && (
              <Rectangle bounds={[[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]]} pathOptions={style} eventHandlers={{ click: () => onSelect(p.id) }}>
                <Tooltip sticky>{p.name} (box)</Tooltip>
              </Rectangle>
            )}
            {p.kind !== 'bbox' && p.lat !== null && p.lng !== null && (
              <>
                {p.radiusKm !== null && <Circle center={[p.lat, p.lng]} radius={p.radiusKm * 1000} pathOptions={style} />}
                <Marker position={[p.lat, p.lng]} icon={placeIcon(sel)} zIndexOffset={900} eventHandlers={{ click: () => onSelect(p.id) }}>
                  <Tooltip>{p.name}</Tooltip>
                </Marker>
              </>
            )}
          </span>
        );
      })}
    </>
  );
}

function CountryShading({ risk, boundaries, onOpen }: { risk: CountryRiskResponse; boundaries: BoundariesResponse | null; onOpen: (code: string) => void }) {
  const shapes = boundaries?.status === 'ok' ? boundaries.shapes : null;
  return (
    <>
      {risk.items.map((c) => {
        const fill = RISK_COLORS[c.rating];
        const tip = (
          <Tooltip sticky>
            <strong>{c.name}</strong>: {c.rating}<br />{c.categories.slice(0, 3).map((x) => `${x.label} ${x.rating}`).join(' · ')}
          </Tooltip>
        );
        const shape = shapes?.[c.code];
        if (shape) {
          return (
            <GeoJSON key={`${c.code}-${c.rating}`} data={{ type: 'Feature', properties: {}, geometry: shape } as never} style={() => ({ color: '#312e81', weight: 1, fillColor: fill, fillOpacity: 0.55 })} eventHandlers={{ click: () => onOpen(c.code) }}>{tip}</GeoJSON>
          );
        }
        const centre = risk.centroids[c.code];
        return centre ? (
          <Circle key={`${c.code}-disc`} center={centre} radius={300_000} pathOptions={{ color: '#312e81', weight: 1, dashArray: '4 4', fillColor: fill, fillOpacity: 0.4 }} eventHandlers={{ click: () => onOpen(c.code) }}>{tip}</Circle>
        ) : null;
      })}
    </>
  );
}

// ------------------------------------------------------------------ main component

export function MapModule({ focusId, onNavigate }: { focusId?: string; onNavigate: Navigate }) {
  const [filters, setFilters] = usePersistentState<MapFilters>('map-filters', DEFAULT_FILTERS);
  const [layers, setLayers] = usePersistentState<Record<LayerId, boolean>>('map-layers', DEFAULT_LAYERS);
  const [view, setView] = usePersistentState<MapView>('map-view', DEFAULT_VIEW);
  const [ui, setUi] = usePersistentState('map-ui', DEFAULT_UI);
  const initialView = useRef(view).current;

  const config = useMapResource<MapConfig>('/config');
  const { data, error, loading, reload } = useMapData(filters);
  const placesRes = useMapResource<{ items: MapPlace[] }>('/places', { poll: true });
  const risk = useMapResource<CountryRiskResponse>(layers.countries ? '/countries' : null, { poll: true });
  const boundaries = useMapResource<BoundariesResponse>(layers.countries && config.data?.boundaries.enabled !== false ? '/boundaries' : null);
  const { sources } = useSourceStatus();
  const now = useNow(30_000);

  const [map, setMap] = useState<L.Map | null>(null);
  const [zoom, setZoom] = useState(initialView.zoom);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [hover, setHover] = useState<string[]>([]);
  const [card, setCard] = useState<{ lat: number; lng: number; features: MapFeature[] } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [listLimit, setListLimit] = useState(LIST_PAGE);
  const [showUnlocated, setShowUnlocated] = useState(false);
  const [placeId, setPlaceId] = useState('');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null);
  const [dialog, setDialog] = useState<string[] | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [watchOverride, setWatchOverride] = useState<Record<string, boolean>>({});
  const [focusNote, setFocusNote] = useState('');
  const [refreshNote, setRefreshNote] = useState('');
  const [aircraftId, setAircraftId] = useState('');
  const [aircraftRetry, setAircraftRetry] = useState(0);
  const [tiles, setTiles] = useState({ loaded: 0, failed: 0 });
  const tileRef = useRef<L.TileLayer | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const handledFocus = useRef('');

  const range = useMemo(() => resolveRange(filters, now), [filters, now]);
  const tileCfg = config.data?.tiles;
  const adsb = config.data?.adsb;

  // ---- derived data
  const allFeatures = data?.features ?? [];
  const layered = useMemo(() => allFeatures.filter((f) => layers[f.layer]), [allFeatures, layers]);
  const filtered = useMemo(() => filterFeatures(layered, filters), [layered, filters]);
  const counts = useMemo(() => eventCounts(filtered), [filtered]);
  const clusters = useMemo(() => clusterFeatures(filtered, zoom, 56, CLUSTER_STOP_ZOOM), [filtered, zoom]);
  const ordered = useMemo(
    () => [...filtered].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Date.parse(b.time) - Date.parse(a.time)),
    [filtered],
  );
  const selected = useMemo(() => allFeatures.find((f) => f.id === selectedId) ?? null, [allFeatures, selectedId]);
  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of allFeatures) seen.set(f.sourceId, f.sourceName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allFeatures]);
  const places = placesRes.data?.items ?? [];

  // ---- aircraft
  const aircraftBlocked = !range.includesNow;
  const aircraftOn = layers.aircraft && !aircraftBlocked && adsb?.enabled !== false;
  const aircraft = useAircraft(aircraftOn, bounds, adsb?.refreshMs ?? 15_000, 600);
  void aircraftRetry;
  const aircraftList = aircraftOn ? aircraft.data?.aircraft ?? [] : [];
  const liveAircraft = aircraftList.filter((a) => aircraftState(aircraftAge(a, now)) !== 'expired');

  // ---- layer status
  const layerInfo = useCallback((id: LayerId): LayerInfo => {
    const byId = new Map((sources ?? []).map((s) => [s.id, s]));
    const geo = new Map<string, LayerStatus>((data?.geoStatus ?? []).map((s) => [s.id, s]));
    if (id === 'usgs' || id === 'eonet') {
      const s = geo.get(id);
      if (!s) return { label: 'Not checked yet', tone: 'warn', lastSuccessAt: null, detail: '' };
      const tone = s.status === 'healthy' ? 'ok' : s.status === 'stale' || s.status === 'not_checked' ? 'warn' : 'bad';
      return { label: STATUS_LABEL[s.status], tone, lastSuccessAt: s.lastSuccessAt, detail: s.lastError && s.status !== 'healthy' ? `Last error: ${s.lastError}${s.lastSuccessAt ? ' Showing previously retrieved data.' : ''}` : s.note };
    }
    if (id === 'reports' || id === 'gdelt' || id === 'reliefweb' || id === 'gdacs') {
      let ids = SOURCE_IDS[id];
      if (!ids) {
        const found = [...new Set(allFeatures.filter((f) => f.layer === 'reports').map((f) => f.sourceId))];
        ids = found.length ? found : ['bbc-world', 'un-news'];
      }
      const rows = ids.map((x) => byId.get(x)).filter((x): x is SourceStatusItem => Boolean(x));
      if (rows.length === 0) return { label: sources ? 'Not checked yet' : 'Loading…', tone: 'warn', lastSuccessAt: null, detail: '' };
      const worst = rows.reduce((a, b) => (BAD[b.status] > BAD[a.status] ? b : a));
      const last = rows.map((r) => r.lastSuccessAt).filter(Boolean).sort().pop() ?? null;
      const detail = worst.status === 'setup_required' ? (worst.setup?.instructions ?? 'A server credential is required.') : worst.status === 'unavailable' && worst.lastError ? `Last error: ${worst.lastError}` : '';
      return { label: STATUS_LABEL[worst.status], tone: toneOf(worst.status), lastSuccessAt: last, detail };
    }
    if (id === 'incidents' || id === 'places') return { label: 'Your records', tone: 'idle', lastSuccessAt: null, detail: '' };
    if (id === 'countries') {
      if (!layers.countries) return { label: 'Off', tone: 'idle', lastSuccessAt: null, detail: '' };
      const b = boundaries.data;
      if (boundaries.error || b?.status === 'unavailable') return { label: 'Outlines unavailable', tone: 'bad', lastSuccessAt: null, detail: `${b?.message ?? boundaries.error}. Showing country-centre discs instead of outlines.` };
      return { label: b ? 'Ready' : 'Loading…', tone: b ? 'ok' : 'warn', lastSuccessAt: b?.fetchedAt ?? null, detail: '' };
    }
    // aircraft
    if (aircraftBlocked) return { label: 'Not available for past dates', tone: 'idle', lastSuccessAt: null, detail: '' };
    if (adsb?.enabled === false) return { label: 'Disabled on server', tone: 'bad', lastSuccessAt: null, detail: '' };
    if (!layers.aircraft) return { label: 'Off', tone: 'idle', lastSuccessAt: null, detail: '' };
    const d = aircraft.data;
    if (aircraft.error && !d) return { label: 'Unavailable', tone: 'bad', lastSuccessAt: null, detail: aircraft.error };
    if (!d) return { label: 'Loading…', tone: 'warn', lastSuccessAt: null, detail: '' };
    if (d.status === 'too_large') return { label: 'Zoom in to load', tone: 'warn', lastSuccessAt: null, detail: d.message ?? '' };
    if (d.status === 'unavailable' || d.status === 'disabled') return { label: 'Unavailable', tone: 'bad', lastSuccessAt: null, detail: d.message ?? '' };
    const old = now - Date.parse(d.fetchedAt) > (adsb?.refreshMs ?? 15_000) * 3 + 5_000;
    return { label: d.message || old || aircraft.error ? 'Stale' : 'Live', tone: d.message || old || aircraft.error ? 'warn' : 'ok', lastSuccessAt: d.fetchedAt, detail: d.message ?? aircraft.error };
  }, [sources, data, allFeatures, layers.countries, layers.aircraft, boundaries.data, boundaries.error, aircraftBlocked, adsb, aircraft.data, aircraft.error, now]);

  const layerCount = (id: LayerId) => (EVENT_LAYERS as string[]).includes(id) ? filtered.filter((f) => f.layer === id).length : id === 'places' ? places.length : id === 'aircraft' ? liveAircraft.length : id === 'countries' ? risk.data?.items.length ?? 0 : 0;

  // ---- actions
  const onView = useCallback((v: MapView, b: Bounds) => { setView(v); setZoom(v.zoom); setBounds(b); }, [setView]);

  const flyToFeature = useCallback((f: MapFeature) => {
    map?.flyTo([f.lat, f.lng], Math.max(map.getZoom(), f.precision === 'approximate' || f.precision === 'reported' ? 5 : 8), { duration: 0.6 });
  }, [map]);

  const selectFeature = useCallback((id: string, opts: { fly?: boolean } = {}) => {
    setSelectedId(id); setCard(null); setActionMessage('');
    const f = allFeatures.find((x) => x.id === id);
    if (f && opts.fly) flyToFeature(f);
  }, [allFeatures, flyToFeature]);

  const onCluster = useCallback((c: Cluster) => {
    if (c.features.length === 1) { selectFeature(c.features[0].id); return; }
    const coords = new Set(c.features.map((f) => `${f.lat.toFixed(4)},${f.lng.toFixed(4)}`));
    if (map && coords.size > 1) {
      const box = L.latLngBounds(c.features.map((f) => [f.lat, f.lng] as [number, number]));
      const target = map.getBoundsZoom(box, false, L.point(70, 70));
      if (target > map.getZoom() && map.getZoom() < CLUSTER_STOP_ZOOM) { map.flyToBounds(box, { padding: [70, 70], maxZoom: Math.min(CLUSTER_STOP_ZOOM, tileCfg?.maxZoom ?? 18), duration: 0.5 }); return; }
    }
    setCard({ lat: c.lat, lng: c.lng, features: c.features });
  }, [map, selectFeature, tileCfg?.maxZoom]);

  // Scroll the list to the selected record (marker -> list).
  useEffect(() => {
    if (!selectedId) return;
    const el = document.querySelector(`[data-fid="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, ordered.length]);

  // Opening the page from an alert or link focuses that record.
  useEffect(() => {
    if (!focusId || !data || handledFocus.current === focusId) return;
    handledFocus.current = focusId;
    const f = data.features.find((x) => x.id === focusId || x.refId === focusId);
    if (f) { setFocusNote(''); setLayers((l) => ({ ...l, [f.layer]: true })); selectFeature(f.id, { fly: true }); }
    else setFocusNote('The linked record is not in the current time range or has expired from the stored data. Widen the time range to find it.');
  }, [focusId, data, selectFeature, setLayers]);

  // First visit (no saved position): fit the inhabited world to whatever size the map has.
  useEffect(() => {
    if (map && initialView === DEFAULT_VIEW) map.fitBounds(WORLD_BOUNDS);
  }, [map, initialView]);

  // Resize / fullscreen / panel changes.
  useEffect(() => {
    if (!map || !wrapRef.current) return undefined;
    const el = wrapRef.current;
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [map]);
  useEffect(() => { const t = window.setTimeout(() => map?.invalidateSize({ pan: false }), 60); return () => window.clearTimeout(t); }, [map, fullscreen, ui.panelOpen, ui.layersOpen]);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    const onFs = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    try { void wrapRef.current?.requestFullscreen?.().catch(() => undefined); } catch { /* the fixed-position layout still fills the window */ }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [fullscreen]);

  const tilesFailing = tiles.failed >= 4 && tiles.failed > tiles.loaded;
  const retryTiles = () => { setTiles({ loaded: 0, failed: 0 }); tileRef.current?.redraw(); };

  async function toggleWatch(f: MapFeature) {
    setActionBusy(true); setActionMessage('');
    try {
      const next = !(watchOverride[f.id] ?? f.watchlisted ?? false);
      await saveItemState(f.refId, { watchlisted: next });
      setWatchOverride((w) => ({ ...w, [f.id]: next }));
      setActionMessage(next ? 'Added to your watchlist.' : 'Removed from your watchlist.');
    } catch (caught) { setActionMessage(caught instanceof Error ? caught.message : 'Could not change the watchlist.'); } finally { setActionBusy(false); }
  }

  async function createHazardIncident(f: MapFeature) {
    setActionBusy(true); setActionMessage('');
    try {
      const summary = [f.summary, ...f.native.map((n) => `${n.label}: ${n.value}`), f.url ? `Source: ${f.url}` : '', `Position: ${PRECISION_LABELS[f.precision]}.`].filter(Boolean).join('\n').slice(0, 4000);
      const created = await wsFetch<{ id: string }>('POST', '/incidents', {
        input: {
          title: f.title.slice(0, 200), summary, category: f.categoryLabel.slice(0, 100), locationText: f.locationLabel.slice(0, 200),
          lat: f.precision === 'source' ? f.lat : null, lng: f.precision === 'source' ? f.lng : null, countryCodes: f.countries.map((c) => c.code),
          severity: 'Unassessed', severityRationale: `Created from the map. ${f.severityBasis}`.slice(0, 2000), confidence: 'Unassessed', owner: null, eventAt: f.time,
        },
      });
      onNavigate('Incidents', created.id);
    } catch (caught) { setActionMessage(caught instanceof Error ? caught.message : 'Could not create the incident.'); } finally { setActionBusy(false); }
  }

  async function refreshSources() {
    setRefreshNote('Checking USGS and EONET…');
    try { await mapFetch('POST', '/refresh'); setRefreshNote('Sources re-checked.'); await reload(); }
    catch (caught) { setRefreshNote(caught instanceof Error ? caught.message : 'Could not refresh.'); }
  }

  const setFilter = <K extends keyof MapFilters>(key: K, value: MapFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const filtersActive = filters.country || filters.category || filters.severity !== 'All' || filters.source || filters.review !== 'All' || filters.area || (filters.keywords?.length ?? 0) > 0;
  const clearFilters = () => setFilters((f) => ({ ...f, country: '', category: '', severity: 'All', source: '', review: 'All', area: null, keywords: [] }));
  const geoDown = (data?.geoStatus ?? []).some((s) => s.status === 'unavailable' || s.status === 'stale');
  const watchedNow = selected ? (watchOverride[selected.id] ?? selected.watchlisted) : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className={`mp-root${fullscreen ? ' mp-full' : ''}`} ref={wrapRef} data-testid="map-workspace">
      <MapAiSearch onApply={(result) => setFilters((f) => ({ ...f, ...result.filters, area: f.area, source: f.source, keywords: result.keywords }))} />
      {(filters.keywords?.length ?? 0) > 0 && <p className="muted-note mp-basis-note">Showing only records mentioning: {filters.keywords!.slice(0, 8).join(', ')}. <button type="button" className="link-button" onClick={() => setFilter('keywords', [])}>Remove word filter</button></p>}
      {/* ---------------- filter bar */}
      <div className="mp-filters" role="group" aria-label="Map filters">
        <label>Time range
          <select value={filters.preset} onChange={(e) => setFilter('preset', e.target.value as MapFilters['preset'])} aria-label="Time range">
            <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="custom">Custom dates</option>
          </select>
        </label>
        {filters.preset === 'custom' && (
          <>
            <label>From<input type="date" max={today} value={filters.customFrom} onChange={(e) => setFilter('customFrom', e.target.value)} aria-label="From date" /></label>
            <label>To<input type="date" max={today} value={filters.customTo} onChange={(e) => setFilter('customTo', e.target.value)} aria-label="To date" /></label>
          </>
        )}
        <label>Country
          <select value={filters.country} onChange={(e) => setFilter('country', e.target.value)} aria-label="Country">
            <option value="">All countries</option>{countryOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label>Category
          <select value={filters.category} onChange={(e) => setFilter('category', e.target.value)} aria-label="Category">
            <option value="">All categories</option>{CATEGORY_OPTIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label>Severity
          <select value={filters.severity} onChange={(e) => setFilter('severity', e.target.value as MapFilters['severity'])} aria-label="Severity">
            <option value="All">All severities</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Source
          <select value={filters.source} onChange={(e) => setFilter('source', e.target.value)} aria-label="Source">
            <option value="">All sources</option>{sourceOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>Review status
          <select value={filters.review} onChange={(e) => setFilter('review', e.target.value as MapFilters['review'])} aria-label="Review status">
            <option value="All">Any review status</option><option value="Reviewed">Reviewed</option><option value="Unreviewed">Unreviewed</option>
          </select>
        </label>
        {filtersActive && <button type="button" className="outline-button" onClick={clearFilters}>Clear filters</button>}
        <p className="mp-basis-note" data-testid="time-basis">
          Showing {range.label}. The time filter uses each record’s own time: <b>event time</b> for USGS and EONET, <b>publication time</b> for news, GDELT, ReliefWeb and GDACS alerts, and the <b>incident date</b> for incidents.
        </p>
      </div>

      {aircraftBlocked && layers.aircraft && <Notice>Aircraft are live positions and cannot be shown for a past date range, so the layer is hidden. Choose a range that ends today to see current aircraft.</Notice>}
      {focusNote && <Notice kind="stale">{focusNote}</Notice>}
      {error && data && <Notice kind="stale">The map could not refresh ({error}). Showing data retrieved {ago(data.serverTime)}.</Notice>}
      {data && data.truncated > 0 && <Notice kind="stale">{data.truncated} older records in this range are not drawn (limit {allFeatures.length}). Narrow the time range or filters.</Notice>}

      {layers.aircraft && !aircraftBlocked && adsb && (
        <div className="ws-notice mp-ac-note" data-testid="aircraft-note" role="status">
          <b>Aircraft:</b> current positions from ADSB.lol’s volunteer receiver network. Coverage is provider-dependent, not every aircraft is shown, and a missing aircraft does not indicate a problem.
          {' '}Time filters do not apply. Positions fade after {config.data?.aircraft.staleAfterSec}s and are removed after {config.data?.aircraft.expireAfterSec}s.
          {aircraft.data?.status === 'too_large' && <> <b>Zoom in to load aircraft.</b></>}
          {aircraft.error && <> <b>Error:</b> {aircraft.error} <button type="button" className="link-button" onClick={() => setAircraftRetry((n) => n + 1)}>Retry</button></>}
          {!adsb.contactConfirmed && <> <i>Setup note:</i> ADSB.lol is licensed under the ODbL and asks to be contacted before production use; set ADSB_CONTACT_CONFIRMED=1 once done.</>}
        </div>
      )}


      {/* ---------------- workspace */}
      <div className={`mp-body${ui.panelOpen ? '' : ' panel-closed'}`}>
        <div className={`mp-mapwrap${picking ? ' picking' : ''}`} data-testid="map-canvas">
          <MapContainer
            ref={setMap} center={[initialView.lat, initialView.lng]} zoom={initialView.zoom} minZoom={1} maxZoom={tileCfg?.maxZoom ?? 18} worldCopyJump
            zoomControl={false} className="mp-map" attributionControl
          >
            {tileCfg && (
              <TileLayer
                ref={tileRef} url={tileCfg.url} attribution={tileCfg.attribution} maxZoom={tileCfg.maxZoom}
                eventHandlers={{ tileerror: () => setTiles((t) => ({ ...t, failed: t.failed + 1 })), tileload: () => setTiles((t) => (t.loaded > 50 ? t : { ...t, loaded: t.loaded + 1 })) }}
              />
            )}
            <ViewSync onView={onView} />
            <PickHandler active={picking} onPick={(p) => { setPicked(p); setPicking(false); }} />
            {layers.countries && risk.data && <CountryShading risk={risk.data} boundaries={boundaries.data} onOpen={(code) => onNavigate('Country Assessments', code)} />}
            {layers.places && <PlacesLayer places={places} selectedId={placeId} onSelect={(id) => { setPlaceId(id); setUi((u) => ({ ...u, tab: 'places', panelOpen: true })); }} />}
            {selected?.polygon && <Polygon positions={selected.polygon.map(([lng, lat]) => [lat, lng] as [number, number])} pathOptions={{ color: '#f8fafc', weight: 2, dashArray: '5 4', fillOpacity: 0.12 }} />}
            <EventMarkers clusters={clusters} selectedId={selectedId} hover={hover} onCluster={onCluster} onHover={setHover} />
            {aircraftOn && <AircraftLayer aircraft={aircraftList} selectedHex={aircraftId} onSelect={setAircraftId} />}
          </MapContainer>

          {/* controls */}
          <div className="mp-ctrl" role="group" aria-label="Map controls">
            <button type="button" aria-label="Zoom in" onClick={() => map?.zoomIn()}>＋</button>
            <button type="button" aria-label="Zoom out" onClick={() => map?.zoomOut()}>－</button>
            <button type="button" aria-label="Reset view" title="Reset view" onClick={() => map?.fitBounds(WORLD_BOUNDS)}>⟲</button>
            <button type="button" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} aria-pressed={fullscreen} onClick={() => setFullscreen((v) => !v)}>{fullscreen ? '⤡' : '⤢'}</button>
          </div>

          <div className={`mp-layers${ui.layersOpen ? '' : ' collapsed'}`} data-testid="layer-panel">
            <button type="button" className="mp-layers-toggle" aria-expanded={ui.layersOpen} onClick={() => setUi((u) => ({ ...u, layersOpen: !u.layersOpen }))}>Layers {ui.layersOpen ? '▾' : '▸'}</button>
            {ui.layersOpen && (
              <ul>
                {MAP_LAYERS.map((layer) => {
                  const info = layerInfo(layer.id);
                  const disabled = layer.id === 'aircraft' && (aircraftBlocked || adsb?.enabled === false);
                  return (
                    <li key={layer.id} data-layer={layer.id}>
                      <label className="mp-layer-row">
                        <input type="checkbox" checked={layers[layer.id] && !disabled} disabled={disabled} onChange={(e) => setLayers((l) => ({ ...l, [layer.id]: e.target.checked }))} aria-label={layer.label} />
                        <span className="mp-layer-name">{layer.label}</span>
                        <span className="mp-count" data-testid={`count-${layer.id}`}>{layerCount(layer.id)}</span>
                      </label>
                      <div className={`mp-layer-status ${info.tone}`} title={info.detail}>
                        <span className="mp-state" data-testid={`state-${layer.id}`}>{info.label}</span>
                        {info.lastSuccessAt && <span>Retrieved {ago(info.lastSuccessAt, now)}</span>}
                      </div>
                      {info.detail && (info.tone === 'bad' || layer.id === 'aircraft') && <small className="mp-layer-detail" title={info.detail}>{info.detail}</small>}
                    </li>
                  );
                })}
                <li className="mp-layer-foot">
                  {geoDown && <button type="button" className="outline-button" onClick={() => void refreshSources()}>Retry USGS / EONET</button>}
                  {refreshNote && <small role="status">{refreshNote}</small>}
                </li>
              </ul>
            )}
          </div>

          <Legend collapsed={ui.legendCollapsed} onToggle={() => setUi((u) => ({ ...u, legendCollapsed: !u.legendCollapsed }))}>
            <small>GDACS records use the feed’s documented mapping of alert level to severity (Red = Critical, Orange = High, Green = Low). An alert level describes the hazard, not business impact.</small>
            {layers.countries && (
              <div data-testid="country-legend">
                <strong>Country risk shading (separate layer)</strong>
                <ul className="mp-legend-sev">{Object.entries(RISK_COLORS).map(([k, c]) => <li key={k}><i style={{ background: c }} />{k}</li>)}</ul>
                <small>Method: the highest category rating in the latest saved country assessment, which an analyst must support with linked evidence. Countries without a saved assessment are not shaded. It is a judgement made by people, not computed from the event markers.</small>
              </div>
            )}
            {layers.aircraft && !aircraftBlocked && (
              <div><strong>Aircraft</strong><ul className="mp-legend-pos"><li><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2 14.2 9.2 22 13.4V15.6L14.2 13.4 13.6 19 16.2 21V22.4L12 21.2 7.8 22.4V21L10.4 19 9.8 13.4 2 15.6V13.4L9.8 9.2Z" fill={AIRCRAFT_COLOR} stroke="#fff" strokeWidth="1.2" /></svg>Plane points along its reported track; colour is unrelated to severity</li></ul></div>
            )}
          </Legend>

          {tilesFailing && (
            <div className="mp-tile-warn" role="alert" data-testid="tile-error">
              The base map tiles could not be loaded from {tileCfg?.provider ?? 'the tile provider'}. Markers still work.
              <button type="button" className="outline-button" onClick={retryTiles}>Retry</button>
            </div>
          )}
          {tileCfg?.productionNote && !tilesFailing && <div className="mp-prod-note" title={tileCfg.productionNote}>{tileCfg.provider}</div>}

          <div className="mp-overlay">
            {loading && !data && <div className="mp-state-card" role="status" data-testid="map-loading">Loading map data…</div>}
            {error && !data && (
              <div className="mp-state-card error" role="alert" data-testid="map-error">
                <strong>Map data could not be loaded</strong><span>{error}</span>
                <button type="button" className="primary-button" onClick={() => void reload()}>Retry</button>
              </div>
            )}
            {data && filtered.length === 0 && (
              <div className="mp-state-card" role="status" data-testid="map-empty">
                <strong>No records match</strong>
                <span>{layered.length === 0 ? 'No layer is switched on, or the selected layers have no records in this time range.' : 'The current filters hide every record in the selected layers and time range.'}</span>
                {filtersActive && <button type="button" className="outline-button" onClick={clearFilters}>Clear filters</button>}
              </div>
            )}
          </div>

          {card && (
            <div className="mp-cluster-card" role="dialog" aria-label="Grouped records" data-testid="cluster-card">
              <div className="mp-details-head"><strong>{card.features.length} records at this position</strong><button type="button" className="link-button" onClick={() => setCard(null)}>Close</button></div>
              <small><BreakdownText features={card.features} /></small>
              <ul>
                {card.features.slice(0, 40).map((f) => (
                  <li key={f.id}><button type="button" onClick={() => selectFeature(f.id)}><SeverityChip severity={f.severity} /> {f.title}<small>{f.sourceName}</small></button></li>
                ))}
              </ul>
              {card.features.length > 40 && <small>…and {card.features.length - 40} more in the results list.</small>}
            </div>
          )}
        </div>

        {/* ---------------- right panel */}
        <aside className="mp-panel" aria-label="Results and places">
          <div className="mp-panel-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={ui.tab === 'results'} className={ui.tab === 'results' ? 'selected' : ''} onClick={() => setUi((u) => ({ ...u, tab: 'results' }))}>Results</button>
            <button type="button" role="tab" aria-selected={ui.tab === 'places'} className={ui.tab === 'places' ? 'selected' : ''} onClick={() => setUi((u) => ({ ...u, tab: 'places' }))}>Places ({places.length})</button>
            <button type="button" className="link-button mp-collapse" aria-label="Collapse panel" onClick={() => setUi((u) => ({ ...u, panelOpen: false }))}>Hide ▸</button>
          </div>

          {ui.tab === 'places' ? (
            <div className="mp-panel-scroll">
              <PlacesTab
                places={places} selectedId={placeId} onSelect={setPlaceId} onChanged={() => { void placesRes.reload(); }}
                mapCentre={() => { const c = map?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : null; }} mapBounds={() => bounds}
                picking={picking} onPick={(on) => { setPicking(on); if (on) setPicked(null); }} pickedPoint={picked}
                onFocus={(p) => { if (p.kind === 'bbox' && p.bbox) map?.fitBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], { padding: [40, 40] }); else if (p.lat !== null && p.lng !== null) map?.flyTo([p.lat, p.lng], Math.max(5, map.getZoom())); }}
              />
            </div>
          ) : (
            <>
              <div className="mp-results-head">
                <div data-testid="result-counts">
                  <strong>{counts.records}</strong> records · <strong>{counts.events}</strong> distinct events
                  {counts.records !== counts.events && <small> ({counts.records - counts.events} duplicate reports linked)</small>}
                </div>
                <div className="mp-results-actions">
                  <button type="button" className="outline-button" disabled={!bounds} onClick={() => bounds && setFilter('area', bounds)} data-testid="search-area">Search this area</button>
                  {filters.area && <button type="button" className="chip-button" onClick={() => setFilter('area', null)} data-testid="clear-area">Area ✕</button>}
                </div>
              </div>
              {selected && (
                <FeatureDetails
                  feature={selected} all={allFeatures} onSelect={(id) => selectFeature(id, { fly: true })} onNavigate={onNavigate} onClose={() => setSelectedId('')}
                  onCreateReportIncident={(id) => setDialog([id])} watched={watchedNow} onToggleWatch={() => void toggleWatch(selected)}
                  onCreateHazardIncident={() => void createHazardIncident(selected)} busy={actionBusy} message={actionMessage}
                />
              )}
              <ul className="mp-list" data-testid="result-list">
                {ordered.slice(0, listLimit).map((f) => (
                  <li key={f.id} data-fid={f.id} className={`${f.id === selectedId ? 'selected' : ''}${hover.includes(f.id) ? ' hov' : ''}`} onMouseEnter={() => setHover([f.id])} onMouseLeave={() => setHover([])}>
                    <button type="button" onClick={() => selectFeature(f.id, { fly: true })}>
                      <span className="mp-li-top"><SeverityChip severity={f.severity} /><CategoryTag category={f.category} /></span>
                      <span className="mp-li-title">{f.title}</span>
                      <span className="mp-li-meta">
                        {f.sourceName} · {TIME_BASIS_LABELS[f.timeBasis].toLowerCase()} {ago(f.time, now)}
                        {(f.precision === 'approximate' || f.precision === 'reported') && <b className="mp-approx"> · approximate</b>}
                        {f.groupId && <b className="mp-dup"> · linked duplicate</b>}
                      </span>
                    </button>
                  </li>
                ))}
                {data && ordered.length === 0 && <li className="muted-note mp-none">Nothing to list.</li>}
              </ul>
              {ordered.length > listLimit && <button type="button" className="outline-button mp-more" onClick={() => setListLimit((n) => n + LIST_PAGE)}>Show more ({ordered.length - listLimit} left)</button>}
              {data && (
                <div className="mp-unlocated" data-testid="unlocated">
                  <button type="button" className="link-button" aria-expanded={showUnlocated} onClick={() => setShowUnlocated((v) => !v)}>
                    Not on the map: {data.unlocatedTotal} {data.unlocatedTotal === 1 ? 'record has' : 'records have'} no usable location {showUnlocated ? '▾' : '▸'}
                  </button>
                  {showUnlocated && (
                    <ul>
                      {data.unlocated.map((u) => (
                        <li key={u.id}>
                          <span>{u.title}</span>
                          <small>{u.source} · {u.reason}</small>
                          <button type="button" className="link-button" onClick={() => (u.kind === 'incident' ? onNavigate('Incidents', u.id) : onNavigate('Intelligence Feed', u.id))}>{u.kind === 'incident' ? 'Open incident' : 'Open report'}</button>
                        </li>
                      ))}
                      {data.unlocatedTotal > data.unlocated.length && <li className="muted-note">…and {data.unlocatedTotal - data.unlocated.length} more.</li>}
                    </ul>
                  )}
                  <small>Unlocated records are never given a guessed position.</small>
                </div>
              )}
            </>
          )}
        </aside>
        {!ui.panelOpen && <button type="button" className="mp-panel-open outline-button" onClick={() => setUi((u) => ({ ...u, panelOpen: true }))} aria-label="Show results panel">◂ Results</button>}
      </div>

      {dialog && <IncidentLinkDialog articleIds={dialog} initialMode="create" onClose={() => setDialog(null)} onNavigate={onNavigate} />}
    </div>
  );
}
