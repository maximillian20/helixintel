import { useEffect, useState } from 'react';
import { aiFetch, useAiRun, useAiStatus } from '../data/aiApi.ts';
import type { AiAnswerDto, EnrichmentView, MapQueryResult, RelatedSuggestion } from '../data/aiTypes.ts';
import { DEPTH_LABELS } from '../data/aiTypes.ts';
import { AiStatusBanner, AnswerView, ErrorNote } from './aiParts.tsx';
import { Notice, Pill, fmt, type Navigate } from './shared.tsx';

type DraftSource = { type: 'incident'; id: string } | { type: 'country'; code: string } | { type: 'reports'; ids: string[] };

/** "Draft bulletin with AI": creates a NEW draft SIB. Nothing is approved or sent; the analyst opens the draft to review it. */
export function DraftBulletinButton({ source, onNavigate, small, label }: { source: DraftSource; onNavigate: Navigate; small?: boolean; label?: string }) {
  const { status, ready: statusReady } = useAiStatus();
  const blockedByPrivacy = source.type !== 'reports' && status?.privateRecords === false;
  const ready = statusReady && !blockedByPrivacy;
  const { error, running, run, cancel } = useAiRun<{ sibId: string; message: string }>();
  return (
    <span className="ai-inline">
      {!running && (
        <button className={`outline-button${small ? ' small' : ''}`} disabled={!ready} title={blockedByPrivacy ? 'Off: this would send private records to a third-party AI service.' : ready ? 'Creates a new draft bulletin from the saved records. Nothing is approved or sent.' : 'AI setup required'}
          onClick={async () => { const result = await run('POST', '/sibs', { source }); if (result) onNavigate('SIBs', result.sibId); }}>
          {label ?? 'Draft bulletin with AI'}
        </button>
      )}
      {running && <button className="outline-button small" onClick={cancel}>Cancel drafting</button>}
      {running && <span className="muted-note" role="status">Drafting from the saved records…</span>}
      <ErrorNote error={error} />
    </span>
  );
}

const kindText: Record<RelatedSuggestion['kind'], string> = {
  'repeated-reporting': 'Repeated reporting (not independent)',
  'independent-corroboration': 'Possible independent corroboration',
  'possibly-related': 'Possibly related',
};

