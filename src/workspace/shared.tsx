import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openSharedEvents } from '../data/eventHub.ts';

export function fmt(iso: string | null | undefined) {
  if (!iso) return 'not recorded';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(iso: string | null | undefined) {
  if (!iso) return 'not recorded';
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 'never';
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

export function toneFor(value: string) {
  if (['Critical', 'Severe', 'Alert', 'High', 'Deteriorating', 'Rising'].includes(value)) return 'critical';
  if (['Elevated', 'Warning', 'Medium', 'Moderate', 'Investigating', 'New'].includes(value)) return 'warning';
  if (['Low', 'Normal', 'Improving', 'Closed', 'Falling', 'Stable', 'Monitoring'].includes(value)) return 'success';
  return 'neutral';
}

export function Pill({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${toneFor(value)}`}>{label ?? value}</span>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'stale'; children: ReactNode }) {
  return <div className={`ws-notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [onClose]);
  return (
    <div className="ws-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`ws-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="panel-header">
          <h3>{title}</h3>
          <button className="ghost-button small" onClick={onClose} aria-label="Close dialog">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export type SourceStatusItem = {
  id: string; name: string; status: 'healthy' | 'stale' | 'unavailable' | 'not_checked' | 'setup_required';
  lastSuccessAt: string | null; lastAttemptAt: string | null; latestPublishedAt: string | null; lastError: string | null; pollIntervalMs: number;
  setup?: { required: boolean; instructions: string } | null;
};

export const STATUS_LABEL: Record<SourceStatusItem['status'], string> = {
  healthy: 'Live', stale: 'Stale', unavailable: 'Source unavailable', not_checked: 'Not checked yet', setup_required: 'Setup required',
};

/** Retrieval and publication times per source. "Live" is the server's judgement: a working connection within its expected interval. */
export function DataStatus({ sources, ids, now }: { sources: SourceStatusItem[] | null; ids: string[]; now: number }) {
  if (!sources) return <div className="ws-datastatus" role="status">Loading source status…</div>;
  const rows = ids.map((id) => sources.find((source) => source.id === id)).filter((source): source is SourceStatusItem => Boolean(source));
  return (
    <section className="ws-datastatus" aria-label="Data sources">
      {rows.map((source) => (
        <div key={source.id} className={`ws-source ${source.status}`}>
          <strong>{source.name}</strong>
          <span className="ws-source-state">{STATUS_LABEL[source.status]}</span>
          <small>Last successful retrieval: {source.lastSuccessAt ? `${fmt(source.lastSuccessAt)} (${ago(source.lastSuccessAt, now)})` : 'none yet'}</small>
          <small>Newest publication: {source.latestPublishedAt ? fmt(source.latestPublishedAt) : 'no records'}</small>
          {source.status === 'stale' && <small>Showing previously retrieved data.</small>}
          {source.status === 'unavailable' && source.lastSuccessAt && <small>Showing previously retrieved data; the latest attempt failed.</small>}
          {source.status === 'setup_required' && <small>{source.setup?.instructions ?? 'A server credential is required.'}</small>}
        </div>
      ))}
    </section>
  );
}

export function useSourceStatus() {
  const [sources, setSources] = useState<SourceStatusItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/sources');
        const body = await response.json() as { items: SourceStatusItem[] };
        if (active && response.ok) { setSources(body.items); setError(''); }
      } catch {
        if (active) setError('Could not read source status.');
      }
    };
    void load();
    const events = openSharedEvents();
    events.addEventListener('source-sync-updated', () => void load());
    const interval = window.setInterval(() => void load(), 60_000);
    return () => { active = false; events.close(); window.clearInterval(interval); };
  }, []);
  return { sources, error };
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type Navigate = (view: 'Incidents' | 'Country Assessments' | 'Threat Indicators' | 'Market Impact' | 'Intelligence Feed', id?: string) => void;

/** Filter and selection state that survives switching tabs (kept for the browser session, not sent anywhere). */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.sessionStorage.getItem(`gsi-ws-${key}`);
      if (stored !== null) return { ...(typeof initial === 'object' && initial !== null ? initial : {}), ...JSON.parse(stored) } as T;
    } catch {
      // ignore
    }
    return initial;
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(`gsi-ws-${key}`, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export function CountryPicker({ value, onChange, options }: { value: string[]; onChange: (codes: string[]) => void; options: Array<{ code: string; name: string }> }) {
  return (
    <div className="ws-country-picker">
      <div className="tag-list">
        {value.length === 0 && <span className="muted-note">No country set</span>}
        {value.map((code) => (
          <span key={code} className="chip">
            {options.find((option) => option.code === code)?.name ?? code}
            <button type="button" className="chip-remove" aria-label={`Remove ${options.find((option) => option.code === code)?.name ?? code}`} onClick={() => onChange(value.filter((entry) => entry !== code))}>×</button>
          </span>
        ))}
      </div>
      <select aria-label="Add country" value="" onChange={(event) => { if (event.target.value && !value.includes(event.target.value)) onChange([...value, event.target.value]); }}>
        <option value="">Add country…</option>
        {options.filter((option) => !value.includes(option.code)).map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
      </select>
    </div>
  );
}
