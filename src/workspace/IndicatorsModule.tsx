import { AiExplain } from './AiPanels.tsx';
import { useEffect, useMemo, useState } from 'react';
import { sortedCountries } from '../data/countries.ts';
import { wsFetch, useWorkspaceData } from '../data/workspaceApi.ts';
import type { IndicatorEvidenceItem, IndicatorReading, IndicatorSettings, IndicatorSummary, IndicatorWeek } from '../data/workspaceTypes.ts';
import { AddToCountryDialog } from './CountriesModule.tsx';
import { IncidentLinkDialog } from './IncidentsModule.tsx';
import { DataStatus, Notice, Pill, fmt, fmtDay, useNow, usePersistentState, useSourceStatus, type Navigate } from './shared.tsx';

const SOURCE_IDS = ['gdacs', 'cisa-kev', 'bbc-world', 'un-news', 'gdelt', 'reliefweb'];
const realCountries = sortedCountries.filter((country) => country.code !== 'GLOBAL' && country.code !== 'UNKNOWN');

type Summaries = { items: IndicatorSummary[]; confidencePolicy: string[]; computedAt: string };

const pairKey = (id: string, geo: string) => `${id}|${geo}`;

function LevelPill({ level }: { level: string }) {
  const tone = level === 'Alert' ? 'critical' : level === 'Warning' ? 'warning' : level === 'Normal' ? 'success' : 'neutral';
  return <span className={`badge ${tone}`}>{level}</span>;
}

function TrendText({ trend }: { trend: string }) {
  return <span className={`indicator-status ${trend === 'Rising' ? 'worsening' : trend.toLowerCase().replace(/\s+/g, '-')}`}>{trend}</span>;
}

const STATUS_TEXT: Record<IndicatorSummary['dataStatus'], string> = {
  live: 'Live', stale: 'Stale', unavailable: 'Source unavailable', setup_required: 'Setup required', no_data: 'No data',
};

