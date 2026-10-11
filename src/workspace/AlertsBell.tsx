import { useEffect, useRef, useState } from 'react';
import { getAnalystName, setAnalystName, wsFetch, useWorkspaceData } from '../data/workspaceApi.ts';
import type { AlertDto } from '../data/workspaceTypes.ts';
import { ago, type Navigate } from './shared.tsx';

type AlertList = { items: AlertDto[]; unread: number };

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

export function AlertsBell({ onNavigate }: { onNavigate: Navigate }) {
  const alerts = useWorkspaceData<AlertList>('/alerts');
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const unread = alerts.data?.unread ?? 0;

  async function markRead(ids: number[] | 'all') {
    try {
      await wsFetch('POST', '/alerts/read', { ids });
      void alerts.reload();
    } catch {
      // the list reloads on the next update
    }
  }

  return (
    <div className="ws-popover-anchor" ref={ref}>
      <button className="outline-button ws-bell" aria-haspopup="dialog" aria-expanded={open} aria-label={`Alerts, ${unread} unread`} onClick={() => setOpen(!open)}>
        Alerts{unread > 0 && <span className="ws-bell-count">{unread}</span>}
      </button>
      {open && (
        <div className="ws-popover" role="dialog" aria-label="Alerts">
          <div className="panel-header">
            <h3>Alerts</h3>
            <button className="ghost-button small" disabled={unread === 0} onClick={() => void markRead('all')}>Mark all read</button>
          </div>
          {alerts.error && <p className="muted-note" role="alert">Could not refresh alerts: {alerts.error}</p>}
          {alerts.data && alerts.data.items.length === 0 && <p className="muted-note">No alerts. Watch an indicator or a country to be notified here when thresholds are crossed or material changes occur.</p>}
          <ul className="ws-alert-list">
            {(alerts.data?.items ?? []).map((alert) => (
              <li key={alert.id} className={`${alert.severity} ${alert.readAt ? 'read' : 'unread'}`}>
                <button onClick={() => {
                  void markRead([alert.id]);
                  setOpen(false);
                  if (alert.link) onNavigate(alert.link.view as Parameters<Navigate>[0], alert.link.id);
                }}>
                  <strong>{alert.title}</strong>
                  <small>{alert.detail}</small>
                  <small>{ago(alert.createdAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AnalystMenu() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(getAnalystName());
  const ref = useDismiss(open, () => setOpen(false));
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
  return (
    <div className="ws-popover-anchor" ref={ref}>
      <button className="avatar" aria-haspopup="dialog" aria-expanded={open} aria-label={name ? `Analyst: ${name}` : 'Set your analyst name'} onClick={() => setOpen(!open)}>{initials}</button>
      {open && (
        <div className="ws-popover small" role="dialog" aria-label="Analyst name">
          <form className="ws-form" onSubmit={(event) => { event.preventDefault(); setAnalystName(name); setOpen(false); }}>
            <label>Your name<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Shown in audit trails" /></label>
            <p className="muted-note">Used for the audit trail of incidents and assessments. Records are private to this browser; there are no shared accounts.</p>
            <div className="ws-form-actions"><button className="outline-button small">Save</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
