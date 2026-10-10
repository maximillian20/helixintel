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

type FeedItem = Omit<
  (typeof intelligenceFeed)[number],
  'sourceType' | 'country' | 'region' | 'type' | 'severity' | 'reliability' | 'confidence' | 'relevance' | 'watchlist' | 'reviewStatus'
> & {
  id?: string;
  sourceType: string;
  country: string;
  region: string;
  type: string;
  severity: string;
  reliability: string;
  confidence: string;
  relevance: string;
  watchlist: boolean;
  reviewStatus: string;
  sourceUrl?: string;
  sourceModifiedAt?: string | null;
  retrievedAt?: string;
  lastCheckedAt?: string;
  verificationStatus?: string;
  attribution?: string;
};

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
  status: 'healthy' | 'stale' | 'unavailable' | 'not_checked';
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

  return { payload, error, loading };
}

type PublicFeedState = ReturnType<typeof usePublicFeed>;

type PlaceMention = { place: Place; items: PublicFeedPayload['items'] };

function OverviewPanel({ feed }: { feed: PublicFeedState }) {
  const mapRef = useRef<LeafletMap>(null);
  const [mapFilter, setMapFilter] = useState('All mentioned');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => feed.payload?.items ?? [], [feed.payload]);
  const sources = useMemo(() => feed.payload?.sources ?? [], [feed.payload]);
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
  const visibleMentions = mapFilter === 'Top 10' ? mentions.slice(0, 10) : mentions;
  const maxMentions = Math.max(1, ...mentions.map((entry) => entry.items.length));
  const latest = [...items]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 6);

  const hasData = items.length > 0;
  const feedHealthy = sources.length > 0 && healthyCount === sources.length;

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
          <strong>{sources.length > 0 ? `${healthyCount} of ${sources.length} healthy` : 'Not checked'}</strong>
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
          <div className="metric-header"><span>Places named in headlines</span><span className="metric-trend">keyword match</span></div>
          <strong>{mentions.length}</strong>
        </article>
        <article className={`metric-card ${feedHealthy ? 'positive' : 'warning'}`}>
          <div className="metric-header"><span>Sources healthy</span><span className="metric-trend">connector status</span></div>
          <strong>{healthyCount}/{sources.length}</strong>
        </article>
      </section>

      <section className="content-grid top-row">
        <div className="panel large-panel map-panel">
          <div className="panel-header map-panel-header">
            <div>
              <h3>Global news map</h3>
              <span className="map-subtitle">Places named in current public headlines / LIVE</span>
            </div>
            <div className="map-toolbar">
              <label className="map-filter-control">
                <span className="sr-only">Filter map</span>
                <select value={mapFilter} onChange={(event) => setMapFilter(event.target.value)}>
                  <option>All mentioned</option>
                  <option>Top 10</option>
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
              {visibleMentions.map((entry) => (
                <CircleMarker
                  key={entry.place.name}
                  center={[entry.place.lat, entry.place.lng]}
                  radius={5 + 14 * Math.sqrt(entry.items.length / maxMentions)}
                  pathOptions={{ color: '#e2e8f0', weight: 1.5, fillColor: '#38bdf8', fillOpacity: 0.65 }}
                >
                  <Tooltip direction="top">{entry.place.name}: {entry.items.length} article{entry.items.length === 1 ? '' : 's'}</Tooltip>
                  <Popup>
                    <div className="risk-popup">
                      <strong>{entry.place.name}</strong>
                      <p>{entry.items.length} article{entry.items.length === 1 ? '' : 's'} name this place.</p>
                      {entry.items.slice(0, 3).map((item) => (
                        <p key={item.id}>
                          <a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a>
                          <br /><small>{item.source}</small>
                        </p>
                      ))}
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
            <div className="map-legend">
              <span><i className="monitoring-dot" />Marker size = number of articles</span>
            </div>
          </div>
          <div className="map-footer">
            <span>{visibleMentions.length} of {mentions.length} places shown</span>
            <span>Place names are matched by keyword; this is not a risk rating. Select a marker for headlines.</span>
          </div>
        </div>

        <div className="panel medium-panel">
          <div className="panel-header">
            <h3>Latest headlines</h3>
          </div>
          <div className="priority-list">
            {latest.length === 0 && <p className="muted-note">No articles retrieved yet.</p>}
            {latest.map((item) => (
              <div key={item.id} className="priority-item">
                <div className="priority-row">
                  <span className="badge neutral">{item.source}</span>
                  <span className="meta-label">{relativeTime(item.publishedAt, now)}</span>
                </div>
                <strong>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a>
                </strong>
                <p>{item.summary}</p>
                <div className="detail-row">
                  <span>{item.attribution}</span>
                  <span>Unassessed</span>
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

function IntelligenceFeedPanel() {
  const [items, setItems] = useState<FeedItem[]>(intelligenceFeed);
  const [publicItems, setPublicItems] = useState<FeedItem[]>([]);
  const [publicSources, setPublicSources] = useState<PublicFeedPayload['sources']>([]);
  const [feedMode, setFeedMode] = useState<'Demo' | 'Public web'>('Public web');
  const [loadingPublic, setLoadingPublic] = useState(false);
  const [publicError, setPublicError] = useState('');
  const [publicFetchedAt, setPublicFetchedAt] = useState('');
  const [publicFeedCached, setPublicFeedCached] = useState(false);
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [countryFilter, setCountryFilter] = useState('All');
  const [reviewFilter, setReviewFilter] = useState('All');
  const [quickFilter, setQuickFilter] = useState<'All' | 'Needs review' | 'On watchlist'>('All');
  const [selectedHeadline, setSelectedHeadline] = useState(items[0]?.headline ?? '');
  const activeItems = feedMode === 'Demo' ? items : publicItems;

  const filteredItems = activeItems.filter((item) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [
      item.headline,
      item.summary,
      item.source,
      item.country,
      item.location,
      item.entities,
      item.type,
    ].join(' ').toLowerCase().includes(query);

    return matchesSearch
      && (severityFilter === 'All' || item.severity === severityFilter)
      && (countryFilter === 'All' || item.country === countryFilter)
      && (reviewFilter === 'All' || item.reviewStatus === reviewFilter)
      && (quickFilter !== 'Needs review' || item.reviewStatus !== 'Reviewed')
      && (quickFilter !== 'On watchlist' || item.watchlist);
  });

  const selectedItem = filteredItems.find((item) => item.id === selectedHeadline || item.headline === selectedHeadline) ?? filteredItems[0];
  const hasFilters = search !== '' || severityFilter !== 'All' || countryFilter !== 'All'
    || reviewFilter !== 'All' || quickFilter !== 'All';

  async function loadPublicFeed() {
    setFeedMode('Public web');
    setLoadingPublic(true);
    setPublicError('');

    try {
      const response = await fetch('/api/feed/public');
      const payload = await response.json() as PublicFeedPayload;
      if (!response.ok) throw new Error(payload.error || `Public feeds returned HTTP ${response.status}`);

      const mappedItems: FeedItem[] = payload.items.map((item) => ({
        id: item.id,
        headline: item.headline,
        summary: item.summary,
        source: item.source,
        sourceType: 'Publisher RSS',
        date: item.publishedAt,
        location: 'Not geolocated',
        country: 'Global',
        region: 'Global',
        type: 'Public report',
        severity: 'Unassessed',
        reliability: 'Not assessed',
        confidence: 'Not assessed',
        entities: '',
        relevance: 'Not assessed',
        watchlist: false,
        reviewStatus: 'Unreviewed',
        url: item.url,
        sourceUrl: item.sourceUrl,
        sourceModifiedAt: item.sourceModifiedAt,
        retrievedAt: item.retrievedAt,
        lastCheckedAt: item.lastCheckedAt,
        verificationStatus: item.verificationStatus,
        attribution: item.attribution,
      }));

      setPublicItems(mappedItems);
      setPublicSources(payload.sources);
      setPublicFetchedAt(payload.fetchedAt ?? '');
      setPublicFeedCached(payload.cached);
      setSelectedHeadline((currentHeadline) => mappedItems.some((item) => item.id === currentHeadline || item.headline === currentHeadline)
        ? currentHeadline
        : mappedItems[0]?.id ?? mappedItems[0]?.headline ?? '');
      setPublicError(payload.error ?? '');
    } catch (error) {
      setPublicError(error instanceof Error ? error.message : 'Could not load public feeds.');
    } finally {
      setLoadingPublic(false);
    }
  }

  const publicFeedReloadRef = useRef(loadPublicFeed);
  publicFeedReloadRef.current = loadPublicFeed;

  useEffect(() => {
    void publicFeedReloadRef.current();
  }, []);

  useEffect(() => {
    if (feedMode !== 'Public web') return undefined;
    const events = new EventSource('/api/events');
    let refreshTimer: number | undefined;
    const refreshAfterSync = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void publicFeedReloadRef.current(), 250);
    };
    events.addEventListener('public-feed-updated', refreshAfterSync);
    events.addEventListener('source-sync-updated', refreshAfterSync);
    return () => {
      events.close();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [feedMode]);

  function updateSelectedItem(update: Partial<FeedItem>) {
    if (!selectedItem) return;
    const updateItems = feedMode === 'Demo' ? setItems : setPublicItems;
    updateItems((currentItems) => currentItems.map((item) => (
      (item.id ?? item.headline) === (selectedItem.id ?? selectedItem.headline) ? { ...item, ...update } : item
    )));
  }

  function resetFilters() {
    setSearch('');
    setSeverityFilter('All');
    setCountryFilter('All');
    setReviewFilter('All');
    setQuickFilter('All');
  }

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">{feedMode === 'Demo' ? 'Demo dataset' : 'Publisher RSS / public web'}</div>
          <h2>Intelligence feed</h2>
        </div>
        <div className="feed-heading-actions">
          <div className="feed-mode-switch" role="group" aria-label="Feed source mode">
            <button
              className={feedMode === 'Demo' ? 'selected' : ''}
              onClick={() => setFeedMode('Demo')}
              aria-pressed={feedMode === 'Demo'}
            >
              Demo
            </button>
            <button
              className={feedMode === 'Public web' ? 'selected' : ''}
              onClick={() => void loadPublicFeed()}
              aria-pressed={feedMode === 'Public web'}
              disabled={loadingPublic}
            >
              {loadingPublic ? 'Fetching...' : publicFetchedAt ? 'Refresh public' : 'Public web'}
            </button>
          </div>
          <span className="status-pill neutral">{filteredItems.length} of {activeItems.length} reports</span>
        </div>
      </div>

      {feedMode === 'Public web' && (
        <section className="public-feed-status" aria-live="polite">
          <div>
            <strong>Publisher-provided reporting</strong>
            <span>Unreviewed items have no analyst-assigned severity, location, or confidence.</span>
          </div>
          {publicFetchedAt && <small>{publicFeedCached ? 'No new source content' : 'Latest successful source check'} / {formatIsoDate(publicFetchedAt)}</small>}
          <div className="public-source-list">
            {publicSources.map((source) => (
              <span key={source.name} className={`source-health ${source.status}`}>
                {source.name}: {source.status} / {source.itemCount} stored
                {source.lastError ? ` / ${source.lastError}` : ''}
              </span>
            ))}
          </div>
          {publicError && <p role="alert">{publicError}</p>}
        </section>
      )}

      <div className="feed-workspace">
        <section className="panel feed-browser" aria-label="Intelligence reports">
          <div className="feed-filter-row">
            <label className="feed-search">
              <span className="sr-only">Search reports</span>
              <input
                type="search"
                placeholder="Search headlines, entities, locations..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="filter-select">
              <span>Severity</span>
              <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
                <option>All</option>
                <option>Critical</option>
                <option>High</option>
                <option>Moderate</option>
                <option>Watch</option>
                <option>Unassessed</option>
              </select>
            </label>
            <label className="filter-select">
              <span>Country</span>
              <select value={countryFilter} onChange={(event) => setCountryFilter(event.target.value)}>
                <option>All</option>
                {[...new Set(activeItems.map((item) => item.country))].sort().map((country) => (
                  <option key={country}>{country}</option>
                ))}
              </select>
            </label>
            <label className="filter-select">
              <span>Review</span>
              <select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}>
                <option>All</option>
                {[...new Set(activeItems.map((item) => item.reviewStatus))].sort().map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            {hasFilters && <button className="ghost-button" onClick={resetFilters}>Reset</button>}
          </div>

          <div className="feed-quick-filters" role="group" aria-label="Quick filters">
            {(['All', 'Needs review', 'On watchlist'] as const).map((filter) => (
              <button
                key={filter}
                className={quickFilter === filter ? 'selected' : ''}
                onClick={() => setQuickFilter(filter)}
                aria-pressed={quickFilter === filter}
              >
                {filter}
              </button>
            ))}
          </div>

          <div className="feed-results" aria-live="polite">
            {filteredItems.length === 0 ? (
              <div className="feed-empty">
                {feedMode === 'Public web' && !publicFetchedAt && !publicError
                  ? 'Load public sources to retrieve recent reports.'
                  : 'No reports match these filters.'}
              </div>
            ) : filteredItems.map((item) => (
              <button
                key={item.id ?? item.headline}
                className={`feed-result ${(selectedItem?.id ?? selectedItem?.headline) === (item.id ?? item.headline) ? 'selected' : ''}`}
                onClick={() => setSelectedHeadline(item.id ?? item.headline)}
                aria-pressed={(selectedItem?.id ?? selectedItem?.headline) === (item.id ?? item.headline)}
              >
                <div className="feed-result-top">
                  <span className={`badge ${severityTone[item.severity as keyof typeof severityTone] ?? 'neutral'}`}>{item.severity}</span>
                  <time dateTime={item.date}>{formatIsoDate(item.date)}</time>
                </div>
                <strong>{item.headline}</strong>
                <p>{item.summary}</p>
                <div className="feed-result-meta">
                  <span>{item.source}</span>
                  <span>{item.country} / {item.location}</span>
                  <span>{item.reviewStatus}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {selectedItem ? (
          <aside className="panel feed-detail" aria-label="Selected report details">
            <div className="panel-header">
              <span className={`badge ${severityTone[selectedItem.severity as keyof typeof severityTone] ?? 'neutral'}`}>{selectedItem.severity}</span>
              <span className="status-pill neutral">{selectedItem.reviewStatus}</span>
            </div>
            <h3>{selectedItem.headline}</h3>
            <p className="feed-detail-summary">{selectedItem.summary}</p>

            <dl className="feed-facts">
              <div><dt>Source</dt><dd>{selectedItem.source}</dd></div>
              <div><dt>Source type</dt><dd>{selectedItem.sourceType}</dd></div>
              <div><dt>Published</dt><dd>{formatIsoDate(selectedItem.date)}</dd></div>
              {selectedItem.sourceModifiedAt && <div><dt>Source modified</dt><dd>{formatIsoDate(selectedItem.sourceModifiedAt)}</dd></div>}
              {selectedItem.retrievedAt && <div><dt>Retrieved by app</dt><dd>{formatIsoDate(selectedItem.retrievedAt)}</dd></div>}
              {selectedItem.lastCheckedAt && <div><dt>Source last checked</dt><dd>{formatIsoDate(selectedItem.lastCheckedAt)}</dd></div>}
              <div><dt>Country / region</dt><dd>{selectedItem.country} / {selectedItem.region}</dd></div>
              <div><dt>Location</dt><dd>{selectedItem.location}</dd></div>
              <div><dt>Category</dt><dd>{selectedItem.type}</dd></div>
              <div><dt>Reliability</dt><dd>{selectedItem.reliability}</dd></div>
              <div><dt>Assessment confidence</dt><dd>{selectedItem.confidence}</dd></div>
              <div><dt>Entities</dt><dd>{selectedItem.entities}</dd></div>
              <div><dt>Relevance</dt><dd>{selectedItem.relevance}</dd></div>
            </dl>

            <div className="feed-detail-actions">
              <button
                className="outline-button"
                onClick={() => updateSelectedItem({
                  reviewStatus: selectedItem.reviewStatus === 'Reviewed' ? 'Needs review' : 'Reviewed',
                })}
              >
                {selectedItem.reviewStatus === 'Reviewed' ? 'Reopen review' : 'Mark reviewed'}
              </button>
              <button
                className="ghost-button"
                onClick={() => updateSelectedItem({ watchlist: !selectedItem.watchlist })}
                aria-pressed={selectedItem.watchlist}
              >
                {selectedItem.watchlist ? 'Remove from watchlist' : 'Add to watchlist'}
              </button>
            </div>
            <a className="source-link" href={selectedItem.url} target="_blank" rel="noreferrer">Open publisher article</a>
            {selectedItem.sourceUrl && <a className="source-link" href={selectedItem.sourceUrl} target="_blank" rel="noreferrer">View publisher feed</a>}
            <p className="muted-note">
              {feedMode === 'Demo'
                ? 'Demo content for workflow testing. Source links are placeholders; verify reports before acting.'
                : 'Publisher-provided headline and summary. This is not an assessed alert; verify the original article and corroborate independently.'}
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
  ));
  const selectedSource = filteredSources.find((source) => source.id === selectedId) ?? filteredSources[0];
  const healthyCount = sources.filter((source) => source.status === 'healthy').length;
  const staleCount = sources.filter((source) => source.status === 'stale').length;
  const unavailableCount = sources.filter((source) => source.status === 'unavailable').length;

  function statusLabel(status: SourceRegistryItem['status']) {
    return status === 'not_checked' ? 'Not checked' : status[0].toUpperCase() + status.slice(1);
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
              <div><dt>Update mechanism</dt><dd>Conditional RSS polling / {Math.round(selectedSource.pollIntervalMs / 60000)} min</dd></div>
            </dl>

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
            <p className="muted-note">This registry reports connector reachability, not source accuracy. Articles remain unassessed until reviewed and corroborated.</p>
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
        {activeView === 'Intelligence Feed' && <IntelligenceFeedPanel />}
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
