import { useEffect, useMemo, useState } from 'react';
import { sortedCountries } from '../data/countries.ts';
import { SEVERITIES, type Severity } from '../data/feedTypes.ts';
import { wsFetch, useWorkspaceData, getAnalystName } from '../data/workspaceApi.ts';
import {
  ASSET_KINDS, CONFIDENCE_LEVELS, IMPACT_AREAS, INCIDENT_STATUSES,
  type DuplicateSuggestion, type IncidentDetail, type IncidentInput, type IncidentStatus, type IncidentSummary,
} from '../data/workspaceTypes.ts';
import { CountryPicker, DataStatus, Modal, Notice, Pill, fmt, fmtDay, useNow, usePersistentState, useSourceStatus, type Navigate } from './shared.tsx';

const realCountries = sortedCountries.filter((country) => country.code !== 'GLOBAL' && country.code !== 'UNKNOWN');
const SOURCE_IDS = ['bbc-world', 'un-news', 'gdacs', 'gdelt', 'cisa-kev', 'reliefweb'];

function sevClass(severity: string) {
  return `badge sev-${severity.toLowerCase()}`;
}

// ------------------------------------------------------------------ feed to incident dialog

type Prefill = {
  input: IncidentInput;
  reports: Array<{ articleId: string; headline: string; url: string; source: string; publishedAt: string }>;
  duplicates: DuplicateSuggestion[];
};

