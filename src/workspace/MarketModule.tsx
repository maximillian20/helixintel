import { useEffect, useMemo, useState } from 'react';
import { marketFetch, useMarketData } from '../data/marketApi.ts';
import { sortedCountries } from '../data/countries.ts';
import type {
  AssetChart, AssetWithStatus, AssociationResult, ChartMarker, CorrelationResult, EventAsset, EventView, MarketAlertSettings, ProviderInfo, WindowReaction,
} from '../data/marketTypes.ts';
import { Notice, Pill, ago, fmt, usePersistentState, useNow, type Navigate } from './shared.tsx';

const countries = sortedCountries.filter((c) => c.code !== 'GLOBAL' && c.code !== 'UNKNOWN');
const SEVERITY_OPTIONS = ['Critical', 'High', 'Medium', 'Low', 'Unassessed'];

type Meta = {
  providers: ProviderInfo[]; categories: string[]; serverTime: string; method: string[];
  thresholds: { preliminary: number; observed: number; correlationObservations: number; correlationEventDays: number };
};
type EventRow = { key: string; type: 'report' | 'incident'; title: string; severity: string; category: string; countries: Array<{ code: string; name: string }>; anchorAt: string; anchorSource: string; members: number; suggestedAssets: number };

const utc = (iso: string | null | undefined) => {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n/a' : `${d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
};
const pct = (value: number | null, digits = 2) => (value === null ? 'n/a' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`);
const pp = (value: number | null) => (value === null ? 'n/a' : `${value > 0 ? '+' : ''}${value.toFixed(2)} pp`);
const share = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
const direction = (value: number | null) => (value === null ? 'none' : value > 0 ? 'up' : value < 0 ? 'down' : 'flat');

const FRESH_TONE: Record<string, string> = { live: 'success', delayed: 'warning', stale: 'warning', unavailable: 'critical', setup_required: 'neutral', unsupported: 'neutral', not_fetched: 'neutral' };
function FreshPill({ asset }: { asset: AssetWithStatus }) {
  return <span className={`badge ${FRESH_TONE[asset.status.status] ?? 'neutral'}`} title={asset.status.detail}>{asset.status.label}</span>;
}
const REL_TONE: Record<string, string> = { Direct: 'critical', 'Sector and geography': 'warning', Sector: 'neutral', 'Broad market': 'neutral', 'Analyst-added': 'neutral' };

// ------------------------------------------------------------------ price chart with intelligence markers

function PriceChart({ chart, selected, onSelect }: { chart: AssetChart; selected: string | null; onSelect: (marker: ChartMarker) => void }) {
  const width = 820, height = 320, pad = { left: 58, right: 16, top: 16, bottom: 34 };
  const bars = chart.bars;
  if (bars.length < 2) return <Notice>Not enough stored prices in this range to draw a chart yet.</Notice>;
  const times = bars.map((b) => Date.parse(b.t));
  // The time axis also covers events that fall outside the stored prices (for example a report after the latest close), so no marker is silently hidden.
  const markerTimes = chart.markers.map((m) => Date.parse(m.at)).filter((t) => !Number.isNaN(t));
  const t0 = Math.min(times[0], ...markerTimes), t1 = Math.max(times[times.length - 1], ...markerTimes);
  const lo = Math.min(...bars.map((b) => b.close)), hi = Math.max(...bars.map((b) => b.close));
  const span = hi - lo || hi * 0.01 || 1;
  const yMin = lo - span * 0.08, yMax = hi + span * 0.12;
  const x = (t: number) => pad.left + ((t - t0) / (t1 - t0 || 1)) * (width - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * (height - pad.top - pad.bottom);
  const path = bars.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(times[i]).toFixed(1)},${y(b.close).toFixed(1)}`).join(' ');
  const priceAt = (t: number) => {
    let best = 0;
    for (let i = 0; i < times.length; i += 1) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    return bars[best].close;
  };
  const ticks = [0, 1, 2, 3].map((i) => yMin + ((yMax - yMin) * i) / 3);
  const dateTicks = [0, 1, 2, 3, 4].map((i) => t0 + ((t1 - t0) * i) / 4);
  const inRange = chart.markers;
  const fmtAxis = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  return (
    <figure className="ws-chart market-chart" data-testid="price-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${chart.asset.name} price with ${inRange.length} linked intelligence markers`}>
        {ticks.map((tick) => (
          <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid" /><text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="axis">{tick >= 100 ? tick.toFixed(0) : tick.toFixed(2)}</text></g>
        ))}
        {dateTicks.map((tick) => <text key={tick} x={x(tick)} y={height - 12} textAnchor="middle" className="axis">{fmtAxis(tick)}</text>)}
        <path d={path} className="price-line" />
        {inRange.map((marker) => {
          const mx = x(Date.parse(marker.at)), my = y(priceAt(Date.parse(marker.at)));
          const sel = selected === marker.eventId;
          return (
            <g key={marker.eventId} className={`marker ${marker.linkStatus} ${sel ? 'selected' : ''}`} role="button" tabIndex={0} data-marker={marker.eventId}
              aria-label={`${marker.severity} severity event ${utc(marker.at)}: ${marker.title}`} aria-pressed={sel}
              onClick={() => onSelect(marker)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(marker); } }}>
              <title>{`${utc(marker.at)} — ${marker.title}`}</title>
              <line x1={mx} x2={mx} y1={pad.top} y2={height - pad.bottom} className="marker-line" />
              <line x1={mx} x2={mx} y1={pad.top} y2={height - pad.bottom} className="marker-hit" />
              <circle cx={mx} cy={my} r={sel ? 8 : 6} className={`marker-dot sev-${marker.severity.toLowerCase()}`} />
            </g>
          );
        })}
      </svg>
      <figcaption>{chart.priceBasis} Markers sit at the earliest public report time of each event. Marker colour shows event severity only; it says nothing about price direction.</figcaption>
    </figure>
  );
}

