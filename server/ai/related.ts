import { similarity } from '../analysis-store';
import { ruleLabel } from '../classify';
import { buildAllItems } from '../feed-service';
import { GLOBAL_CODE, UNKNOWN_CODE, countryName } from '../../src/data/countries';
import type { FeedItemDto } from '../../src/data/feedTypes';
import type { RelatedSuggestion } from '../../src/data/aiTypes';
import { NotFoundError } from '../analysis-store';
import type { AiDeps } from './common';

/**
 * Related-event detection. This is plain, inspectable code: location, time, shared named entities and event type decide
 * the match, and the reasons are listed. No model is involved, so it works with AI switched off. Nothing is merged or
 * linked here; the person accepts or dismisses each suggestion.
 */

const HOUR = 3_600_000;
const NEAR_DUPLICATE = 0.75;

const GENERIC = new Set(('monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december ' +
  'government president minister ministry police army security forces news reuters report reports officials official state states united nations city province region district ' +
  'the this that these those after before during according said says media agency spokesman spokesperson').split(' '));

export function entitiesOf(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\b([A-Z][\p{L}'-]{2,}(?:\s+[A-Z][\p{L}'-]{2,}){0,3})\b/gu;
  for (const match of text.matchAll(pattern)) {
    const phrase = match[1].trim();
    const lower = phrase.toLowerCase();
    if (GENERIC.has(lower)) continue;
    if (!lower.includes(' ') && lower.length < 4) continue; // short single words are mostly sentence starts
    if (lower.split(/\s+/).every((word) => GENERIC.has(word))) continue;
    found.add(lower);
  }
  return [...found];
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLng - aLng) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const realCountries = (item: FeedItemDto) => item.countries.map((c) => c.code).filter((code) => code !== GLOBAL_CODE && code !== UNKNOWN_CODE);

type Scored = { reasons: string[]; score: number; hasAnchor: boolean };