/** "Create incident" and "Add to existing incident" for one or more reports. Prefills only what the feed supports. */
export function IncidentLinkDialog({ articleIds, initialMode, onClose, onNavigate }: {
  articleIds: string[]; initialMode: 'create' | 'existing'; onClose: () => void; onNavigate: Navigate;
}) {
  const [mode, setMode] = useState(initialMode);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [form, setForm] = useState<IncidentInput | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState<{ text: string; incidentId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const list = useWorkspaceData<{ items: IncidentSummary[] }>(mode === 'existing' || prefill?.duplicates.length ? '/incidents' : null);

  useEffect(() => {
    let active = true;
    wsFetch<Prefill>('POST', '/incidents/prefill', { articleIds })
      .then((result) => { if (active) { setPrefill(result); setForm(result.input); } })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not prepare the incident.'); });
    return () => { active = false; };
  }, [articleIds]);

  async function create() {
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const created = await wsFetch<IncidentDetail>('POST', '/incidents', { articleIds, input: form });
      onClose();
      onNavigate('Incidents', created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the incident.');
    } finally {
      setBusy(false);
    }
  }

  async function link(incidentId: string) {
    setBusy(true);
    setError('');
    try {
      const result = await wsFetch<{ linked: number; skipped: number }>('POST', `/incidents/${incidentId}/reports`, { articleIds });
      setMessage({
        incidentId,
        text: result.linked > 0
          ? `Linked ${result.linked} report${result.linked === 1 ? '' : 's'}${result.skipped ? `; ${result.skipped} already linked and skipped` : ''}.`
          : 'Already linked to this incident, so nothing was added.',
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not link the report.');
    } finally {
      setBusy(false);
    }
  }

  const incidents = (list.data?.items ?? []).filter((incident) => {
    const query = search.trim().toLowerCase();
    return !query || `${incident.id} ${incident.title}`.toLowerCase().includes(query);
  });
  const set = <K extends keyof IncidentInput>(key: K, value: IncidentInput[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));

  return (
    <Modal title={mode === 'create' ? 'Create incident from report' : 'Add to existing incident'} onClose={onClose} wide>
      {error && <Notice kind="error">{error}</Notice>}
      {!prefill && !error && <p role="status">Preparing…</p>}
      {prefill && form && (
        <>
          <div className="ws-tabs" role="tablist">
            <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'selected' : ''} onClick={() => setMode('create')}>Create new incident</button>
            <button role="tab" aria-selected={mode === 'existing'} className={mode === 'existing' ? 'selected' : ''} onClick={() => setMode('existing')}>Add to existing incident</button>
          </div>
          <div className="ws-linked-reports">
            <strong>{prefill.reports.length} report{prefill.reports.length === 1 ? '' : 's'} will be linked as evidence</strong>
            <ul>{prefill.reports.map((report) => (
              <li key={report.articleId}><a href={report.url} target="_blank" rel="noreferrer">{report.headline}</a> <small>{report.source}, published {fmt(report.publishedAt)}</small></li>
            ))}</ul>
          </div>
          {message && (
            <Notice>
              {message.text} <button className="ghost-button small" onClick={() => { onClose(); onNavigate('Incidents', message.incidentId); }}>Open incident</button>
            </Notice>
          )}

          {prefill.duplicates.length > 0 && mode === 'create' && (
            <div className="ws-duplicates">
              <strong>Possible duplicates: review before creating</strong>
              {prefill.duplicates.map((duplicate) => (
                <div key={duplicate.id} className="ws-row">
                  <span><strong>{duplicate.id}</strong> {duplicate.title} <Pill value={duplicate.status} /><small>{duplicate.reasons.join('; ')}</small></span>
                  <button className="outline-button small" disabled={busy} onClick={() => void link(duplicate.id)}>Add to this incident instead</button>
                </div>
              ))}
            </div>
          )}

          {mode === 'create' ? (
            <form className="ws-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
              <p className="muted-note">Fields are pre-filled from the report and can be edited. Severity comes from the feed&apos;s {'automatic'} assessment; review the rationale before relying on it.</p>
              <label>Title<input value={form.title} maxLength={200} onChange={(event) => set('title', event.target.value)} required /></label>
              <label>Summary<textarea rows={3} value={form.summary} onChange={(event) => set('summary', event.target.value)} /></label>
              <div className="ws-form-grid">
                <label>Category<input value={form.category} onChange={(event) => set('category', event.target.value)} /></label>
                <label>Location<input value={form.locationText} onChange={(event) => set('locationText', event.target.value)} placeholder="Only if the source gives one" /></label>
                <label>Severity
                  <select value={form.severity} onChange={(event) => set('severity', event.target.value as Severity)}>
                    {SEVERITIES.map((severity) => <option key={severity}>{severity}</option>)}
                  </select>
                </label>
                <label>Confidence
                  <select value={form.confidence} onChange={(event) => set('confidence', event.target.value as IncidentInput['confidence'])}>
                    {CONFIDENCE_LEVELS.map((level) => <option key={level}>{level}</option>)}
                  </select>
                </label>
                <label>Owner<input value={form.owner ?? ''} onChange={(event) => set('owner', event.target.value || null)} placeholder="Optional" /></label>
              </div>
              <label>Severity rationale<textarea rows={2} value={form.severityRationale} onChange={(event) => set('severityRationale', event.target.value)} /></label>
              <div><span className="meta-label">Countries</span><CountryPicker value={form.countryCodes} onChange={(codes) => set('countryCodes', codes)} options={realCountries} /></div>
              <div className="ws-form-actions">
                <button type="submit" className="outline-button" disabled={busy || !form.title.trim()}>{busy ? 'Creating…' : 'Create incident'}</button>
                <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="ws-existing">
              <input type="search" placeholder="Search incidents by ID or title" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search incidents" />
              {list.loading && <p role="status">Loading incidents…</p>}
              {!list.loading && incidents.length === 0 && <div className="feed-empty">{(list.data?.items.length ?? 0) === 0 ? 'No incidents yet. Create one instead.' : 'No incidents match.'}</div>}
              {incidents.map((incident) => (
                <div key={incident.id} className="ws-row">
                  <span><strong>{incident.id}</strong> {incident.title} <Pill value={incident.status} /><small>{incident.reportCount} linked report{incident.reportCount === 1 ? '' : 's'}</small></span>
                  <button className="outline-button small" disabled={busy} onClick={() => void link(incident.id)}>Add report{articleIds.length === 1 ? '' : 's'}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ brief

function uncertaintiesOf(incident: IncidentDetail, now: number) {
  const list: string[] = [];
  if (incident.confidence === 'Unassessed' || incident.confidence === 'Low') list.push(`Overall confidence is ${incident.confidence.toLowerCase()}.`);
  if (incident.severity === 'Unassessed' || !incident.severityRationale.trim()) list.push('Severity has not been assessed with a rationale.');
  if (incident.evidence.length <= 1) list.push(`The incident rests on ${incident.evidence.length === 0 ? 'no linked reports' : 'a single report'}; corroboration is not established.`);
  if (incident.lat === null) list.push('No confirmed coordinates are recorded.');
  if (incident.impacts.length === 0) list.push('Impacts have not been assessed.');
  const newest = incident.evidence.map((link) => Date.parse(link.publishedAt)).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  if (newest && incident.status !== 'Closed' && now - newest > 7 * 86_400_000) list.push(`No new report has been linked since ${fmtDay(new Date(newest).toISOString())}.`);
  for (const action of incident.actions) {
    if (action.status === 'Open' && action.dueDate && action.dueDate < new Date(now).toISOString().slice(0, 10)) list.push(`Action overdue: ${action.text} (due ${action.dueDate}).`);
  }
  return list;
}

function briefMarkdown(incident: IncidentDetail, now: number) {
  const lines: string[] = [
    `# ${incident.title}`, '',
    `${incident.id} | Status: ${incident.status} | Severity: ${incident.severity} | Confidence: ${incident.confidence}`,
    `Owner: ${incident.owner ?? 'unassigned'} | Countries: ${incident.countries.map((c) => c.name).join(', ') || 'not set'} | Location: ${incident.locationText || 'not recorded'}`,
    `Event time: ${incident.eventAt ? fmt(incident.eventAt) : 'not recorded'} | Created: ${fmt(incident.createdAt)} | Last updated: ${fmt(incident.updatedAt)}`, '',
    '## Summary', incident.summary || 'No summary recorded.', '',
    '## Severity rationale', incident.severityRationale || 'None recorded.', '',
    '## Evidence',
    ...incident.evidence.map((link) => `- ${link.headline} (${link.source}; published ${fmt(link.publishedAt)}; retrieved ${link.retrievedAt ? fmt(link.retrievedAt) : 'record no longer stored'}; linked by ${link.linkedBy} on ${fmt(link.linkedAt)}) ${link.url}`), '',
    '## Affected sites, suppliers and routes',
    ...(incident.assets.length ? incident.assets.map((asset) => `- ${asset.kind}: ${asset.name}${asset.countryCode ? ` (${asset.countryCode})` : ''}${asset.notes ? ` - ${asset.notes}` : ''}`) : ['None recorded.']), '',
    '## Impacts',
    ...(incident.impacts.length ? incident.impacts.map((impact) => `- ${impact.area}: ${impact.text} (${impact.author}, ${fmt(impact.createdAt)})`) : ['None recorded.']), '',
    '## Uncertainties',
    ...(uncertaintiesOf(incident, now).map((entry) => `- ${entry}`)), '',
    '## Outstanding actions',
    ...(incident.actions.filter((a) => a.status === 'Open').map((a) => `- ${a.text} | owner: ${a.owner ?? 'unassigned'} | due: ${a.dueDate ?? 'no deadline'}`)),
    ...(incident.actions.some((a) => a.status === 'Open') ? [] : ['None outstanding.']), '',
    `Generated ${fmt(new Date(now).toISOString())}. Severity and category may come from automatic assessments of publisher-provided text; check the linked sources.`,
  ];
  return lines.join('\n');
}

function BriefDialog({ incident, onClose }: { incident: IncidentDetail; onClose: () => void }) {
  const now = Date.now();
  const uncertainties = uncertaintiesOf(incident, now);
  function download() {
    const blob = new Blob([briefMarkdown(incident, now)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${incident.id}-brief.md`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Modal title="Incident brief" onClose={onClose} wide>
      <div className="ws-form-actions no-print">
        <button className="outline-button" onClick={() => window.print()}>Print / save as PDF</button>
        <button className="ghost-button" onClick={download}>Download (.md)</button>
      </div>
      <article className="brief" aria-label="Incident brief">
        <h2>{incident.title}</h2>
        <p><strong>{incident.id}</strong> · Status {incident.status} · Severity {incident.severity} · Confidence {incident.confidence} · Owner {incident.owner ?? 'unassigned'}</p>
        <p>Countries: {incident.countries.map((c) => c.name).join(', ') || 'not set'} · Location: {incident.locationText || 'not recorded'} · Event time: {incident.eventAt ? fmt(incident.eventAt) : 'not recorded'} · Created {fmt(incident.createdAt)} · Updated {fmt(incident.updatedAt)}</p>
        <h4>Summary</h4><p>{incident.summary || 'No summary recorded.'}</p>
        <h4>Severity rationale</h4><p>{incident.severityRationale || 'None recorded.'}</p>
        <h4>Evidence ({incident.evidence.length})</h4>
        <ol>{incident.evidence.map((link) => (
          <li key={link.articleId}>{link.headline} — {link.source}; published {fmt(link.publishedAt)}; retrieved {link.retrievedAt ? fmt(link.retrievedAt) : 'record no longer stored'}. <a href={link.url}>{link.url}</a></li>
        ))}</ol>
        <h4>Affected sites, suppliers and routes</h4>
        {incident.assets.length === 0 ? <p>None recorded.</p> : <ul>{incident.assets.map((asset) => <li key={asset.id}>{asset.kind}: {asset.name}{asset.notes ? ` — ${asset.notes}` : ''}</li>)}</ul>}
        <h4>Impacts</h4>
        {incident.impacts.length === 0 ? <p>None recorded.</p> : <ul>{incident.impacts.map((impact) => <li key={impact.id}>{impact.area}: {impact.text}</li>)}</ul>}
        <h4>Uncertainties</h4>
        {uncertainties.length === 0 ? <p>No specific gaps flagged by the checks (evidence, severity rationale, confidence, impacts, location, deadlines).</p> : <ul>{uncertainties.map((entry) => <li key={entry}>{entry}</li>)}</ul>}
        <h4>Outstanding actions</h4>
        {incident.actions.filter((action) => action.status === 'Open').length === 0 ? <p>None outstanding.</p> : (
          <ul>{incident.actions.filter((action) => action.status === 'Open').map((action) => <li key={action.id}>{action.text} — owner {action.owner ?? 'unassigned'}, due {action.dueDate ?? 'no deadline'}</li>)}</ul>
        )}
        <p className="muted-note">Generated {fmt(new Date(now).toISOString())}. Severity and category may come from automatic assessments of publisher-provided text; check the linked sources.</p>
      </article>
    </Modal>
  );
}

// ------------------------------------------------------------------ detail

type SuggestionPayload = { items: Array<{ articleId: string; headline: string; url: string; source: string; publishedAt: string; retrievedAt: string; severity: string; reasons: string[] }>; basis: string };

function IncidentDetailView({ id, onBack, onNavigate }: { id: string; onBack: () => void; onNavigate: Navigate }) {
  const detail = useWorkspaceData<IncidentDetail>(`/incidents/${id}`);
  const suggestions = useWorkspaceData<SuggestionPayload>(`/incidents/${id}/suggestions`);
  const duplicates = useWorkspaceData<{ items: DuplicateSuggestion[]; basis: string }>(`/incidents/${id}/duplicates`);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<IncidentInput | null>(null);
  const [error, setError] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);
  const [asset, setAsset] = useState({ kind: 'Site', name: '', notes: '' });
  const [impact, setImpact] = useState({ area: 'Operational', text: '' });
  const [action, setAction] = useState({ text: '', owner: '', dueDate: '' });
  const incident = detail.data;

  async function run(task: () => Promise<unknown>, success?: () => void) {
    setError('');
    try {
      await task();
      success?.();
      void detail.reload();
      void suggestions.reload();
      void duplicates.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The change was not saved.');
    }
  }

  function startEdit() {
    if (!incident) return;
    setDraft({
      title: incident.title, summary: incident.summary, category: incident.category, locationText: incident.locationText, lat: incident.lat, lng: incident.lng,
      countryCodes: incident.countries.map((c) => c.code), severity: incident.severity, severityRationale: incident.severityRationale,
      confidence: incident.confidence, owner: incident.owner, eventAt: incident.eventAt,
    });
    setEditing(true);
  }

  if (detail.error && !incident) return <div className="module-view"><Notice kind="error">{detail.error}</Notice><button className="outline-button" onClick={onBack}>Back to incidents</button></div>;
  if (!incident) return <div className="module-view"><p role="status">Loading incident…</p></div>;

  const set = <K extends keyof IncidentInput>(key: K, value: IncidentInput[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));
  const openActions = incident.actions.filter((entry) => entry.status === 'Open');

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow"><button className="ghost-button small" onClick={onBack}>← All incidents</button> Incident analysis</div>
          <h2>{incident.title}</h2>
        </div>
        <div className="feed-heading-actions">
          <button className="outline-button" onClick={() => setBriefOpen(true)}>Incident brief</button>
          <button className="outline-button" onClick={() => onNavigate('SIBs', `incident:${incident.id}`)}>Create SIB</button>
          {!editing && <button className="outline-button" onClick={startEdit}>Edit details</button>}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {detail.error && <Notice kind="stale">Could not refresh: {detail.error}. Showing the last loaded version from {fmt(detail.lastLoadedAt)}.</Notice>}

      <div className="incident-layout">
        <div className="panel">
          <div className="panel-header">
            <h3>Event summary</h3>
            <span className={sevClass(incident.severity)}>{incident.severity}</span>
          </div>
          {editing && draft ? (
            <form className="ws-form" onSubmit={(event) => {
              event.preventDefault();
              void run(() => wsFetch('PATCH', `/incidents/${id}`, draft), () => setEditing(false));
            }}>
              <label>Title<input value={draft.title} onChange={(event) => set('title', event.target.value)} required /></label>
              <label>Summary<textarea rows={4} value={draft.summary} onChange={(event) => set('summary', event.target.value)} /></label>
              <div className="ws-form-grid">
                <label>Category<input value={draft.category} onChange={(event) => set('category', event.target.value)} /></label>
                <label>Location<input value={draft.locationText} onChange={(event) => set('locationText', event.target.value)} /></label>
                <label>Latitude<input type="number" step="any" value={draft.lat ?? ''} onChange={(event) => set('lat', event.target.value === '' ? null : Number(event.target.value))} /></label>
                <label>Longitude<input type="number" step="any" value={draft.lng ?? ''} onChange={(event) => set('lng', event.target.value === '' ? null : Number(event.target.value))} /></label>
                <label>Severity
                  <select value={draft.severity} onChange={(event) => set('severity', event.target.value as Severity)}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
                </label>
                <label>Confidence
                  <select value={draft.confidence} onChange={(event) => set('confidence', event.target.value as IncidentInput['confidence'])}>{CONFIDENCE_LEVELS.map((s) => <option key={s}>{s}</option>)}</select>
                </label>
                <label>Owner<input value={draft.owner ?? ''} onChange={(event) => set('owner', event.target.value || null)} /></label>
                <label>Event time<input type="datetime-local" value={draft.eventAt ? draft.eventAt.slice(0, 16) : ''} onChange={(event) => set('eventAt', event.target.value ? new Date(event.target.value).toISOString() : null)} /></label>
              </div>
              <label>Severity rationale (required unless Unassessed)<textarea rows={2} value={draft.severityRationale} onChange={(event) => set('severityRationale', event.target.value)} /></label>
              <div><span className="meta-label">Countries</span><CountryPicker value={draft.countryCodes} onChange={(codes) => set('countryCodes', codes)} options={realCountries} /></div>
              <div className="ws-form-actions">
                <button type="submit" className="outline-button">Save changes</button>
                <button type="button" className="ghost-button" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <>
              <div className="facts-grid">
                <div><span className="meta-label">Incident ID</span><strong>{incident.id}</strong></div>
                <div><span className="meta-label">Event time</span><strong>{incident.eventAt ? fmt(incident.eventAt) : 'not recorded'}</strong></div>
                <div><span className="meta-label">Countries</span><strong>{incident.countries.map((c) => c.name).join(', ') || 'not set'}</strong></div>
                <div><span className="meta-label">Location</span><strong>{incident.locationText || 'not recorded'}</strong></div>
                <div><span className="meta-label">Coordinates</span><strong>{incident.lat !== null && incident.lng !== null ? `${incident.lat.toFixed(3)}, ${incident.lng.toFixed(3)}` : 'not recorded'}</strong></div>
                <div>
                  <span className="meta-label">Status</span>
                  <select aria-label="Incident status" value={incident.status} onChange={(event) => void run(() => wsFetch('PATCH', `/incidents/${id}`, { status: event.target.value as IncidentStatus }))}>
                    {INCIDENT_STATUSES.map((status) => <option key={status}>{status}</option>)}
                  </select>
                  {incident.status === 'Closed' && <small>Closed {fmt(incident.closedAt)}. Choose another status to reopen.</small>}
                  {incident.reopenedCount > 0 && <small>Reopened {incident.reopenedCount}×</small>}
                </div>
                <div><span className="meta-label">Owner</span><strong>{incident.owner ?? 'unassigned'}</strong></div>
                <div><span className="meta-label">Confidence</span><strong>{incident.confidence}</strong></div>
                <div><span className="meta-label">Category</span><strong>{incident.category || 'not set'}</strong></div>
                <div><span className="meta-label">Created / updated</span><strong>{fmt(incident.createdAt)} / {fmt(incident.updatedAt)}</strong></div>
              </div>
              <div className="detail-block"><h4>Description</h4><p>{incident.summary || 'No summary recorded.'}</p></div>
              <div className="detail-block"><h4>Severity rationale</h4><p>{incident.severityRationale || 'No rationale recorded.'}</p></div>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-header"><h3>Impact assessment</h3></div>
          <div className="impact-stack">
            {incident.impacts.length === 0 && <p className="muted-note">No impacts assessed yet.</p>}
            {incident.impacts.map((entry) => (
              <div key={entry.id}>
                <span className="meta-label">{entry.area} impact</span>
                <p>{entry.text}</p>
                <small>{entry.author}, {fmt(entry.createdAt)} <button className="ghost-button small" onClick={() => void run(() => wsFetch('DELETE', `/incidents/${id}/impacts/${entry.id}`))}>Remove</button></small>
              </div>
            ))}
          </div>
          <form className="ws-inline-form" onSubmit={(event) => { event.preventDefault(); void run(() => wsFetch('POST', `/incidents/${id}/impacts`, impact), () => setImpact({ ...impact, text: '' })); }}>
            <select aria-label="Impact area" value={impact.area} onChange={(event) => setImpact({ ...impact, area: event.target.value })}>{IMPACT_AREAS.map((area) => <option key={area}>{area}</option>)}</select>
            <input aria-label="Impact description" placeholder="Describe the impact" value={impact.text} onChange={(event) => setImpact({ ...impact, text: event.target.value })} />
            <button className="outline-button small" disabled={!impact.text.trim()}>Add impact</button>
          </form>

          <div className="detail-block">
            <h4>Affected sites, suppliers and routes</h4>
            {incident.assets.length === 0 && <p className="muted-note">None recorded.</p>}
            <ul className="ws-plain-list">{incident.assets.map((entry) => (
              <li key={entry.id}><span className="chip">{entry.kind}</span> <strong>{entry.name}</strong>{entry.notes ? ` — ${entry.notes}` : ''} <button className="ghost-button small" onClick={() => void run(() => wsFetch('DELETE', `/incidents/${id}/assets/${entry.id}`))}>Remove</button></li>
            ))}</ul>
            <form className="ws-inline-form" onSubmit={(event) => { event.preventDefault(); void run(() => wsFetch('POST', `/incidents/${id}/assets`, { ...asset, countryCode: incident.countries[0]?.code ?? null }), () => setAsset({ ...asset, name: '', notes: '' })); }}>
              <select aria-label="Asset type" value={asset.kind} onChange={(event) => setAsset({ ...asset, kind: event.target.value })}>{ASSET_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select>
              <input aria-label="Asset name" placeholder="Name" value={asset.name} onChange={(event) => setAsset({ ...asset, name: event.target.value })} />
              <input aria-label="Asset notes" placeholder="Notes (optional)" value={asset.notes} onChange={(event) => setAsset({ ...asset, notes: event.target.value })} />
              <button className="outline-button small" disabled={!asset.name.trim()}>Add</button>
            </form>
          </div>
        </div>
      </div>

      <div className="incident-layout">
        <div className="panel">
          <div className="panel-header"><h3>Evidence ({incident.evidence.length})</h3></div>
          {incident.evidence.length === 0 && <p className="muted-note">No reports linked. Use “Add to existing incident” on a feed item.</p>}
          <ul className="ws-evidence">{incident.evidence.map((link) => (
            <li key={link.articleId}>
              <a href={link.url} target="_blank" rel="noreferrer">{link.headline}</a>
              <small>{link.source} · published {fmt(link.publishedAt)} · retrieved {link.retrievedAt ? fmt(link.retrievedAt) : 'record no longer stored'}{link.severity ? ` · feed severity ${link.severity}` : ''} · linked by {link.linkedBy} on {fmt(link.linkedAt)}</small>
              <button className="ghost-button small" onClick={() => void run(() => wsFetch('DELETE', `/incidents/${id}/reports/${encodeURIComponent(link.articleId)}`))}>Unlink</button>
            </li>
          ))}</ul>

          <div className="detail-block">
            <h4>Suggested reports for review</h4>
            <p className="muted-note">{suggestions.data?.basis ?? 'Looking for related new reports…'}</p>
            {suggestions.data && suggestions.data.items.length === 0 && <p className="muted-note">No new related reports.</p>}
            <ul className="ws-evidence">{suggestions.data?.items.map((entry) => (
              <li key={entry.articleId}>
                <a href={entry.url} target="_blank" rel="noreferrer">{entry.headline}</a>
                <small>{entry.source} · published {fmt(entry.publishedAt)} · {entry.reasons.join('; ')}</small>
                <span>
                  <button className="outline-button small" onClick={() => void run(() => wsFetch('POST', `/incidents/${id}/reports`, { articleIds: [entry.articleId] }))}>Link as evidence</button>
                  <button className="ghost-button small" onClick={() => void run(() => wsFetch('POST', `/incidents/${id}/suggestions/dismiss`, { articleId: entry.articleId }))}>Dismiss</button>
                </span>
              </li>
            ))}</ul>
          </div>

          {duplicates.data && duplicates.data.items.length > 0 && (
            <div className="detail-block ws-duplicates">
              <h4>Possible duplicate incidents</h4>
              <p className="muted-note">{duplicates.data.basis}</p>
              {duplicates.data.items.map((entry) => (
                <div key={entry.id} className="ws-row">
                  <span><strong>{entry.id}</strong> {entry.title}<small>{entry.reasons.join('; ')}</small></span>
                  <button className="outline-button small" onClick={() => onNavigate('Incidents', entry.id)}>Open</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-header"><h3>Actions ({openActions.length} open)</h3></div>
          {incident.actions.length === 0 && <p className="muted-note">No actions yet.</p>}
          <ul className="ws-actions">{incident.actions.map((entry) => {
            const overdue = entry.status === 'Open' && entry.dueDate !== null && entry.dueDate < new Date().toISOString().slice(0, 10);
            return (
              <li key={entry.id} className={entry.status === 'Done' ? 'done' : ''}>
                <label>
                  <input type="checkbox" checked={entry.status === 'Done'} onChange={(event) => void run(() => wsFetch('PATCH', `/incidents/${id}/actions/${entry.id}`, { status: event.target.checked ? 'Done' : 'Open' }))} />
                  <span>{entry.text}</span>
                </label>
                <small>Owner: {entry.owner ?? 'unassigned'} · Due: {entry.dueDate ?? 'no deadline'}{overdue ? ' (overdue)' : ''}{entry.completedAt ? ` · Completed ${fmt(entry.completedAt)}` : ''}</small>
                <button className="ghost-button small" onClick={() => void run(() => wsFetch('DELETE', `/incidents/${id}/actions/${entry.id}`))}>Remove</button>
              </li>
            );
          })}</ul>
          <form className="ws-inline-form" onSubmit={(event) => { event.preventDefault(); void run(() => wsFetch('POST', `/incidents/${id}/actions`, { text: action.text, owner: action.owner || null, dueDate: action.dueDate || null }), () => setAction({ text: '', owner: '', dueDate: '' })); }}>
            <input aria-label="Action" placeholder="New action" value={action.text} onChange={(event) => setAction({ ...action, text: event.target.value })} />
            <input aria-label="Action owner" placeholder="Owner" value={action.owner} onChange={(event) => setAction({ ...action, owner: event.target.value })} />
            <input aria-label="Action deadline" type="date" value={action.dueDate} onChange={(event) => setAction({ ...action, dueDate: event.target.value })} />
            <button className="outline-button small" disabled={!action.text.trim()}>Add action</button>
          </form>
        </div>
      </div>

      <div className="panel timeline-panel">
        <div className="panel-header"><h3>Audit trail</h3></div>
        <div className="timeline-list">
          {incident.audit.map((entry) => (
            <div key={entry.id} className="timeline-item">
              <span className="timeline-dot" />
              <div><strong>{entry.detail}</strong><small>{fmt(entry.at)} · {entry.actor} · {entry.type}</small></div>
            </div>
          ))}
        </div>
        <p className="muted-note">Every entry records who made the change and when. Changes by an unnamed browser are attributed to that browser; set your name in the header to be named.</p>
      </div>
      {briefOpen && <BriefDialog incident={incident} onClose={() => setBriefOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ list

type ListFilters = { q: string; country: string; severity: string; status: string; owner: string; from: string; to: string };
const emptyFilters: ListFilters = { q: '', country: '', severity: '', status: '', owner: '', from: '', to: '' };

export function IncidentsModule({ focusId, onNavigate }: { focusId?: string; onNavigate: Navigate }) {
  const [filters, setFilters] = usePersistentState<ListFilters>('incident-filters', emptyFilters);
  const [selected, setSelected] = useState<string>(focusId ?? '');
  const [creating, setCreating] = useState(false);
  const { sources } = useSourceStatus();
  const now = useNow();
  useEffect(() => { if (focusId) setSelected(focusId); }, [focusId]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return `/incidents${params.toString() ? `?${params}` : ''}`;
  }, [filters]);
  const list = useWorkspaceData<{ items: IncidentSummary[]; total: number }>(query);
  const all = useWorkspaceData<{ items: IncidentSummary[]; total: number }>('/incidents');
  const owners = [...new Set((all.data?.items ?? []).map((incident) => incident.owner).filter((owner): owner is string => Boolean(owner)))].sort();
  const active = Object.values(filters).some(Boolean);

  if (selected) return <IncidentDetailView id={selected} onBack={() => setSelected('')} onNavigate={(view, id) => { if (view === 'Incidents' && id) setSelected(id); else onNavigate(view, id); }} />;

  const items = list.data?.items ?? [];
  const patch = (change: Partial<ListFilters>) => setFilters((current) => ({ ...current, ...change }));

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Incident analysis</div>
          <h2>Incident register</h2>
        </div>
        <div className="feed-heading-actions">
          <span className="status-pill neutral">{all.data ? `${list.data?.total ?? 0} of ${all.data.total}` : '…'} incidents</span>
          <button className="outline-button" onClick={() => setCreating(true)}>New incident</button>
        </div>
      </div>
      <DataStatus sources={sources} ids={SOURCE_IDS} now={now} />
      <section className="panel" aria-label="Incident list">
        <div className="indicator-filters">
          <label className="indicator-search"><span className="sr-only">Search incidents</span>
            <input type="search" placeholder="Search incidents by title, ID, location, owner…" value={filters.q} onChange={(event) => patch({ q: event.target.value })} />
          </label>
          <label className="filter-select"><span>Country</span>
            <select value={filters.country} onChange={(event) => patch({ country: event.target.value })}>
              <option value="">All</option>
              {realCountries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
            </select>
          </label>
          <label className="filter-select"><span>Severity</span>
            <select value={filters.severity} onChange={(event) => patch({ severity: event.target.value })}>
              <option value="">All</option>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="filter-select"><span>Status</span>
            <select value={filters.status} onChange={(event) => patch({ status: event.target.value })}>
              <option value="">All</option>{INCIDENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="filter-select"><span>Owner</span>
            <select value={filters.owner} onChange={(event) => patch({ owner: event.target.value })}>
              <option value="">All</option>{owners.map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="filter-select"><span>From</span><input type="date" value={filters.from} onChange={(event) => patch({ from: event.target.value })} /></label>
          <label className="filter-select"><span>To</span><input type="date" value={filters.to} onChange={(event) => patch({ to: event.target.value })} /></label>
          {active && <button className="ghost-button" onClick={() => setFilters(emptyFilters)}>Reset</button>}
        </div>
        {list.error && <Notice kind="error">Could not load incidents: {list.error} <button className="outline-button small" onClick={() => void list.reload()}>Retry</button></Notice>}
        {list.loading && !list.data && <div className="feed-empty" role="status">Loading incidents…</div>}
        {list.data && items.length === 0 && (
          <div className="feed-empty">
            {all.data && all.data.total === 0
              ? <p>No incidents yet. Open the Intelligence Feed and choose “Create incident” on a report, or start one here.</p>
              : <p>No incidents match these filters.</p>}
            {active && <button className="outline-button" onClick={() => setFilters(emptyFilters)}>Reset filters</button>}
          </div>
        )}
        {items.length > 0 && (
          <div className="ws-table" role="table" aria-label="Incidents">
            <div className="ws-table-head" role="row"><span>Incident</span><span>Countries</span><span>Severity</span><span>Status</span><span>Owner</span><span>Event / created</span><span>Reports</span></div>
            {items.map((incident) => (
              <button key={incident.id} role="row" className="ws-table-row" onClick={() => setSelected(incident.id)}>
                <span><strong>{incident.title}</strong><small>{incident.id}{incident.category ? ` · ${incident.category}` : ''}</small></span>
                <span>{incident.countries.map((c) => c.name).join(', ') || '—'}</span>
                <span><span className={sevClass(incident.severity)}>{incident.severity}</span></span>
                <span><Pill value={incident.status} /></span>
                <span>{incident.owner ?? 'unassigned'}</span>
                <span>{fmtDay(incident.eventAt ?? incident.createdAt)}</span>
                <span>{incident.reportCount}{incident.openActions > 0 ? ` · ${incident.openActions} open action${incident.openActions === 1 ? '' : 's'}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {creating && <NewIncidentDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); }} />}
    </div>
  );
}

function NewIncidentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title="New incident" onClose={onClose}>
      {error && <Notice kind="error">{error}</Notice>}
      <form className="ws-form" onSubmit={(event) => {
        event.preventDefault();
        wsFetch<IncidentDetail>('POST', '/incidents', { input: { title, summary } }).then((created) => onCreated(created.id)).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not create the incident.'));
      }}>
        <p className="muted-note">An incident without linked reports has no evidence yet. Link reports from the Intelligence Feed afterwards{getAnalystName() ? '' : '; set your name in the header so changes are attributed to you'}.</p>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label>Summary<textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <div className="ws-form-actions"><button className="outline-button" disabled={!title.trim()}>Create incident</button></div>
      </form>
    </Modal>
  );
}