function MarkerDetail({ marker, onOpen }: { marker: ChartMarker; onOpen: () => void }) {
  return (
    <aside className="panel market-marker-detail" aria-label="Selected event" data-testid="marker-detail">
      <div className="panel-header"><h3>{marker.title}</h3></div>
      <dl className="market-facts">
        <dt>Source</dt><dd><a href={marker.url} target="_blank" rel="noreferrer noopener">{marker.source}</a></dd>
        <dt>Published (earliest report)</dt><dd>{utc(marker.at)}</dd>
        <dt>Event time</dt><dd>{marker.eventAt ? utc(marker.eventAt) : 'not recorded'}</dd>
        <dt>Event severity</dt><dd><Pill value={marker.severity} /></dd>
        <dt>Category</dt><dd>{marker.category}</dd>
        <dt>Countries</dt><dd>{marker.countries.map((c) => c.name).join(', ') || 'none identified'}</dd>
        <dt>Market relevance</dt><dd><span className={`badge ${REL_TONE[marker.relevance] ?? 'neutral'}`}>{marker.relevance}</span> <span className="badge neutral">{marker.linkStatus === 'confirmed' ? 'Confirmed by you' : 'Suggested'}</span></dd>
        <dt>Why linked</dt><dd>{marker.basis}</dd>
        <dt>Exposure pathway (hypothesis)</dt><dd>{marker.pathway || 'none recorded'}</dd>
        <dt>Coverage</dt><dd>{marker.memberCount} de-duplicated report{marker.memberCount === 1 ? '' : 's'}</dd>
      </dl>
      <button className="ghost-button" onClick={onOpen}>Open in Event view</button>
    </aside>
  );
}

// ------------------------------------------------------------------ reactions

function ReactionRow({ reaction }: { reaction: WindowReaction }) {
  if (reaction.status !== 'ok') {
    const label = reaction.status === 'pending' ? 'Pending' : reaction.status === 'unsupported' ? 'Unsupported' : 'No data';
    return (
      <tr className={`reaction ${reaction.status}`} data-window={reaction.window}>
        <th scope="row">{reaction.window}</th>
        <td colSpan={5}><span className={`badge ${reaction.status === 'pending' ? 'warning' : 'neutral'}`}>{label}</span> <small>{reaction.reason}</small></td>
      </tr>
    );
  }
  return (
    <tr className="reaction ok" data-window={reaction.window}>
      <th scope="row">{reaction.window}</th>
      <td><strong className={`move ${direction(reaction.returnPct)}`}>{pct(reaction.returnPct)}</strong><small>{direction(reaction.returnPct)}</small></td>
      <td>{pct(reaction.benchmarkReturnPct)}<small>{reaction.benchmarkNote}</small></td>
      <td><strong>{pp(reaction.adjustedPct)}</strong><small>Benchmark-adjusted return</small></td>
      <td>{pct(reaction.preReturnPct)}<small>{reaction.preFromAt ? `from ${utc(reaction.preFromAt)}` : 'no earlier price'}</small></td>
      <td><small>Reference {reaction.referencePrice?.toPrecision(6)} at {utc(reaction.referenceAt)}</small><small>Measured {reaction.measuredPrice?.toPrecision(6)} at {utc(reaction.measuredAt)}</small></td>
    </tr>
  );
}

