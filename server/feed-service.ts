import { assessItem, assessmentConfidence, CLASSIFIER_VERSION, ruleImpact, ruleLabel } from './classify';
import type { AssessmentRow, SourceStore, StoredArticle, UserItemState, UserItemStatePatch } from './source-store';
import { GLOBAL_CODE, UNKNOWN_CODE, countryName } from '../src/data/countries';
import {
  SEVERITIES,
  matchesFilters,
  type FeedFilters,
  type FeedItemDto,
  type FeedPage,
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
  const pending: AssessmentRow[] = [];
  for (const record of records) {
    if (existing.get(record.id)?.classifierVersion === CLASSIFIER_VERSION) continue;
    const assessment = assessItem({ headline: record.headline, summary: record.summary });
    pending.push({
      articleId: record.id,
      severity: assessment.severity,
      impact: assessment.impact,
      scope: assessment.scope,
      urgency: assessment.urgency,
      categories: assessment.categories,
      strongCount: assessment.strongCount,
      deaths: assessment.deaths,
      deathsStated: assessment.deathsStated,
      injured: assessment.injured,
      hedged: assessment.hedged,
      rationale: assessment.rationale,
      countryCodes: assessment.countryCodes,
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

function toDto(
  record: StoredArticle,
  row: AssessmentRow,
  state: UserItemState | undefined,
  corroborating: number,
): FeedItemDto {
  const assessed = asSeverity(row.severity) ?? 'Unassessed';
  const override = asSeverity(state?.severityOverride);
  const confidence = assessmentConfidence({
    severity: assessed,
    strongCount: row.strongCount,
    figuresStated: row.deathsStated,
    corroboratingReports: corroborating,
    hedged: row.hedged,
    officialHumanitarianSource: record.sourceId === 'un-news' && row.categories.some((id) => ['famine', 'health-emergency', 'evacuation', 'repression', 'mass-displacement'].includes(id)),
  });
  const sourceNote = corroborating > 0
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
    severity: override ?? assessed,
    assessedSeverity: assessed,
    severityOverridden: override !== null,
    severityOverriddenAt: override ? state?.severityOverrideAt ?? null : null,
    severityRationale: `${row.rationale} ${sourceNote}`,
    assessmentConfidence: confidence,
    categories: row.categories,
    categoryLabels: row.categories.map((id) => ruleLabel(id)),
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
  const corroboration = countCorroboration(records, assessments);
  const items: FeedItemDto[] = [];
  for (const record of records) {
    const row = assessments.get(record.id);
    if (!row) continue;
    items.push(toDto(record, row, states.get(record.id), corroboration.get(record.id) ?? 0));
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