/** AI summary, translation, related-report suggestions and bulletin drafting for one feed report. */
export function ReportAiPanel({ articleId, onNavigate }: { articleId: string; onNavigate: Navigate }) {
  const { status, ready, reload } = useAiStatus();
  const [view, setView] = useState<EnrichmentView | null>(null);
  const [related, setRelated] = useState<RelatedSuggestion[] | null>(null);
  const [relatedError, setRelatedError] = useState('');
  const { error, running, run, cancel } = useAiRun<EnrichmentView>();

  useEffect(() => {
    setView(null); setRelated(null); setRelatedError('');
    let active = true;
    aiFetch<{ items: Record<string, EnrichmentView> }>('GET', `/enrichment?ids=${encodeURIComponent(articleId)}`).then((r) => { if (active) setView(r.items[articleId] ?? null); }).catch(() => undefined);
    return () => { active = false; };
  }, [articleId]);

  async function summarise(force = false) {
    const result = await run('POST', '/enrich', { articleId, force });
    if (result) setView(result); else void reload();
  }
  async function setDismissed(dismissed: boolean) {
    try { await aiFetch('POST', '/enrichment/dismiss', { articleId, dismissed }); setView((v) => (v ? { ...v, dismissed } : v)); } catch { /* shown on next load */ }
  }
  async function findRelated() {
    setRelatedError('');
    try { setRelated((await aiFetch<{ items: RelatedSuggestion[] }>('GET', `/related?articleId=${encodeURIComponent(articleId)}`)).items); } catch (caught) { setRelatedError(caught instanceof Error ? caught.message : 'Could not look for related reports.'); }
  }
  async function hideRelated(item: RelatedSuggestion) {
    try { await aiFetch('POST', '/related/dismiss', { subject: `report:${articleId}`, target: item.id }); setRelated((list) => list?.filter((entry) => entry.id !== item.id) ?? null); } catch { /* keep listed */ }
  }

  return (
    <section className="ai-panel" aria-label="AI assistance">
      <div className="ai-panel-head"><strong>AI assistance</strong><span className="badge warning">Draft only</span></div>
      {status && status.state !== 'ready' && <AiStatusBanner status={status} compact />}
      {view && !view.dismissed && (
        <div className="ai-summary">
          <p>{view.summary}</p>
          {view.translatedFrom && <small className="muted-note">Translated from {view.translatedFrom.toUpperCase()}. The original headline above is unchanged.</small>}
          {view.keyFacts.length > 0 && <ul>{view.keyFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
          <dl className="ai-facts">
            {view.category && <div><dt>Type (AI)</dt><dd>{view.category}</dd></div>}
            {view.countries.length > 0 && <div><dt>Countries named</dt><dd>{view.countries.map((c) => c.name).join(', ')}</dd></div>}
            {view.organisations.length > 0 && <div><dt>Organisations named</dt><dd>{view.organisations.join(', ')}</dd></div>}
            {view.eventDate && <div><dt>Event date (AI)</dt><dd>{view.eventDate}</dd></div>}
            <div><dt>Severity in the feed</dt><dd><Pill value={view.feedSeverity} /> {view.feedSeverityIsOverride ? '(your correction)' : '(rules-based)'}</dd></div>
            <div><dt>AI suggestion</dt><dd><Pill value={view.suggestedSeverity} /> <small className="muted-note">suggestion only, never applied automatically. {view.severityRationale}</small></dd></div>
          </dl>
          <small className="muted-note">Based on: {DEPTH_LABELS[view.depth]}. Written by {view.meta.model} on {fmt(view.meta.generatedAt)}.</small>
          {view.outdated && <Notice kind="stale">The report changed after this summary was written. Regenerate it.</Notice>}
        </div>
      )}
      {view?.dismissed && <p className="muted-note">AI summary hidden for you. <button className="link-button" onClick={() => void setDismissed(false)}>Show it again</button></p>}
      <div className="feed-detail-actions">
        {!running && <button className="outline-button small" disabled={!ready} title={ready ? undefined : 'AI setup required'} onClick={() => void summarise(Boolean(view))}>{view ? 'Regenerate AI summary' : 'Summarise with AI'}</button>}
        {running && <button className="outline-button small" onClick={cancel}>Cancel</button>}
        {view && !view.dismissed && <button className="ghost-button small" onClick={() => void setDismissed(true)}>Dismiss summary</button>}
        <button className="ghost-button small" onClick={() => void findRelated()}>Find related reports</button>
        <DraftBulletinButton source={{ type: 'reports', ids: [articleId] }} onNavigate={onNavigate} small />
      </div>
      <ErrorNote error={error} />
      {relatedError && <Notice kind="error">{relatedError}</Notice>}
      {related && (
        <div className="ai-related">
          <h4>Possibly related <small className="muted-note">(matched by country, time, event type, names and wording; nothing is merged or linked)</small></h4>
          {related.length === 0 && <p className="muted-note">No related reports or incidents found.</p>}
          <ul>
            {related.map((item) => (
              <li key={item.id}>
                <span className={`badge ${item.kind === 'independent-corroboration' ? 'success' : 'neutral'}`}>{kindText[item.kind]}</span>
                <div>{item.target.title}</div>
                <small className="muted-note">{item.target.source ? `${item.target.source} · ` : ''}{item.target.publishedAt ? fmt(item.target.publishedAt) : ''}</small>
                <small className="muted-note">{item.reasons.join('; ')}.</small>
                <small className="muted-note">{item.independence}</small>
                <span className="ai-inline">
                  {item.target.type === 'incident' && <button className="link-button" onClick={() => onNavigate('Incidents', item.target.id)}>Open incident</button>}
                  {item.target.url && <a href={item.target.url} target="_blank" rel="noreferrer noopener">Open source</a>}
                  <button className="link-button" onClick={() => void hideRelated(item)}>Not related</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Generic "explain with AI" panel for incidents, country assessments, indicators and market events. */
export function AiExplain({ title, path, body, label, onNavigate, children, hint, needsPrivate }: {
  title: string; path: string; body?: Record<string, unknown>; label?: string; onNavigate: Navigate; children?: React.ReactNode; hint?: string; needsPrivate?: boolean;
}) {
  const { status, ready: statusReady, reload } = useAiStatus();
  const blocked = Boolean(needsPrivate) && status?.privateRecords === false;
  const ready = statusReady && !blocked;
  const { data, error, running, run, cancel } = useAiRun<AiAnswerDto>();
  return (
    <section className="ai-panel" aria-label={title}>
      <div className="ai-panel-head"><strong>{title}</strong><span className="badge warning">Draft only</span></div>
      {hint && <p className="muted-note">{hint}</p>}
      {status && status.state !== 'ready' && <AiStatusBanner status={status} compact />}
      {blocked && <Notice kind="stale">This assistant reads your private records. They are not sent to a third-party AI service. Use a model on your own computer, or set AI_ALLOW_PRIVATE_RECORDS=1 on the server if you accept sending them (docs/AI.md).</Notice>}
      <div className="feed-detail-actions">
        {!running && <button className="outline-button small" disabled={!ready} title={ready ? undefined : blocked ? 'Private records are not sent to this AI service' : 'AI setup required'} onClick={async () => { if (!(await run('POST', path, { ...(body ?? {}), refresh: data ? true : undefined }))) void reload(); }}>{data ? 'Regenerate' : label ?? 'Explain with AI'}</button>}
        {running && <button className="outline-button small" onClick={cancel}>Cancel</button>}
        {running && <span className="muted-note" role="status">Working on your computer's model…</span>}
        {children}
      </div>
      <ErrorNote error={error} />
      {data && <AnswerView answer={data} onNavigate={onNavigate} />}
    </section>
  );
}

/** Plain-language map filters. The result is a checked filter object, shown for confirmation before it is applied. */
export function MapAiSearch({ onApply }: { onApply: (result: MapQueryResult) => void }) {
  const [text, setText] = useState('');
  const { data, error, running, run } = useAiRun<MapQueryResult>();
  return (
    <form className="ai-map-search" onSubmit={async (event) => { event.preventDefault(); const result = await run('POST', '/map/query', { text }); if (result) onApply(result); }}>
      <label className="sr-only" htmlFor="ai-map-text">Describe what to show on the map</label>
      <input id="ai-map-text" value={text} maxLength={240} placeholder="Describe what to show, e.g. high-severity maritime reports from the last 7 days" onChange={(event) => setText(event.target.value)} />
      <button className="outline-button small" disabled={running || text.trim().length < 2}>Apply</button>
      <ErrorNote error={error} />
      {data && (
        <div className="muted-note ai-map-explain" role="status">
          Applied {data.method === 'rules' ? 'by simple rules' : 'with AI help (check it)'}: {data.understood.length > 0 ? data.understood.join('; ') : 'nothing recognised'}.
          {data.ignored.length > 0 && <> Not applied: {data.ignored.join('; ')}.</>}
        </div>
      )}
    </form>
  );
}

/** Reports that look related to an incident (computed by code; nothing is linked until the analyst does it). */
export function IncidentRelatedReports({ incidentId, onNavigate }: { incidentId: string; onNavigate: Navigate }) {
  const [items, setItems] = useState<RelatedSuggestion[] | null>(null);
  const [error, setError] = useState('');
  async function load() {
    setError('');
    try { setItems((await aiFetch<{ items: RelatedSuggestion[] }>('GET', `/related?incidentId=${encodeURIComponent(incidentId)}`)).items); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not look for related reports.'); }
  }
  return (
    <div className="ai-related">
      <button className="ghost-button small" onClick={() => void load()}>Find related reports</button>
      {error && <Notice kind="error">{error}</Notice>}
      {items && items.length === 0 && <p className="muted-note">No unlinked reports look related.</p>}
      {items && items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <span className={`badge ${item.kind === 'independent-corroboration' ? 'success' : 'neutral'}`}>{kindText[item.kind]}</span>
              <div>{item.target.title}</div>
              <small className="muted-note">{item.target.source ?? ''}{item.target.publishedAt ? ` · ${fmt(item.target.publishedAt)}` : ''}</small>
              <small className="muted-note">{item.reasons.join('; ')}. {item.independence}</small>
              <span className="ai-inline">
                <button className="link-button" onClick={() => onNavigate('Intelligence Feed', item.target.id)}>Open in feed</button>
                {item.target.url && <a href={item.target.url} target="_blank" rel="noreferrer noopener">Open source</a>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