function AssetCard({ item, eventKey, onChanged, onChart }: { item: EventAsset; eventKey: string; onChanged: () => void; onChart: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const asset = item.asset;
  const setLink = async (status: 'confirmed' | 'rejected' | 'reset') => {
    try { setError(''); await marketFetch('PUT', '/event/link', { key: eventKey, assetId: asset.id, status }); onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save.'); }
  };
  const track = async () => {
    try { setError(''); await marketFetch(asset.watched ? 'DELETE' : 'POST', asset.watched ? `/watchlist?assetId=${encodeURIComponent(asset.id)}` : '/watchlist', asset.watched ? undefined : { assetId: asset.id }); onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save.'); }
  };
  const relevance = item.link.explanation?.relevance ?? 'Analyst-added';
  const statusLabel = item.link.status === 'confirmed' ? 'Confirmed by you' : item.link.status === 'rejected' ? 'Rejected by you' : 'Suggested';
  return (
    <article className={`panel market-asset ${item.link.status}`} data-asset={asset.id} data-link-status={item.link.status}>
      <header className="market-asset-head">
        <div>
          <h4>{asset.symbol} <span className="muted-note">{asset.name}</span></h4>
          <small>{asset.class} · {asset.exchange}{asset.mic ? ` (${asset.mic})` : ''} · {asset.currency} · {asset.adjustment}{asset.note ? ` · ${asset.note}` : ''}</small>
        </div>
        <div className="market-asset-badges">
          <span title="How strongly the app's rules connect this event to the asset. This is a hypothesis about exposure." className={`badge ${REL_TONE[relevance] ?? 'neutral'}`}>Relevance: {relevance}</span>
          <span className={`badge ${item.link.status === 'confirmed' ? 'success' : 'neutral'}`}>{statusLabel}</span>
          <FreshPill asset={asset} />
        </div>
      </header>
      {item.link.explanation && <p className="market-basis"><strong>Why suggested:</strong> {item.link.explanation.basis}</p>}
      {item.link.origin === 'user' && <p className="market-basis"><strong>Added by you</strong> ({item.link.updatedBy}).</p>}
      {item.link.status !== 'rejected' && (
        <table className="market-reactions" aria-label={`Observed price changes for ${asset.symbol}`}>
          <thead><tr><th>Window</th><th>Observed change</th><th>Benchmark{item.benchmark ? ` (${item.benchmark.symbol})` : ''}</th><th>Difference</th><th>Same-length period before</th><th>Prices and times (UTC)</th></tr></thead>
          <tbody>{item.reactions.map((reaction) => <ReactionRow key={reaction.window} reaction={reaction} />)}</tbody>
        </table>
      )}
      <p className="market-session"><small>{item.sessionNote}</small></p>
      <div className="ws-form-actions">
        {item.link.status !== 'confirmed' && <button className="ghost-button small" onClick={() => void setLink('confirmed')}>Confirm link</button>}
        {item.link.status !== 'rejected' && <button className="ghost-button small" onClick={() => void setLink('rejected')}>Reject link</button>}
        {(item.link.status !== 'suggested' || item.link.origin === 'user') && <button className="ghost-button small" onClick={() => void setLink('reset')}>{item.link.origin === 'user' ? 'Remove link' : 'Reset to suggestion'}</button>}
        <button className="ghost-button small" onClick={() => void track()}>{asset.watched ? 'Stop tracking' : 'Track (add to watchlist)'}</button>
        <button className="ghost-button small" onClick={() => onChart(asset.id)}>Price chart</button>
        <button className="ghost-button small" aria-expanded={open} onClick={() => setOpen(!open)}>Why this may matter</button>
      </div>
      {asset.status.status !== 'live' && asset.status.status !== 'delayed' && <small className="muted-note">{asset.status.label}: {asset.status.detail}</small>}
      {error && <Notice kind="error">{error}</Notice>}
      {open && (
        <div className="ws-why" data-testid="why-matters">
          <strong>Supporting evidence</strong>
          <ul className="ws-notes">{item.why.supporting.map((line) => <li key={line}>{line}</li>)}</ul>
          <strong>Possible exposure pathway (a hypothesis, not an observation)</strong>
          <p>{item.why.pathway}</p>
          <strong>Alternative explanations</strong>
          <ul className="ws-notes">{item.why.alternatives.map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="muted-note">{item.why.caution}</p>
        </div>
      )}
    </article>
  );
}

// ------------------------------------------------------------------ event view

function AssetPicker({ onPick, label, filterOut }: { onPick: (asset: AssetWithStatus) => void; label: string; filterOut?: Set<string> }) {
  const [q, setQ] = useState('');
  const [cls, setCls] = useState('');
  const results = useMarketData<{ items: AssetWithStatus[] }>(`/assets?q=${encodeURIComponent(q)}${cls ? `&class=${cls}` : ''}`);
  return (
    <div className="market-picker">
      <div className="ws-inline-form">
        <input type="search" aria-label={`Search assets to ${label}`} placeholder="Search name, symbol or exchange…" value={q} onChange={(event) => setQ(event.target.value)} />
        <select aria-label="Asset class" value={cls} onChange={(event) => setCls(event.target.value)}><option value="">All classes</option><option value="stock">Stocks</option><option value="index">Indices</option><option value="crypto">Crypto</option></select>
      </div>
      <ul className="ws-plain-list market-results" aria-label="Asset search results">
        {(results.data?.items ?? []).filter((a) => !filterOut?.has(a.id)).slice(0, 12).map((asset) => (
          <li key={asset.id} className="ws-row">
            <span><strong>{asset.symbol}</strong> {asset.name}<small>{asset.class} · {asset.exchange}{asset.mic ? ` (${asset.mic})` : ''} · {asset.currency}</small></span>
            <span className="market-row-actions"><FreshPill asset={asset} /><button className="ghost-button small" onClick={() => onPick(asset)}>{label}</button></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventViewTab({ focusKey, onChart }: { focusKey: string | null; onChart: (id: string) => void }) {
  const [filters, setFilters] = usePersistentState('market-event-filters', { q: '', severity: 'All', category: 'All', country: 'All', days: 14, all: false });
  const [selected, setSelected] = usePersistentState<{ key: string }>('market-event-selected', { key: '' });
  const meta = useMarketData<Meta>('/meta');
  const qs = new URLSearchParams({ days: String(filters.days), ...(filters.q ? { q: filters.q } : {}), ...(filters.severity !== 'All' ? { severity: filters.severity } : {}), ...(filters.category !== 'All' ? { category: filters.category } : {}), ...(filters.country !== 'All' ? { country: filters.country } : {}), all: filters.all ? '1' : '0' });
  const list = useMarketData<{ items: EventRow[]; total: number }>(`/events?${qs.toString()}`);
  useEffect(() => { if (focusKey) setSelected({ key: focusKey }); }, [focusKey, setSelected]);
  const view = useMarketData<EventView>(selected.key ? `/event?key=${encodeURIComponent(selected.key)}` : null);
  const [adding, setAdding] = useState(false);
  const patch = (change: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...change }));
  const detail = view.data && view.data.event.key === selected.key ? view.data : null;
  const linked = new Set(detail?.assets.map((a) => a.asset.id) ?? []);

  const addLink = async (asset: AssetWithStatus) => {
    await marketFetch('PUT', '/event/link', { key: selected.key, assetId: asset.id, status: 'confirmed' });
    setAdding(false);
    await view.reload();
  };

  return (
    <div className="market-split">
      <section className="panel market-events" aria-label="Events">
        <div className="market-filters">
          <input type="search" aria-label="Search events" placeholder="Search events…" value={filters.q} onChange={(event) => patch({ q: event.target.value })} />
          <label className="filter-select"><span>Event severity</span><select value={filters.severity} onChange={(event) => patch({ severity: event.target.value })}><option>All</option>{SEVERITY_OPTIONS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="filter-select"><span>Category</span><select value={filters.category} onChange={(event) => patch({ category: event.target.value })}><option>All</option>{(meta.data?.categories ?? []).map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="filter-select"><span>Country</span><select value={filters.country} onChange={(event) => patch({ country: event.target.value })}><option>All</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
          <label className="filter-select"><span>Period</span><select value={filters.days} onChange={(event) => patch({ days: Number(event.target.value) })}>{[3, 7, 14, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select></label>
          <label className="ws-check"><input type="checkbox" checked={filters.all} onChange={(event) => patch({ all: event.target.checked })} /> Include events with no suggested assets</label>
        </div>
        {list.error && <Notice kind="stale">{list.error}</Notice>}
        <p className="muted-note">{list.data ? `${list.data.total} event${list.data.total === 1 ? '' : 's'}. Coverage of the same event is de-duplicated; each event is dated by its earliest public report.` : 'Loading events…'}</p>
        <ul className="market-event-list">
          {(list.data?.items ?? []).map((event) => (
            <li key={event.key}>
              <button className={`market-event ${selected.key === event.key ? 'selected' : ''}`} data-event={event.key} onClick={() => setSelected({ key: event.key })}>
                <span><Pill value={event.severity} /> <span className="badge neutral">{event.type === 'incident' ? 'Incident' : 'Report'}</span></span>
                <strong>{event.title}</strong>
                <small>{utc(event.anchorAt)} · {event.anchorSource} · {event.category}{event.countries.length ? ` · ${event.countries.map((c) => c.name).join(', ')}` : ''}</small>
                <small>{event.members} report{event.members === 1 ? '' : 's'} · {event.suggestedAssets} suggested asset{event.suggestedAssets === 1 ? '' : 's'}</small>
              </button>
            </li>
          ))}
        </ul>
        {list.data && list.data.items.length === 0 && <Notice>No events match. Events appear here when the app's exposure rules link them to a supported asset.</Notice>}
      </section>

      <section className="market-detail" aria-label="Event market view">
        {!selected.key && <Notice>Select an event to see potentially relevant assets and their observed price changes.</Notice>}
        {selected.key && view.error && !detail && <Notice kind="error">{view.error}</Notice>}
        {selected.key && !detail && !view.error && <Notice>Loading…</Notice>}
        {detail && (
          <>
            <div className="panel">
              <div className="panel-header"><h3>{detail.event.title}</h3></div>
              <dl className="market-facts">
                <dt>Event severity</dt><dd><Pill value={detail.event.severity} /> <small>describes the event, not market impact</small></dd>
                <dt>Earliest public report</dt><dd>{utc(detail.event.anchorAt)} — <a href={detail.event.anchorUrl} target="_blank" rel="noreferrer noopener">{detail.event.anchorSource}</a></dd>
                <dt>Event time</dt><dd>{detail.event.eventAt ? utc(detail.event.eventAt) : 'not recorded'}</dd>
                <dt>Retrieved by this app</dt><dd>{utc(detail.event.retrievedAt)}</dd>
                <dt>Category and place</dt><dd>{detail.event.category}{detail.event.countries.length ? ` · ${detail.event.countries.map((c) => c.name).join(', ')}` : ''}</dd>
                <dt>De-duplicated coverage</dt>
                <dd><ul className="ws-notes">{detail.event.members.map((m) => <li key={m.articleId}><a href={m.url} target="_blank" rel="noreferrer noopener">{m.headline}</a> — {m.source}, published {utc(m.publishedAt)}</li>)}</ul></dd>
              </dl>
              {detail.sessionNotes.map((n) => <p key={n.calendar} className="market-session"><small><strong>{n.calendar === 'XNYS' ? 'US exchanges' : n.calendar === '24x7' ? 'Crypto (24/7)' : 'Daily spot prices'}:</strong> {n.note}</small></p>)}
              <Notice>Price changes shown after a report are observations. They are not evidence that the report caused them, and they are not forecasts or advice.</Notice>
            </div>
            <div className="ws-form-actions"><button className="ghost-button" onClick={() => setAdding(!adding)} aria-expanded={adding}>Link another asset</button></div>
            {adding && <div className="panel"><AssetPicker label="Link" filterOut={linked} onPick={(asset) => void addLink(asset)} /></div>}
            {detail.assets.length === 0 && <Notice>No assets are linked to this event yet.</Notice>}
            {detail.assets.map((item) => <AssetCard key={item.asset.id} item={item} eventKey={selected.key} onChanged={() => void view.reload()} onChart={onChart} />)}
          </>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ asset view

function AssetViewTab({ assetId, setAssetId, onOpenEvent }: { assetId: string; setAssetId: (id: string) => void; onOpenEvent: (key: string) => void }) {
  const [filters, setFilters] = usePersistentState('market-chart-filters', { from: '', to: '', country: 'All', category: 'All', severity: 'All', granularity: '' });
  const watch = useMarketData<{ items: AssetWithStatus[] }>('/watchlist');
  const meta = useMarketData<Meta>('/meta');
  const [marker, setMarker] = useState<ChartMarker | null>(null);
  const [picker, setPicker] = useState(false);
  const qs = new URLSearchParams({ assetId, ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}), ...(filters.country !== 'All' ? { country: filters.country } : {}), ...(filters.category !== 'All' ? { category: filters.category } : {}), ...(filters.severity !== 'All' ? { severity: filters.severity } : {}), ...(filters.granularity ? { granularity: filters.granularity } : {}) });
  const chart = useMarketData<AssetChart>(assetId ? `/chart?${qs.toString()}` : null);
  const data = chart.data && chart.data.asset.id === assetId ? chart.data : null;
  const patch = (change: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...change }));
  useEffect(() => { setMarker(null); }, [assetId]);
  const shown = marker && data?.markers.find((m) => m.eventId === marker.eventId) ? marker : null;

  return (
    <div className="market-asset-view">
      <div className="panel">
        <div className="market-filters">
          <label className="filter-select"><span>Asset</span>
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)} aria-label="Asset">
              <option value="">Choose a watched asset…</option>
              {(watch.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.symbol} — {a.name} ({a.exchange})</option>)}
              {assetId && !(watch.data?.items ?? []).some((a) => a.id === assetId) && <option value={assetId}>{assetId}</option>}
            </select>
          </label>
          <button className="ghost-button small" onClick={() => setPicker(!picker)} aria-expanded={picker}>Search other assets</button>
          <label className="filter-select"><span>From</span><input type="date" value={filters.from} onChange={(event) => patch({ from: event.target.value })} /></label>
          <label className="filter-select"><span>To</span><input type="date" value={filters.to} onChange={(event) => patch({ to: event.target.value })} /></label>
          <label className="filter-select"><span>Country</span><select value={filters.country} onChange={(event) => patch({ country: event.target.value })}><option>All</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
          <label className="filter-select"><span>Category</span><select value={filters.category} onChange={(event) => patch({ category: event.target.value })}><option>All</option>{(meta.data?.categories ?? []).map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="filter-select"><span>Event severity</span><select value={filters.severity} onChange={(event) => patch({ severity: event.target.value })}><option>All</option>{SEVERITY_OPTIONS.map((s) => <option key={s}>{s}</option>)}</select></label>
          {data && data.asset.granularities.length > 1 && (
            <label className="filter-select"><span>Interval</span><select value={filters.granularity} onChange={(event) => patch({ granularity: event.target.value })}><option value="">Default</option><option value="1h">Hourly</option><option value="1d">Daily</option></select></label>
          )}
          <button className="ghost-button small" onClick={() => setFilters({ from: '', to: '', country: 'All', category: 'All', severity: 'All', granularity: '' })}>Clear filters</button>
        </div>
        {picker && <AssetPicker label="Show chart" onPick={(asset) => { setAssetId(asset.id); setPicker(false); }} />}
      </div>
      {!assetId && <Notice>Choose an asset to see its price history with linked intelligence events.</Notice>}
      {assetId && chart.error && !data && <Notice kind="error">{chart.error}</Notice>}
      {data && (
        <>
          <div className="panel-header market-chart-head">
            <h3>{data.asset.symbol} <span className="muted-note">{data.asset.name}</span></h3>
            <span><FreshPill asset={data.asset} /> <small>{data.asset.exchange}{data.asset.mic ? ` (${data.asset.mic})` : ''} · {data.asset.currency} · provider {data.asset.provider}</small></span>
          </div>
          {data.asset.status.status !== 'live' && data.asset.status.status !== 'delayed' && <Notice kind={data.asset.status.status === 'stale' ? 'stale' : 'info'}>{data.asset.status.label}: {data.asset.status.detail}</Notice>}
          <small className="muted-note">Newest stored bar closed {utc(data.asset.status.latestBarClose)}. Last successful retrieval {data.asset.status.lastSuccessAt ? `${fmt(data.asset.status.lastSuccessAt)} (${ago(data.asset.status.lastSuccessAt)})` : 'never'}. Showing {data.bars.length} of {data.barsTotal} bars in the selected range.</small>
          <div className="market-chart-grid">
            <div className="panel"><PriceChart chart={data} selected={shown?.eventId ?? null} onSelect={setMarker} />
              <p className="muted-note" data-testid="marker-count">{data.markers.length} linked event{data.markers.length === 1 ? '' : 's'} match the filters.</p>
            </div>
            {shown ? <MarkerDetail marker={shown} onOpen={() => onOpenEvent(shown.eventId)} /> : <aside className="panel"><p className="muted-note">Select a marker on the chart to see the source, publication time, event details and why it is linked.</p></aside>}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ watchlists

const CLASS_LABEL: Record<string, string> = { stock: 'Stocks', index: 'Indices and benchmarks', crypto: 'Crypto-assets' };

function AlertSettingsForm() {
  const settings = useMarketData<MarketAlertSettings>('/alert-settings');
  const [draft, setDraft] = useState<MarketAlertSettings | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (settings.data && !draft) setDraft(settings.data); }, [settings.data, draft]);
  if (!draft) return <p className="muted-note">Loading alert settings…</p>;
  const save = async () => {
    try { setError(''); const result = await marketFetch<MarketAlertSettings>('PUT', '/alert-settings', draft); setDraft(result); setSaved('Saved'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save.'); }
  };
  const set = (change: Partial<MarketAlertSettings>) => { setSaved(''); setDraft({ ...draft, ...change }); };
  return (
    <form className="ws-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="Watchlist alert settings">
      <label className="ws-check"><input type="checkbox" checked={draft.linkAlerts} onChange={(event) => set({ linkAlerts: event.target.checked })} /> Alert me when a new report is linked (suggested or confirmed) to a watched asset</label>
      <label className="ws-check"><input type="checkbox" checked={draft.moveAlerts} onChange={(event) => set({ moveAlerts: event.target.checked })} /> Alert me when a watched asset moves by at least the threshold</label>
      <div className="ws-form-grid">
        <label>Move threshold (%)<input type="number" min={0.5} max={50} step={0.5} value={draft.movePct} onChange={(event) => set({ movePct: Number(event.target.value) })} /></label>
        <label>Measured over<select value={draft.moveWindow} onChange={(event) => set({ moveWindow: event.target.value as '1h' | '24h' })}><option value="24h">24 hours</option><option value="1h">1 hour (crypto only)</option></select></label>
        <label>Cooldown per asset (hours)<input type="number" min={1} max={168} value={draft.cooldownHours} onChange={(event) => set({ cooldownHours: Number(event.target.value) })} /></label>
      </div>
      <p className="muted-note">Each event and asset pair alerts once. After an alert for an asset, further alerts of that kind for it are suppressed until the cooldown ends. Alerts report observations and suggested links; they are not trading signals.</p>
      <div className="ws-form-actions"><button className="ghost-button" type="submit">Save alert settings</button>{saved && <span role="status" className="muted-note">{saved}</span>}</div>
      {error && <Notice kind="error">{error}</Notice>}
    </form>
  );
}

function WatchlistTab({ onChart }: { onChart: (id: string) => void }) {
  const list = useMarketData<{ items: AssetWithStatus[] }>('/watchlist');
  const [error, setError] = useState('');
  const items = list.data?.items ?? [];
  const add = async (asset: AssetWithStatus) => { try { setError(''); await marketFetch('POST', '/watchlist', { assetId: asset.id }); await list.reload(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not add.'); } };
  const remove = async (asset: AssetWithStatus) => { try { setError(''); await marketFetch('DELETE', `/watchlist?assetId=${encodeURIComponent(asset.id)}`); await list.reload(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not remove.'); } };
  return (
    <div className="market-watch">
      {error && <Notice kind="error">{error}</Notice>}
      <div className="market-watch-grid">
        {(['stock', 'index', 'crypto'] as const).map((cls) => (
          <section key={cls} className="panel" aria-label={`${CLASS_LABEL[cls]} watchlist`} data-watchlist={cls}>
            <div className="panel-header"><h3>{CLASS_LABEL[cls]}</h3></div>
            {items.filter((a) => a.class === cls).length === 0 && <p className="muted-note">Nothing watched yet.</p>}
            <ul className="ws-plain-list">
              {items.filter((a) => a.class === cls).map((asset) => (
                <li key={asset.id} className="ws-row" data-watched={asset.id}>
                  <span><strong>{asset.symbol}</strong> {asset.name}<small>{asset.exchange}{asset.mic ? ` (${asset.mic})` : ''} · {asset.currency} · newest bar {utc(asset.status.latestBarClose)}</small><small>{asset.status.detail}</small></span>
                  <span className="market-row-actions"><FreshPill asset={asset} /><button className="ghost-button small" onClick={() => onChart(asset.id)}>Chart</button><button className="ghost-button small" onClick={() => void remove(asset)} aria-label={`Remove ${asset.symbol} from watchlist`}>Remove</button></span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <section className="panel" aria-label="Add assets">
        <div className="panel-header"><h3>Add to a watchlist</h3></div>
        <AssetPicker label="Watch" filterOut={new Set(items.map((a) => a.id))} onPick={(asset) => void add(asset)} />
        <small className="muted-note">Prices are fetched in the background only for watched assets, assets with confirmed links, and their benchmarks.</small>
      </section>
      <section className="panel" aria-label="Alerts"><div className="panel-header"><h3>Watchlist alerts</h3></div><AlertSettingsForm /></section>
    </div>
  );
}

// ------------------------------------------------------------------ associations

function LabelPill({ label }: { label: string }) {
  return <span className={`badge ${label === 'Historically observed association' ? 'warning' : 'neutral'}`}>{label}</span>;
}

function AssociationsTab() {
  const meta = useMarketData<Meta>('/meta');
  const watch = useMarketData<{ items: AssetWithStatus[] }>('/watchlist');
  const [f, setF] = usePersistentState('market-assoc-filters', { assetId: '', category: '', window: '24h', country: false, exposure: false });
  const dims = ['category', ...(f.country ? ['country'] : []), ...(f.exposure ? ['exposure'] : [])].join(',');
  const qs = new URLSearchParams({ window: f.window, dims, ...(f.assetId ? { assetId: f.assetId } : {}), ...(f.category ? { category: f.category } : {}) });
  const result = useMarketData<{ results: AssociationResult[]; exploratory: boolean; comparisons: number }>(`/associations?${qs.toString()}`);
  const [corrAsset, setCorrAsset] = useState('');
  const corrAssets = (watch.data?.items ?? []).filter((a) => a.granularities.includes('1d'));
  const corr = useMarketData<{ items: CorrelationResult[] }>(corrAsset ? `/correlations?assetId=${encodeURIComponent(corrAsset)}${f.category ? `&category=${f.category}` : ''}` : null);
  const t = meta.data?.thresholds;
  return (
    <div className="market-assoc">
      <Notice>These are descriptive statistics of what followed past events, using classifications recorded at the time the app first saw each event. They are not probabilities and not predictions, and association is not causation.{t ? ` A group needs at least ${t.preliminary} distinct, non-overlapping events to be shown, and at least ${t.observed} plus a significant corrected test to be called "Historically observed association".` : ''}</Notice>
      <div className="panel">
        <div className="market-filters">
          <label className="filter-select"><span>Asset</span><select value={f.assetId} onChange={(event) => setF({ ...f, assetId: event.target.value })}><option value="">All assets (exploratory)</option>{(watch.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.symbol} ({a.exchange})</option>)}</select></label>
          <label className="filter-select"><span>Category</span><select value={f.category} onChange={(event) => setF({ ...f, category: event.target.value })}><option value="">All categories</option>{(meta.data?.categories ?? []).map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="filter-select"><span>Window</span><select value={f.window} onChange={(event) => setF({ ...f, window: event.target.value })}><option value="1h">1 hour</option><option value="24h">24 hours</option><option value="7d">7 days</option></select></label>
          <label className="ws-check"><input type="checkbox" checked={f.country} onChange={(event) => setF({ ...f, country: event.target.checked })} /> Group by country</label>
          <label className="ws-check"><input type="checkbox" checked={f.exposure} onChange={(event) => setF({ ...f, exposure: event.target.checked })} /> Group by link relevance</label>
        </div>
      </div>
      {result.error && <Notice kind="stale">{result.error}</Notice>}
      {result.data?.exploratory && result.data.results.length > 0 && <Notice kind="stale">Exploratory scan: {result.data.comparisons} group(s) were tested together. Significance is shown only after correcting for multiple comparisons (Holm).</Notice>}
      <div className="ws-table market-assoc-table" role="table" aria-label="Historical associations">
        {(result.data?.results ?? []).map((r, i) => (
          <article key={`${r.asset.id}|${r.category}|${r.country}|${r.exposure}|${r.window}|${i}`} className="panel market-assoc-row" data-label={r.label}>
            <header><strong>{r.asset.symbol}</strong> after <strong>{r.category}</strong> events{r.country ? ` in ${r.country}` : ''}{r.exposure ? ` (${r.exposure} links)` : ''} · {r.window} · {r.measure} <LabelPill label={r.label} /></header>
            <dl className="market-facts">
              <dt>Sample</dt><dd>{r.usedEvents} used of {r.distinctEvents} distinct events{r.overlappingExcluded ? `; ${r.overlappingExcluded} overlapping excluded` : ''}{r.pendingOrMissing ? `; ${r.pendingOrMissing} not usable` : ''}</dd>
              <dt>Period</dt><dd>{r.period.from ? `${utc(r.period.from)} to ${utc(r.period.to)}` : 'none'}</dd>
              {r.median !== null && <><dt>Median reaction</dt><dd>{r.measure === 'raw' ? pct(r.median) : pp(r.median)} <small>middle half {r.q1 === null ? '' : `${r.measure === 'raw' ? pct(r.q1) : pp(r.q1)} to ${r.q3 === null ? '' : r.measure === 'raw' ? pct(r.q3) : pp(r.q3)}`}, standard deviation {r.stdev?.toFixed(2)}</small></dd>
                <dt>Direction</dt><dd>{share(r.positiveShare)} positive · {share(r.negativeShare)} negative · {share(r.zeroShare)} unchanged</dd>
                <dt>Sign test</dt><dd>p = {r.signTestP?.toPrecision(2)}; corrected p = {r.adjustedP?.toPrecision(2)} across {r.comparisons} test(s){r.exploratory ? ' (exploratory)' : ''}</dd></>}
            </dl>
            {r.notes.map((n) => <small key={n} className="muted-note">{n}</small>)}
          </article>
        ))}
        {result.data && result.data.results.length === 0 && <Notice>Insufficient history: no event has been recorded with a completed window yet. Classifications are recorded from the moment the app first sees an event, so history builds up from the time this module was switched on.</Notice>}
      </div>

      <section className="panel" aria-label="Correlations">
        <div className="panel-header"><h3>Correlation of event counts with daily returns</h3></div>
        <label className="filter-select"><span>Asset (daily data)</span><select value={corrAsset} onChange={(event) => setCorrAsset(event.target.value)}><option value="">Choose a watched asset…</option>{corrAssets.map((a) => <option key={a.id} value={a.id}>{a.symbol} ({a.exchange})</option>)}</select></label>
        {corr.data?.items.length === 0 && <Notice>No correlation can be defined for this asset (no daily series or no linked events).</Notice>}
        {(corr.data?.items ?? []).map((c) => (
          <article key={c.category} className="market-corr" data-status={c.status}>
            <strong>{c.category}</strong> {c.status === 'ok' ? <LabelPill label="Preliminary association" /> : <span className="badge neutral">Insufficient history</span>}
            <small>X: {c.seriesX}</small><small>Y: {c.seriesY}</small><small>Method: {c.method}</small>
            <small>Observations: {c.observations} days ({c.nonZeroDays} with an event) · window {c.window.from ? `${utc(c.window.from)} to ${utc(c.window.to)}` : 'none'}</small>
            {c.status === 'ok' ? <small>Pearson {c.pearson?.toFixed(2) ?? 'n/a'} · Spearman {c.spearman?.toFixed(2) ?? 'n/a'} · 95% interval {c.ci95 ? `${c.ci95[0].toFixed(2)} to ${c.ci95[1].toFixed(2)}` : 'n/a'} · p = {c.pValue?.toPrecision(2)}, corrected p = {c.adjustedP?.toPrecision(2)} across {c.comparisons}</small> : <small>{c.needed}</small>}
            {c.notes.map((n) => <small key={n} className="muted-note">{n}</small>)}
          </article>
        ))}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ sources and method

function MethodTab() {
  const meta = useMarketData<Meta>('/meta');
  return (
    <div className="market-method">
      <section className="panel" aria-label="Price providers">
        <div className="panel-header"><h3>Price providers</h3></div>
        {(meta.data?.providers ?? []).filter((p) => p.id !== 'none').map((p) => (
          <article key={p.id} className="market-provider" data-provider={p.id}>
            <h4>{p.name} {p.credential ? <span className={`badge ${p.credential.configured ? 'success' : 'neutral'}`}>{p.credential.configured ? 'Configured' : 'Setup required'}</span> : <span className="badge success">No key needed</span>}</h4>
            <small>Covers: {p.covers}</small>
            {p.credential && !p.credential.configured && <small>Set <code>{p.credential.envVar}</code> on the server (free key: {p.credential.signupUrl}).</small>}
            <small>Limits: {p.limits}</small><small>Licence and display: {p.license}</small><small>Timeliness: {p.delay}</small><small>Attribution: {p.attribution}</small><small>Verification: {p.verified}</small>
          </article>
        ))}
      </section>
      <section className="panel" aria-label="Method">
        <div className="panel-header"><h3>How figures are calculated</h3></div>
        <ul className="ws-notes">{(meta.data?.method ?? []).map((line) => <li key={line}>{line}</li>)}</ul>
        <ul className="ws-notes"><li>Severity (event), market relevance (how the rules link the event to an asset) and observed price change are three separate things and are never combined into a score.</li><li>Links are suggestions from named entities, sector keywords and geography. You can confirm, reject or add links; your changes are kept separate from suggestions.</li><li>Exchange special closures are not modelled; holidays and early closes follow the published NYSE rules.</li></ul>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ module

type Tab = 'Event view' | 'Asset view' | 'Watchlists' | 'Associations' | 'Sources and method';
const TABS: Tab[] = ['Event view', 'Asset view', 'Watchlists', 'Associations', 'Sources and method'];

export function MarketModule({ focusId }: { focusId?: string; onNavigate: Navigate }) {
  const [tab, setTab] = usePersistentState<{ name: Tab }>('market-tab', { name: 'Event view' });
  const [assetId, setAssetId] = usePersistentState<{ id: string }>('market-asset', { id: '' });
  const [eventFocus, setEventFocus] = useState<string | null>(null);
  const meta = useMarketData<Meta>('/meta');
  const now = useNow();
  useEffect(() => {
    if (!focusId) return;
    if (focusId.startsWith('incident:') || focusId.startsWith('report:')) { setEventFocus(focusId); setTab({ name: 'Event view' }); } else { setAssetId({ id: focusId }); setTab({ name: 'Asset view' }); }
  }, [focusId, setTab, setAssetId]);
  const setupNeeded = useMemo(() => (meta.data?.providers ?? []).filter((p) => p.credential && !p.credential.configured), [meta.data]);
  const openChart = (id: string) => { setAssetId({ id }); setTab({ name: 'Asset view' }); };
  return (
    <div className="module-view market-module">
      <div className="module-header">
        <div><div className="eyebrow">Observed market reactions and historical associations / not advice, not forecasts</div><h2>Market impact</h2></div>
        <span className="status-pill neutral">Server time {meta.data ? utc(meta.data.serverTime) : '…'}</span>
      </div>
      {setupNeeded.length > 0 && (
        <Notice>Setup required for some prices: {setupNeeded.map((p) => `${p.credential!.envVar} (${p.name})`).join('; ')}. Assets that depend on them show “Setup required” until the key is set on the server. Crypto prices need no key.</Notice>
      )}
      {meta.error && !meta.data && <Notice kind="error">{meta.error}</Notice>}
      <div className="ws-tabs" role="tablist" aria-label="Market impact views">
        {TABS.map((name) => <button key={name} role="tab" aria-selected={tab.name === name} className={tab.name === name ? 'selected' : ''} onClick={() => setTab({ name })}>{name}</button>)}
      </div>
      <p className="muted-note" aria-live="polite">Times in UTC. Updated {ago(meta.data?.serverTime ?? null, now)}.</p>
      {tab.name === 'Event view' && <EventViewTab focusKey={eventFocus} onChart={openChart} />}
      {tab.name === 'Asset view' && <AssetViewTab assetId={assetId.id} setAssetId={(id) => setAssetId({ id })} onOpenEvent={(key) => { setEventFocus(key); setTab({ name: 'Event view' }); }} />}
      {tab.name === 'Watchlists' && <WatchlistTab onChart={openChart} />}
      {tab.name === 'Associations' && <AssociationsTab />}
      {tab.name === 'Sources and method' && <MethodTab />}
    </div>
  );
}
