import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { CircleMarker, LayersControl, MapContainer, Popup, TileLayer, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  alertFeed,
  countryAssessmentDetails,
  countryAssessments,
  incidentDetails,
  intelligenceFeed,
  sibDraft,
  threatIndicators,
  watchlists,
} from './data/demo.ts';
import { findPlaces, type Place } from './data/geo.ts';
import {
  GLOBAL_CODE,
  UNKNOWN_CODE,
  countries,
  countryName,
  sortedCountries,
} from './data/countries.ts';
import { fetchFeedPage, fetchOverview, saveItemState, type ItemStateChange, type OverviewPayload } from './data/feedApi.ts';
import { groupForMap, type MapGroup } from './data/mapGroups.ts';
import {
  DEFAULT_FEED_FILTERS,
  SEVERITIES,
  hasActiveFilters,
  matchesFilters,
  type ConfidenceLevel,
  ASSESSMENT_METHOD_LABELS,
  SEVERITY_COLORS,
  SEVERITY_RANK,
  type FeedFilters,
  type FeedItemDto,
  type FeedPage,
  type Severity,
} from './data/feedTypes.ts';

const severityTone = {
  Critical: 'critical',
  High: 'warning',
  Moderate: 'neutral',
  Watch: 'amber',
  Monitoring: 'success',
} as const;

const navItems = [
  'Overview',
  'Intelligence Feed',
  'Incidents',
  'Country Assessments',
  'Threat Indicators',
  'SIBs',
  'Human Rights',
  'Political Risk',
  'Map',
  'Watchlists',
  'Reports',
  'Sources',
  'Settings',
] as const;

type PublicFeedPayload = {
  fetchedAt: string | null;
  items: Array<{
    id: string;
    sourceRecordId: string;
    headline: string;
    summary: string;
    url: string;
    source: string;
    sourceUrl: string;
    publishedAt: string;
    sourceModifiedAt: string | null;
    retrievedAt: string;
    lastCheckedAt: string;
    verificationStatus: string;
    attribution: string;
  }>;
  sources: SourceRegistryItem[];
  cached: boolean;
  stale: boolean;
  error?: string;
};

type SourceRegistryItem = {
  id: string;
  name: string;
  url: string;
  format: string;
  coverage: string;
  cadence: string;
  attribution: string;
  termsUrl: string;
  status: 'healthy' | 'stale' | 'unavailable' | 'not_checked' | 'setup_required';
  kind?: string;
  setup?: { required: boolean; envVars: string[]; instructions: string; signupUrl: string } | null;
  itemCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  updateMode: 'periodic';
  pollIntervalMs: number;
};

type SourceRegistryPayload = {
  items: SourceRegistryItem[];
  total: number;
};

type SourceChange = {
  changeId: number;
  sourceId: string;
  recordId: string;
  headline: string;
  changedAt: string;
  fields: Array<{ field: string; previous: string; current: string }>;
};

function formatIsoDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeTime(iso: string | null | undefined, now: number) {
  if (!iso) return 'not yet';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function usePublicFeed() {
  const [payload, setPayload] = useState<PublicFeedPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/feed/public');
      const data = await response.json() as PublicFeedPayload;
      if (!response.ok) throw new Error(data.error || `Public feeds returned HTTP ${response.status}`);
      setPayload(data);
      setError(data.error ?? '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load public feeds.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const events = new EventSource('/api/events');
    let timer: number | undefined;
    const reloadSoon = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    };
    events.addEventListener('public-feed-updated', reloadSoon);
    events.addEventListener('source-sync-updated', reloadSoon);
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      events.close();
      window.clearInterval(interval);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);

  return { payload, error, loading, reload: load };
}

type PublicFeedState = ReturnType<typeof usePublicFeed>;

/** Overview headlines and map use the same report model (severity, countries, location) as the Intelligence Feed. */
function useOverviewItems() {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await fetchOverview());
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load reports.');
    }
  }, []);

  useEffect(() => {
    void load();
    const events = new EventSource('/api/events');
    let timer: number | undefined;
    const reloadSoon = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    };
    events.addEventListener('public-feed-updated', reloadSoon);
    events.addEventListener('source-sync-updated', reloadSoon);
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      events.close();
      window.clearInterval(interval);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);

  return { data, error };
}

