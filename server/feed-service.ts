import { assessItem, assessmentConfidence, CLASSIFIER_VERSION, ruleImpact, ruleLabel } from './classify';
import type { ArticleEnrichment, AssessmentRow, SourceStore, StoredArticle, UserItemState, UserItemStatePatch } from './source-store';
import { GLOBAL_CODE, UNKNOWN_CODE, countryName, findCountryCodes } from '../src/data/countries';
import { countryCentroids } from '../src/data/centroids';
import {
  SEVERITIES,
  matchesFilters,
  type FeedFilters,
  type FeedItemDto,
  type FeedPage,
  type ItemLocation,
  type Severity,
} from '../src/data/feedTypes';

const corroborationWindowMs = 48 * 60 * 60 * 1000;

function asSeverity(value: string | null | undefined): Severity | null {
  return SEVERITIES.find((severity) => severity === value) ?? null;
}

/** Classifies every stored article that has no current assessment. Existing user state is never touched. */
export function ensureAssessments(store: SourceStore, now = new Date()) {
  const records = store.getRecords();
  const existing = store.getAssessments();
  const enrichments = store.getEnrichments();
  const pending: AssessmentRow[] = [];
  for (const record of records) {
    if (existing.get(record.id)?.classifierVersion === CLASSIFIER_VERSION) continue;
    const assessment = assessItem({ headline: record.headline, summary: record.summary });
    const enrichment = enrichments.get(record.id);
    const provided = enrichment?.severity;
    const countryCodes = enrichment?.countryCodes?.length
      ? enrichment.countryCodes
      : enrichment?.global ? [GLOBAL_CODE] : assessment.countryCodes;
    pending.push({
      articleId: record.id,
      severity: provided ? provided.value : assessment.severity,
      impact: assessment.impact,
      scope: assessment.scope,
      urgency: assessment.urgency,
      categories: assessment.categories,
      strongCount: assessment.strongCount,
      deaths: assessment.deaths,
      deathsStated: assessment.deathsStated,
      injured: assessment.injured,
      hedged: assessment.hedged,
      rationale: provided ? provided.reason : assessment.rationale,
      countryCodes,
      method: provided?.method === 'source' ? 'source' : 'rules',
      classifierVersion: assessment.version,
      classifiedAt: now.toISOString(),
    });
  }
  if (pending.length > 0) store.saveAssessments(pending);
  return pending.length;
}

function countCorroboration(records: StoredArticle[], assessments: Map<string, AssessmentRow>) {
  const timed = records
    .map((record) => ({ record, time: Date.parse(record.publishedAt), row: assessments.get(record.id) }))
    .filter((entry): entry is { record: StoredArticle; time: number; row: AssessmentRow } => !Number.isNaN(entry.time) && Boolean(entry.row))
    .sort((a, b) => b.time - a.time);
  const counts = new Map<string, number>();
  for (let i = 0; i < timed.length; i += 1) {
    const a = timed[i];
    const realCountries = a.row.countryCodes.filter((code) => code !== GLOBAL_CODE && code !== UNKNOWN_CODE);
    let count = 0;
    if (realCountries.length > 0 && a.row.categories.length > 0) {
      for (let j = 0; j < timed.length; j += 1) {
        if (i === j) continue;
        const b = timed[j];
        if (Math.abs(a.time - b.time) > corroborationWindowMs) {
          if (b.time < a.time) break;
          continue;
        }
        const sharesCountry = b.row.countryCodes.some((code) => realCountries.includes(code));
        const sharesCategory = b.row.categories.some((id) => a.row.categories.includes(id) && ruleImpact(id) >= 1);
        if (sharesCountry && sharesCategory) count += 1;
      }
    }
    counts.set(a.record.id, count);
  }
  return counts;
}

/** Only supported event locations are mapped: source coordinates, or a single affected country (approximate). */
function locate(record: StoredArticle, row: AssessmentRow, enrichment: ArticleEnrichment | undefined): ItemLocation | null {
  if (enrichment?.location) {
    return { lat: enrichment.location.lat, lng: enrichment.location.lng, precision: 'event', label: enrichment.location.label };
  }
  let codes: string[];
  if (enrichment?.countryCodes?.length) codes = row.countryCodes.filter((code) => code !== GLOBAL_CODE && code !== UNKNOWN_CODE);
  else if (enrichment) return null; // e.g. vulnerabilities: no place, so no map position is invented
  else codes = findCountryCodes(record.headline); // countries named in the headline itself, not merely in the summary
  if (codes.length !== 1) return null;
  const centre = countryCentroids[codes[0]];
  if (!centre) return null;
  return { lat: centre[0], lng: centre[1], precision: 'approximate', label: `${countryName(codes[0])} (country centre, approximate)` };
}

