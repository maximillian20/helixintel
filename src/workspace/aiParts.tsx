import { useState, type ReactNode } from 'react';
import { BASIS_LABELS, DEPTH_LABELS, type AiAnswerDto, type AiStatusDto, type ClaimDto, type EvidenceDto } from '../data/aiTypes.ts';
import type { AiRequestError } from '../data/aiApi.ts';
import { Notice, Pill, fmt, type Navigate } from './shared.tsx';

/** The one honest status line used wherever an AI feature appears. */
export function AiStatusBanner({ status, error, compact }: { status: AiStatusDto | null; error?: string; compact?: boolean }) {
  if (error && !status) return <Notice kind="error">Could not read the AI status: {error}</Notice>;
  if (!status) return <Notice>Checking the AI connection…</Notice>;
  if (status.state === 'ready' && status.userEnabled) {
    if (compact) return null;
    return <Notice>AI ready: {status.model}{status.modelDigest ? ` (${status.modelDigest})` : ''} on {status.endpoint ?? 'this server'}{status.provider === 'cloudflare' ? ' (free hosted service; prompts leave this server)' : ''}. Answers are drafted from your records and always list their sources. No paid AI service is used.{!status.privateRecords && ' Private incidents, assessments and saved places are not sent to this service, so the features that need them are off.'}</Notice>;
  }
  if (status.state === 'ready') return <Notice kind="stale">{status.message}</Notice>;
  return (
    <Notice kind={status.state === 'disabled' ? 'info' : 'stale'}>
      <strong>{status.state === 'setup_required' ? 'AI setup required' : status.state === 'disabled' ? 'AI is switched off' : status.state === 'model_missing' ? 'AI model not installed' : status.state === 'limit_reached' ? 'AI daily free limit reached' : status.provider === 'cloudflare' ? 'AI service not reachable' : 'AI computer not reachable'}.</strong> {status.message}
      {status.steps.length > 0 && !compact && <ol className="ai-steps">{status.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
      <div className="muted-note">Everything else in the app keeps working; no AI result is ever made up while the model is unavailable.</div>
    </Notice>
  );
}

export function ErrorNote({ error }: { error: AiRequestError | null }) {
  if (!error) return null;
  return <Notice kind={[503, 504, 429, 409].includes(error.status) ? 'stale' : 'error'}>{error.message}</Notice>;
}

export function BasisBadge({ basis }: { basis: ClaimDto['basis'] }) {
  const tone = basis === 'corroborated' ? 'success' : basis === 'reported' ? 'neutral' : basis === 'conflict' ? 'critical' : basis === 'interpretation' ? 'warning' : 'neutral';
  return <span className={`badge ${tone} ai-basis ai-basis-${basis}`} title={BASIS_LABELS[basis]}>{BASIS_LABELS[basis]}</span>;
}

export function ClaimList({ claims, evidence, onOpen }: { claims: ClaimDto[]; evidence: EvidenceDto[]; onOpen: (ref: string) => void }) {
  return (
    <ul className="ai-claims">
      {claims.map((claim, index) => (
        <li key={`${index}-${claim.text.slice(0, 24)}`} className={`ai-claim ai-claim-${claim.basis}`}>
          <div className="ai-claim-head"><BasisBadge basis={claim.basis} />{claim.headlineOnly && <span className="badge neutral" title="Every cited report had only a headline">Headline only</span>}</div>
          <p>{claim.text}</p>
          {claim.refs.length > 0 && (
            <div className="ai-cites" aria-label="Sources for this statement">
              {claim.refs.map((ref) => {
                const item = evidence.find((entry) => entry.ref === ref);
                return <button key={ref} type="button" className="chip-button" onClick={() => onOpen(ref)} title={item?.title}>{ref}</button>;
              })}
              {claim.basis !== 'interpretation' && claim.basis !== 'unknown' && <small className="muted-note">{claim.independentSources} independent source{claim.independentSources === 1 ? '' : 's'}</small>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function EvidenceList({ evidence, onNavigate, highlight }: { evidence: EvidenceDto[]; onNavigate?: Navigate; highlight?: string | null }) {
  if (evidence.length === 0) return <p className="muted-note">No records were used.</p>;
  return (
    <ol className="ai-evidence">
      {evidence.map((item) => (
        <li key={item.ref} id={`ev-${item.ref}`} className={highlight === item.ref ? 'highlight' : ''}>
          <div className="ai-ev-head">
            <strong>{item.ref}</strong>
            <span className="badge neutral">{kindLabel(item.kind)}</span>
            {item.severity && <Pill value={item.severity} />}
            {item.flagged && <span className="badge warning" title="This text contained instruction-like wording. It was treated as data only.">Contains instruction-like text</span>}
            {item.stale && <span className="badge warning">Old record</span>}
          </div>
          <div>{item.title}</div>
          <small className="muted-note">
            {item.source ? `${item.source} · ` : ''}{item.publishedAt ? `published ${fmt(item.publishedAt)}` : 'date not recorded'}{item.retrievedAt ? ` · retrieved ${fmt(item.retrievedAt)}` : ''} · {DEPTH_LABELS[item.depth]}
          </small>
          {item.note && <small className="muted-note">{item.note}</small>}
          <div className="ai-ev-links">
            {item.url && <a href={item.url} target="_blank" rel="noreferrer noopener">Open source</a>}
            {item.link && onNavigate && <button type="button" className="link-button" onClick={() => onNavigate(item.link!.view as Parameters<Navigate>[0], item.link!.id)}>Open in Helix</button>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function kindLabel(kind: EvidenceDto['kind']) {
  return ({ report: 'Report', incident: 'Incident', country: 'Country assessment', indicator: 'Indicator (calculated)', place: 'Saved place', market: 'Market data' } as const)[kind];
}

/** A full AI result: summary, claims or sections, gaps, freshness, sources and model details. */
export function AnswerView({ answer, onNavigate, children }: { answer: AiAnswerDto; onNavigate?: Navigate; children?: ReactNode }) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const open = (ref: string) => {
    setHighlight(ref);
    document.getElementById(`ev-${ref}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  return (
    <div className="ai-answer">
      <div className="ai-meta-row">
        <span className="badge warning">AI-generated draft</span>
        {answer.cached && <span className="badge neutral" title="Same question, same records, same model: no new generation was needed.">Reused saved result</span>}
        <small className="muted-note">{answer.meta.model}{answer.meta.modelDigest ? ` (${answer.meta.modelDigest})` : ''} · prompt {answer.meta.promptVersion} · {fmt(answer.meta.generatedAt)}</small>
      </div>
      {answer.notes.length > 0 && <ul className="ai-notes">{answer.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {answer.facts.length > 0 && (
        <dl className="ai-facts" aria-label="Figures calculated by the app">
          {answer.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          <small className="muted-note">These figures are calculated by the app, not by the AI.</small>
        </dl>
      )}
      {answer.claims.length > 0 && <ClaimList claims={answer.claims} evidence={answer.evidence} onOpen={open} />}
      {answer.sections.map((section) => section.items.length > 0 && (
        <section key={section.heading} className="ai-section">
          <h4>{section.heading}</h4>
          <ClaimList claims={section.items} evidence={answer.evidence} onOpen={open} />
        </section>
      ))}
      {answer.removedClaims > 0 && <p className="muted-note">{answer.removedClaims} statement{answer.removedClaims === 1 ? ' was' : 's were'} removed because {answer.removedClaims === 1 ? 'it' : 'they'} lacked a valid source or contained figures, links or forecasts not found in the records.</p>}
      {answer.gaps.length > 0 && <section className="ai-section"><h4>Gaps and unknowns</h4><ul>{answer.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></section>}
      {children}
      <details className="ai-sources" open={answer.evidence.length <= 6}>
        <summary>{answer.evidence.length} source record{answer.evidence.length === 1 ? '' : 's'} used</summary>
        <EvidenceList evidence={answer.evidence} onNavigate={onNavigate} highlight={highlight} />
      </details>
      <details className="ai-sources">
        <summary>How this was selected</summary>
        <ul>{answer.filters.map((line) => <li key={line}>{line}</li>)}<li>{answer.considered} accessible record{answer.considered === 1 ? '' : 's'} matched the filters before ranking.</li></ul>
        <p className="muted-note">
          Newest report: {answer.freshness.newestReportAt ? fmt(answer.freshness.newestReportAt) : 'none'} · Last successful source retrieval: {answer.freshness.lastSourceSuccessAt ? fmt(answer.freshness.lastSourceSuccessAt) : 'unknown'}
          {answer.freshness.staleSources.length > 0 ? ` · Stale sources: ${answer.freshness.staleSources.join(', ')}` : ''}
        </p>
      </details>
    </div>
  );
}