function SeverityMarkerPopup({ group, now }: { group: MapGroup; now: number }) {
  const breakdown = SEVERITIES.filter((severity) => group.counts[severity] > 0);
  return (
    <div className="risk-popup severity-popup">
      <strong>{group.label}</strong>
      <p>
        {group.items.length} report{group.items.length === 1 ? '' : 's'}
        {' · '}
        {breakdown.map((severity) => (
          <span key={severity} className="severity-count">
            <i style={{ background: SEVERITY_COLORS[severity] }} />{group.counts[severity]} {severity}
          </span>
        ))}
      </p>
      {group.precision === 'approximate' && (
        <p className="approx-note">Approximate: placed at the centre of the country, not at the event itself.</p>
      )}
      <div className="severity-popup-list">
        {group.items.map((item) => (
          <div key={item.id} className="severity-popup-item">
            <div className="severity-popup-top">
              <SeverityBadge severity={item.severity} manual={item.severityOverridden} />
              <small title={formatIsoDate(item.publishedAt)}>{relativeTime(item.publishedAt, now)}</small>
            </div>
            <a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a>
            <small className="severity-popup-reason">{item.severityRationale.slice(0, 220)}{item.severityRationale.length > 220 ? '…' : ''}</small>
            <small>{item.source} · published {formatIsoDate(item.publishedAt)} · {ASSESSMENT_METHOD_LABELS[item.assessmentMethod]}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

type PlaceMention = { place: Place; items: PublicFeedPayload['items'] };

function OverviewPanel({ feed }: { feed: PublicFeedState }) {
  const mapRef = useRef<LeafletMap>(null);
  const [mapFilter, setMapFilter] = useState('All locations');
  const [mapSeverity, setMapSeverity] = useState<'All' | Severity>('All');
  const overview = useOverviewItems();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => feed.payload?.items ?? [], [feed.payload]);
  const sources = useMemo(() => feed.payload?.sources ?? [], [feed.payload]);
  const activeSources = sources.filter((source) => source.status !== 'setup_required');
  const setupCount = sources.length - activeSources.length;
  const healthyCount = sources.filter((source) => source.status === 'healthy').length;
  const pollMinutes = sources[0] ? Math.round(sources[0].pollIntervalMs / 60000) : null;
  const dayMs = 24 * 60 * 60 * 1000;
  const last24h = items.filter((item) => now - Date.parse(item.publishedAt) <= dayMs).length;

  const perDay = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now - (6 - index) * dayMs);
      return { key: date.toDateString(), label: date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), count: 0 };
    });
    for (const item of items) {
      const published = new Date(item.publishedAt);
      if (Number.isNaN(published.getTime())) continue;
      const bucket = days.find((day) => day.key === published.toDateString());
      if (bucket) bucket.count += 1;
    }
    return days;
  }, [items, now, dayMs]);
  const maxPerDay = Math.max(1, ...perDay.map((day) => day.count));

  const mentions = useMemo(() => {
    const byPlace = new Map<Place, PlaceMention>();
    for (const item of items) {
      for (const place of findPlaces(`${item.headline}. ${item.summary}`)) {
        const entry = byPlace.get(place) ?? { place, items: [] };
        entry.items.push(item);
        byPlace.set(place, entry);
      }
    }
    return [...byPlace.values()].sort((a, b) => b.items.length - a.items.length);
  }, [items]);
  const overviewItems = useMemo(() => overview.data?.items ?? [], [overview.data]);
  const mapData = useMemo(() => groupForMap(overviewItems, mapSeverity), [overviewItems, mapSeverity]);
  const visibleGroups = mapFilter === 'Top 10' ? mapData.groups.slice(0, 10) : mapData.groups;
  const maxGroupSize = Math.max(1, ...mapData.groups.map((group) => group.items.length));
  const legendCounts = useMemo(() => {
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Unassessed: 0 } as Record<Severity, number>;
    for (const group of mapData.groups) for (const severity of SEVERITIES) counts[severity] += group.counts[severity];
    return counts;
  }, [mapData.groups]);
  const latest = [...overviewItems]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 6);

  const hasData = items.length > 0;
  const feedHealthy = activeSources.length > 0 && healthyCount === activeSources.length;

  return (
    <>
      <section className="summary-bar">
        <div>
          <span className="meta-label">Current time</span>
          <strong>{formatIsoDate(new Date(now).toISOString())}</strong>
        </div>
        <div>
          <span className="meta-label">Data freshness</span>
          <strong className={feedHealthy ? 'success-text' : undefined}>
            {hasData ? `Updated ${relativeTime(feed.payload?.fetchedAt, now)}` : feed.loading ? 'Loading…' : 'No data yet'}
          </strong>
        </div>
        <div>
          <span className="meta-label">Public sources</span>
          <strong>{sources.length > 0 ? `${healthyCount} of ${activeSources.length} healthy${setupCount > 0 ? ` · ${setupCount} need setup` : ''}` : 'Not checked'}</strong>
        </div>
        <div>
          <span className="meta-label">System mode</span>
          <strong className="success-text">
            LIVE – PUBLIC WEB{pollMinutes ? ` (checked every ${pollMinutes} min)` : ''}
          </strong>
        </div>
      </section>

      {feed.error && (
        <section className="panel">
          <p className="muted-note">{feed.error}</p>
        </section>
      )}
      {!hasData && !feed.error && (
        <section className="panel">
          <p className="muted-note">
            {feed.loading ? 'Contacting public sources…' : 'Waiting for the first sync from public sources. This page refreshes automatically.'}
          </p>
        </section>
      )}

      <section className="metrics-grid">
        <article className="metric-card neutral">
          <div className="metric-header"><span>Articles retained</span><span className="metric-trend">public RSS</span></div>
          <strong>{items.length}</strong>
        </article>
        <article className="metric-card positive">
          <div className="metric-header"><span>Published in last 24h</span><span className="metric-trend">by publisher time</span></div>
          <strong>{last24h}</strong>
        </article>
        <article className="metric-card neutral">
          <div className="metric-header"><span>Reports on map</span><span className="metric-trend">supported location</span></div>
          <strong>{overview.data ? mapData.locatedCount : '–'}</strong>
        </article>
        <article className={`metric-card ${feedHealthy ? 'positive' : 'warning'}`}>
          <div className="metric-header"><span>Sources healthy</span><span className="metric-trend">connector status</span></div>
          <strong>{healthyCount}/{activeSources.length}</strong>
        </article>
      </section>

      <section className="content-grid top-row">
        <div className="panel large-panel map-panel">
          <div className="panel-header map-panel-header">
            <div>
              <h3>Global news map</h3>
              <span className="map-subtitle">Reports with a supported event location, coloured by severity / LIVE</span>
            </div>
            <div className="map-toolbar">
              <label className="map-filter-control">
                <span className="sr-only">Filter map locations</span>
                <select aria-label="Map locations" value={mapFilter} onChange={(event) => setMapFilter(event.target.value)}>
                  <option>All locations</option>
                  <option>Top 10</option>
                </select>
              </label>
              <label className="map-filter-control">
                <span className="sr-only">Filter map by severity</span>
                <select aria-label="Map severity" value={mapSeverity} onChange={(event) => setMapSeverity(event.target.value as 'All' | Severity)}>
                  <option value="All">All severities</option>
                  {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                </select>
              </label>
              <button className="ghost-button" onClick={() => mapRef.current?.setView([25, 35], 2)}>
                Reset globe
              </button>
            </div>
          </div>
          <div className="world-map">
            <MapContainer
              ref={mapRef}
              center={[25, 35]}
              zoom={2}
              minZoom={2}
              maxZoom={11}
              scrollWheelZoom
              worldCopyJump
            >
              <LayersControl position="topright">
                <LayersControl.BaseLayer checked name="Street detail">
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                </LayersControl.BaseLayer>
                <LayersControl.BaseLayer name="Terrain">
                  <TileLayer
                    attribution='Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
                    url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
                  />
                </LayersControl.BaseLayer>
              </LayersControl>
              {visibleGroups.map((group) => (
                <CircleMarker
                  key={group.key}
                  center={[group.lat, group.lng]}
                  radius={5 + 14 * Math.sqrt(group.items.length / maxGroupSize)}
                  pathOptions={{
                    color: '#e2e8f0',
                    weight: 1.5,
                    dashArray: group.precision === 'approximate' ? '4 3' : undefined,
                    fillColor: SEVERITY_COLORS[group.severity],
                    fillOpacity: 0.8,
                  }}
                >
                  <Tooltip direction="top">
                    {group.label}: {group.items.length} report{group.items.length === 1 ? '' : 's'}, highest severity {group.severity}
                  </Tooltip>
                  <Popup maxWidth={380} minWidth={280}>
                    <SeverityMarkerPopup group={group} now={now} />
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
          <div className="map-legend" aria-label="Map legend">
            <strong>Report severity</strong>
            {SEVERITIES.map((severity) => (
              <span key={severity} className="legend-item">
                <i className="legend-dot" style={{ background: SEVERITY_COLORS[severity] }} />
                {severity} <small>({legendCounts[severity]})</small>
              </span>
            ))}
            <span className="legend-note">Size = number of reports</span>
          </div>
          <div className="map-footer">
            <span>
              {overview.error
                ? `Could not load map data: ${overview.error}`
                : !overview.data
                  ? 'Loading reports…'
                  : `${visibleGroups.length} of ${mapData.groups.length} locations · ${mapData.locatedCount} of ${mapData.matching.length} matching reports on the map`}
            </span>
            <span data-testid="unlocated-count">
              {mapData.unlocated.total} not shown (no supported location): {mapData.unlocated.global} global coverage, {mapData.unlocated.unknown} unknown location, {mapData.unlocated.multiple} several countries
            </span>
            <span className="map-explainer">
              Marker colour is the highest severity among the reports at that location. It describes the reports, not a country risk rating. Dashed outlines are country-centre positions and are approximate.
            </span>
          </div>
        </div>

        <div className="panel medium-panel">
          <div className="panel-header">
            <h3>Latest headlines</h3>
          </div>
          <div className="priority-list">
            {latest.length === 0 && <p className="muted-note">{overview.error ? `Could not load headlines: ${overview.error}` : 'No articles retrieved yet.'}</p>}
            {latest.map((item) => (
              <div key={item.id} className="priority-item">
                <div className="priority-row">
                  <span className="badge neutral">{item.source}</span>
                  <SeverityBadge severity={item.severity} manual={item.severityOverridden} />
                  <span className="meta-label" title={formatIsoDate(item.publishedAt)}>{relativeTime(item.publishedAt, now)}</span>
                </div>
                <strong>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a>
                </strong>
                <p>{item.summary}</p>
                <div className="detail-row">
                  <span>{item.attribution}</span>
                  <span>{ASSESSMENT_METHOD_LABELS[item.assessmentMethod]}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="content-grid charts-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>Articles published per day (last 7 days)</h3>
          </div>
          <div className="bars">
            {perDay.map((day) => (
              <div key={day.key} className="bar-group">
                <div className="bar-stack">
                  <span style={{ height: `${Math.max(3, (day.count / maxPerDay) * 100)}%` }} className="bar-volume" />
                </div>
                <small>{day.label}</small>
                <small>{day.count}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3>Most-mentioned places</h3>
          </div>
          <div className="country-list">
            {mentions.length === 0 && <p className="muted-note">No place names detected yet.</p>}
            {mentions.slice(0, 8).map((entry) => (
              <div key={entry.place.name} className="country-row">
                <strong>{entry.place.name}</strong>
                <span className="badge neutral">{entry.items.length} article{entry.items.length === 1 ? '' : 's'}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="content-grid lower-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>Source status</h3>
          </div>
          <div className="country-list">
            {sources.map((source) => (
              <div key={source.id} className="country-row">
                <strong>{source.name}</strong>
                <span className={`badge ${source.status === 'healthy' ? 'success' : source.status === 'not_checked' ? 'neutral' : 'warning'}`}>
                  {source.status.replace('_', ' ')}
                </span>
                <span>{source.itemCount} articles</span>
                <small>checked {relativeTime(source.lastCheckedAt, now)}</small>
              </div>
            ))}
          </div>
          <p className="muted-note">Status shows whether the connector could reach each publisher, not whether the reporting is accurate.</p>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3>About this data</h3>
          </div>
          <p className="muted-note">
            Articles come from publisher RSS feeds, are polled periodically, and appear here as published. Nothing on this page has been
            verified, risk-rated or corroborated. Open the original article before acting on any item.
          </p>
        </div>
      </section>

      <section className="feed-panel panel">
        <div className="panel-header">
          <h3>Latest public reports</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>Headline</th>
              <th>Source</th>
              <th>Published</th>
              <th>Retrieved</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 25).map((item) => (
              <tr key={item.id}>
                <td><a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a></td>
                <td>{item.source}</td>
                <td>{formatIsoDate(item.publishedAt)}</td>
                <td>{relativeTime(item.retrievedAt, now)}</td>
                <td>{item.verificationStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

const feedPageSize = 20;

type ViewItem = FeedItemDto & {
  sourceType: string;
  reliability: string;
  locationText?: string;
  region?: string;
  entities?: string;
  relevance?: string;
};

function severityClass(severity: string) {
  return `sev-${severity.toLowerCase()}`;
}

function SeverityBadge({ severity, manual }: { severity: string; manual?: boolean }) {
  return (
    <span className={`badge ${severityClass(severity)}`} title={manual ? 'Severity set manually' : undefined}>
      {severity}{manual ? ' *' : ''}
    </span>
  );
}

function toViewItem(item: FeedItemDto): ViewItem {
  return { ...item, sourceType: 'Publisher RSS', reliability: 'Not assessed' };
}

const demoCountryCodes = new Map(countries.map((country) => [country.name, country.code]));

function demoToViewItem(item: (typeof intelligenceFeed)[number], index: number): ViewItem {
  const legacy: Record<string, Severity> = { Moderate: 'Medium', Watch: 'Low', Monitoring: 'Low' };
  const severity = (SEVERITIES as readonly string[]).includes(item.severity)
    ? item.severity as Severity
    : legacy[item.severity] ?? 'Unassessed';
  const code = item.country === 'Global' ? GLOBAL_CODE : demoCountryCodes.get(item.country) ?? UNKNOWN_CODE;
  const confidence = ['High', 'Medium', 'Low'].includes(item.confidence) ? item.confidence as ConfidenceLevel : 'Not assessed';
  return {
    id: `demo:${index}`,
    headline: item.headline,
    summary: item.summary,
    url: item.url,
    source: item.source,
    sourceUrl: '',
    attribution: item.source,
    publishedAt: item.date,
    sourceModifiedAt: null,
    retrievedAt: item.date,
    lastCheckedAt: item.date,
    verificationStatus: 'demo',
    sourceId: 'demo',
    category: item.type,
    location: null,
    assessmentMethod: 'rules',
    severity,
    assessedSeverity: severity,
    severityOverridden: false,
    severityOverriddenAt: null,
    severityRationale: 'Demo data: this severity is illustrative and was not calculated from the report.',
    assessmentConfidence: confidence,
    categories: [],
    categoryLabels: [item.type],
    corroboratingReports: 0,
    countries: [{ code, name: code === UNKNOWN_CODE ? item.country : countryName(code) }],
    countryStatus: code === GLOBAL_CODE ? 'global' : code === UNKNOWN_CODE ? 'unknown' : 'identified',
    reviewStatus: item.reviewStatus === 'Reviewed' ? 'Reviewed' : 'Unreviewed',
    reviewedAt: null,
    reviewedBy: null,
    watchlisted: item.watchlist,
    watchlistedAt: null,
    sourceType: item.sourceType,
    reliability: item.reliability,
    locationText: item.location,
    region: item.region,
    entities: item.entities,
    relevance: item.relevance,
  };
}

function countryText(item: FeedItemDto, limit = 3) {
  const names = item.countries.map((country) => country.name);
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} +${names.length - limit}`;
}

function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function usePublicFeedItems(enabled: boolean, filters: FeedFilters, page: number) {
  const [data, setData] = useState<FeedPage | null>(null);
  const [dataRequestedPage, setDataRequestedPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const { severity, country, review, watchlistOnly, search } = filters;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setLoading(true);
    fetchFeedPage({ severity, country, review, watchlistOnly, search }, page, feedPageSize, controller.signal)
      .then((result) => {
        setData(result);
        setDataRequestedPage(page);
        setError('');
        setLoading(false);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : 'Could not load reports.');
        setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, severity, country, review, watchlistOnly, search, page, reloadToken]);

  useEffect(() => {
    if (!enabled) return undefined;
    const events = new EventSource('/api/events');
    let timer: number | undefined;
    const refresh = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => setReloadToken((token) => token + 1), 250);
    };
    events.addEventListener('public-feed-updated', refresh);
    events.addEventListener('source-sync-updated', refresh);
    return () => {
      events.close();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled]);

  return { data, dataRequestedPage, loading, error, reload: () => setReloadToken((token) => token + 1) };
}

function IntelligenceFeedPanel({ feed }: { feed: PublicFeedState }) {
  const [feedMode, setFeedMode] = useState<'Demo' | 'Public web'>('Public web');
  const [demoItems, setDemoItems] = useState<ViewItem[]>(() => intelligenceFeed.map(demoToViewItem));
  const [filters, setFilters] = useState<FeedFilters>(DEFAULT_FEED_FILTERS);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState('');
  const [selectedCache, setSelectedCache] = useState<ViewItem | null>(null);
  const [pendingId, setPendingId] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const isDemo = feedMode === 'Demo';
  const debouncedSearch = useDebounced(filters.search, 300);
  const serverFilters = useMemo<FeedFilters>(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );
  const publicFeed = usePublicFeedItems(!isDemo, serverFilters, page);
  const pageData = publicFeed.data;

  const demoFiltered = useMemo(() => demoItems.filter((item) => matchesFilters(item, filters)), [demoItems, filters]);
  const items: ViewItem[] = isDemo ? demoFiltered : (pageData?.items ?? []).map(toViewItem);
  const total = isDemo ? demoFiltered.length : pageData?.total ?? 0;
  const datasetTotal = isDemo ? demoItems.length : pageData?.datasetTotal ?? 0;
  const watchlistTotal = isDemo ? demoItems.filter((item) => item.watchlisted).length : pageData?.watchlistTotal ?? 0;
  const totalPages = isDemo ? 1 : pageData?.totalPages ?? 1;
  const currentPage = isDemo ? 1 : page;
  const loading = !isDemo && publicFeed.loading;
  const error = isDemo ? '' : publicFeed.error;
  const filtersActive = hasActiveFilters(filters);

  useEffect(() => {
    // Only follow the server's page clamp for the page that was actually requested, not for stale data.
    if (!isDemo && pageData && publicFeed.dataRequestedPage === page && pageData.page !== page) setPage(pageData.page);
  }, [isDemo, pageData, page, publicFeed.dataRequestedPage]);

  const selectedItem = items.find((item) => item.id === selectedId)
    ?? (selectedId && selectedCache?.id === selectedId ? selectedCache : undefined)
    ?? items[0];

  function updateFilters(patch: Partial<FeedFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }

  function resetFilters() {
    setFilters(DEFAULT_FEED_FILTERS);
    setPage(1);
  }

  function resetOtherFiltersKeepWatchlist() {
    setFilters({ ...DEFAULT_FEED_FILTERS, watchlistOnly: true });
    setPage(1);
  }

  function selectItem(item: ViewItem) {
    setSelectedId(item.id);
    setSelectedCache(item);
  }

  function switchMode(mode: 'Demo' | 'Public web') {
    setFeedMode(mode);
    setPage(1);
    setSelectedId('');
    setSelectedCache(null);
    setActionError('');
  }

  async function refreshPublic() {
    setRefreshing(true);
    try {
      await fetch('/api/feed/public?refresh=true');
    } catch {
      // The item list below reports its own errors.
    } finally {
      setRefreshing(false);
      feed.reload();
      publicFeed.reload();
    }
  }

  async function changePublicState(item: ViewItem, change: ItemStateChange) {
    setPendingId(item.id);
    setActionError('');
    try {
      const result = await saveItemState(item.id, change);
      setSelectedId(item.id);
      setSelectedCache(toViewItem(result.item));
      publicFeed.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not save the change.');
    } finally {
      setPendingId('');
    }
  }

  function changeDemoState(item: ViewItem, patch: Partial<ViewItem>) {
    setDemoItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, ...patch } : entry)));
  }

  function toggleReview(item: ViewItem) {
    const next = item.reviewStatus === 'Reviewed' ? 'Unreviewed' : 'Reviewed';
    if (isDemo) {
      changeDemoState(item, { reviewStatus: next, reviewedAt: next === 'Reviewed' ? new Date().toISOString() : null });
    } else {
      void changePublicState(item, { reviewStatus: next });
    }
  }

  function toggleWatchlist(item: ViewItem) {
    if (isDemo) {
      changeDemoState(item, { watchlisted: !item.watchlisted });
    } else {
      void changePublicState(item, { watchlisted: !item.watchlisted });
    }
  }

  function overrideSeverity(item: ViewItem, value: Severity | null) {
    if (isDemo) {
      changeDemoState(item, {
        severity: value ?? item.assessedSeverity,
        severityOverridden: value !== null,
        severityOverriddenAt: value !== null ? new Date().toISOString() : null,
      });
    } else {
      void changePublicState(item, { severityOverride: value });
    }
  }

  const needsReviewActive = !filters.watchlistOnly && filters.review === 'Unreviewed';
  const allActive = !filters.watchlistOnly && !needsReviewActive;
  const firstShown = total === 0 ? 0 : (currentPage - 1) * feedPageSize + 1;
  const lastShown = isDemo ? total : Math.min(total, currentPage * feedPageSize);
  const publicSources = feed.payload?.sources ?? [];
  const publicFetchedAt = feed.payload?.fetchedAt ?? '';

  let results;
  if (error) {
    results = (
      <div className="feed-empty" role="alert">
        <p>Could not load reports: {error}</p>
        <button className="outline-button" onClick={publicFeed.reload}>Retry</button>
      </div>
    );
  } else if (loading && items.length === 0) {
    results = <div className="feed-empty" role="status">Loading reports...</div>;
  } else if (items.length === 0 && filters.watchlistOnly && watchlistTotal === 0) {
    results = (
      <div className="feed-empty">
        <p>Your watchlist is empty. Add reports using the watchlist button on each report.</p>
        <button className="outline-button" onClick={() => updateFilters({ watchlistOnly: false })}>Show all reports</button>
      </div>
    );
  } else if (items.length === 0 && filters.watchlistOnly) {
    results = (
      <div className="feed-empty">
        <p>No watchlisted reports match your current filters.</p>
        <div className="feed-empty-actions">
          <button className="outline-button" onClick={resetOtherFiltersKeepWatchlist}>Reset filters</button>
          <button className="ghost-button" onClick={() => updateFilters({ watchlistOnly: false })}>Show all reports</button>
        </div>
      </div>
    );
  } else if (items.length === 0 && datasetTotal === 0) {
    results = <div className="feed-empty">No reports have been retrieved yet. They appear here after the first source check.</div>;
  } else if (items.length === 0) {
    results = (
      <div className="feed-empty">
        <p>No reports match these filters.</p>
        <button className="outline-button" onClick={resetFilters}>Reset filters</button>
      </div>
    );
  } else {
    results = items.map((item) => {
      const selected = selectedItem?.id === item.id;
      const reviewed = item.reviewStatus === 'Reviewed';
      return (
        <article key={item.id} className={`feed-result ${selected ? 'selected' : ''}`}>
          <button className="feed-result-main" onClick={() => selectItem(item)} aria-pressed={selected}>
            <div className="feed-result-top">
              <SeverityBadge severity={item.severity} manual={item.severityOverridden} />
              <time dateTime={item.publishedAt}>{formatIsoDate(item.publishedAt)}</time>
            </div>
            <strong>{item.headline}</strong>
            <p>{item.summary}</p>
            <div className="feed-result-meta">
              <span>{item.source}</span>
              {item.category && <span>{item.category}</span>}
              <span>{countryText(item)}</span>
              <span>{item.reviewStatus}</span>
              {item.watchlisted && <span>On watchlist</span>}
            </div>
          </button>
          <div className="feed-result-actions">
            <button
              className="ghost-button small"
              onClick={() => toggleReview(item)}
              disabled={pendingId === item.id}
              aria-pressed={reviewed}
            >
              {reviewed ? 'Mark as unreviewed' : 'Mark as reviewed'}
            </button>
            <button
              className="ghost-button small"
              onClick={() => toggleWatchlist(item)}
              disabled={pendingId === item.id}
              aria-pressed={item.watchlisted}
            >
              {item.watchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
            </button>
          </div>
        </article>
      );
    });
  }

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">{isDemo ? 'Demo dataset' : 'Publisher RSS / public web'}</div>
          <h2>Intelligence feed</h2>
        </div>
        <div className="feed-heading-actions">
          <div className="feed-mode-switch" role="group" aria-label="Feed source mode">
            <button
              className={isDemo ? 'selected' : ''}
              onClick={() => switchMode('Demo')}
              aria-pressed={isDemo}
            >
              Demo
            </button>
            <button
              className={!isDemo ? 'selected' : ''}
              onClick={() => (isDemo ? switchMode('Public web') : void refreshPublic())}
              aria-pressed={!isDemo}
              disabled={refreshing}
            >
              {refreshing ? 'Fetching...' : isDemo ? 'Public web' : 'Refresh public'}
            </button>
          </div>
          <span className="status-pill neutral" aria-live="polite">{total} of {datasetTotal} reports</span>
        </div>
      </div>

      {!isDemo && (
        <section className="public-feed-status" aria-live="polite">
          <div>
            <strong>Publisher-provided reporting</strong>
            <span>Severity and countries are automated estimates from each headline and summary. Verify the original article before acting.</span>
          </div>
          {publicFetchedAt && <small>{feed.payload?.cached ? 'No new source content' : 'Latest successful source check'} / {formatIsoDate(publicFetchedAt)}</small>}
          <div className="public-source-list">
            {publicSources.map((source) => (
              <span key={source.name} className={`source-health ${source.status}`}>
                {source.name}: {source.status} / {source.itemCount} stored
                {source.lastError ? ` / ${source.lastError}` : ''}
              </span>
            ))}
          </div>
          {feed.error && <p role="alert">{feed.error}</p>}
        </section>
      )}

      <div className="feed-workspace">
        <section className="panel feed-browser" aria-label="Intelligence reports">
          <div className="feed-filter-row">
            <label className="feed-search">
              <span className="sr-only">Search reports</span>
              <input
                type="search"
                placeholder="Search headlines, sources, countries..."
                value={filters.search}
                onChange={(event) => updateFilters({ search: event.target.value })}
              />
            </label>
            <label className="filter-select">
              <span>Severity</span>
              <select aria-label="Severity" value={filters.severity} onChange={(event) => updateFilters({ severity: event.target.value as FeedFilters['severity'] })}>
                <option value="All">All severities</option>
                {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </select>
            </label>
            <label className="filter-select">
              <span>Country</span>
              <select aria-label="Country" value={filters.country} onChange={(event) => updateFilters({ country: event.target.value })}>
                <option value="All">All countries</option>
                <optgroup label="Countries">
                  {sortedCountries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
                </optgroup>
                <optgroup label="Not country-specific">
                  <option value={GLOBAL_CODE}>Global (worldwide)</option>
                  <option value={UNKNOWN_CODE}>Unknown location</option>
                </optgroup>
              </select>
            </label>
            <label className="filter-select">
              <span>Reviewed</span>
              <select aria-label="Reviewed" value={filters.review} onChange={(event) => updateFilters({ review: event.target.value as FeedFilters['review'] })}>
                <option value="All">All items</option>
                <option value="Reviewed">Reviewed</option>
                <option value="Unreviewed">Unreviewed</option>
              </select>
            </label>
            <button className="ghost-button" onClick={resetFilters} disabled={!filtersActive}>Reset filters</button>
          </div>

          <div className="feed-quick-filters" role="group" aria-label="Quick filters">
            <button
              className={allActive ? 'selected' : ''}
              onClick={() => updateFilters({ watchlistOnly: false, review: filters.review === 'Unreviewed' ? 'All' : filters.review })}
              aria-pressed={allActive}
            >
              All
            </button>
            <button
              className={needsReviewActive ? 'selected' : ''}
              onClick={() => updateFilters({ watchlistOnly: false, review: 'Unreviewed' })}
              aria-pressed={needsReviewActive}
            >
              Needs review
            </button>
            <button
              className={filters.watchlistOnly ? 'selected' : ''}
              onClick={() => updateFilters({ watchlistOnly: true })}
              aria-pressed={filters.watchlistOnly}
            >
              On watchlist{watchlistTotal > 0 ? ` (${watchlistTotal})` : ''}
            </button>
          </div>

          {filters.watchlistOnly && (
            <div className="feed-watchlist-banner" role="status">
              <span>Showing your watchlist only</span>
              <button className="ghost-button small" onClick={() => updateFilters({ watchlistOnly: false })}>Show all reports</button>
            </div>
          )}
          {actionError && <p className="feed-action-error" role="alert">{actionError}</p>}
          {!error && total > 0 && (
            <div className="feed-count-line" aria-live="polite">
              Showing {firstShown}-{lastShown} of {total} matching reports
            </div>
          )}

          <div className={`feed-results ${loading && items.length > 0 ? 'is-loading' : ''}`} aria-live="polite" aria-busy={loading}>
            {results}
          </div>

          {!error && totalPages > 1 && (
            <nav className="feed-pager" aria-label="Report pages">
              <button className="ghost-button small" onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1}>Previous</button>
              <span>Page {currentPage} of {totalPages}</span>
              <button className="ghost-button small" onClick={() => setPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages}>Next</button>
            </nav>
          )}
        </section>

        {selectedItem ? (
          <aside className="panel feed-detail" aria-label="Selected report details">
            <div className="panel-header">
              <SeverityBadge severity={selectedItem.severity} manual={selectedItem.severityOverridden} />
              <span className="status-pill neutral">{selectedItem.reviewStatus}</span>
            </div>
            <h3>{selectedItem.headline}</h3>
            <p className="feed-detail-summary">{selectedItem.summary}</p>

            <div className="severity-panel">
              <strong>Severity assessment</strong>
              <p>{selectedItem.severityRationale}</p>
              {selectedItem.severityOverridden && (
                <p className="severity-override-note">
                  Set manually{selectedItem.severityOverriddenAt ? ` on ${formatIsoDate(selectedItem.severityOverriddenAt)}` : ''}.
                  Automatic assessment: {selectedItem.assessedSeverity}.
                </p>
              )}
              <label className="filter-select">
                <span>Correct severity</span>
                <select
                  aria-label="Correct severity"
                  value={selectedItem.severityOverridden ? selectedItem.severity : ''}
                  disabled={pendingId === selectedItem.id}
                  onChange={(event) => overrideSeverity(selectedItem, event.target.value === '' ? null : event.target.value as Severity)}
                >
                  <option value="">Automatic ({selectedItem.assessedSeverity})</option>
                  {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                </select>
              </label>
            </div>

            <dl className="feed-facts">
              <div><dt>Source</dt><dd>{selectedItem.source}</dd></div>
              <div><dt>Source type</dt><dd>{selectedItem.sourceType}</dd></div>
              <div><dt>Published</dt><dd>{formatIsoDate(selectedItem.publishedAt)}</dd></div>
              {selectedItem.sourceModifiedAt && <div><dt>Source modified</dt><dd>{formatIsoDate(selectedItem.sourceModifiedAt)}</dd></div>}
              {!isDemo && <div><dt>Retrieved by app</dt><dd>{formatIsoDate(selectedItem.retrievedAt)}</dd></div>}
              {!isDemo && <div><dt>Source last checked</dt><dd>{formatIsoDate(selectedItem.lastCheckedAt)}</dd></div>}
              <div><dt>Countries</dt><dd>{selectedItem.countries.map((country) => country.name).join(', ')}</dd></div>
              {(selectedItem.location || selectedItem.locationText) && <div><dt>Location</dt><dd>{selectedItem.location?.label ?? selectedItem.locationText}</dd></div>}
              {!isDemo && <div><dt>Assessment method</dt><dd>{ASSESSMENT_METHOD_LABELS[selectedItem.assessmentMethod]}</dd></div>}
              <div><dt>Category</dt><dd>{selectedItem.categoryLabels.length > 0 ? selectedItem.categoryLabels.join(', ') : 'None detected'}</dd></div>
              <div><dt>Reliability</dt><dd>{selectedItem.reliability}</dd></div>
              <div><dt>Assessment confidence</dt><dd>{selectedItem.assessmentConfidence}</dd></div>
              {selectedItem.entities && <div><dt>Entities</dt><dd>{selectedItem.entities}</dd></div>}
              {selectedItem.relevance && <div><dt>Relevance</dt><dd>{selectedItem.relevance}</dd></div>}
              {selectedItem.reviewedAt && <div><dt>Reviewed</dt><dd>{formatIsoDate(selectedItem.reviewedAt)}{selectedItem.reviewedBy ? ` by ${selectedItem.reviewedBy}` : ''}</dd></div>}
              {selectedItem.watchlistedAt && <div><dt>Added to watchlist</dt><dd>{formatIsoDate(selectedItem.watchlistedAt)}</dd></div>}
            </dl>

            <div className="feed-detail-actions">
              <button
                className="outline-button"
                onClick={() => toggleReview(selectedItem)}
                disabled={pendingId === selectedItem.id}
              >
                {selectedItem.reviewStatus === 'Reviewed' ? 'Mark as unreviewed' : 'Mark as reviewed'}
              </button>
              <button
                className="ghost-button"
                onClick={() => toggleWatchlist(selectedItem)}
                disabled={pendingId === selectedItem.id}
                aria-pressed={selectedItem.watchlisted}
              >
                {selectedItem.watchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
              </button>
            </div>
            <a className="source-link" href={selectedItem.url} target="_blank" rel="noreferrer">Open publisher article</a>
            {selectedItem.sourceUrl && <a className="source-link" href={selectedItem.sourceUrl} target="_blank" rel="noreferrer">View publisher feed</a>}
            <p className="muted-note">
              {isDemo
                ? 'Demo content for workflow testing. Source links are placeholders; verify reports before acting.'
                : 'Publisher-provided headline and summary. Severity is a rules-based estimate (impact, scope, urgency, source, corroboration), not an analyst judgement; your corrections are kept when the feed updates. Confidence reflects how much explicit evidence the text gives, not whether the report is true. Review, watchlist and severity choices are saved for this browser.'}
            </p>
          </aside>
        ) : (
          <aside className="panel feed-detail feed-empty-detail">Select a report to inspect its source and assessment metadata.</aside>
        )}
      </div>
    </div>
  );
}

function ThreatIndicatorsPanel() {
  const [signals, setSignals] = useState(threatIndicators);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [countryFilter, setCountryFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [quickFilter, setQuickFilter] = useState<'All signals' | 'Worsening' | 'Watchlisted'>('All signals');
  const [selectedId, setSelectedId] = useState(signals[0]?.id ?? '');

  const filteredSignals = signals.filter((signal) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [
      signal.name,
      signal.category,
      signal.geography,
      signal.country,
      signal.rationale,
    ].join(' ').toLowerCase().includes(query);

    return matchesSearch
      && (categoryFilter === 'All' || signal.category === categoryFilter)
      && (countryFilter === 'All' || signal.country === countryFilter)
      && (statusFilter === 'All' || signal.status === statusFilter)
      && (quickFilter !== 'Worsening' || signal.status === 'Worsening')
      && (quickFilter !== 'Watchlisted' || signal.watchlisted);
  });

  const selectedSignal = filteredSignals.find((signal) => signal.id === selectedId) ?? filteredSignals[0];
  const worseningCount = signals.filter((signal) => signal.status === 'Worsening').length;
  const monitoredCount = signals.filter((signal) => signal.watchlisted).length;
  const elevatedCount = signals.filter((signal) => signal.level === 'High' || signal.level === 'Elevated').length;
  const hasFilters = search !== '' || categoryFilter !== 'All' || countryFilter !== 'All'
    || statusFilter !== 'All' || quickFilter !== 'All signals';

  function resetFilters() {
    setSearch('');
    setCategoryFilter('All');
    setCountryFilter('All');
    setStatusFilter('All');
    setQuickFilter('All signals');
  }

  function toggleWatchlist() {
    if (!selectedSignal) return;
    setSignals((currentSignals) => currentSignals.map((signal) => (
      signal.id === selectedSignal.id ? { ...signal, watchlisted: !signal.watchlisted } : signal
    )));
  }

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Early-warning monitor / demo dataset</div>
          <h2>Threat indicators</h2>
        </div>
        <span className="status-pill neutral">Illustrative signals only</span>
      </div>

      <section className="indicator-metrics" aria-label="Indicator summary">
        <article className="metric-card neutral"><span>Tracked signals</span><strong>{signals.length}</strong></article>
        <article className="metric-card critical"><span>Worsening</span><strong>{worseningCount}</strong></article>
        <article className="metric-card warning"><span>Elevated / high</span><strong>{elevatedCount}</strong></article>
        <article className="metric-card positive"><span>Watchlisted</span><strong>{monitoredCount}</strong></article>
      </section>

      <div className="indicator-workspace">
        <section className="panel indicator-register" aria-label="Threat indicator register">
          <div className="indicator-filters">
            <label className="indicator-search">
              <span className="sr-only">Search indicators</span>
              <input
                type="search"
                placeholder="Search indicators, places, rationale..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="filter-select">
              <span>Category</span>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option>All</option>
                {[...new Set(signals.map((signal) => signal.category))].sort().map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label className="filter-select">
              <span>Country</span>
              <select value={countryFilter} onChange={(event) => setCountryFilter(event.target.value)}>
                <option>All</option>
                {[...new Set(signals.map((signal) => signal.country))].sort().map((country) => (
                  <option key={country}>{country}</option>
                ))}
              </select>
            </label>
            <label className="filter-select">
              <span>Trend</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option>All</option>
                {[...new Set(signals.map((signal) => signal.status))].sort().map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            {hasFilters && <button className="ghost-button" onClick={resetFilters}>Reset</button>}
          </div>

          <div className="indicator-quick-filters" role="group" aria-label="Indicator quick filters">
            {(['All signals', 'Worsening', 'Watchlisted'] as const).map((filter) => (
              <button
                key={filter}
                className={quickFilter === filter ? 'selected' : ''}
                onClick={() => setQuickFilter(filter)}
                aria-pressed={quickFilter === filter}
              >
                {filter}
              </button>
            ))}
            <span>{filteredSignals.length} signals</span>
          </div>

          <div className="indicator-table-head" aria-hidden="true">
            <span>Indicator</span><span>Geography</span><span>Level</span><span>Trend</span><span>Recent pattern</span>
          </div>
          <div className="indicator-list" aria-live="polite">
            {filteredSignals.length === 0 ? (
              <div className="feed-empty">No indicators match these filters.</div>
            ) : filteredSignals.map((signal) => (
              <button
                key={signal.id}
                className={`indicator-row ${selectedSignal?.id === signal.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(signal.id)}
                aria-pressed={selectedSignal?.id === signal.id}
              >
                <span className="indicator-name">
                  <strong>{signal.name}</strong>
                  <small>{signal.id} / {signal.category}</small>
                </span>
                <span className="indicator-place">{signal.geography}<small>{signal.country}</small></span>
                <span><span className={`badge ${signal.level === 'High' ? 'critical' : signal.level === 'Elevated' ? 'warning' : 'neutral'}`}>{signal.level}</span></span>
                <span className={`indicator-status ${signal.status.toLowerCase()}`}>{signal.status}</span>
                <span className="indicator-spark" aria-label="Recent seven-period trend">
                  {signal.trend.map((point, index) => (
                    <i key={`${signal.id}-${index}`} style={{ height: `${point}%` }} />
                  ))}
                </span>
              </button>
            ))}
          </div>
        </section>

        {selectedSignal ? (
          <aside className="panel indicator-detail" aria-label="Selected indicator details">
            <div className="panel-header">
              <span className={`indicator-status ${selectedSignal.status.toLowerCase()}`}>{selectedSignal.status}</span>
              <span className={`badge ${selectedSignal.level === 'High' ? 'critical' : selectedSignal.level === 'Elevated' ? 'warning' : 'neutral'}`}>{selectedSignal.level}</span>
            </div>
            <div className="eyebrow">{selectedSignal.id} / {selectedSignal.category}</div>
            <h3>{selectedSignal.name}</h3>

            <div className="indicator-current">
              <div><span className="meta-label">Current reading</span><strong>{selectedSignal.currentValue}</strong><small>{selectedSignal.unit}</small></div>
              <div><span className="meta-label">Baseline</span><strong>{selectedSignal.baselineValue}</strong><small>{selectedSignal.unit}</small></div>
            </div>

            <div className="indicator-detail-chart" aria-label="Illustrative trend over seven periods">
              {selectedSignal.trend.map((point, index) => (
                <div key={`${selectedSignal.id}-detail-${index}`}>
                  <span style={{ height: `${point}%` }} />
                  <small>{index + 1}</small>
                </div>
              ))}
            </div>
            <p className="indicator-chart-caption">Relative signal activity / last 7 periods</p>

            <dl className="feed-facts">
              <div><dt>Geography</dt><dd>{selectedSignal.geography}, {selectedSignal.country}</dd></div>
              <div><dt>Confidence</dt><dd>{selectedSignal.confidence}</dd></div>
              <div><dt>Source reliability</dt><dd>{selectedSignal.reliability}</dd></div>
              <div><dt>First observed</dt><dd>{formatIsoDate(selectedSignal.firstObserved)}</dd></div>
              <div><dt>Last updated</dt><dd>{formatIsoDate(selectedSignal.lastUpdated)}</dd></div>
            </dl>

            <div className="indicator-rationale">
              <h4>Analyst interpretation</h4>
              <p>{selectedSignal.rationale}</p>
            </div>

            <div className="indicator-sources">
              <h4>Source provenance</h4>
              {selectedSignal.sources.map((source) => (
                <div key={source.name}>
                  <span><strong>{source.name}</strong><small>{source.type}</small></span>
                  <span className="badge neutral">Reliability {source.reliability}</span>
                </div>
              ))}
            </div>

            <button className="outline-button indicator-watch-button" onClick={toggleWatchlist} aria-pressed={selectedSignal.watchlisted}>
              {selectedSignal.watchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
            </button>
            <p className="muted-note">Demo values and trend points are illustrative, not live measurements. Validate signals against original sources before acting.</p>
          </aside>
        ) : (
          <aside className="panel indicator-detail feed-empty-detail">Select a signal to inspect its trend and source provenance.</aside>
        )}
      </div>
    </div>
  );
}

function IncidentDetailPanel() {
  const incident = incidentDetails[0];

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Incident analysis</div>
          <h2>{incident.title}</h2>
        </div>
        <button className="outline-button">Create incident review</button>
      </div>

      <div className="incident-layout">
        <div className="panel">
          <div className="panel-header">
            <h3>Event summary</h3>
            <span className={`badge ${severityTone[incident.severity as keyof typeof severityTone]}`}>{incident.severity}</span>
          </div>
          <div className="facts-grid">
            <div><span className="meta-label">Incident ID</span><strong>{incident.id}</strong></div>
            <div><span className="meta-label">Date and time</span><strong>{formatIsoDate(incident.date)}</strong></div>
            <div><span className="meta-label">Country</span><strong>{incident.country}</strong></div>
            <div><span className="meta-label">Region</span><strong>{incident.region}</strong></div>
            <div><span className="meta-label">Coordinates</span><strong>{incident.coordinates}</strong></div>
            <div><span className="meta-label">Current status</span><strong>{incident.status}</strong></div>
          </div>

          <div className="detail-block">
            <h4>Description</h4>
            <p>{incident.description}</p>
          </div>

          <div className="detail-block">
            <h4>What happened?</h4>
            <p>{incident.trigger}</p>
          </div>

          <div className="detail-block">
            <h4>Who was involved?</h4>
            <p>{incident.actors}</p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3>Impact assessment</h3>
          </div>
          <div className="impact-stack">
            <div>
              <span className="meta-label">Operational impact</span>
              <p>{incident.operationalImpact}</p>
            </div>
            <div>
              <span className="meta-label">Business impact</span>
              <p>{incident.businessImpact}</p>
            </div>
            <div>
              <span className="meta-label">Human-rights impact</span>
              <p>{incident.rightsImpact}</p>
            </div>
          </div>
          <ul className="action-list">
            {incident.recommendedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel timeline-panel">
        <div className="panel-header">
          <h3>Timeline and review history</h3>
        </div>
        <div className="timeline-list">
          {incident.timeline.map((event) => (
            <div key={event.label} className="timeline-item">
              <span className="timeline-dot" />
              <div>
                <strong>{event.label}</strong>
                <small>{event.value}</small>
                <p>{event.detail}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="muted-note">{incident.reviewHistory}</p>
      </div>
    </div>
  );
}

function CountryAssessmentPanel() {
  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Country assessments</div>
          <h2>Regional risk evaluation</h2>
        </div>
        <button className="outline-button">Create assessment</button>
      </div>

      <div className="country-grid">
        {countryAssessmentDetails.map((item) => (
          <div key={item.country} className="panel country-card">
            <div className="panel-header">
              <h3>{item.country}</h3>
              <span className={`badge ${severityTone[item.risk as keyof typeof severityTone]}`}>{item.risk}</span>
            </div>

            <div className="score-ring">
              <div>
                <strong>{item.score}</strong>
                <span>Risk score</span>
              </div>
            </div>

            <div className="risk-row">
              <span className="meta-label">Trend</span>
              <strong>{item.trend}</strong>
            </div>
            <div className="risk-row">
              <span className="meta-label">Confidence</span>
              <strong>{item.confidence}</strong>
            </div>

            <p>{item.summary}</p>

            {item.sections.map((section) => (
              <div key={section.heading} className="inline-section">
                <h4>{section.heading}</h4>
                <p>{section.text}</p>
              </div>
            ))}

            <div className="tag-list">
              {item.indicators.map((indicator) => (
                <span key={indicator} className="chip">{indicator}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SIBBuilderPanel() {
  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Security information bulletin</div>
          <h2>SIB builder</h2>
        </div>
        <div className="action-cluster">
          <button className="ghost-button">Approve</button>
          <button className="outline-button">Export PDF</button>
        </div>
      </div>

      <div className="sib-layout">
        <div className="panel form-panel">
          <div className="panel-header">
            <h3>Bulletin record</h3>
            <span className="status-pill success">Draft</span>
          </div>

          <div className="form-grid">
            <label>
              Title
              <input defaultValue={sibDraft.title} />
            </label>
            <label>
              Classification
              <input defaultValue={sibDraft.classification} />
            </label>
            <label>
              Severity
              <input defaultValue={sibDraft.severity} />
            </label>
            <label>
              Location
              <input defaultValue={sibDraft.location} />
            </label>
            <label className="wide">
              Executive summary
              <textarea defaultValue={sibDraft.summary} />
            </label>
            <label className="wide">
              Current situation
              <textarea defaultValue={sibDraft.currentSituation} />
            </label>
            <label className="wide">
              Recommended actions
              <textarea defaultValue={sibDraft.recommendedActions.join('\n')} />
            </label>
          </div>
        </div>

        <div className="panel preview-panel">
          <div className="panel-header">
            <h3>Preview</h3>
            <span className={`badge ${severityTone[sibDraft.severity as keyof typeof severityTone]}`}>{sibDraft.severity}</span>
          </div>

          <div className="sib-banner">
            <strong>{sibDraft.title}</strong>
            <span>{sibDraft.classification}</span>
          </div>

          <div className="sib-content">
            <p><strong>Location:</strong> {sibDraft.location}</p>
            <p><strong>Summary:</strong> {sibDraft.summary}</p>
            <p><strong>Current situation:</strong> {sibDraft.currentSituation}</p>
            <p><strong>Impact on employees:</strong> {sibDraft.impactOnEmployees}</p>
            <p><strong>Impact on operations:</strong> {sibDraft.impactOnOperations}</p>
            <p><strong>Approver:</strong> {sibDraft.approver}</p>
          </div>

          <div className="export-row">
            <button className="ghost-button">PDF</button>
            <button className="ghost-button">Word</button>
            <button className="ghost-button">HTML</button>
            <button className="ghost-button">Email</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WatchlistPanel() {
  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Watchlists and alerts</div>
          <h2>Operational monitoring</h2>
        </div>
        <button className="outline-button">New watchlist</button>
      </div>

      <div className="watch-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>Watchlists</h3>
          </div>
          <div className="watchlist-stack">
            {watchlists.map((watchlist) => (
              <div key={watchlist.name} className="watch-card">
                <div className="watch-head">
                  <strong>{watchlist.name}</strong>
                  <span className={`badge ${severityTone[watchlist.severity as keyof typeof severityTone]}`}>{watchlist.severity}</span>
                </div>
                <div className="detail-row">
                  <span>{watchlist.type}</span>
                  <span>{watchlist.alerts} alerts</span>
                </div>
                <div className="tag-list">
                  {watchlist.items.map((item) => (
                    <span key={item} className="chip">{item}</span>
                  ))}
                </div>
                <small>{watchlist.lastUpdated}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3>Alert feed</h3>
          </div>
          <div className="alert-stack">
            {alertFeed.map((alert) => (
              <div key={alert.title} className="alert-item">
                <div className="watch-head">
                  <strong>{alert.title}</strong>
                  <span className={`badge ${severityTone[alert.severity as keyof typeof severityTone]}`}>{alert.severity}</span>
                </div>
                <div className="detail-row">
                  <span>{alert.channel}</span>
                  <span>{alert.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SourcesPanel() {
  const [sources, setSources] = useState<SourceRegistryItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [changes, setChanges] = useState<SourceChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');

  async function loadSources(checkFeeds = false) {
    setLoading(true);
    setError('');

    try {
      if (checkFeeds) {
        const feedResponse = await fetch('/api/feed/public?refresh=true');
        const feedPayload = await feedResponse.json() as PublicFeedPayload;
        if (!feedResponse.ok) throw new Error(feedPayload.error || `Feed check returned HTTP ${feedResponse.status}`);
      }

      const response = await fetch('/api/sources');
      if (!response.ok) throw new Error(`Source registry returned HTTP ${response.status}`);
      const payload = await response.json() as SourceRegistryPayload;
      setSources(payload.items);
      setSelectedId((currentId) => payload.items.some((source) => source.id === currentId)
        ? currentId
        : payload.items[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load source registry.');
    } finally {
      setLoading(false);
    }
  }

  const reloadSourcesRef = useRef(loadSources);
  reloadSourcesRef.current = loadSources;

  useEffect(() => {
    void loadSources();
    const events = new EventSource('/api/events');
    let refreshTimer: number | undefined;
    const refreshAfterSync = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void reloadSourcesRef.current(), 250);
    };
    events.addEventListener('source-sync-updated', refreshAfterSync);
    return () => {
      events.close();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setChanges([]);
      return undefined;
    }
    const controller = new AbortController();
    void fetch(`/api/sources/${encodeURIComponent(selectedId)}/history`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load source change history.');
        return response.json() as Promise<{ items: SourceChange[] }>;
      })
      .then((payload) => setChanges(payload.items))
      .catch((historyError: unknown) => {
        if (historyError instanceof DOMException && historyError.name === 'AbortError') return;
        setChanges([]);
      });
    return () => controller.abort();
  }, [selectedId]);

  const filteredSources = sources.filter((source) => (
    statusFilter === 'All'
    || (statusFilter === 'Healthy' && source.status === 'healthy')
    || (statusFilter === 'Stale' && source.status === 'stale')
    || (statusFilter === 'Unavailable' && source.status === 'unavailable')
    || (statusFilter === 'Not checked' && source.status === 'not_checked')
    || (statusFilter === 'Setup required' && source.status === 'setup_required')
  ));
  const selectedSource = filteredSources.find((source) => source.id === selectedId) ?? filteredSources[0];
  const healthyCount = sources.filter((source) => source.status === 'healthy').length;
  const staleCount = sources.filter((source) => source.status === 'stale').length;
  const unavailableCount = sources.filter((source) => source.status === 'unavailable').length;
  const setupCount = sources.filter((source) => source.status === 'setup_required').length;

  function statusLabel(status: SourceRegistryItem['status']) {
    return status === 'not_checked' ? 'Not checked' : status === 'setup_required' ? 'Setup required' : status[0].toUpperCase() + status.slice(1);
  }

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Provider registry / public connectors</div>
          <h2>Sources</h2>
        </div>
        <button className="outline-button" onClick={() => void loadSources(true)} disabled={loading}>
          {loading ? 'Checking feeds...' : 'Check feeds'}
        </button>
      </div>

      <section className="source-summary" aria-label="Source health summary">
        <article><span>Configured</span><strong>{sources.length}</strong></article>
        <article><span>Healthy</span><strong>{healthyCount}</strong></article>
        <article><span>Stale</span><strong>{staleCount}</strong></article>
        <article><span>Unavailable</span><strong>{unavailableCount}</strong></article>
        <article><span>Setup required</span><strong>{setupCount}</strong></article>
      </section>

      {error && <p className="source-registry-error" role="alert">{error}</p>}

      <div className="source-workspace">
        <section className="panel source-registry" aria-label="Configured public sources">
          <div className="source-registry-toolbar">
            <h3>Configured sources</h3>
            <label className="filter-select">
              <span>Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option>All</option>
                <option>Healthy</option>
                <option>Stale</option>
                <option>Unavailable</option>
                <option>Not checked</option>
                <option>Setup required</option>
              </select>
            </label>
          </div>

          <div className="source-registry-list" aria-live="polite">
            {filteredSources.length === 0 ? (
              <div className="feed-empty">No sources match this status.</div>
            ) : filteredSources.map((source) => (
              <button
                key={source.id}
                className={`source-registry-row ${selectedSource?.id === source.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(source.id)}
                aria-pressed={selectedSource?.id === source.id}
              >
                <span className={`source-state ${source.status}`} />
                <span className="source-registry-name">
                  <strong>{source.name}</strong>
                  <small>{source.format} / {source.coverage}</small>
                </span>
                <span className={`source-health ${source.status}`}>
                  {statusLabel(source.status)}
                </span>
              </button>
            ))}
          </div>
        </section>

        {selectedSource ? (
          <aside className="panel source-detail" aria-label="Selected source details">
            <div className="panel-header">
              <div>
                <div className="eyebrow">{selectedSource.id}</div>
                <h3>{selectedSource.name}</h3>
              </div>
              <span className={`source-health ${selectedSource.status}`}>
                {statusLabel(selectedSource.status)}
              </span>
            </div>

            <dl className="source-facts">
              <div><dt>Coverage</dt><dd>{selectedSource.coverage}</dd></div>
              <div><dt>Feed format</dt><dd>{selectedSource.format}</dd></div>
              <div><dt>Refresh / cache</dt><dd>{selectedSource.cadence}</dd></div>
              <div><dt>Attribution</dt><dd>{selectedSource.attribution}</dd></div>
              <div><dt>Items in last check</dt><dd>{selectedSource.itemCount}</dd></div>
              <div><dt>Last checked</dt><dd>{selectedSource.lastCheckedAt ? formatIsoDate(selectedSource.lastCheckedAt) : 'Not checked yet'}</dd></div>
              <div><dt>Last success</dt><dd>{selectedSource.lastSuccessAt ? formatIsoDate(selectedSource.lastSuccessAt) : 'No successful check yet'}</dd></div>
              <div><dt>Next scheduled check</dt><dd>{selectedSource.nextRunAt ? formatIsoDate(selectedSource.nextRunAt) : 'Waiting for first check'}</dd></div>
              <div><dt>Update mechanism</dt><dd>Scheduled polling / every {selectedSource.pollIntervalMs >= 3_600_000 ? `${Math.round(selectedSource.pollIntervalMs / 3_600_000)} h` : `${Math.round(selectedSource.pollIntervalMs / 60000)} min`}</dd></div>
            </dl>

            {selectedSource.status === 'setup_required' && selectedSource.setup && (
              <div className="source-setup" role="note">
                <strong>Setup required</strong>
                <p>{selectedSource.setup.instructions}</p>
                <p>Server setting{selectedSource.setup.envVars.length > 1 ? 's' : ''}: <code>{selectedSource.setup.envVars.join(', ')}</code> (kept on the server, never sent to the browser).</p>
                <a href={selectedSource.setup.signupUrl} target="_blank" rel="noreferrer">Get free access</a>
              </div>
            )}
            {selectedSource.status === 'stale' && selectedSource.lastSuccessAt && (
              <p className="source-registry-error">Stale: showing reports retained from the last successful check ({formatIsoDate(selectedSource.lastSuccessAt)}).</p>
            )}
            {selectedSource.lastError && <p className="source-registry-error">{selectedSource.lastError}</p>}
            <div className="source-detail-links">
              <a href={selectedSource.url} target="_blank" rel="noreferrer">Open feed endpoint</a>
              <a href={selectedSource.termsUrl} target="_blank" rel="noreferrer">Publisher information / terms</a>
            </div>
            <div className="source-history">
              <h4>Recent source corrections</h4>
              {changes.length === 0 ? (
                <p className="muted-note">No publisher corrections recorded for this source.</p>
              ) : changes.map((change) => (
                <article key={change.changeId}>
                  <strong>{change.headline}</strong>
                  <small>{formatIsoDate(change.changedAt)}</small>
                  <span>{change.fields.map((field) => field.field).join(', ')} changed</span>
                </article>
              ))}
            </div>
            <p className="muted-note">This registry reports connector reachability and freshness, not source accuracy. Severity labels are either provided by the source or estimated by transparent automated rules; check the original report before acting.</p>
          </aside>
        ) : (
          <aside className="panel source-detail feed-empty-detail">Select a source to inspect its connector and attribution details.</aside>
        )}
      </div>
    </div>
  );
}

function App() {
  const [activeView, setActiveView] = useState<(typeof navItems)[number]>('Overview');
  const feed = usePublicFeed();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const feedSources = feed.payload?.sources ?? [];
  const feedLive = feedSources.length > 0 && feedSources.some((source) => source.status === 'healthy');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">GSI</div>
          <div>
            <h1>Global Security Intelligence</h1>
          </div>
        </div>

        <nav className="nav-section">
          <p className="nav-label">Operations</p>
          <ul>
            {navItems.map((item) => (
              <li
                key={item}
                className={activeView === item ? 'active' : ''}
                onClick={() => setActiveView(item)}
              >
                {item}
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="header-left">
            <div>
              <div className="eyebrow">Operational picture</div>
              <h2>{activeView}</h2>
            </div>
            <button className="outline-button">Last refresh: {feed.payload?.fetchedAt ? relativeTime(feed.payload.fetchedAt, clock) : 'pending'}</button>
          </div>

          <div className="header-actions">
            <div className="search-box">Search incidents, sources, countries…</div>
            <div className={`status-pill ${feedLive ? 'success' : 'neutral'}`}>{feedLive ? 'Public feeds live' : 'Public feeds connecting'}</div>
            <div className="avatar">AM</div>
            <div className="theme-toggle">☾</div>
          </div>
        </header>

        {activeView === 'Overview' && <OverviewPanel feed={feed} />}
        {activeView === 'Intelligence Feed' && <IntelligenceFeedPanel feed={feed} />}
        {activeView === 'Threat Indicators' && <ThreatIndicatorsPanel />}
        {activeView === 'Incidents' && <IncidentDetailPanel />}
        {activeView === 'Country Assessments' && <CountryAssessmentPanel />}
        {activeView === 'SIBs' && <SIBBuilderPanel />}
        {activeView === 'Watchlists' && <WatchlistPanel />}
        {activeView === 'Sources' && <SourcesPanel />}
      </main>
    </div>
  );
}

export default App;
