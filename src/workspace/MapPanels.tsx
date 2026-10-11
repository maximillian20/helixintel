import { useEffect, useState, type ReactNode } from 'react';
import { SEVERITIES, SEVERITY_COLORS, type Severity } from '../data/feedTypes.ts';
import { countSeverities, distanceKm, type Bounds } from '../data/mapLogic.ts';
import { PRECISION_LABELS, TIME_BASIS_LABELS, type MapFeature, type MapPlace, type PlaceInput } from '../data/mapTypes.ts';
import { mapFetch } from '../data/mapApi.ts';
import { CATEGORY_GLYPHS, glyphSvg } from './mapIcons.ts';
import { Notice, ago, fmt, type Navigate } from './shared.tsx';

export const CATEGORY_OPTIONS = Object.entries(CATEGORY_GLYPHS).map(([id, g]) => ({ id, label: g.label }));
export const categoryLabel = (id: string) => CATEGORY_GLYPHS[id]?.label ?? id;

export function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <span className="mp-sev" data-sev={severity} style={{ borderColor: SEVERITY_COLORS[severity] }}>
      <i style={{ background: SEVERITY_COLORS[severity] }} aria-hidden="true" />{severity}
    </span>
  );
}

export function CategoryTag({ category }: { category: string }) {
  return <span className="mp-cat"><span className="mp-cat-ico" dangerouslySetInnerHTML={{ __html: glyphSvg(category, 14, 'currentColor') }} />{categoryLabel(category)}</span>;
}

