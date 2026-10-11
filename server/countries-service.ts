import type { AnalysisStore } from './analysis-store';
import { computeTrends } from './analysis-store';
import { buildAllItems } from './feed-service';
import type { SourceStore } from './source-store';
import { GLOBAL_CODE, UNKNOWN_CODE, countries, countryName, isKnownCountryCode } from '../src/data/countries';
import {
  COUNTRY_CATEGORIES, RATING_RANK, type CountryCategoryId, type CountryDetail, type CountryDirectoryEntry, type Rating,
} from '../src/data/workspaceTypes';

const DAY = 86_400_000;

/** Maps the classifier's event types to the six assessment categories. A suggestion for filing, never a rating. */
const CATEGORY_MAP: Record<string, CountryCategoryId> = {
  'armed-attack': 'security', 'hostage-taking': 'security', 'armed-clashes': 'security', extremism: 'security', escalation: 'security',
  atrocity: 'human-rights', repression: 'human-rights', 'mass-displacement': 'human-rights', 'war-declaration': 'security', wmd: 'security',
  coup: 'political', 'power-seizure': 'political', political: 'political', unrest: 'political', protest: 'political', diplomacy: 'political',
  'natural-hazard': 'infrastructure', cyber: 'infrastructure', 'health-emergency': 'travel', evacuation: 'travel',
  famine: 'supply-chain', 'famine-declared': 'supply-chain', hunger: 'supply-chain', migration: 'human-rights',
};

export function suggestCategory(categories: string[], sourceCategory: string): { category: CountryCategoryId | null; basis: string } {
  if (sourceCategory === 'known exploited vulnerability') return { category: null, basis: 'Global vulnerability; not tied to a country.' };
  for (const id of categories) {
    const mapped = CATEGORY_MAP[id];
    if (mapped) return { category: mapped, basis: `Automatic suggestion from the detected event type "${id}". Change it if it does not fit.` };
  }
  return { category: null, basis: 'No event type detected; choose a category yourself.' };
}

export function countryDirectory(store: SourceStore, analysis: AnalysisStore, clientId: string, now = Date.now()): CountryDirectoryEntry[] {
  const items = buildAllItems(store, clientId);
  const cutoff = now - 30 * DAY;
  const reports = new Map<string, number>();
  const alerts = new Map<string, number>();
  for (const item of items) {
    if (Date.parse(item.publishedAt) < cutoff) continue;
    for (const country of item.countries) {
      if (country.code === GLOBAL_CODE || country.code === UNKNOWN_CODE) continue;
      reports.set(country.code, (reports.get(country.code) ?? 0) + 1);
      if (item.sourceId === 'gdacs') alerts.set(country.code, (alerts.get(country.code) ?? 0) + 1);
    }
  }
  const incidents = analysis.listIncidents(clientId, {});
  const watched = new Set(analysis.getWatchedCountries(clientId));
  const latest = analysis.latestAssessments(clientId);
  return countries.map((country) => {
    const mine = incidents.filter((incident) => incident.countries.some((c) => c.code === country.code));
    const version = latest.get(country.code);
    let highest: Rating | 'Unassessed' = 'Unassessed';
    if (version) {
      for (const category of Object.values(version.categories)) {
        if (category.rating !== 'Unassessed' && (highest === 'Unassessed' || RATING_RANK[category.rating] > RATING_RANK[highest])) highest = category.rating;
      }
    }
    return {
      code: country.code, name: country.name, watched: watched.has(country.code), assessedAt: version?.assessedAt ?? null,
      highestRating: highest, reportCount30d: reports.get(country.code) ?? 0, incidentCount: mine.length,
      openIncidents: mine.filter((incident) => incident.status !== 'Closed').length, disasterAlerts30d: alerts.get(country.code) ?? 0,
    };
  });
}

export function countryDetail(store: SourceStore, analysis: AnalysisStore, clientId: string, code: string, now = Date.now()): CountryDetail | null {
  if (!isKnownCountryCode(code) || code === GLOBAL_CODE || code === UNKNOWN_CODE) return null;
  const versions = analysis.listAssessmentVersions(clientId, code); // newest first
  const latest = versions[0] ?? null;
  const items = buildAllItems(store, clientId).filter((item) => item.countries.some((country) => country.code === code));
  const cutoff = now - 30 * DAY;
  const recent = items.filter((item) => Date.parse(item.publishedAt) >= cutoff);
  const bySuggested = Object.fromEntries(COUNTRY_CATEGORIES.map((category) => [category.id, 0])) as Record<CountryCategoryId, number>;
  const recentReports = recent.slice(0, 40).map((item) => {
    const suggestion = suggestCategory(item.categories, item.category);
    return {
      articleId: item.id, headline: item.headline, url: item.url, source: item.source, publishedAt: item.publishedAt,
      severity: item.severity, suggestedCategory: suggestion.category, suggestionBasis: suggestion.basis,
    };
  });
  for (const item of recent) {
    const suggestion = suggestCategory(item.categories, item.category);
    if (suggestion.category) bySuggested[suggestion.category] += 1;
  }
  const incidents = analysis.listIncidents(clientId, { country: code });
  const assets = incidents.flatMap((summary) => {
    const detail = analysis.getIncident(clientId, summary.id);
    return detail.assets.map((asset) => ({ ...asset, incidentId: detail.id, incidentTitle: detail.title }));
  });
  return {
    code, name: countryName(code), watched: analysis.getWatchedCountries(clientId).includes(code), latest,
    versions: versions.map((version) => ({ version: version.version, assessedAt: version.assessedAt, assessor: version.assessor, confidence: version.confidence })),
    trends: computeTrends(versions, now),
    evidence: analysis.listCountryEvidence(clientId, code),
    incidents, assets,
    evidenceSummary: {
      reports30d: recent.length, reportsBySuggestedCategory: bySuggested,
      disasterAlerts30d: recent.filter((item) => item.sourceId === 'gdacs').length,
      latestReportPublishedAt: items[0]?.publishedAt ?? null,
    },
    recentReports,
  };
}
