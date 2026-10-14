import { useMemo, useState } from 'react';
import type { ConnectionNode, ConnectionsResponse } from '../data/connectionTypes.ts';
import { SEVERITY_COLORS } from '../data/feedTypes.ts';
import { useWorkspaceData } from '../data/workspaceApi.ts';
import { Notice, Pill, type Navigate } from './shared.tsx';

const COLUMNS: Array<{ type: ConnectionNode['type']; title: string; left: number; right: number }> = [
  { type: 'sib', title: 'Bulletins', left: 0, right: 280 },
  { type: 'incident', title: 'Incidents', left: 360, right: 640 },
  { type: 'country', title: 'Countries', left: 720, right: 1000 },
];
const ROW = 72;
const TYPE_LABEL: Record<ConnectionNode['type'], string> = { incident: 'Incident', country: 'Country', sib: 'Bulletin' };

function open(node: ConnectionNode, onNavigate: Navigate) {
  if (node.type === 'incident') onNavigate('Incidents', node.openId);
  else if (node.type === 'country') onNavigate('Country Assessments', node.openId);
  else onNavigate('SIBs', node.openId);
}

export function ConnectionsModule({ onNavigate }: { onNavigate: Navigate }) {
  const graph = useWorkspaceData<ConnectionsResponse>('/connections');
  const [selected, setSelected] = useState<string | null>(null);
  const data = graph.data;

  const layout = useMemo(() => {
    const byType = new Map<ConnectionNode['type'], ConnectionNode[]>();
    for (const node of data?.nodes ?? []) byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
    for (const list of byType.values()) list.sort((a, b) => a.label.localeCompare(b.label, 'en'));
    const position = new Map<string, { x: number; y: number; column: (typeof COLUMNS)[number] }>();
    for (const column of COLUMNS) (byType.get(column.type) ?? []).forEach((node, index) => position.set(node.id, { x: column.left, y: index * ROW, column }));
    const rows = Math.max(1, ...COLUMNS.map((column) => (byType.get(column.type) ?? []).length));
    return { byType, position, height: rows * ROW };
  }, [data]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of data?.edges ?? []) {
      map.set(edge.from, (map.get(edge.from) ?? new Set()).add(edge.to));
      map.set(edge.to, (map.get(edge.to) ?? new Set()).add(edge.from));
    }
    return map;
  }, [data]);

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.id, node])), [data]);
  const current = selected ? nodeById.get(selected) ?? null : null;
  const linked = current ? [...(neighbours.get(current.id) ?? [])].map((id) => nodeById.get(id)).filter((node): node is ConnectionNode => Boolean(node)) : [];
  const isActive = (id: string) => !current || id === current.id || neighbours.get(current.id)?.has(id) === true;

  const edgePath = (from: string, to: string) => {
    const a = layout.position.get(from);
    const b = layout.position.get(to);
    if (!a || !b) return null;
    const [left, right] = a.x <= b.x ? [a, b] : [b, a];
    const x1 = left.column.right;
    const x2 = right.column.left;
    const y1 = left.y + ROW / 2 - 4;
    const y2 = right.y + ROW / 2 - 4;
    const bend = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Connections</div>
          <h2>How your records connect</h2>
          <p className="muted-note">Your incidents, bulletins and countries, joined by the links you have already saved: which countries an incident affects, and which incident or country a bulletin was written from. No link is guessed. Click a record to see what it connects to.</p>
        </div>
      </div>

      {graph.error && <Notice kind={data ? 'stale' : 'error'}>Could not refresh: {graph.error}.</Notice>}
      {graph.loading && !data && <p role="status">Loading connections…</p>}
      {data && data.nodes.length === 0 && (
        <Notice>
          Nothing to connect yet. Create an incident from a report in the <button className="link-button" onClick={() => onNavigate('Intelligence Feed')}>Intelligence Feed</button>, watch a country in{' '}
          <button className="link-button" onClick={() => onNavigate('Country Assessments')}>Country Assessments</button>, or write a bulletin in <button className="link-button" onClick={() => onNavigate('SIBs')}>SIBs</button>, and the links will appear here.
        </Notice>
      )}

      {data && data.nodes.length > 0 && (
        <div className="cn-layout">
          <div className="panel cn-board" data-testid="connection-board">
            <div className="cn-headings" aria-hidden="true">{COLUMNS.map((column) => <span key={column.type}>{column.title} ({layout.byType.get(column.type)?.length ?? 0})</span>)}</div>
            <div className="cn-canvas" style={{ height: layout.height }}>
              <svg className="cn-edges" viewBox={`0 0 1000 ${layout.height}`} preserveAspectRatio="none" aria-hidden="true">
                {data.edges.map((edge) => {
                  const path = edgePath(edge.from, edge.to);
                  if (!path) return null;
                  const on = !current || edge.from === current.id || edge.to === current.id;
                  return <path key={`${edge.from}|${edge.to}`} d={path} className={`cn-edge ${edge.kind}${on ? ' on' : ' off'}`} vectorEffect="non-scaling-stroke" />;
                })}
              </svg>
              {data.nodes.map((node) => {
                const place = layout.position.get(node.id);
                if (!place) return null;
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-testid="connection-node"
                    data-type={node.type}
                    aria-pressed={selected === node.id}
                    className={`cn-node ${node.type}${selected === node.id ? ' selected' : ''}${isActive(node.id) ? '' : ' dim'}`}
                    style={{ left: `${place.x / 10}%`, top: place.y, width: '28%', height: ROW - 8, borderLeftColor: node.severity ? SEVERITY_COLORS[node.severity] : undefined }}
                    onClick={() => setSelected(selected === node.id ? null : node.id)}
                  >
                    <strong>{node.label}</strong>
                    <small>{node.detail}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="panel cn-detail" aria-label="Selected record" aria-live="polite">
            {!current ? <p className="muted-note">Select a record to see what it connects to.</p> : (
              <>
                <div className="watch-head">
                  <strong>{current.label}</strong>
                  {current.severity && <Pill value={current.severity} />}
                </div>
                <p className="muted-note">{TYPE_LABEL[current.type]} · {current.detail}</p>
                <div className="wl-actions"><button className="outline-button" onClick={() => open(current, onNavigate)}>Open {TYPE_LABEL[current.type].toLowerCase()}</button></div>
                <h3>Connected to ({linked.length})</h3>
                {linked.length === 0 ? <p className="muted-note">No saved links yet.</p> : (
                  <ul className="cn-linked">
                    {linked.map((node) => (
                      <li key={node.id}><button className="link-button" onClick={() => setSelected(node.id)}>{node.label}</button> <small>{TYPE_LABEL[node.type]}</small></li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
