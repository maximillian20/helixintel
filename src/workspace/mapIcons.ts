import L from 'leaflet';
import { SEVERITY_COLORS, type Severity } from '../data/feedTypes';
import type { Aircraft } from '../data/mapTypes';

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Category glyphs (24x24, stroke only) drawn inside markers; the text label is always shown beside the colour elsewhere. */
export const CATEGORY_GLYPHS: Record<string, { label: string; path: string }> = {
  conflict: { label: 'Conflict and security', path: '<circle cx="12" cy="12" r="6"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>' },
  political: { label: 'Political', path: '<path d="M6 21V4M6 4h12l-3 4 3 4H6"/>' },
  humanitarian: { label: 'Humanitarian', path: '<path d="M12 5v14M5 12h14"/>' },
  cyber: { label: 'Cyber', path: '<rect x="5" y="6" width="14" height="12" rx="1"/><path d="M9 10h6M9 14h4"/>' },
  'natural-hazard': { label: 'Natural hazard', path: '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 10v4M12 17v.5"/>' },
  other: { label: 'Other', path: '<path d="M12 4 20 12 12 20 4 12Z"/>' },
};
export const glyphSvg = (category: string, size = 16, color = '#fff') => {
  const g = CATEGORY_GLYPHS[category] ?? CATEGORY_GLYPHS.other;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g.path}</svg>`;
};

const TEXT_ON: Record<Severity, string> = { Critical: '#fff', High: '#111827', Medium: '#111827', Low: '#111827', Unassessed: '#111827' };

export type MarkerSpec = {
  key: string; severity: Severity; category: string | null; count: number; events: number; approximate: boolean;
  selected: boolean; hovered: boolean; label: string;
};

/** Event marker: severity colour fill, category glyph (single record) or record count (group), dashed ring when approximate. */
export function eventIcon(spec: MarkerSpec) {
  const size = spec.count > 1 ? 34 + Math.min(14, Math.round(Math.log2(spec.count) * 3)) : 30;
  const fg = TEXT_ON[spec.severity];
  const inner = spec.count > 1 ? `<b>${spec.count}</b>` : glyphSvg(spec.category ?? 'other', 16, fg);
  const cls = ['mp-mk', spec.approximate ? 'approx' : '', spec.selected ? 'sel' : '', spec.hovered ? 'hov' : '', spec.count > 1 ? 'group' : ''].filter(Boolean).join(' ');
  return L.divIcon({
    className: 'mp-mk-wrap', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    html: `<div class="${cls}" data-key="${esc(spec.key)}" data-sev="${spec.severity}" data-count="${spec.count}" data-events="${spec.events}" role="button" aria-label="${esc(spec.label)}" style="width:${size}px;height:${size}px;background:${SEVERITY_COLORS[spec.severity]};color:${fg}">${inner}</div>`,
  });
}

export const AIRCRAFT_COLOR = '#0369A1';
const PLANE = 'M12 2 14.2 9.2 22 13.4V15.6L14.2 13.4 13.6 19 16.2 21V22.4L12 21.2 7.8 22.4V21L10.4 19 9.8 13.4 2 15.6V13.4L9.8 9.2Z';

/** Directional plane icon (heading in degrees clockwise from north). Colour is separate from the severity palette. */
export function aircraftIcon(a: Pick<Aircraft, 'headingDeg' | 'hex'>, opacity: number, selected: boolean) {
  const known = a.headingDeg !== null;
  return L.divIcon({
    className: 'mp-ac-wrap', iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="mp-ac${selected ? ' sel' : ''}${known ? '' : ' nohead'}" data-hex="${esc(a.hex)}" style="opacity:${opacity.toFixed(2)};transform:rotate(${known ? a.headingDeg : 0}deg)"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="${PLANE}" fill="${AIRCRAFT_COLOR}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`,
  });
}

export function placeIcon(selected: boolean) {
  return L.divIcon({
    className: 'mp-pl-wrap', iconSize: [24, 24], iconAnchor: [12, 12],
    html: `<div class="mp-pl${selected ? ' sel' : ''}" aria-label="Saved place"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10Z"/><circle cx="12" cy="11" r="2"/></svg></div>`,
  });
}
