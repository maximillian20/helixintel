import { useEffect, useMemo, useState } from 'react';
import { wsFetch, useWorkspaceData } from '../data/workspaceApi.ts';
import {
  COUNTRY_CATEGORIES, RATINGS, SCORING_METHOD, CONFIDENCE_LEVELS,
  type AssessmentVersion, type CategoryAssessment, type CountryCategoryId, type CountryDetail, type CountryDirectoryEntry, type Confidence,
} from '../data/workspaceTypes.ts';
import { DataStatus, Modal, Notice, Pill, fmt, fmtDay, useNow, usePersistentState, useSourceStatus, type Navigate } from './shared.tsx';

const SOURCE_IDS = ['bbc-world', 'un-news', 'gdacs', 'gdelt', 'reliefweb'];
type Directory = { items: CountryDirectoryEntry[]; total: number };

function RatingPill({ rating }: { rating: string }) {
  return rating === 'Unassessed' ? <span className="badge neutral" title="No analyst rating. Missing data is not low risk.">Unassessed</span> : <Pill value={rating} />;
}

function TrendPill({ trend }: { trend: string }) {
  return <span className={`badge ${trend === 'Deteriorating' ? 'critical' : trend === 'Improving' ? 'success' : trend === 'Stable' ? 'neutral' : 'neutral'}`}>{trend}</span>;
}

// ------------------------------------------------------------------ add evidence from elsewhere (indicators, feed)