function Sparkline({ values }: { values: Array<number | null> }) {
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  return (
    <span className="indicator-spark" aria-label={`Weekly values: ${values.map((v) => (v === null ? 'missing' : v)).join(', ')}`}>
      {values.map((value, index) => (
        <i key={index} className={value === null ? 'missing' : ''} style={{ height: value === null ? '12%' : `${Math.max(6, (value / max) * 100)}%` }} title={value === null ? 'Not enough coverage' : String(value)} />
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ chart

function WeekChart({ reading, selected, onSelect }: { reading: IndicatorReading; selected: number; onSelect: (index: number) => void }) {
  const width = 560;
  const height = 230;
  const pad = { left: 36, right: 12, top: 14, bottom: 34 };
  const values = reading.weeks.map((week) => week.value ?? 0);
  const top = Math.max(1, ...values, reading.alertThreshold ?? 0, reading.warnThreshold ?? 0, reading.baselineMean ?? 0) * 1.15;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / reading.weeks.length;
  const y = (value: number) => pad.top + plotH - (value / top) * plotH;
  const ticks = [0, Math.round(top / 2), Math.round(top)];
  const levelColor = reading.level === 'Alert' ? '#DC2626' : reading.level === 'Warning' ? '#F59E0B' : '#38BDF8';

  return (
    <figure className="ws-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${reading.name}, ${reading.geoName}: weekly values with baseline and thresholds`}>
        {ticks.map((tick) => (
          <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid" /><text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="axis">{tick}</text></g>
        ))}
        {reading.weeks.map((week, index) => {
          const x = pad.left + index * slot + slot * 0.15;
          const barW = slot * 0.7;
          const isCurrent = index === reading.weeks.length - 1;
          const label = `${fmtDay(week.start)} to ${fmtDay(week.end)}: ${week.value === null ? `missing (source read on ${week.coveredDays} of 7 days)` : `${week.value}`}`;
          return (
            <g key={week.start} className={`bar ${selected === index ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={label} aria-pressed={selected === index}
              onClick={() => onSelect(index)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(index); } }}>
              <title>{label}</title>
              <rect x={pad.left + index * slot} y={pad.top} width={slot} height={plotH} className="hit" />
              {week.value === null ? (
                <rect x={x} y={y(top * 0.08)} width={barW} height={plotH - (y(top * 0.08) - pad.top)} className="missing-bar" />
              ) : (
                <rect x={x} y={y(week.value)} width={barW} height={Math.max(1, pad.top + plotH - y(week.value))} fill={isCurrent ? levelColor : '#64748B'} />
              )}
              {week.value !== null && <text x={x + barW / 2} y={y(week.value) - 3} textAnchor="middle" className="value">{week.value}</text>}
              <text x={x + barW / 2} y={height - 18} textAnchor="middle" className="axis">{new Date(`${week.start}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })}</text>
            </g>
          );
        })}
        {reading.baselineMean !== null && <g><line x1={pad.left} x2={width - pad.right} y1={y(reading.baselineMean)} y2={y(reading.baselineMean)} className="baseline" /><text x={width - pad.right} y={y(reading.baselineMean) - 3} textAnchor="end" className="axis">baseline {reading.baselineMean.toFixed(1)}</text></g>}
        {reading.warnThreshold !== null && <g><line x1={pad.left} x2={width - pad.right} y1={y(reading.warnThreshold)} y2={y(reading.warnThreshold)} className="warn" /><text x={pad.left + 2} y={y(reading.warnThreshold) - 3} className="axis">warning {reading.warnThreshold}</text></g>}
        {reading.alertThreshold !== null && <g><line x1={pad.left} x2={width - pad.right} y1={y(reading.alertThreshold)} y2={y(reading.alertThreshold)} className="alertline" /><text x={pad.left + 2} y={y(reading.alertThreshold) - 3} className="axis">alert {reading.alertThreshold}</text></g>}
        <text x={width / 2} y={height - 3} textAnchor="middle" className="axis">Week starting (UTC); right-most bar is the latest complete week</text>
      </svg>
      <figcaption>Hatched bars are weeks without enough source coverage: they are missing, not zero. Select a bar to see the reports behind it.</figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ detail

function SettingsForm({ reading, onSaved }: { reading: IndicatorReading; onSaved: () => void }) {
  const [settings, setSettings] = useState<IndicatorSettings>(reading.settings);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSettings(reading.settings); setSaved(false); }, [reading.id, reading.geo, reading.settings]);
  async function save(next: IndicatorSettings) {
    setError('');
    try {
      await wsFetch('PUT', `/indicators/${reading.id}/settings?geo=${reading.geo}`, {
        mode: next.mode, warn: next.mode === 'fixed' ? next.warn : null, alert: next.mode === 'fixed' ? next.alert : null,
        minCount: next.minCount, cooldownHours: next.cooldownHours, watched: next.watched,
      });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the settings.');
    }
  }
  return (
    <form className="ws-form" onSubmit={(event) => { event.preventDefault(); void save(settings); }}>
      <h4>Thresholds and alerts</h4>
      {error && <Notice kind="error">{error}</Notice>}
      <label>Thresholds
        <select value={settings.mode} onChange={(event) => setSettings({ ...settings, mode: event.target.value as 'auto' | 'fixed', warn: settings.warn ?? reading.warnThreshold, alert: settings.alert ?? reading.alertThreshold })}>
          <option value="auto">Automatic from the baseline</option><option value="fixed">Fixed values</option>
        </select>
      </label>
      {settings.mode === 'fixed' && (
        <div className="ws-form-grid">
          <label>Warning at<input type="number" min={0} step="any" value={settings.warn ?? ''} onChange={(event) => setSettings({ ...settings, warn: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <label>Alert at<input type="number" min={0} step="any" value={settings.alert ?? ''} onChange={(event) => setSettings({ ...settings, alert: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        </div>
      )}
      <div className="ws-form-grid">
        <label>Minimum count<input type="number" min={0} value={settings.minCount} onChange={(event) => setSettings({ ...settings, minCount: Number(event.target.value) })} /></label>
        <label>Alert cooldown (hours)<input type="number" min={1} value={settings.cooldownHours} onChange={(event) => setSettings({ ...settings, cooldownHours: Number(event.target.value) })} /></label>
      </div>
      <label className="ws-check"><input type="checkbox" checked={settings.watched} onChange={(event) => { const next = { ...settings, watched: event.target.checked }; setSettings(next); void save(next); }} /> <span>Watch this indicator (in-app alert when it crosses a threshold)</span></label>
      <div className="ws-form-actions"><button className="outline-button small">Save settings</button>{saved && <small role="status">Saved</small>}</div>
    </form>
  );
}

function EvidenceList({ week, reading, onCreate, onLink, onCountry }: {
  week: IndicatorWeek; reading: IndicatorReading;
  onCreate: (ids: string[]) => void; onLink: (ids: string[]) => void; onCountry: (item: IndicatorEvidenceItem) => void;
}) {
  const ids = week.evidence.map((item) => item.articleId).slice(0, 25);
  return (
    <div className="ws-evidence-panel">
      <h4>Contributing evidence: {fmtDay(week.start)} to {fmtDay(week.end)}</h4>
      <p className="muted-note">
        {week.value === null
          ? `No value for this week: the sources were read on ${week.coveredDays} of 7 days, which is below the 6-day minimum. Records published in it are shown for reference but are not counted.`
          : `${week.value} ${reading.isReportingActivity ? 'unique reports (reporting activity, not confirmed events)' : 'distinct source records'}. Duplicates are already removed.`}
        {week.evidence.length >= 100 ? ' Showing the 100 most recent.' : ''}
      </p>
      {week.evidence.length === 0 && <p className="muted-note">{week.value === 0 ? 'A real zero: the sources were read and reported nothing that qualifies.' : 'No records.'}</p>}
      {week.evidence.length > 0 && (
        <div className="ws-form-actions">
          <button className="outline-button small" onClick={() => onCreate(ids)}>Create incident from {ids.length} report{ids.length === 1 ? '' : 's'}</button>
          <button className="ghost-button small" onClick={() => onLink(ids)}>Link {ids.length === 1 ? 'it' : 'them'} to incident</button>
        </div>
      )}
      <ul className="ws-evidence">{week.evidence.map((item) => (
        <li key={item.articleId}>
          <a href={item.url} target="_blank" rel="noreferrer">{item.headline}</a>
          <small>{item.source} · published {fmt(item.publishedAt)} · {item.severity}</small>
          <span>
            <button className="ghost-button small" onClick={() => onCreate([item.articleId])}>Create incident</button>
            <button className="ghost-button small" onClick={() => onLink([item.articleId])}>Link to incident</button>
            <button className="ghost-button small" onClick={() => onCountry(item)}>Add to country assessment</button>
          </span>
        </li>
      ))}</ul>
    </div>
  );
}

function IndicatorDetail({ id, geo, onGeo, onNavigate }: { id: string; geo: string; onGeo: (geo: string) => void; onNavigate: Navigate }) {
  const state = useWorkspaceData<IndicatorReading>(`/indicators/${id}?geo=${geo}`);
  const reading = state.data;
  const [weekIndex, setWeekIndex] = useState(8);
  const [incidentDialog, setIncidentDialog] = useState<{ ids: string[]; mode: 'create' | 'existing' } | null>(null);
  const [countryReport, setCountryReport] = useState<IndicatorEvidenceItem | null>(null);
  useEffect(() => { setWeekIndex(8); }, [id, geo]);

  if (state.error && !reading) return <aside className="panel indicator-detail"><Notice kind="error">{state.error}</Notice></aside>;
  if (!reading) return <aside className="panel indicator-detail feed-empty-detail" role="status">Loading indicator…</aside>;
  const week = reading.weeks[Math.min(weekIndex, reading.weeks.length - 1)];

  return (
    <aside className="panel indicator-detail" aria-label="Selected indicator details">
      <div className="panel-header">
        <span className="meta-label">Level</span><LevelPill level={reading.level} />
        <span className="meta-label">Trend</span><TrendText trend={reading.trend} />
      </div>
      {state.error && <Notice kind="stale">Could not refresh: {state.error}. Showing data from {fmt(state.lastLoadedAt)}.</Notice>}
      {reading.dataStatus === 'stale' && <Notice kind="stale">Stale: a source is behind or failing. The last successfully retrieved data is shown.</Notice>}
      <div className="eyebrow">{reading.id} / {reading.category}</div>
      <h3>{reading.name}</h3>
      {reading.isReportingActivity && <p className="ws-reporting-label">Reporting activity: counts of published reports, not confirmed events.</p>}
      {reading.perCountry && (
        <label className="filter-select"><span>Geography</span>
          <select value={reading.geo} onChange={(event) => onGeo(event.target.value)} aria-label="Indicator geography">
            <option value="ALL">Worldwide</option>{realCountries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
          </select>
        </label>
      )}

      <div className="indicator-current">
        <div><span className="meta-label">Latest complete week</span><strong>{reading.current ?? 'No value'}</strong><small>{reading.unit}</small></div>
        <div><span className="meta-label">Baseline (mean of {reading.baselineWeeks} weeks)</span><strong>{reading.baselineMean === null ? 'Insufficient history' : reading.baselineMean.toFixed(1)}</strong><small>{reading.changePct === null ? '' : `${reading.changePct > 0 ? '+' : ''}${reading.changePct.toFixed(0)}% vs baseline`}</small></div>
      </div>
      {reading.trend === 'Rising' && <p className="muted-note">{reading.definition.risingMeaning}</p>}

      <WeekChart reading={reading} selected={weekIndex} onSelect={setWeekIndex} />
      <AiExplain key={`${reading.id}-${reading.geo}`} title="AI explanation" path="/indicators/explain" body={{ indicatorId: reading.id, geo: reading.geo }} label="Explain this indicator" onNavigate={onNavigate}
        hint="The level, baseline and trend above are calculated by the app. The AI only explains what they mean, lists limits and suggests questions to ask. It never changes a threshold or a reading." />
      <p className="muted-note"><strong>Thresholds.</strong> {reading.thresholdBasis}</p>

      <dl className="feed-facts">
        <div><dt>Geography</dt><dd>{reading.geoName}</dd></div>
        <div><dt>Confidence</dt><dd>{reading.confidence}: {reading.confidenceReason}</dd></div>
        <div><dt>Data status</dt><dd>{STATUS_TEXT[reading.dataStatus]}</dd></div>
        <div><dt>Calculated</dt><dd>{fmt(reading.computedAt)}</dd></div>
      </dl>
      {reading.notes.length > 0 && <ul className="ws-notes">{reading.notes.map((note) => <li key={note}>{note}</li>)}</ul>}

      <EvidenceList week={week} reading={reading}
        onCreate={(ids) => setIncidentDialog({ ids, mode: 'create' })} onLink={(ids) => setIncidentDialog({ ids, mode: 'existing' })}
        onCountry={setCountryReport} />

      <div className="indicator-sources">
        <h4>Source provenance and reliability</h4>
        {reading.dependencies.map((dep) => (
          <div key={dep.sourceId}>
            <span><strong>{dep.name}</strong><small>{dep.status.replace('_', ' ')} · last retrieval {dep.lastSuccessAt ? fmt(dep.lastSuccessAt) : 'none'} · newest publication {dep.latestPublishedAt ? fmt(dep.latestPublishedAt) : 'none'}</small><small>{dep.reliabilityReason}</small></span>
            <span className="badge neutral">Reliability {dep.reliability}</span>
          </div>
        ))}
      </div>

      <details className="ws-definition">
        <summary>Definition: unit, sources, window, calculation, baseline, coverage, thresholds</summary>
        <dl className="feed-facts">
          <div><dt>Unit</dt><dd>{reading.unit}</dd></div>
          <div><dt>Geography</dt><dd>{reading.perCountry ? 'Worldwide or one country' : 'Worldwide (global indicator)'}</dd></div>
          <div><dt>Sources</dt><dd>{reading.definition.sources.join('; ')}</dd></div>
          <div><dt>Window</dt><dd>{reading.definition.window}</dd></div>
          <div><dt>Calculation</dt><dd>{reading.definition.calculation}</dd></div>
          <div><dt>Baseline</dt><dd>{reading.definition.baseline}</dd></div>
          <div><dt>Minimum coverage</dt><dd>{reading.definition.minimumCoverage}</dd></div>
          <div><dt>Thresholds</dt><dd>{reading.definition.thresholds}</dd></div>
          <div><dt>Deduplication</dt><dd>{reading.definition.deduplication}</dd></div>
          <div><dt>Zero and missing</dt><dd>A zero means the sources were read and nothing qualified. A week without enough coverage is missing and is excluded from the baseline.</dd></div>
        </dl>
      </details>

      <SettingsForm reading={reading} onSaved={() => void state.reload()} />
      {incidentDialog && <IncidentLinkDialog articleIds={incidentDialog.ids} initialMode={incidentDialog.mode} onClose={() => setIncidentDialog(null)} onNavigate={onNavigate} />}
      {countryReport && (
        <AddToCountryDialog onClose={() => setCountryReport(null)} onNavigate={onNavigate}
          report={{ articleId: countryReport.articleId, headline: countryReport.headline, countries: countryReport.countries.filter((c) => c !== 'GLOBAL' && c !== 'UNKNOWN').map((c) => ({ code: c, name: realCountries.find((country) => country.code === c)?.name ?? c })) }} />
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ register

type RegisterFilters = { q: string; category: string; geo: string; level: string; trend: string; quick: 'all' | 'rising' | 'watched' };

export function IndicatorsModule({ focusId, onNavigate }: { focusId?: string; onNavigate: Navigate }) {
  const list = useWorkspaceData<Summaries>('/indicators');
  const [filters, setFilters] = usePersistentState<RegisterFilters>('indicator-filters', { q: '', category: 'All', geo: 'All', level: 'All', trend: 'All', quick: 'all' });
  const [selection, setSelection] = usePersistentState<{ id: string; geo: string }>('indicator-selection', { id: 'disaster-alerts', geo: 'ALL' });
  const { sources } = useSourceStatus();
  const now = useNow();
  useEffect(() => {
    if (focusId) { const [id, geo] = focusId.split('|'); if (id) setSelection({ id, geo: geo || 'ALL' }); }
  }, [focusId, setSelection]);

  const items = list.data?.items ?? [];
  const filtered = useMemo(() => {
    const query = filters.q.trim().toLowerCase();
    return items.filter((item) => (
      (!query || `${item.name} ${item.category} ${item.geoName}`.toLowerCase().includes(query))
      && (filters.category === 'All' || item.category === filters.category)
      && (filters.geo === 'All' || item.geo === filters.geo)
      && (filters.level === 'All' || item.level === filters.level)
      && (filters.trend === 'All' || item.trend === filters.trend)
      && (filters.quick !== 'rising' || item.trend === 'Rising')
      && (filters.quick !== 'watched' || item.watched)
    ));
  }, [items, filters]);
  const unique = (pick: (item: IndicatorSummary) => string) => [...new Set(items.map(pick))].sort();
  const active = filters.q !== '' || filters.category !== 'All' || filters.geo !== 'All' || filters.level !== 'All' || filters.trend !== 'All' || filters.quick !== 'all';
  const patch = (change: Partial<RegisterFilters>) => setFilters((current) => ({ ...current, ...change }));

  return (
    <div className="module-view">
      <div className="module-header">
        <div><div className="eyebrow">Early-warning monitor / calculated from connected sources</div><h2>Threat indicators</h2></div>
        <span className="status-pill neutral">Computed {list.data ? fmt(list.data.computedAt) : '…'}</span>
      </div>
      <DataStatus sources={sources} ids={SOURCE_IDS} now={now} />

      <section className="indicator-metrics" aria-label="Indicator summary">
        <article className="metric-card neutral"><span>Tracked indicators</span><strong>{items.length}</strong></article>
        <article className="metric-card critical"><span>At warning or alert</span><strong>{items.filter((i) => i.level === 'Warning' || i.level === 'Alert').length}</strong></article>
        <article className="metric-card warning"><span>Rising</span><strong>{items.filter((i) => i.trend === 'Rising').length}</strong></article>
        <article className="metric-card positive"><span>Watched</span><strong>{items.filter((i) => i.watched).length}</strong></article>
        <article className="metric-card neutral"><span>Insufficient history</span><strong>{items.filter((i) => i.level === 'Insufficient data').length}</strong></article>
      </section>

      <div className="indicator-workspace">
        <section className="panel indicator-register" aria-label="Threat indicator register">
          <div className="indicator-filters">
            <label className="indicator-search"><span className="sr-only">Search indicators</span>
              <input type="search" placeholder="Search indicators, places…" value={filters.q} onChange={(event) => patch({ q: event.target.value })} />
            </label>
            <label className="filter-select"><span>Category</span>
              <select value={filters.category} onChange={(event) => patch({ category: event.target.value })}><option>All</option>{unique((i) => i.category).map((c) => <option key={c}>{c}</option>)}</select>
            </label>
            <label className="filter-select"><span>Geography</span>
              <select value={filters.geo} onChange={(event) => patch({ geo: event.target.value })}><option value="All">All</option>{[...new Map(items.map((i) => [i.geo, i.geoName])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select>
            </label>
            <label className="filter-select"><span>Level</span>
              <select value={filters.level} onChange={(event) => patch({ level: event.target.value })}><option>All</option>{unique((i) => i.level).map((c) => <option key={c}>{c}</option>)}</select>
            </label>
            <label className="filter-select"><span>Trend</span>
              <select value={filters.trend} onChange={(event) => patch({ trend: event.target.value })}><option>All</option>{unique((i) => i.trend).map((c) => <option key={c}>{c}</option>)}</select>
            </label>
            {active && <button className="ghost-button" onClick={() => setFilters({ q: '', category: 'All', geo: 'All', level: 'All', trend: 'All', quick: 'all' })}>Reset</button>}
          </div>
          <div className="indicator-quick-filters" role="group" aria-label="Indicator quick filters">
            {([['all', 'All indicators'], ['rising', 'Rising'], ['watched', 'Watched']] as const).map(([key, label]) => (
              <button key={key} className={filters.quick === key ? 'selected' : ''} aria-pressed={filters.quick === key} onClick={() => patch({ quick: key })}>{label}</button>
            ))}
            <span>{filtered.length} indicators</span>
          </div>
          {list.error && <Notice kind={items.length ? 'stale' : 'error'}>Could not refresh indicators: {list.error}{items.length ? ` Showing data from ${fmt(list.lastLoadedAt)}.` : ''}</Notice>}
          <div className="indicator-table-head" aria-hidden="true"><span>Indicator</span><span>Geography</span><span>Level</span><span>Trend</span><span>Weekly values</span></div>
          <div className="indicator-list" aria-live="polite">
            {list.loading && !list.data ? <div className="feed-empty" role="status">Loading indicators…</div>
              : filtered.length === 0 ? <div className="feed-empty">No indicators match these filters.</div>
              : filtered.map((item) => {
                const isSelected = selection.id === item.id && selection.geo === item.geo;
                return (
                  <button key={pairKey(item.id, item.geo)} className={`indicator-row ${isSelected ? 'selected' : ''}`} aria-pressed={isSelected} onClick={() => setSelection({ id: item.id, geo: item.geo })}>
                    <span className="indicator-name"><strong>{item.name}{item.watched ? ' ★' : ''}</strong><small>{item.isReportingActivity ? 'Reporting activity' : 'Event count'} · {item.current === null ? 'no value' : `latest ${item.current}`} · {STATUS_TEXT[item.dataStatus]}{item.blockedBy ? ` (${item.blockedBy})` : ''}</small></span>
                    <span className="indicator-place">{item.geoName}</span>
                    <span><LevelPill level={item.level} /></span>
                    <TrendText trend={item.trend} />
                    <Sparkline values={item.sparkline} />
                  </button>
                );
              })}
          </div>
          <details className="ws-definition">
            <summary>How confidence is defined</summary>
            <ul className="ws-notes">{(list.data?.confidencePolicy ?? []).map((line) => <li key={line}>{line}</li>)}</ul>
            <p className="muted-note">Level (Normal, Warning, Alert) says how the latest week compares with thresholds. Trend (Rising, Stable, Falling) says whether it moved against the baseline. They are separate: a rising trend can still be Normal.</p>
          </details>
        </section>
        <IndicatorDetail id={selection.id} geo={selection.geo} onGeo={(geo) => setSelection({ id: selection.id, geo })} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