function toDto(
  record: StoredArticle,
  enrichment: ArticleEnrichment | undefined,
  row: AssessmentRow,
  state: UserItemState | undefined,
  corroborating: number,
): FeedItemDto {
  const assessed = asSeverity(row.severity) ?? 'Unassessed';
  const override = asSeverity(state?.severityOverride);
  const rulesConfidence = assessmentConfidence({
    severity: assessed,
    strongCount: row.strongCount,
    figuresStated: row.deathsStated,
    corroboratingReports: corroborating,
    hedged: row.hedged,
    officialHumanitarianSource: record.sourceId === 'un-news' && row.categories.some((id) => ['famine', 'health-emergency', 'evacuation', 'repression', 'mass-displacement'].includes(id)),
  });
  const confidence = row.method === 'source' && assessed !== 'Unassessed' ? 'High' as const : rulesConfidence;
  const sourceNote = row.method === 'source'
    ? `Source: ${record.sourceName}.`
    : corroborating > 0
    ? `Source: ${record.sourceName} (publisher-provided); ${corroborating} other report${corroborating === 1 ? '' : 's'} in this feed cover the same country and type of event.`
    : `Source: ${record.sourceName} (publisher-provided); no other report in this feed corroborates it yet.`;
  const realCountries = row.countryCodes.filter((code) => code !== GLOBAL_CODE && code !== UNKNOWN_CODE);

  return {
    id: record.id,
    headline: record.headline,
    summary: record.summary,
    url: record.canonicalUrl,
    source: record.sourceName,
    sourceUrl: record.sourceUrl,
    attribution: record.attribution,
    publishedAt: record.publishedAt,
    sourceModifiedAt: record.sourceModifiedAt,
    retrievedAt: record.retrievedAt,
    lastCheckedAt: record.lastCheckedAt,
    verificationStatus: record.verificationStatus,
    sourceId: record.sourceId,
    category: enrichment?.category ?? row.categories.map((id) => ruleLabel(id))[0] ?? '',
    location: locate(record, row, enrichment),
    assessmentMethod: override ? 'manual' : row.method,
    severity: override ?? assessed,
    assessedSeverity: assessed,
    severityOverridden: override !== null,
    severityOverriddenAt: override ? state?.severityOverrideAt ?? null : null,
    severityRationale: `${row.rationale} ${sourceNote}`,
    assessmentConfidence: confidence,
    categories: row.categories,
    categoryLabels: enrichment?.category ? [enrichment.category] : row.categories.map((id) => ruleLabel(id)),
    corroboratingReports: corroborating,
    countries: row.countryCodes.map((code) => ({ code, name: countryName(code) })),
    countryStatus: realCountries.length > 0 ? 'identified' : row.countryCodes.includes(GLOBAL_CODE) ? 'global' : 'unknown',
    reviewStatus: state?.reviewStatus ?? 'Unreviewed',
    reviewedAt: state?.reviewedAt ?? null,
    reviewedBy: state?.reviewedBy ?? null,
    watchlisted: state?.watchlisted ?? false,
    watchlistedAt: state?.watchlistedAt ?? null,
  };
}

function buildAllItems(store: SourceStore, clientId: string): FeedItemDto[] {
  ensureAssessments(store);
  const records = store.getRecords();
  const assessments = store.getAssessments();
  const states = store.getUserStates(clientId);
  const enrichments = store.getEnrichments();
  const corroboration = countCorroboration(records, assessments);
  const items: FeedItemDto[] = [];
  for (const record of records) {
    const row = assessments.get(record.id);
    if (!row) continue;
    items.push(toDto(record, enrichments.get(record.id), row, states.get(record.id), corroboration.get(record.id) ?? 0));
  }
  return items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id));
}

/** Filters run over the whole stored dataset; pagination is applied afterwards. */
export function buildFeedPage(
  store: SourceStore,
  clientId: string,
  filters: FeedFilters,
  page: number,
  pageSize: number,
): FeedPage {
  const all = buildAllItems(store, clientId);
  const filtered = all.filter((item) => matchesFilters(item, filters));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
    datasetTotal: all.length,
    watchlistTotal: all.filter((item) => item.watchlisted).length,
    page: currentPage,
    pageSize,
    totalPages,
  };
}

/** Everything the Overview map and headline list need, from the same model as the Intelligence Feed. */
export function buildOverview(store: SourceStore, clientId: string, limit = 600) {
  const all = buildAllItems(store, clientId);
  const items = all.slice(0, limit);
  return {
    items,
    total: all.length,
    returned: items.length,
    unlocated: items.filter((item) => item.location === null).length,
  };
}

export function updateItemState(
  store: SourceStore,
  clientId: string,
  articleId: string,
  patch: UserItemStatePatch,
  now = new Date(),
): { item: FeedItemDto; watchlistTotal: number } | undefined {
  const saved = store.updateUserState(clientId, articleId, patch, now.toISOString());
  if (!saved) return undefined;
  const all = buildAllItems(store, clientId);
  const item = all.find((entry) => entry.id === articleId);
  if (!item) return undefined;
  return { item, watchlistTotal: all.filter((entry) => entry.watchlisted).length };
}