export function AddToCountryDialog({ report, onClose, onNavigate }: {
  report: { articleId: string; headline: string; countries: Array<{ code: string; name: string }> };
  onClose: () => void; onNavigate: Navigate;
}) {
  const [country, setCountry] = useState(report.countries[0]?.code ?? '');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  return (
    <Modal title="Add to country assessment" onClose={onClose}>
      <p><strong>{report.headline}</strong></p>
      {report.countries.length === 0 ? <Notice>This report does not name a country, so it cannot be used as country evidence.</Notice> : (
        <form className="ws-form" onSubmit={(event) => {
          event.preventDefault();
          wsFetch('POST', `/countries/${country}/evidence`, { refType: 'report', refId: report.articleId, category, note })
            .then(() => setDone(true))
            .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not add the evidence.'));
        }}>
          {error && <Notice kind="error">{error}</Notice>}
          {done && <Notice>Saved as evidence. <button type="button" className="ghost-button small" onClick={() => { onClose(); onNavigate('Country Assessments', country); }}>Open country</button></Notice>}
          <label>Country
            <select value={country} onChange={(event) => setCountry(event.target.value)}>{report.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
          </label>
          <label>Category
            <select value={category} onChange={(event) => setCategory(event.target.value)} required>
              <option value="">Choose a category…</option>
              {COUNTRY_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label>Note (optional)<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label>
          <p className="muted-note">This stores the report as evidence only. It does not change any rating until you save a new assessment.</p>
          <div className="ws-form-actions"><button className="outline-button" disabled={!category || done}>Add evidence</button></div>
        </form>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ assessment form

function AssessDialog({ detail, onClose }: { detail: CountryDetail; onClose: () => void }) {
  const latest = detail.latest;
  const [summary, setSummary] = useState(latest?.summary ?? '');
  const [confidence, setConfidence] = useState<Confidence>(latest?.confidence ?? 'Unassessed');
  const [categories, setCategories] = useState<Record<CountryCategoryId, CategoryAssessment>>(() => {
    const base = {} as Record<CountryCategoryId, CategoryAssessment>;
    for (const category of COUNTRY_CATEGORIES) {
      base[category.id] = latest?.categories[category.id] ?? { rating: 'Unassessed', rationale: '', confidence: 'Unassessed', evidenceIds: [] };
    }
    return base;
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (id: CountryCategoryId, patch: Partial<CategoryAssessment>) => setCategories((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      await wsFetch('POST', `/countries/${detail.code}/assessments`, { summary, confidence, categories });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the assessment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Assess ${detail.name}`} onClose={onClose} wide>
      {error && <Notice kind="error">{error}</Notice>}
      <form className="ws-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p className="muted-note">Each rating needs a written rationale and at least one report or incident of this country as evidence. Leave a category Unassessed if you cannot support a rating. Saving creates a new version; earlier versions are kept.</p>
        {detail.evidence.length === 0 && <Notice>No evidence has been added for this country yet. Add reports or incidents as evidence first (Evidence workbench on the country page).</Notice>}
        <label>Overall summary<textarea rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <label>Overall confidence
          <select value={confidence} onChange={(event) => setConfidence(event.target.value as Confidence)}>{CONFIDENCE_LEVELS.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        {COUNTRY_CATEGORIES.map((category) => {
          const entry = categories[category.id];
          const rated = entry.rating !== 'Unassessed';
          return (
            <fieldset key={category.id} className="ws-category-form">
              <legend>{category.label}</legend>
              <div className="ws-form-grid">
                <label>Rating
                  <select value={entry.rating} onChange={(event) => change(category.id, { rating: event.target.value as CategoryAssessment['rating'] })}>
                    <option>Unassessed</option>{RATINGS.map((r) => <option key={r}>{r}</option>)}
                  </select>
                </label>
                <label>Confidence
                  <select value={entry.confidence} disabled={!rated} onChange={(event) => change(category.id, { confidence: event.target.value as Confidence })}>{CONFIDENCE_LEVELS.map((c) => <option key={c}>{c}</option>)}</select>
                </label>
              </div>
              {rated && (
                <>
                  <label>Rationale<textarea rows={2} value={entry.rationale} onChange={(event) => change(category.id, { rationale: event.target.value })} /></label>
                  <div className="ws-evidence-pick">
                    <span className="meta-label">Evidence</span>
                    {detail.evidence.length === 0 && <small>None available.</small>}
                    {[...detail.evidence].sort((a, b) => Number(b.category === category.id) - Number(a.category === category.id)).map((item) => (
                      <label key={item.id} className="ws-check">
                        <input type="checkbox" checked={entry.evidenceIds.includes(item.id)} onChange={(event) => change(category.id, { evidenceIds: event.target.checked ? [...entry.evidenceIds, item.id] : entry.evidenceIds.filter((id) => id !== item.id) })} />
                        <span>{item.label} <small>{item.source} · {fmtDay(item.eventTime)}{item.category === category.id ? ' · filed under this category' : ''}</small></span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
          );
        })}
        <div className="ws-form-actions">
          <button className="outline-button" disabled={busy}>{busy ? 'Saving…' : 'Save new version'}</button>
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ detail

function WhyRating({ version, categoryId }: { version: AssessmentVersion; categoryId: CountryCategoryId }) {
  const category = version.categories[categoryId];
  const evidence = version.evidence.filter((item) => category.evidenceIds.includes(item.id));
  return (
    <div className="ws-why">
      <p><strong>Rationale.</strong> {category.rationale || 'No rationale recorded.'}</p>
      <p><strong>Confidence.</strong> {category.confidence}. <strong>Assessed</strong> {fmt(version.assessedAt)} by {version.assessor} (version {version.version}).</p>
      <p><strong>Evidence ({evidence.length}).</strong></p>
      <ul className="ws-evidence">{evidence.map((item) => (
        <li key={item.id}>
          {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.label}</a> : <span>{item.label}</span>}
          <small>{item.refType === 'incident' ? 'Incident' : item.source} · {item.refType === 'incident' ? 'created' : 'published'} {fmt(item.eventTime)} · filed under {item.category} by {item.addedBy}{item.note ? ` · ${item.note}` : ''}</small>
        </li>
      ))}</ul>
      <p><strong>Methodology.</strong> {SCORING_METHOD.summary} {SCORING_METHOD.scale}</p>
    </div>
  );
}

function CountryDetailView({ code, onBack, onNavigate }: { code: string; onBack: () => void; onNavigate: Navigate }) {
  const detailState = useWorkspaceData<CountryDetail>(`/countries/${code}`);
  const [assessing, setAssessing] = useState(false);
  const [openWhy, setOpenWhy] = useState<CountryCategoryId | ''>('');
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [versionData, setVersionData] = useState<AssessmentVersion | null>(null);
  const [evidenceCategory, setEvidenceCategory] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const { sources } = useSourceStatus();
  const now = useNow();
  const detail = detailState.data;

  useEffect(() => {
    if (viewVersion === null) { setVersionData(null); return; }
    wsFetch<AssessmentVersion>('GET', `/countries/${code}/assessments/${viewVersion}`).then(setVersionData).catch(() => setVersionData(null));
  }, [viewVersion, code]);

  async function run(task: () => Promise<unknown>) {
    setError('');
    try { await task(); void detailState.reload(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'The change was not saved.'); }
  }

  if (detailState.error && !detail) return <div className="module-view"><Notice kind="error">{detailState.error}</Notice><button className="outline-button" onClick={onBack}>Back</button></div>;
  if (!detail) return <div className="module-view"><p role="status">Loading country…</p></div>;

  const shown = versionData ?? detail.latest;
  const savedKeys = new Set(detail.evidence.map((item) => `${item.refType}:${item.refId}`));

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow"><button className="ghost-button small" onClick={onBack}>← All countries</button> Country assessment</div>
          <h2>{detail.name}</h2>
        </div>
        <div className="feed-heading-actions">
          <button className="ghost-button" aria-pressed={detail.watched} onClick={() => void run(() => wsFetch('PUT', `/countries/${code}/watch`, { watched: !detail.watched }))}>
            {detail.watched ? 'Remove from watchlist' : 'Add to watchlist'}
          </button>
          <button className="outline-button" onClick={() => setAssessing(true)}>{detail.latest ? 'Update assessment' : 'Create assessment'}</button>
          {detail.latest && <button className="outline-button" onClick={() => onNavigate('SIBs', `country:${code}`)}>Create SIB</button>}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {detailState.error && <Notice kind="stale">Could not refresh: {detailState.error}. Showing data loaded {fmt(detailState.lastLoadedAt)}.</Notice>}
      <DataStatus sources={sources} ids={SOURCE_IDS} now={now} />

      <div className="panel">
        <div className="panel-header">
          <h3>{shown ? `Assessment, version ${shown.version}` : 'No assessment yet'}</h3>
          {shown && <span className="muted-note">Assessed {fmt(shown.assessedAt)} by {shown.assessor} · overall confidence {shown.confidence}</span>}
        </div>
        {viewVersion !== null && <Notice kind="stale">Viewing saved version {viewVersion}. <button className="ghost-button small" onClick={() => setViewVersion(null)}>Back to latest</button></Notice>}
        {!shown && <Notice>Unassessed. No analyst rating has been saved for this country. Automated scores are not shown because no defensible scoring method is configured, and missing data is never treated as low risk.</Notice>}
        {shown?.summary && <p>{shown.summary}</p>}
        <div className="country-grid">
          {COUNTRY_CATEGORIES.map((category) => {
            const entry = shown?.categories[category.id];
            const trend = detail.trends[category.id];
            const isOpen = openWhy === category.id;
            return (
              <div key={category.id} className="panel country-card" data-category={category.id}>
                <div className="panel-header"><h3>{category.label}</h3><RatingPill rating={entry?.rating ?? 'Unassessed'} /></div>
                <div className="risk-row"><span className="meta-label">Trend</span><TrendPill trend={viewVersion === null ? trend.trend : 'Insufficient history'} /></div>
                <div className="risk-row"><span className="meta-label">Confidence</span><strong>{entry && entry.rating !== 'Unassessed' ? entry.confidence : 'Unassessed'}</strong></div>
                {viewVersion === null && (
                  <div className="ws-changes">
                    {trend.changes.map((change) => (
                      <span key={change.windowDays} title={change.fromDate ? `Compared with version saved ${fmt(change.fromDate)}` : 'No saved version old enough'}>
                        {change.windowDays}d: {change.steps === null ? 'no history' : change.steps === 0 ? 'no change' : `${change.steps > 0 ? '+' : ''}${change.steps} step${Math.abs(change.steps) === 1 ? '' : 's'} (from ${change.from})`}
                      </span>
                    ))}
                  </div>
                )}
                {entry && entry.rating !== 'Unassessed' && shown ? (
                  <>
                    <button className="outline-button small" aria-expanded={isOpen} onClick={() => setOpenWhy(isOpen ? '' : category.id)}>Why this rating?</button>
                    {isOpen && <WhyRating version={shown} categoryId={category.id} />}
                  </>
                ) : <p className="muted-note">Unassessed: no supported analyst rating.</p>}
              </div>
            );
          })}
        </div>
        <p className="muted-note">{SCORING_METHOD.scale} {SCORING_METHOD.missing}</p>
      </div>

      <div className="incident-layout">
        <div className="panel">
          <div className="panel-header"><h3>Evidence summary (context, not a rating)</h3></div>
          <div className="facts-grid">
            <div><span className="meta-label">Reports, last 30 days</span><strong>{detail.evidenceSummary.reports30d}</strong></div>
            <div><span className="meta-label">Disaster alerts, 30 days</span><strong>{detail.evidenceSummary.disasterAlerts30d}</strong></div>
            <div><span className="meta-label">Newest report published</span><strong>{detail.evidenceSummary.latestReportPublishedAt ? fmt(detail.evidenceSummary.latestReportPublishedAt) : 'none'}</strong></div>
            <div><span className="meta-label">Linked incidents</span><strong>{detail.incidents.length}</strong></div>
          </div>
          <div className="tag-list">{COUNTRY_CATEGORIES.map((c) => <span key={c.id} className="chip">{c.label}: {detail.evidenceSummary.reportsBySuggestedCategory[c.id]} report{detail.evidenceSummary.reportsBySuggestedCategory[c.id] === 1 ? '' : 's'}</span>)}</div>
          <p className="muted-note">{SCORING_METHOD.automated}</p>

          <div className="detail-block">
            <h4>Methodology</h4>
            <p><strong>{SCORING_METHOD.name}.</strong> {SCORING_METHOD.summary}</p>
            <p>{SCORING_METHOD.trend}</p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><h3>Saved versions</h3></div>
          {detail.versions.length === 0 && <p className="muted-note">No versions saved.</p>}
          <ul className="ws-plain-list">{detail.versions.map((version) => (
            <li key={version.version}>
              <button className={`ghost-button small ${viewVersion === version.version ? 'selected' : ''}`} onClick={() => setViewVersion(version.version === detail.latest?.version ? null : version.version)}>Version {version.version}</button>
              {' '}{fmt(version.assessedAt)} · {version.assessor} · confidence {version.confidence}
            </li>
          ))}</ul>
          <div className="detail-block">
            <h4>Linked incidents</h4>
            {detail.incidents.length === 0 && <p className="muted-note">No incidents for this country.</p>}
            <ul className="ws-plain-list">{detail.incidents.map((incident) => (
              <li key={incident.id}><button className="ghost-button small" onClick={() => onNavigate('Incidents', incident.id)}>{incident.id}</button> {incident.title} <Pill value={incident.status} /></li>
            ))}</ul>
          </div>
          <div className="detail-block">
            <h4>Business assets in affected areas</h4>
            {detail.assets.length === 0 && <p className="muted-note">No sites, suppliers or routes are recorded on this country&apos;s incidents.</p>}
            <ul className="ws-plain-list">{detail.assets.map((asset) => <li key={`${asset.incidentId}-${asset.id}`}><span className="chip">{asset.kind}</span> {asset.name} <small>via {asset.incidentId}</small></li>)}</ul>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h3>Evidence workbench</h3></div>
        <div className="incident-layout">
          <div>
            <h4>Saved evidence ({detail.evidence.length})</h4>
            {detail.evidence.length === 0 && <p className="muted-note">Nothing saved yet.</p>}
            <ul className="ws-evidence">{detail.evidence.map((item) => (
              <li key={item.id}>
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.label}</a> : <span>{item.label}</span>}
                <small>{COUNTRY_CATEGORIES.find((c) => c.id === item.category)?.label} · {item.refType} · {item.source} · {fmt(item.eventTime)} · added {fmt(item.addedAt)} by {item.addedBy}</small>
                <button className="ghost-button small" onClick={() => void run(() => wsFetch('DELETE', `/countries/${code}/evidence/${item.id}`))}>Remove</button>
              </li>
            ))}</ul>
          </div>
          <div>
            <h4>Recent reports naming {detail.name}</h4>
            {detail.recentReports.length === 0 && <p className="muted-note">No reports in the last 30 days.</p>}
            <ul className="ws-evidence">{detail.recentReports.map((report) => {
              const chosen = evidenceCategory[report.articleId] ?? report.suggestedCategory ?? '';
              return (
                <li key={report.articleId}>
                  <a href={report.url} target="_blank" rel="noreferrer">{report.headline}</a>
                  <small>{report.source} · published {fmt(report.publishedAt)} · {report.severity} · {report.suggestionBasis}</small>
                  <span className="ws-inline-form">
                    <select aria-label="Category" value={chosen} onChange={(event) => setEvidenceCategory({ ...evidenceCategory, [report.articleId]: event.target.value })}>
                      <option value="">Category…</option>{COUNTRY_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <button className="outline-button small" disabled={!chosen || savedKeys.has(`report:${report.articleId}`)} onClick={() => void run(() => wsFetch('POST', `/countries/${code}/evidence`, { refType: 'report', refId: report.articleId, category: chosen }))}>
                      {savedKeys.has(`report:${report.articleId}`) ? 'Saved' : 'Add as evidence'}
                    </button>
                  </span>
                </li>
              );
            })}</ul>
            {detail.incidents.length > 0 && <h4>Incidents</h4>}
            <ul className="ws-evidence">{detail.incidents.map((incident) => (
              <li key={incident.id}>
                <span>{incident.title}</span>
                <span className="ws-inline-form">
                  <select aria-label="Category for incident" value={evidenceCategory[incident.id] ?? ''} onChange={(event) => setEvidenceCategory({ ...evidenceCategory, [incident.id]: event.target.value })}>
                    <option value="">Category…</option>{COUNTRY_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  <button className="outline-button small" disabled={!evidenceCategory[incident.id] || savedKeys.has(`incident:${incident.id}`)} onClick={() => void run(() => wsFetch('POST', `/countries/${code}/evidence`, { refType: 'incident', refId: incident.id, category: evidenceCategory[incident.id] }))}>
                    {savedKeys.has(`incident:${incident.id}`) ? 'Saved' : 'Add as evidence'}
                  </button>
                </span>
              </li>
            ))}</ul>
          </div>
        </div>
      </div>
      {assessing && <AssessDialog detail={detail} onClose={() => { setAssessing(false); void detailState.reload(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ comparison

function CompareView({ codes, onBack }: { codes: string[]; onBack: () => void }) {
  const state = useWorkspaceData<{ items: CountryDetail[] }>(`/countries/compare?codes=${codes.join(',')}`);
  const items = state.data?.items ?? [];
  return (
    <div className="module-view">
      <div className="module-header">
        <div><div className="eyebrow"><button className="ghost-button small" onClick={onBack}>← All countries</button> Comparison</div><h2>Compare countries</h2></div>
      </div>
      {state.error && <Notice kind="error">{state.error}</Notice>}
      {state.loading && !state.data && <p role="status">Loading comparison…</p>}
      {items.length > 0 && (
        <div className="panel ws-compare">
          <table>
            <thead><tr><th scope="col">Criterion</th>{items.map((item) => <th key={item.code} scope="col">{item.name}</th>)}</tr></thead>
            <tbody>
              {COUNTRY_CATEGORIES.map((category) => (
                <tr key={category.id}>
                  <th scope="row">{category.label}</th>
                  {items.map((item) => {
                    const entry = item.latest?.categories[category.id];
                    return (
                      <td key={item.code}>
                        <RatingPill rating={entry?.rating ?? 'Unassessed'} />
                        <div><TrendPill trend={item.trends[category.id].trend} /></div>
                        <small>{entry && entry.rating !== 'Unassessed' ? `Confidence ${entry.confidence}; ${entry.evidenceIds.length} evidence item${entry.evidenceIds.length === 1 ? '' : 's'}` : 'No analyst rating'}</small>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr><th scope="row">Assessed</th>{items.map((item) => <td key={item.code}>{item.latest ? `${fmt(item.latest.assessedAt)} (v${item.latest.version})` : 'never'}</td>)}</tr>
              <tr><th scope="row">Overall confidence</th>{items.map((item) => <td key={item.code}>{item.latest?.confidence ?? 'Unassessed'}</td>)}</tr>
              <tr><th scope="row">Reports, 30 days (context)</th>{items.map((item) => <td key={item.code}>{item.evidenceSummary.reports30d}</td>)}</tr>
              <tr><th scope="row">Disaster alerts, 30 days</th>{items.map((item) => <td key={item.code}>{item.evidenceSummary.disasterAlerts30d}</td>)}</tr>
              <tr><th scope="row">Open incidents</th>{items.map((item) => <td key={item.code}>{item.incidents.filter((i) => i.status !== 'Closed').length}</td>)}</tr>
            </tbody>
          </table>
          <p className="muted-note">All countries are shown against the same six criteria. Ratings are analyst-assigned; report counts are context only and are not used as risk. {SCORING_METHOD.scale}</p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ directory

type Filters = { q: string; scope: 'all' | 'watched' | 'assessed' | 'incidents' | 'active' };

export function CountriesModule({ focusId, onNavigate }: { focusId?: string; onNavigate: Navigate }) {
  const [filters, setFilters] = usePersistentState<Filters>('country-filters', { q: '', scope: 'all' });
  const [selected, setSelected] = useState(focusId ?? '');
  const [compare, setCompare] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const directory = useWorkspaceData<Directory>('/countries');
  const { sources } = useSourceStatus();
  const now = useNow();
  useEffect(() => { if (focusId) setSelected(focusId); }, [focusId]);

  const rows = useMemo(() => {
    const query = filters.q.trim().toLowerCase();
    return (directory.data?.items ?? []).filter((row) => {
      if (query && !row.name.toLowerCase().includes(query) && !row.code.toLowerCase().includes(query)) return false;
      if (filters.scope === 'watched') return row.watched;
      if (filters.scope === 'assessed') return row.assessedAt !== null;
      if (filters.scope === 'incidents') return row.incidentCount > 0;
      if (filters.scope === 'active') return row.reportCount30d > 0;
      return true;
    }).sort((a, b) => Number(b.watched) - Number(a.watched) || b.reportCount30d - a.reportCount30d || a.name.localeCompare(b.name));
  }, [directory.data, filters]);

  if (comparing && compare.length >= 2) return <CompareView codes={compare} onBack={() => setComparing(false)} />;
  if (selected) return <CountryDetailView code={selected} onBack={() => setSelected('')} onNavigate={(view, id) => { if (view === 'Country Assessments' && id) setSelected(id); else onNavigate(view, id); }} />;

  const toggle = (code: string) => setCompare((current) => (current.includes(code) ? current.filter((c) => c !== code) : current.length >= 3 ? current : [...current, code]));

  return (
    <div className="module-view">
      <div className="module-header">
        <div><div className="eyebrow">Country assessments</div><h2>Country directory</h2></div>
        <div className="feed-heading-actions">
          <span className="status-pill neutral">{rows.length} of {directory.data?.total ?? 0} countries</span>
          <button className="outline-button" disabled={compare.length < 2} onClick={() => setComparing(true)}>Compare selected ({compare.length}/3)</button>
        </div>
      </div>
      <DataStatus sources={sources} ids={SOURCE_IDS} now={now} />
      <section className="panel" aria-label="Country directory">
        <div className="indicator-filters">
          <label className="indicator-search"><span className="sr-only">Search countries</span>
            <input type="search" placeholder="Search countries…" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} />
          </label>
          <label className="filter-select"><span>Show</span>
            <select value={filters.scope} onChange={(event) => setFilters({ ...filters, scope: event.target.value as Filters['scope'] })}>
              <option value="all">All countries</option><option value="active">With reports (30 days)</option><option value="watched">Watched</option>
              <option value="assessed">Assessed</option><option value="incidents">With incidents</option>
            </select>
          </label>
          {(filters.q || filters.scope !== 'all') && <button className="ghost-button" onClick={() => setFilters({ q: '', scope: 'all' })}>Reset</button>}
          {compare.length > 0 && <button className="ghost-button" onClick={() => setCompare([])}>Clear selection</button>}
        </div>
        {directory.error && <Notice kind="error">Could not load countries: {directory.error} <button className="outline-button small" onClick={() => void directory.reload()}>Retry</button></Notice>}
        {directory.loading && !directory.data && <div className="feed-empty" role="status">Loading countries…</div>}
        {directory.data && rows.length === 0 && <div className="feed-empty">No countries match.</div>}
        {rows.length > 0 && (
          <div className="ws-table countries" role="table" aria-label="Countries">
            <div className="ws-table-head" role="row"><span>Compare</span><span>Country</span><span>Highest analyst rating</span><span>Assessed</span><span>Reports (30 d)</span><span>Incidents</span><span>Disaster alerts (30 d)</span></div>
            {rows.slice(0, 250).map((row) => (
              <div key={row.code} role="row" className="ws-table-row static">
                <span><input type="checkbox" aria-label={`Select ${row.name} for comparison`} checked={compare.includes(row.code)} disabled={!compare.includes(row.code) && compare.length >= 3} onChange={() => toggle(row.code)} /></span>
                <button className="link-button" onClick={() => setSelected(row.code)}><strong>{row.name}</strong>{row.watched && <small> · watched</small>}</button>
                <span><RatingPill rating={row.highestRating} /></span>
                <span>{row.assessedAt ? fmtDay(row.assessedAt) : 'never'}</span>
                <span>{row.reportCount30d}</span>
                <span>{row.incidentCount}{row.openIncidents ? ` (${row.openIncidents} open)` : ''}</span>
                <span>{row.disasterAlerts30d}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted-note">Ratings are analyst-assigned and evidence-backed. “Unassessed” means no rating has been saved, not that risk is low. Report counts are context only.</p>
      </section>
    </div>
  );
}