function compareReports(a: FeedItemDto, b: FeedItemDto): Scored & { sameSource: boolean; similarityScore: number } {
  const reasons: string[] = [];
  let score = 0;
  let hasAnchor = false;
  const sharedCountries = realCountries(a).filter((code) => realCountries(b).includes(code));
  if (sharedCountries.length > 0) { score += 2; reasons.push(`Same country: ${sharedCountries.map(countryName).join(', ')}`); }
  if (a.location?.precision === 'event' && b.location?.precision === 'event') {
    const km = haversineKm(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
    if (km <= 100) { score += 3; hasAnchor = true; reasons.push(`Event coordinates ${Math.round(km)} km apart`); }
  }
  const gapHours = Math.abs(Date.parse(a.publishedAt) - Date.parse(b.publishedAt)) / HOUR;
  if (gapHours <= 24) { score += 2; reasons.push(`Published ${gapHours < 1 ? 'within the hour' : `${Math.round(gapHours)} hours apart`}`); } else if (gapHours <= 72) { score += 1; reasons.push(`Published ${Math.round(gapHours)} hours apart`); }
  const sharedTypes = a.categories.filter((id) => b.categories.includes(id));
  if (sharedTypes.length > 0) { score += 2; reasons.push(`Same event type: ${sharedTypes.map(ruleLabel).join(', ')}`); }
  const ea = entitiesOf(`${a.headline}. ${a.summary}`);
  const eb = new Set(entitiesOf(`${b.headline}. ${b.summary}`));
  const sharedEntities = ea.filter((entity) => eb.has(entity));
  const meaningful = sharedEntities.filter((entity) => !a.countries.some((c) => c.name.toLowerCase() === entity));
  if (meaningful.length >= 1) { score += Math.min(3, meaningful.length + 1); hasAnchor = true; reasons.push(`Shared names: ${meaningful.slice(0, 4).join(', ')}`); }
  const sim = similarity(`${a.headline} ${a.summary}`, `${b.headline} ${b.summary}`);
  if (sim >= 0.35) { score += 2; hasAnchor = true; reasons.push('Similar wording'); }
  return { reasons, score, hasAnchor, sameSource: a.sourceId === b.sourceId, similarityScore: sim };
}

/** Other reports and this person's incidents that look related to one report. */
export function relatedToReport(deps: AiDeps, clientId: string, articleId: string): RelatedSuggestion[] {
  const items = buildAllItems(deps.store, clientId);
  const subject = items.find((item) => item.id === articleId);
  if (!subject) throw new NotFoundError('That report no longer exists.');
  const dismissed = deps.aiStore.dismissedRelated(clientId, `report:${articleId}`);
  const out: RelatedSuggestion[] = [];

  for (const other of items) {
    if (other.id === subject.id || dismissed.has(`report:${other.id}`)) continue;
    if (Math.abs(Date.parse(other.publishedAt) - Date.parse(subject.publishedAt)) > 72 * HOUR) continue;
    const result = compareReports(subject, other);
    if (result.score < 5 || !result.hasAnchor) continue;
    let kind: RelatedSuggestion['kind'] = 'possibly-related';
    let independence: string;
    if (result.sameSource || result.similarityScore >= NEAR_DUPLICATE) {
      kind = 'repeated-reporting';
      independence = result.sameSource
        ? `Same publisher (${other.source}). This is repeated reporting and counts as one source, not independent corroboration.`
        : 'Near-identical wording, so this is probably a syndicated or re-published copy. It counts as one source, not independent corroboration.';
    } else if (result.score >= 7) {
      kind = 'independent-corroboration';
      independence = `Different publisher (${other.source} versus ${subject.source}) and different wording. This is a reasonable sign of independent reporting, but the app cannot rule out that both draw on the same wire service.`;
    } else {
      independence = 'Different publisher, but the match is not strong enough to treat as corroboration of the same event.';
    }
    out.push({
      id: `report:${other.id}`, kind, score: result.score, reasons: result.reasons, independence,
      target: { type: 'report', id: other.id, title: other.headline, url: other.url || null, source: other.source, publishedAt: other.publishedAt, severity: other.severity },
    });
  }

  for (const summary of deps.analysis.listIncidents(clientId, {})) {
    if (dismissed.has(`incident:${summary.id}`)) continue;
    const detail = deps.analysis.getIncident(clientId, summary.id);
    const reasons: string[] = [];
    let score = 0;
    const alreadyLinked = detail.evidence.some((link) => link.articleId === subject.id);
    if (alreadyLinked) continue;
    const sharedCountries = realCountries(subject).filter((code) => detail.countries.some((c) => c.code === code));
    if (sharedCountries.length > 0) { score += 2; reasons.push(`Same country: ${sharedCountries.map(countryName).join(', ')}`); }
    const reference = Date.parse(detail.eventAt ?? detail.updatedAt);
    const gap = Math.abs(Date.parse(subject.publishedAt) - reference) / HOUR;
    if (gap <= 72) { score += 2; reasons.push(`Within ${Math.max(1, Math.round(gap))} hours of the incident`); }
    if (subject.categoryLabels.some((label) => detail.category && detail.category.toLowerCase().includes(label.toLowerCase())) || subject.categories.includes(detail.category)) { score += 2; reasons.push('Same event type'); }
    if (subject.location?.precision === 'event' && detail.lat !== null && detail.lng !== null) {
      const km = haversineKm(subject.location.lat, subject.location.lng, detail.lat, detail.lng);
      if (km <= 100) { score += 3; reasons.push(`Event coordinates ${Math.round(km)} km from the incident`); }
    }
    const sim = similarity(`${subject.headline} ${subject.summary}`, `${detail.title} ${detail.summary}`);
    if (sim >= 0.3) { score += 2; reasons.push('Similar wording to the incident'); }
    const entityHits = entitiesOf(`${subject.headline}. ${subject.summary}`).filter((entity) => `${detail.title} ${detail.summary}`.toLowerCase().includes(entity) && !subject.countries.some((c) => c.name.toLowerCase() === entity));
    if (entityHits.length > 0) { score += 2; reasons.push(`Shared names: ${entityHits.slice(0, 3).join(', ')}`); }
    if (score < 5 || reasons.length < 2) continue;

    const linked = detail.evidence;
    const sameSource = linked.find((link) => link.source === subject.source);
    const nearCopy = linked.find((link) => similarity(link.headline, subject.headline) >= NEAR_DUPLICATE);
    let kind: RelatedSuggestion['kind'] = 'possibly-related';
    let independence = 'The incident has no linked report from a different publisher yet; this one would be its first additional source.';
    if (nearCopy) { kind = 'repeated-reporting'; independence = `Near-identical to the linked report "${nearCopy.headline.slice(0, 80)}", so it would not add an independent source.`; }
    else if (sameSource && !linked.some((link) => link.source !== subject.source)) { kind = 'repeated-reporting'; independence = `Same publisher (${subject.source}) as the report already linked, so it would not add an independent source.`; }
    else if (score >= 7 && !sameSource) { kind = 'independent-corroboration'; independence = `${subject.source} is not yet among the incident's linked publishers and the wording differs, so it would add a separate source. The app cannot rule out a shared wire service.`; }
    out.push({
      id: `incident:${detail.id}`, kind, score, reasons, independence,
      target: { type: 'incident', id: detail.id, title: detail.title, url: null, source: null, publishedAt: detail.updatedAt, severity: detail.severity },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Reports that look related to one of this person's incidents but are not linked to it yet. */
export function relatedToIncident(deps: AiDeps, clientId: string, incidentId: string): RelatedSuggestion[] {
  const detail = deps.analysis.getIncident(clientId, incidentId);
  const dismissed = deps.aiStore.dismissedRelated(clientId, `incident:${incidentId}`);
  const linkedIds = new Set(detail.evidence.map((link) => link.articleId));
  const linkedItems = buildAllItems(deps.store, clientId).filter((item) => linkedIds.has(item.id));
  const reference = Date.parse(detail.eventAt ?? detail.createdAt);
  const out: RelatedSuggestion[] = [];

  for (const other of buildAllItems(deps.store, clientId)) {
    if (linkedIds.has(other.id) || dismissed.has(`report:${other.id}`)) continue;
    if (Math.abs(Date.parse(other.publishedAt) - reference) > 7 * 24 * HOUR) continue;
    const reasons: string[] = [];
    let score = 0;
    const sharedCountries = realCountries(other).filter((code) => detail.countries.some((c) => c.code === code));
    if (sharedCountries.length > 0) { score += 2; reasons.push(`Same country: ${sharedCountries.map(countryName).join(', ')}`); }
    const gap = Math.abs(Date.parse(other.publishedAt) - reference) / HOUR;
    if (gap <= 72) { score += 2; reasons.push(`Published ${Math.round(gap)} hours from the incident date`); }
    if (other.categories.includes(detail.category) || other.categoryLabels.some((label) => detail.category && detail.category.toLowerCase().includes(label.toLowerCase()))) { score += 2; reasons.push('Same event type'); }
    if (other.location?.precision === 'event' && detail.lat !== null && detail.lng !== null) {
      const km = haversineKm(other.location.lat, other.location.lng, detail.lat, detail.lng);
      if (km <= 100) { score += 3; reasons.push(`Event coordinates ${Math.round(km)} km from the incident`); }
    }
    const sim = Math.max(similarity(`${other.headline} ${other.summary}`, `${detail.title} ${detail.summary}`), ...linkedItems.map((item) => similarity(`${other.headline} ${other.summary}`, `${item.headline} ${item.summary}`)), 0);
    if (sim >= 0.3) { score += 2; reasons.push('Similar wording to the incident or a linked report'); }
    const entityHits = entitiesOf(`${other.headline}. ${other.summary}`).filter((entity) => `${detail.title} ${detail.summary}`.toLowerCase().includes(entity) && !other.countries.some((c) => c.name.toLowerCase() === entity));
    if (entityHits.length > 0) { score += 2; reasons.push(`Shared names: ${entityHits.slice(0, 3).join(', ')}`); }
    if (score < 5 || reasons.length < 2) continue;

    const nearCopy = linkedItems.find((item) => similarity(`${item.headline} ${item.summary}`, `${other.headline} ${other.summary}`) >= NEAR_DUPLICATE);
    const samePublisherOnly = linkedItems.length > 0 && linkedItems.every((item) => item.sourceId === other.sourceId);
    let kind: RelatedSuggestion['kind'] = 'possibly-related';
    let independence = 'Different publisher, but not a strong enough match to count as corroboration.';
    if (nearCopy) { kind = 'repeated-reporting'; independence = `Near-identical to the linked report from ${nearCopy.source}, so it is likely a copy and would not add an independent source.`; }
    else if (samePublisherOnly) { kind = 'repeated-reporting'; independence = `Same publisher (${other.source}) as every linked report, so it would not add an independent source.`; }
    else if (score >= 7) { kind = 'independent-corroboration'; independence = `${other.source} wrote it separately from the linked reports, so it would add a separate source. The app cannot rule out a shared wire service.`; }
    out.push({
      id: `report:${other.id}`, kind, score, reasons, independence,
      target: { type: 'report', id: other.id, title: other.headline, url: other.url || null, source: other.source, publishedAt: other.publishedAt, severity: other.severity },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}
