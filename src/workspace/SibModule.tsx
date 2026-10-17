import { useEffect, useMemo, useState } from 'react';
import { SEVERITIES } from '../data/feedTypes.ts';
import { getAnalystName, useWorkspaceData, wsFetch } from '../data/workspaceApi.ts';
import { sibDocument, sibFilename, sibMailto, sibToHtml, sibToText, type SibDocument } from '../data/sibExport.ts';
import {
  SIB_CLASSIFICATIONS, SIB_STATUSES, approvalBlockers,
  type SibDetail, type SibFields, type SibRecord, type SibSummary,
} from '../data/sibTypes.ts';
import type { CountryDirectoryEntry, IncidentSummary } from '../data/workspaceTypes.ts';
import { Modal, Notice, fmt, fmtDay, usePersistentState, type Navigate } from './shared.tsx';

const sevClass = (severity: string) => `badge sev-${severity.toLowerCase()}`;

type Form = Omit<SibFields, 'assets' | 'actions' | 'uncertainties' | 'nextReviewDate'> & { assets: string; actions: string; uncertainties: string; nextReviewDate: string };
const toForm = (sib: SibFields): Form => ({ ...sib, assets: sib.assets.join('\n'), actions: sib.actions.join('\n'), uncertainties: sib.uncertainties ?? '', nextReviewDate: sib.nextReviewDate ?? '' });
const lines = (value: string) => value.split('\n').map((entry) => entry.trim()).filter(Boolean);
const fromForm = (form: Form): SibFields => ({ ...form, assets: lines(form.assets), actions: lines(form.actions), uncertainties: form.uncertainties.trim(), nextReviewDate: form.nextReviewDate || null });
const pickFields = (sib: SibRecord): SibFields => ({
  title: sib.title, classification: sib.classification, severity: sib.severity, location: sib.location, summary: sib.summary, situation: sib.situation,
  employeeImpact: sib.employeeImpact, operationsImpact: sib.operationsImpact, assets: sib.assets, actions: sib.actions,
  uncertainties: sib.uncertainties ?? '', nextReviewDate: sib.nextReviewDate ?? null,
});

// ------------------------------------------------------------------ export helpers

function download(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Opens the browser's print dialog for the bulletin (choose "Save as PDF" there). No pop-up window is needed. */
function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc || !frame.contentWindow) { frame.remove(); return false; }
  doc.open(); doc.write(html); doc.close();
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 2000);
  }, 250);
  return true;
}

// ------------------------------------------------------------------ preview

