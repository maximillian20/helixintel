import { SEVERITIES, SEVERITY_RANK, type FeedItemDto, type ItemLocation, type Severity } from './feedTypes';

export type SeverityCounts = Record<Severity, number>;

export type MapGroup = {
  key: string;
  lat: number;
  lng: number;
  precision: ItemLocation['precision'];
  label: string;
  items: FeedItemDto[];
  /** Highest assessed severity among the reports here; Unassessed only if none is assessed. */
  severity: Severity;
  counts: SeverityCounts;
};

export type UnlocatedSummary = { total: number; global: number; unknown: number; multiple: number };

export function emptyCounts(): SeverityCounts {
  return { Critical: 0, High: 0, Medium: 0, Low: 0, Unassessed: 0 };
}

export function highestSeverity(counts: SeverityCounts): Severity {
  return SEVERITIES.find((severity) => counts[severity] > 0) ?? 'Unassessed';
}

/**
 * Groups reports that share a supported location. The severity filter is applied first, so markers,
 * colours and every count are derived from the same list of matching reports.
 */
export function groupForMap(items: FeedItemDto[], severityFilter: 'All' | Severity) {
  const matching = severityFilter === 'All' ? items : items.filter((item) => item.severity === severityFilter);
  const groups = new Map<string, MapGroup>();
  const unlocated: UnlocatedSummary = { total: 0, global: 0, unknown: 0, multiple: 0 };
  for (const item of matching) {
    const location = item.location;
    if (!location) {
      unlocated.total += 1;
      if (item.countryStatus === 'global') unlocated.global += 1;
      else if (item.countryStatus === 'unknown') unlocated.unknown += 1;
      else unlocated.multiple += 1;
      continue;
    }
    const key = `${location.precision}:${location.lat.toFixed(2)},${location.lng.toFixed(2)}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, lat: location.lat, lng: location.lng, precision: location.precision, label: location.label, items: [], severity: 'Unassessed', counts: emptyCounts() };
      groups.set(key, group);
    }
    group.items.push(item);
    group.counts[item.severity] += 1;
  }
  const result = [...groups.values()].map((group) => ({
    ...group,
    severity: highestSeverity(group.counts),
    items: [...group.items].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
  }));
  result.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
  return { groups: result, matching, unlocated, locatedCount: matching.length - unlocated.total };
}