export function BreakdownText({ features }: { features: MapFeature[] }) {
  const counts = countSeverities(features);
  return <>{SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`).join(' · ')}</>;
}

// ------------------------------------------------------------------ details

export function FeatureDetails({ feature, all, onSelect, onNavigate, onClose, onCreateReportIncident, watched, onToggleWatch, onCreateHazardIncident, busy, message }: {
  feature: MapFeature; all: MapFeature[]; onSelect: (id: string) => void; onNavigate: Navigate; onClose: () => void;
  onCreateReportIncident: (articleId: string) => void; watched: boolean | null; onToggleWatch: () => void; onCreateHazardIncident: () => void;
  busy: boolean; message: string;
}) {
  const duplicates = feature.groupId ? all.filter((f) => f.groupId === feature.groupId && f.id !== feature.id) : [];
  const isArticle = feature.id.startsWith('article:');
  return (
    <section className="mp-details" aria-label="Record details" data-testid="map-details">
      <div className="mp-details-head">
        <button type="button" className="outline-button" onClick={onClose}>Close details</button>
        <SeverityChip severity={feature.severity} />
      </div>
      <h3>{feature.title}</h3>
      <div className="mp-meta">
        <CategoryTag category={feature.category} />
        <span>{feature.categoryLabel}</span>
        <span>{feature.sourceName}</span>
      </div>
      <dl className="mp-dl">
        <dt>{TIME_BASIS_LABELS[feature.timeBasis]}</dt><dd>{fmt(feature.time)} ({ago(feature.time)})</dd>
        {feature.retrievedAt && <><dt>Retrieved</dt><dd>{fmt(feature.retrievedAt)}</dd></>}
        <dt>Location</dt><dd>{feature.locationLabel}<br /><small>{PRECISION_LABELS[feature.precision]} · {feature.lat.toFixed(3)}, {feature.lng.toFixed(3)}</small></dd>
        {feature.countries.length > 0 && <><dt>Countries</dt><dd>{feature.countries.map((c) => c.name).join(', ')}</dd></>}
        {feature.reviewStatus && <><dt>Review</dt><dd>{feature.reviewStatus}</dd></>}
      </dl>
      {(feature.precision === 'approximate' || feature.precision === 'reported') && (
        <Notice kind="stale">The marker is at the country centre. {feature.precision === 'reported' ? 'GDELT locations come from places mentioned in news coverage; they are reported locations, not confirmed incident coordinates.' : 'The source names one affected country but gives no coordinates.'}</Notice>
      )}
      {feature.summary && <p className="mp-summary">{feature.summary}</p>}
      {feature.native.length > 0 && (
        <table className="mp-native"><caption>Source-native measurements (as supplied)</caption><tbody>
          {feature.native.map((n) => <tr key={n.label}><th scope="row">{n.label}</th><td>{n.value}</td></tr>)}
        </tbody></table>
      )}
      <p className="mp-basis"><strong>Severity basis:</strong> {feature.severityBasis}</p>
      <div className="mp-evidence">
        <strong>Evidence</strong>
        <ul>
          {feature.url ? <li><a href={feature.url} target="_blank" rel="noreferrer">{feature.sourceName}: original record ↗</a></li> : <li>Internal record ({feature.sourceName})</li>}
        </ul>
      </div>
      {duplicates.length > 0 && (
        <div className="mp-related" data-testid="map-duplicates">
          <strong>Likely the same event, also reported by</strong>
          <ul>{duplicates.map((d) => <li key={d.id}><button type="button" className="link-button" onClick={() => onSelect(d.id)}>{d.sourceName}: {d.title}</button></li>)}</ul>
          <small>Linked by hazard type, distance and time. Every provider record is kept; they count as one distinct event.</small>
        </div>
      )}
      {feature.incidentIds.length > 0 && feature.kind !== 'incident' && (
        <div className="mp-related">
          <strong>Related incidents</strong>
          <ul>{feature.incidentIds.map((id) => <li key={id}><button type="button" className="link-button" onClick={() => onNavigate('Incidents', id)}>Open incident {id.slice(0, 8)}</button></li>)}</ul>
        </div>
      )}
      <div className="mp-actions">
        {isArticle && <button type="button" className="outline-button" onClick={() => onNavigate('Intelligence Feed', feature.refId)}>Open report</button>}
        {feature.kind === 'incident' && <button type="button" className="outline-button" onClick={() => onNavigate('Incidents', feature.refId)}>Open incident</button>}
        {isArticle && <button type="button" className="outline-button" disabled={busy} onClick={onToggleWatch}>{watched ? 'Remove from watchlist' : 'Add to watchlist'}</button>}
        {isArticle && <button type="button" className="primary-button" onClick={() => onCreateReportIncident(feature.refId)}>Create incident</button>}
        {feature.kind === 'hazard' && !isArticle && <button type="button" className="primary-button" disabled={busy} onClick={onCreateHazardIncident}>Create incident</button>}
      </div>
      {message && <Notice kind={/could not|failed|error/i.test(message) ? 'error' : 'info'}>{message}</Notice>}
    </section>
  );
}

// ------------------------------------------------------------------ places

type Draft = {
  id: string | null; name: string; kind: 'point' | 'radius' | 'bbox'; lat: string; lng: string; radiusKm: string;
  south: string; west: string; north: string; east: string; notes: string;
  alertOn: boolean; minSeverity: Severity | 'Any'; categories: string[]; cooldownHours: string; since: string | null;
};
const emptyDraft: Draft = {
  id: null, name: '', kind: 'point', lat: '', lng: '', radiusKm: '50', south: '', west: '', north: '', east: '', notes: '',
  alertOn: false, minSeverity: 'High', categories: [], cooldownHours: '12', since: null,
};
const draftOf = (p: MapPlace): Draft => ({
  id: p.id, name: p.name, kind: p.kind, lat: p.lat?.toString() ?? '', lng: p.lng?.toString() ?? '', radiusKm: p.radiusKm?.toString() ?? '50',
  south: p.bbox?.[0].toString() ?? '', west: p.bbox?.[1].toString() ?? '', north: p.bbox?.[2].toString() ?? '', east: p.bbox?.[3].toString() ?? '', notes: p.notes,
  alertOn: p.alert.enabled, minSeverity: p.alert.minSeverity, categories: p.alert.categories, cooldownHours: String(p.alert.cooldownHours), since: p.alert.since,
});

function toInput(d: Draft): PlaceInput {
  const n = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const bbox = d.kind === 'bbox' ? [n(d.south), n(d.west), n(d.north), n(d.east)] : null;
  return {
    name: d.name.trim(), kind: d.kind, lat: d.kind === 'bbox' ? null : n(d.lat), lng: d.kind === 'bbox' ? null : n(d.lng),
    radiusKm: d.kind === 'bbox' ? null : n(d.radiusKm), bbox: bbox && bbox.every((v) => v !== null) ? (bbox as Bounds) : null, notes: d.notes.trim(),
    alert: { enabled: d.alertOn, minSeverity: d.minSeverity, categories: d.categories, cooldownHours: Math.round(Number(d.cooldownHours) || 12), since: d.since },
  };
}

export function PlacesTab({ places, selectedId, onSelect, onChanged, mapCentre, mapBounds, picking, onPick, pickedPoint, onFocus }: {
  places: MapPlace[]; selectedId: string; onSelect: (id: string) => void; onChanged: () => void; mapCentre: () => { lat: number; lng: number } | null;
  mapBounds: () => Bounds | null; picking: boolean; onPick: (on: boolean) => void; pickedPoint: { lat: number; lng: number } | null; onFocus: (place: MapPlace) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  useEffect(() => {
    if (pickedPoint) setDraft((d) => (d ? { ...d, lat: pickedPoint.lat.toFixed(4), lng: pickedPoint.lng.toFixed(4) } : d));
  }, [pickedPoint]);

  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const input = toInput(draft);
      if (draft.id) await mapFetch('PUT', `/places/${encodeURIComponent(draft.id)}`, input);
      else await mapFetch('POST', '/places', input);
      setDraft(null); onPick(false); onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the place.'); } finally { setBusy(false); }
  }
  async function remove(place: MapPlace) {
    setBusy(true); setError('');
    try { await mapFetch('DELETE', `/places/${encodeURIComponent(place.id)}`); onChanged(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not delete the place.'); } finally { setBusy(false); }
  }

  return (
    <section className="mp-places" aria-label="Saved places and areas" data-testid="map-places">
      <p className="mp-hint">Save a business location, a radius or a bounding box. Places are private to this browser. Alerts are optional.</p>
      {!draft && <button type="button" className="primary-button" onClick={() => { setDraft({ ...emptyDraft }); }}>Add place or area</button>}
      {error && <Notice kind="error">{error}</Notice>}
      {draft && (
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label>Name<input value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} required /></label>
          <label>Type
            <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as Draft['kind'] })}>
              <option value="point">Business location (point)</option>
              <option value="radius">Radius area</option>
              <option value="bbox">Bounding box</option>
            </select>
          </label>
          {draft.kind !== 'bbox' ? (
            <>
              <div className="mp-row">
                <label>Latitude<input inputMode="decimal" value={draft.lat} onChange={(e) => set({ lat: e.target.value })} /></label>
                <label>Longitude<input inputMode="decimal" value={draft.lng} onChange={(e) => set({ lng: e.target.value })} /></label>
              </div>
              <div className="mp-row">
                <button type="button" className="outline-button" onClick={() => { const c = mapCentre(); if (c) set({ lat: c.lat.toFixed(4), lng: c.lng.toFixed(4) }); }}>Use map centre</button>
                <button type="button" className={`outline-button${picking ? ' active' : ''}`} onClick={() => onPick(!picking)}>{picking ? 'Click the map…' : 'Pick on map'}</button>
              </div>
              <label>{draft.kind === 'radius' ? 'Radius (km)' : 'Alert radius (km)'}<input inputMode="decimal" value={draft.radiusKm} onChange={(e) => set({ radiusKm: e.target.value })} /></label>
            </>
          ) : (
            <>
              <div className="mp-row">
                <label>South<input inputMode="decimal" value={draft.south} onChange={(e) => set({ south: e.target.value })} /></label>
                <label>North<input inputMode="decimal" value={draft.north} onChange={(e) => set({ north: e.target.value })} /></label>
              </div>
              <div className="mp-row">
                <label>West<input inputMode="decimal" value={draft.west} onChange={(e) => set({ west: e.target.value })} /></label>
                <label>East<input inputMode="decimal" value={draft.east} onChange={(e) => set({ east: e.target.value })} /></label>
              </div>
              <button type="button" className="outline-button" onClick={() => { const b = mapBounds(); if (b) set({ south: b[0].toFixed(3), west: b[1].toFixed(3), north: b[2].toFixed(3), east: b[3].toFixed(3) }); }}>Use current map view</button>
            </>
          )}
          <label>Notes<textarea rows={2} maxLength={500} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          <fieldset className="mp-alert">
            <legend>In-app alerts</legend>
            <label className="mp-check"><input type="checkbox" checked={draft.alertOn} onChange={(e) => set({ alertOn: e.target.checked, since: e.target.checked && !draft.alertOn ? null : draft.since })} /> Alert me about new events inside this place</label>
            {draft.alertOn && (
              <>
                <label>Minimum severity
                  <select value={draft.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as Draft['minSeverity'] })}>
                    <option value="Any">Any (including Unassessed)</option>
                    {SEVERITIES.filter((s) => s !== 'Unassessed').map((s) => <option key={s} value={s}>{s} or higher</option>)}
                  </select>
                </label>
                <div className="mp-cats" role="group" aria-label="Categories">
                  {CATEGORY_OPTIONS.map((c) => (
                    <label key={c.id} className="mp-check"><input type="checkbox" checked={draft.categories.includes(c.id)} onChange={(e) => set({ categories: e.target.checked ? [...draft.categories, c.id] : draft.categories.filter((x) => x !== c.id) })} /> {c.label}</label>
                  ))}
                  <small>None ticked = every category.</small>
                </div>
                <label>Cooldown (hours)<input inputMode="numeric" value={draft.cooldownHours} onChange={(e) => set({ cooldownHours: e.target.value })} /></label>
                <small>Alerts are geographic matches, not confirmed business impact. Only records with provider or analyst coordinates can match; country-centre markers never do. Events older than the moment alerts were switched on are ignored.</small>
              </>
            )}
          </fieldset>
          <div className="mp-row">
            <button type="submit" className="primary-button" disabled={busy}>{draft.id ? 'Save changes' : 'Save place'}</button>
            <button type="button" className="outline-button" onClick={() => { setDraft(null); onPick(false); setError(''); }}>Cancel</button>
          </div>
        </form>
      )}
      <ul className="mp-place-list">
        {places.length === 0 && !draft && <li className="muted-note">No saved places yet.</li>}
        {places.map((p) => (
          <li key={p.id} className={p.id === selectedId ? 'selected' : ''} data-testid="map-place-row">
            <button type="button" className="mp-place-main" onClick={() => { onSelect(p.id); onFocus(p); }}>
              <strong>{p.name}</strong>
              <small>{p.kind === 'point' ? 'Location' : p.kind === 'radius' ? `Radius ${p.radiusKm} km` : 'Bounding box'}{p.alert.enabled ? ` · alerts ${p.alert.minSeverity === 'Any' ? 'any severity' : `${p.alert.minSeverity}+`}` : ' · alerts off'}</small>
            </button>
            <span className="mp-row-actions">
              <button type="button" className="link-button" onClick={() => setDraft(draftOf(p))}>Edit</button>
              <button type="button" className="link-button" disabled={busy} onClick={() => void remove(p)}>Delete</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ legend

export const RISK_COLORS: Record<string, string> = { Low: '#C7D2FE', Moderate: '#A5B4FC', Elevated: '#818CF8', High: '#6366F1', Severe: '#3730A3' };

export function Legend({ children, collapsed, onToggle }: { children?: ReactNode; collapsed: boolean; onToggle: () => void }) {
  return (
    <aside className={`mp-legend${collapsed ? ' collapsed' : ''}`} aria-label="Legend" data-testid="map-legend">
      <button type="button" className="mp-legend-toggle" aria-expanded={!collapsed} onClick={onToggle}>Legend {collapsed ? '▸' : '▾'}</button>
      {!collapsed && (
        <div className="mp-legend-body">
          <strong>Severity (shared with the feed)</strong>
          <ul className="mp-legend-sev">
            {SEVERITIES.map((s) => <li key={s}><i style={{ background: SEVERITY_COLORS[s] }} />{s}</li>)}
          </ul>
          <small>A group shows the highest assessed severity of its members. Unassessed = no documented severity (earthquake magnitude, PAGER or EONET data are never converted).</small>
          <strong>Category</strong>
          <ul className="mp-legend-cat">
            {CATEGORY_OPTIONS.map((c) => <li key={c.id}><span dangerouslySetInnerHTML={{ __html: glyphSvg(c.id, 14, '#e2e8f0') }} />{c.label}</li>)}
          </ul>
          <strong>Position accuracy</strong>
          <ul className="mp-legend-pos">
            <li><i className="solid" />Solid ring: coordinates from the source or an analyst</li>
            <li><i className="dashed" />Dashed ring: country centre, approximate</li>
            <li><b>12</b>Number: records grouped here (open for members)</li>
          </ul>
          {children}
        </div>
      )}
    </aside>
  );
}

export function placeDistanceKm(place: MapPlace, lat: number, lng: number) {
  return place.lat !== null && place.lng !== null ? distanceKm(place.lat, place.lng, lat, lng) : null;
}