export function SibPreview({ doc }: { doc: SibDocument }) {
  return (
    <article className="sbl-paper" aria-label="Bulletin preview">
      <div className="sbl-banner">{doc.banner}</div>
      {doc.draftNotice && <div className="sbl-draft">{doc.draftNotice}</div>}
      <h3 className="sbl-title">{doc.title}</h3>
      <dl className="sbl-meta">
        {doc.meta.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {doc.blocks.map((block) => (
        <section key={block.heading}>
          <h4>{block.heading}</h4>
          {block.kind === 'text' && block.text.split(/\n{2,}/).map((part, index) => <p key={index} className="sbl-text">{part}</p>)}
          {block.kind === 'list' && (block.ordered
            ? <ol>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ol>
            : <ul>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>)}
          {block.kind === 'sources' && (
            <ul className="sbl-sources">{block.items.map((item, index) => (
              <li key={index}>
                {item.url && /^https?:\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{item.headline}</a> : item.headline}
                <small>{item.source ?? 'source not recorded'} · {item.publishedAt ? fmtDay(item.publishedAt) : 'date not recorded'}</small>
              </li>
            ))}</ul>
          )}
        </section>
      ))}
      <p className="sbl-footer">{doc.footer}</p>
    </article>
  );
}

// ------------------------------------------------------------------ create dialog

type Start = { type: 'incident' | 'country'; id: string };

function NewSibDialog({ initial, onClose, onCreated }: { initial: Start | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [type, setType] = useState<'incident' | 'country'>(initial?.type ?? 'incident');
  const [choice, setChoice] = useState(initial?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const incidents = useWorkspaceData<{ items: IncidentSummary[] }>('/incidents');
  const countries = useWorkspaceData<{ items: CountryDirectoryEntry[] }>('/countries');
  const assessed = (countries.data?.items ?? []).filter((entry) => entry.assessedAt);
  const incidentItems = incidents.data?.items ?? [];

  async function create() {
    setBusy(true);
    setError('');
    try {
      const created = await wsFetch<SibDetail>('POST', '/sibs', { source: type === 'incident' ? { type, id: choice } : { type, code: choice } });
      onCreated(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the bulletin.');
      setBusy(false);
    }
  }

  return (
    <Modal title="New bulletin" onClose={onClose}>
      <p className="muted-note">A bulletin starts from a real record. Its text and source reports are copied in as a starting point that you can edit; nothing is written for you beyond what the record contains.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="ws-tabs" role="tablist">
        <button role="tab" aria-selected={type === 'incident'} className={type === 'incident' ? 'selected' : ''} onClick={() => { setType('incident'); setChoice(''); }}>From an incident</button>
        <button role="tab" aria-selected={type === 'country'} className={type === 'country' ? 'selected' : ''} onClick={() => { setType('country'); setChoice(''); }}>From a country assessment</button>
      </div>
      <div className="ws-form">
        {type === 'incident' ? (
          incidents.loading && !incidents.data ? <p role="status">Loading incidents…</p>
            : incidentItems.length === 0 ? <p>There are no incidents yet. Create one from a report in the Intelligence Feed, then come back.</p>
              : (
                <label>Incident
                  <select value={choice} onChange={(event) => setChoice(event.target.value)}>
                    <option value="">Choose an incident…</option>
                    {incidentItems.map((incident) => <option key={incident.id} value={incident.id}>{incident.title} ({incident.severity}, {incident.status})</option>)}
                  </select>
                </label>
              )
        ) : (
          countries.loading && !countries.data ? <p role="status">Loading countries…</p>
            : assessed.length === 0 ? <p>No country has a saved assessment yet. Save one in Country Assessments, then come back.</p>
              : (
                <label>Country with a saved assessment
                  <select value={choice} onChange={(event) => setChoice(event.target.value)}>
                    <option value="">Choose a country…</option>
                    {assessed.map((entry) => <option key={entry.code} value={entry.code}>{entry.name} (highest rating: {entry.highestRating})</option>)}
                  </select>
                </label>
              )
        )}
        <div className="ws-form-actions">
          <button className="outline-button" disabled={!choice || busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create draft'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ detail

function SibDetailView({ id, onBack, onNavigate }: { id: string; onBack: () => void; onNavigate: Navigate }) {
  const detail = useWorkspaceData<SibDetail>(`/sibs/${id}`);
  const sib = detail.data;
  const [form, setForm] = useState<Form | null>(null);
  const [loadedStamp, setLoadedStamp] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const saved = useMemo(() => (sib ? toForm(pickFields(sib)) : null), [sib]);
  const dirty = Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(saved));

  // Take the stored version in when it changes, unless there are unsaved edits.
  useEffect(() => {
    if (!sib || !saved) return;
    const stamp = `${sib.id}:${sib.updatedAt}`;
    if (stamp !== loadedStamp && (!dirty || !form)) { setForm(saved); setLoadedStamp(stamp); }
  }, [sib, saved, loadedStamp, dirty, form]);

  if (detail.error && !sib) return <div className="module-view"><Notice kind="error">{detail.error}</Notice><button className="outline-button" onClick={onBack}>Back to bulletins</button></div>;
  if (!sib || !form) return <div className="module-view"><p role="status">Loading bulletin…</p></div>;

  const locked = sib.status === 'Approved';
  const working: SibRecord = { ...sib, ...fromForm(form) };
  const blockers = approvalBlockers({ ...fromForm(form), evidence: sib.evidence, ai: sib.ai });
  const savedDoc = sibDocument(sib, new Date().toISOString());
  const previewDoc = sibDocument(working, new Date().toISOString());
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await detail.reload();
      if (done) setMessage(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(() => wsFetch('PATCH', `/sibs/${id}`, fromForm(form)), 'Draft saved.');
  const exportName = (extension: string) => sibFilename(sib, extension);

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow"><button className="ghost-button small" onClick={onBack}>← All bulletins</button> Security information bulletin</div>
          <h2>{sib.title || 'Untitled bulletin'}</h2>
        </div>
        <div className="feed-heading-actions">
          <span className={`badge ${locked ? 'success' : 'warning'}`}>{locked ? `Approved · revision ${sib.revision}` : 'Draft'}</span>
          {locked
            ? <button className="outline-button" disabled={busy} onClick={() => void run(() => wsFetch('POST', `/sibs/${id}/reopen`, {}), 'Reopened as a draft. The earlier approval no longer applies.')}>Reopen as draft</button>
            : (
              <>
                <button className="outline-button" disabled={!dirty || busy} onClick={() => void save()}>Save draft</button>
                <button className="ghost-button" disabled={dirty || busy || blockers.length > 0} title={dirty ? 'Save your changes first.' : blockers[0]} onClick={() => void run(() => wsFetch('POST', `/sibs/${id}/approve`, {}), 'Approved.')}>Approve</button>
              </>
            )}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {detail.error && <Notice kind="stale">Could not refresh: {detail.error}. Showing the version loaded at {fmt(detail.lastLoadedAt)}.</Notice>}
      {sib.sourceState === 'changed' && (
        <Notice kind="stale">
          The {sib.source.type === 'incident' ? 'incident' : 'country assessment'} this bulletin is based on has changed since the draft was taken ({fmt(sib.snapshotAt)}). The text below was not updated.
          {!locked && <> <button className="outline-button small" disabled={busy} onClick={() => void run(() => wsFetch('POST', `/sibs/${id}/refresh-sources`, {}), 'Source reports replaced with the current ones. The text was not changed; review it.')}>Replace source reports with the current ones</button></>}
        </Notice>
      )}
      {sib.sourceState === 'missing' && <Notice kind="stale">The record this bulletin was based on no longer exists. The saved text and source reports are kept as they were.</Notice>}
      {locked && <Notice>This bulletin is approved and locked. Reopen it as a draft to change it.</Notice>}
      {sib.ai && (
        <Notice kind="stale">
          <strong>Drafted with AI.</strong> {sib.ai.model}{sib.ai.modelDigest ? ` (${sib.ai.modelDigest})` : ''} wrote this draft on {fmt(sib.ai.generatedAt)} from {sib.ai.recordIds.length} saved record{sib.ai.recordIds.length === 1 ? '' : 's'}. Every [number] in the text refers to the source list below. Check the facts against those sources, edit the text, and review the uncertainties before approving.
          {sib.ai.confirmedBy
            ? <> Reviewed and confirmed by {sib.ai.confirmedBy} on {fmt(sib.ai.confirmedAt)}.</>
            : !locked && <> <button className="outline-button small" disabled={busy || dirty || !getAnalystName()} title={!getAnalystName() ? 'Set your analyst name first (top right).' : dirty ? 'Save your changes first.' : undefined} onClick={() => void run(() => wsFetch('POST', `/sibs/${id}/confirm-ai`, {}), 'Confirmed as reviewed.')}>I have reviewed this draft</button></>}
          {!locked && !sib.ai.confirmedBy && !getAnalystName() && <div className="muted-note">Confirming records your name, so set it first from the round button at the top right.</div>}
        </Notice>
      )}
      {!locked && blockers.length > 0 && (
        <Notice>Before it can be approved: {blockers.join(' ')}</Notice>
      )}

      <div className="sbl-editor-layout">
        <div className="panel form-panel">
          <div className="panel-header">
            <h3>Bulletin record</h3>
            <span className="muted-note">{dirty ? 'Unsaved changes' : `Saved ${fmt(sib.updatedAt)}`}</span>
          </div>
          <form className="ws-form" onSubmit={(event) => { event.preventDefault(); if (!locked && dirty) void save(); }}>
            <fieldset disabled={locked || busy} className="sbl-fieldset">
              <div className="ws-form-grid">
                <label className="wide">Title<input value={form.title} maxLength={200} onChange={(event) => set('title', event.target.value)} /></label>
                <label>Classification
                  <select value={form.classification} onChange={(event) => set('classification', event.target.value as Form['classification'])}>
                    {SIB_CLASSIFICATIONS.map((value) => <option key={value}>{value}</option>)}
                  </select>
                </label>
                <label>Severity
                  <select value={form.severity} onChange={(event) => set('severity', event.target.value as Form['severity'])}>
                    {SEVERITIES.map((value) => <option key={value}>{value}</option>)}
                  </select>
                </label>
                <label className="wide">Location<input value={form.location} maxLength={200} onChange={(event) => set('location', event.target.value)} /></label>
                <label className="wide">Executive summary<textarea rows={4} value={form.summary} maxLength={4000} onChange={(event) => set('summary', event.target.value)} /></label>
                <label className="wide">Current situation<textarea rows={7} value={form.situation} maxLength={8000} onChange={(event) => set('situation', event.target.value)} /></label>
                <label className="wide">Impact on employees<textarea rows={3} value={form.employeeImpact} maxLength={4000} placeholder="Not recorded by the source. Write it, or leave it empty to omit the section." onChange={(event) => set('employeeImpact', event.target.value)} /></label>
                <label className="wide">Impact on operations<textarea rows={3} value={form.operationsImpact} maxLength={4000} onChange={(event) => set('operationsImpact', event.target.value)} /></label>
                <label className="wide">Affected assets and locations (one per line)<textarea rows={3} value={form.assets} onChange={(event) => set('assets', event.target.value)} /></label>
                <label className="wide">Recommended actions (one per line)<textarea rows={4} value={form.actions} onChange={(event) => set('actions', event.target.value)} /></label>
                <label className="wide">Uncertainties and information gaps<textarea rows={3} value={form.uncertainties} maxLength={3000} placeholder="What is not known, or reported by only one source." onChange={(event) => set('uncertainties', event.target.value)} /></label>
                <label>Next review date<input type="date" value={form.nextReviewDate} onChange={(event) => set('nextReviewDate', event.target.value)} /></label>
              </div>
            </fieldset>
          </form>

          <h4 className="sbl-subhead">Based on</h4>
          <p>
            {sib.source.label}{' '}
            {sib.source.type === 'reports'
              ? <button className="ghost-button small" onClick={() => onNavigate('Intelligence Feed')}>Open the feed</button>
              : <button className="ghost-button small" onClick={() => (sib.source.type === 'incident' ? onNavigate('Incidents', sib.source.id) : onNavigate('Country Assessments', (sib.source as { code: string }).code))}>
                Open {sib.source.type === 'incident' ? 'incident' : 'assessment'}
              </button>}
          </p>
          <h4 className="sbl-subhead">Source reports ({sib.evidence.length})</h4>
          {sib.evidence.length === 0 ? <p className="muted-note">None attached.</p> : (
            <ul className="ws-evidence">{sib.evidence.map((item, index) => (
              <li key={index}>
                {item.url && /^https?:\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{item.headline}</a> : <span>{item.headline}</span>}
                <small>{item.source ?? 'source not recorded'} · published {item.publishedAt ? fmtDay(item.publishedAt) : 'date not recorded'}</small>
              </li>
            ))}</ul>
          )}
          <p className="muted-note">Source reports were copied from the record on {fmt(sib.snapshotAt)}. Approval records the analyst name set in this browser; there are no user accounts, so it is a record of who approved, not a verified sign-off.</p>

          <details className="sbl-audit">
            <summary>Audit trail ({sib.audit.length})</summary>
            <ul className="ws-plain-list">{sib.audit.map((entry) => <li key={entry.id}><strong>{entry.type}</strong> · {entry.actor} · {fmt(entry.at)}<br /><small>{entry.detail}</small></li>)}</ul>
          </details>
          {!locked && (
            <div className="ws-form-actions">
              <button className="ghost-button" disabled={busy} onClick={() => { if (window.confirm('Delete this draft bulletin? This cannot be undone.')) { setBusy(true); wsFetch('DELETE', `/sibs/${id}`).then(onBack).catch((caught) => { setError(caught instanceof Error ? caught.message : 'Could not delete the draft.'); setBusy(false); }); } }}>Delete draft</button>
            </div>
          )}
        </div>

        <div className="panel sbl-preview-panel">
          <div className="panel-header">
            <h3>Preview</h3>
            <span className={sevClass(working.severity)}>{working.severity}</span>
          </div>
          <SibPreview doc={previewDoc} />
          <div className="sbl-exports no-print" role="group" aria-label="Export">
            <button className="outline-button small" disabled={dirty} title={dirty ? 'Save your changes first.' : undefined}
              onClick={() => { if (!printHtml(sibToHtml(savedDoc))) setError('The print dialog could not be opened in this browser.'); }}>PDF (print)</button>
            <button className="outline-button small" disabled={dirty} onClick={() => download(exportName('doc'), 'application/msword', sibToHtml(savedDoc, { word: true }))}>Word (.doc)</button>
            <button className="outline-button small" disabled={dirty} onClick={() => download(exportName('html'), 'text/html', sibToHtml(savedDoc))}>HTML</button>
            <a className={`outline-button small ${dirty ? 'disabled' : ''}`} aria-disabled={dirty} href={dirty ? undefined : sibMailto(savedDoc)}>Email</a>
            <button className="outline-button small" disabled={dirty} onClick={() => { void navigator.clipboard?.writeText(sibToText(savedDoc)).then(() => setMessage('Bulletin text copied.'), () => setError('The text could not be copied.')); }}>Copy text</button>
          </div>
          <p className="muted-note">PDF opens your browser's print dialog: choose “Save as PDF”. The Word file opens in Word as an editable document. Email opens your mail program with a shortened text version. {locked ? '' : 'Drafts are marked “not approved” in every export.'}</p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ list

type ListFilters = { q: string; status: string; severity: string };
const emptyFilters: ListFilters = { q: '', status: '', severity: '' };

export function SibModule({ focusId, onNavigate }: { focusId?: string; onNavigate: Navigate }) {
  const [selected, setSelected] = useState(focusId?.startsWith('SIB-') ? focusId : '');
  const [creating, setCreating] = useState<Start | 'blank' | null>(null);
  const [filters, setFilters] = usePersistentState<ListFilters>('sbl-filters', emptyFilters);
  const list = useWorkspaceData<{ items: SibSummary[]; total: number }>('/sibs');

  useEffect(() => {
    if (!focusId) return;
    if (focusId.startsWith('SIB-')) setSelected(focusId);
    else if (focusId.startsWith('incident:')) setCreating({ type: 'incident', id: focusId.slice('incident:'.length) });
    else if (focusId.startsWith('country:')) setCreating({ type: 'country', id: focusId.slice('country:'.length) });
  }, [focusId]);

  if (selected) return <SibDetailView id={selected} onBack={() => { setSelected(''); void list.reload(); }} onNavigate={onNavigate} />;

  const all = list.data?.items ?? [];
  const items = all.filter((item) => {
    if (filters.status && item.status !== filters.status) return false;
    if (filters.severity && item.severity !== filters.severity) return false;
    const q = filters.q.trim().toLowerCase();
    return !q || `${item.title} ${item.id} ${item.source.label}`.toLowerCase().includes(q);
  });
  const active = Object.values(filters).some(Boolean);

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Security information bulletin</div>
          <h2>SIBs</h2>
        </div>
        <div className="feed-heading-actions">
          <span className="status-pill neutral">{all.length} bulletin{all.length === 1 ? '' : 's'}</span>
          <button className="outline-button" onClick={() => setCreating('blank')}>New bulletin</button>
        </div>
      </div>
      <section className="panel" aria-label="Bulletin list">
        <div className="indicator-filters">
          <label className="indicator-search"><span className="sr-only">Search bulletins</span>
            <input type="search" placeholder="Search bulletins by title, reference or source…" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} />
          </label>
          <label className="filter-select"><span>Status</span>
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">All</option>{SIB_STATUSES.map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
          <label className="filter-select"><span>Severity</span>
            <select value={filters.severity} onChange={(event) => setFilters({ ...filters, severity: event.target.value })}>
              <option value="">All</option>{SEVERITIES.map((severity) => <option key={severity}>{severity}</option>)}
            </select>
          </label>
          {active && <button className="ghost-button" onClick={() => setFilters(emptyFilters)}>Reset</button>}
        </div>
        {list.error && <Notice kind="error">Could not load bulletins: {list.error} <button className="outline-button small" onClick={() => void list.reload()}>Retry</button></Notice>}
        {list.loading && !list.data && <div className="feed-empty" role="status">Loading bulletins…</div>}
        {list.data && items.length === 0 && (
          <div className="feed-empty">
            {all.length === 0
              ? <p>No bulletins yet. Choose “New bulletin” to draft one from an incident or a country assessment. Each bulletin is built from a real record and keeps its source reports.</p>
              : <p>No bulletins match these filters.</p>}
            {active && <button className="outline-button" onClick={() => setFilters(emptyFilters)}>Reset filters</button>}
          </div>
        )}
        {items.length > 0 && (
          <div className="ws-table sbl-table" role="table" aria-label="Bulletins">
            <div className="ws-table-head" role="row"><span>Bulletin</span><span>Severity</span><span>Classification</span><span>Status</span><span>Based on</span><span>Updated</span></div>
            {items.map((item) => (
              <button key={item.id} role="row" className="ws-table-row" onClick={() => setSelected(item.id)}>
                <span><strong>{item.title || 'Untitled bulletin'}</strong><small>{item.id}</small></span>
                <span><span className={sevClass(item.severity)}>{item.severity}</span></span>
                <span>{item.classification}</span>
                <span><span className={`badge ${item.status === 'Approved' ? 'success' : 'warning'}`}>{item.status === 'Approved' ? `Approved · r${item.revision}` : 'Draft'}</span></span>
                <span>{item.source.label}</span>
                <span>{fmtDay(item.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {creating && <NewSibDialog initial={creating === 'blank' ? null : creating} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); setSelected(id); }} />}
    </div>
  );
}
