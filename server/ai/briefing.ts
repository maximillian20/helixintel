import { z } from 'zod';
import type { AiAnswerDto, ClaimDto } from '../../src/data/aiTypes';
import { countryName } from '../../src/data/countries';
import { SEVERITY_RANK } from '../../src/data/feedTypes';
import { buildAllItems } from '../feed-service';
import { computeIndicator, getDefinition, loadIndicatorData } from '../indicators';
import { CLAIM_JSON, allowedNumbers, claimSchema, cleanStrings, resolveClaims } from './claims';
import { GAPS_JSON, buildAnswer, evidenceNotes, followUpTargets, gapsAndFollowUps, metaFrom, noModelMeta, questionFollowUps, type Actor, type AiDeps, type Section } from './common';
import { privateAllowed, contentHash, finalise, freshnessOf, haversineKm, incidentDraft, indicatorDraft, reportDraft, type Retrieval } from './evidence';
import { cleanUntrusted, newNonce } from './guard';
import { PROMPT_VERSION, evidenceBlock, systemPrompt } from './prompts';
import { sha } from './store';

const SECTIONS = [
  { key: 'key_developments', heading: 'Key developments' },
  { key: 'material_changes', heading: 'Material changes since your previous briefing' },
  { key: 'incident_updates', heading: 'Incident updates' },
  { key: 'indicator_movements', heading: 'Indicator movements' },
] as const;

const schema = z.object({ ...Object.fromEntries(SECTIONS.map((s) => [s.key, z.array(claimSchema).max(5).default([])])), ...gapsAndFollowUps });
const jsonSchema = {
  type: 'object',
  properties: { ...Object.fromEntries(SECTIONS.map((s) => [s.key, { type: 'array', items: CLAIM_JSON }])), ...GAPS_JSON },
  required: [...SECTIONS.map((s) => s.key), 'gaps', 'follow_ups'],
};

const TASK = `Write a short personal briefing for one analyst from the evidence. Everything in EVIDENCE is new or changed since their previous briefing; the app already removed anything they have seen. The analyst's watched countries and places are listed under CALCULATED BY THE APP.
Sections (0 to 4 claims each, most important first):
- key_developments: new events or reports that matter to what they watch.
- material_changes: items marked UPDATED, where something they already saw has changed. Say what changed only if the evidence shows it.
- incident_updates: changes to their own incidents.
- indicator_movements: movements in calculated indicators. Do not predict; describe the numbers given.
Do not repeat the PREVIOUS BRIEFING. If a section has nothing, leave it empty. Put missing information in "gaps".
Schema: {"key_developments":[claim],"material_changes":[claim],"incident_updates":[claim],"indicator_movements":[claim],"gaps":[],"follow_ups":[]} where claim = {"text":"","kind":"fact|interpretation|conflict|unknown","evidence":["E1"]}`;

type Result = { answer: AiAnswerDto | null; message: string; generated: boolean; reviewCount: number };

/**
 * On-demand or scheduled briefing. The app decides what is new or changed (by comparing content fingerprints with what the
 * previous briefing covered); the model only writes about that bounded set. With nothing new, no model call is made.
 */
export async function generateBriefing(deps: AiDeps, who: Actor, options: { scheduled?: boolean; signal?: AbortSignal } = {}): Promise<Result> {
  const { ai, aiStore, analysis, places, now } = deps;
  const clientId = who.clientId;
  const settings = aiStore.getSettings(clientId);
  const previous = aiStore.latestOutput(clientId, 'briefing');
  const seen = aiStore.briefingSeen(clientId);

  const watched = new Set(analysis.getWatchedCountries(clientId));
  const myPlaces = places.list(clientId);
  const hasWatches = watched.size > 0 || myPlaces.length > 0 || analysis.watchedIndicators(clientId).length > 0;
  const all = buildAllItems(deps.store, clientId);
  const week = now.getTime() - 7 * 86_400_000;

  const inScope = (item: (typeof all)[number]) => item.watchlisted || item.countries.some((c) => watched.has(c.code))
    || myPlaces.some((place) => item.location?.precision === 'event' && place.lat !== null && place.lng !== null && haversineKm(item.location.lat, item.location.lng, place.lat, place.lng) <= (place.kind === 'radius' && place.radiusKm ? place.radiusKm : 50));
  const scoped = all.filter((item) => Date.parse(item.publishedAt) >= week && (hasWatches ? inScope(item) && SEVERITY_RANK[item.severity] >= (item.watchlisted ? 0 : 2) : SEVERITY_RANK[item.severity] >= 3));

  const fresh: Array<{ item: (typeof all)[number]; status: 'NEW' | 'UPDATED'; fingerprint: string }> = [];
  for (const item of scoped) {
    const fingerprint = contentHash(item);
    const before = seen.get(`report:${item.id}`);
    if (before === fingerprint) continue;
    fresh.push({ item, status: before ? 'UPDATED' : 'NEW', fingerprint });
  }
  fresh.sort((a, b) => SEVERITY_RANK[b.item.severity] - SEVERITY_RANK[a.item.severity] || Date.parse(b.item.publishedAt) - Date.parse(a.item.publishedAt));
  const chosenReports = fresh.slice(0, 10);

  const incidentUpdates = (privateAllowed(deps) ? analysis.listIncidents(clientId, {}) : [])
    .filter((incident) => incident.status !== 'Closed')
    .map((summary) => ({ detail: analysis.getIncident(clientId, summary.id), fingerprint: '' }))
    .map((entry) => ({ ...entry, fingerprint: sha(entry.detail.id, entry.detail.updatedAt) }))
    .filter((entry) => seen.get(`incident:${entry.detail.id}`) !== entry.fingerprint)
    .slice(0, 4);

  const ctx = { store: deps.store, sources: deps.sources, env: deps.env, now };
  const data = loadIndicatorData(ctx);
  const indicatorMoves = analysis.watchedIndicators(clientId).flatMap((watch) => {
    const def = getDefinition(watch.indicatorId);
    if (!def) return [];
    const reading = computeIndicator(def, watch.geo, analysis.getIndicatorSettings(clientId, def.id, watch.geo), ctx, data);
    const fingerprint = `${reading.level}|${reading.trend}`;
    const before = seen.get(`indicator:${def.id}|${watch.geo}`);
    if (before === fingerprint) return [];
    if (!before && (reading.level === 'Normal' || reading.level === 'No threshold' || reading.level === 'Insufficient data')) return [];
    return [{ reading, defId: def.id, geo: watch.geo, fingerprint }];
  }).slice(0, 4);

  const review = all.filter((item) => item.reviewStatus === 'Unreviewed' && SEVERITY_RANK[item.severity] >= 3 && Date.parse(item.publishedAt) >= week && (!hasWatches || inScope(item)));
  const reviewFacts = review.slice(0, 5).map((item) => ({ label: `Needs review (${item.severity})`, value: `${item.headline} (${item.source}, ${item.publishedAt.slice(0, 10)})` }));
  const scopeFact = { label: 'Scope', value: hasWatches ? `Watched countries: ${[...watched].map(countryName).join(', ') || 'none'}; saved places: ${myPlaces.length}; watched indicators: ${analysis.watchedIndicators(clientId).length}` : 'You have no watchlist yet, so this shows High and Critical reports from the last 7 days. Watch countries, places or indicators to personalise it.' };
  const reviewCount = review.length;

  const nothingNew = chosenReports.length === 0 && incidentUpdates.length === 0 && indicatorMoves.length === 0;
  const lastAt = previous?.meta.generatedAt ?? null;
  const settingsNow = aiStore.getSettings(clientId);
  const stamp = (generated: boolean) => aiStore.saveSettings(clientId, { ...settingsNow, briefing: { ...settingsNow.briefing, lastRunAt: now.toISOString(), lastGeneratedAt: generated ? now.toISOString() : settingsNow.briefing.lastGeneratedAt } }, now.toISOString());

  if (nothingNew) {
    stamp(false);
    const message = `No material changes since ${lastAt ? lastAt.slice(0, 16).replace('T', ' ') + ' UTC' : 'you last checked'}. Nothing new or updated matches what you watch.${reviewCount ? ` ${reviewCount} High or Critical report${reviewCount === 1 ? ' still needs' : 's still need'} review.` : ''}`;
    if (options.scheduled) return { answer: null, message, generated: false, reviewCount };
    const empty = {
      kind: 'briefing' as const, title: 'Briefing: no changes', question: null, summary: message,
      claims: [{ text: message, basis: 'unknown' as const, refs: [], independentSources: 0, headlineOnly: false }], sections: [], gaps: [], followUps: [], removedClaims: 0,
      notes: ['No model was used because nothing changed.'], meta: noModelMeta(deps, PROMPT_VERSION.briefing), facts: [scopeFact, ...reviewFacts],
      evidence: [], filters: [scopeFact.value], considered: 0, freshness: freshnessOf(deps, []),
    };
    return { answer: { ...empty, id: '', status: 'active', cached: false }, message, generated: false, reviewCount };
  }

  await ai.status();
  const drafts = [
    ...chosenReports.map(({ item, status }) => reportDraft(item, now, `${status} since your previous briefing`)),
    ...incidentUpdates.map(({ detail }) => incidentDraft(detail, now)),
    ...indicatorMoves.map(({ reading, defId, geo }) => indicatorDraft(reading, defId, geo)),
  ];
  const items = finalise(drafts);
  const retrieval: Retrieval = { items, filters: [scopeFact.value, `Only items new or changed since your previous briefing${lastAt ? ` (${lastAt.slice(0, 16).replace('T', ' ')} UTC)` : ' (this is your first)'}`, 'Only records your browser may access'], considered: fresh.length, freshness: freshnessOf(deps, items) };
  const nonce = newNonce();
  const previousText = previous ? previous.sections.flatMap((section) => section.items.slice(0, 2).map((claim) => claim.text)).slice(0, 5).join(' | ') : '';
  const user = [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    'CALCULATED BY THE APP:', `- ${scopeFact.label}: ${scopeFact.value}`,
    previousText ? `PREVIOUS BRIEFING (already read; do not repeat): ${cleanUntrusted(previousText, 700)}` : 'PREVIOUS BRIEFING: none',
    `EVIDENCE (ids ${items.map((item) => item.ref).join(', ')}):`, evidenceBlock(items, nonce),
  ].join('\n');

  const generated = await ai.generate({
    task: 'briefing', system: systemPrompt(TASK), user, schema, jsonSchema, signal: options.signal,
    check: (value) => {
      const record = value as Record<string, unknown>;
      if (!SECTIONS.some((s) => resolveClaims((record[s.key] as never[]) ?? [], items).claims.length > 0)) throw new Error('No claim survived. Cite evidence ids such as ["E1"] and use only numbers from the evidence.');
    },
  });
  const record = generated.value as Record<string, unknown>;
  const sections: Section[] = [];
  let removed = 0;
  for (const section of SECTIONS) {
    const resolved = resolveClaims((record[section.key] as never[]) ?? [], items, { maxClaims: 4 });
    removed += resolved.removed;
    if (resolved.claims.length > 0) sections.push({ heading: section.heading, items: resolved.claims as ClaimDto[] });
  }
  const allowed = allowedNumbers(items);
  const key = sha('briefing', now.toISOString(), clientId);
  const answer = buildAnswer(deps, 'briefing', {
    title: `Briefing, ${now.toISOString().slice(0, 10)}`, question: null, summary: sections[0]?.items[0]?.text ?? '', claims: [], sections,
    gaps: cleanStrings((record.gaps as string[]) ?? [], 5, 300, allowed), followUps: [...questionFollowUps((record.follow_ups as string[]) ?? []), ...followUpTargets(items)],
    removedClaims: removed, notes: [...evidenceNotes(retrieval), 'Items you already saw are left out unless their content changed.'], meta: metaFrom(generated, PROMPT_VERSION.briefing),
    facts: [scopeFact, ...(reviewCount ? [{ label: 'Reports awaiting your review (High or Critical)', value: String(reviewCount) }] : []), ...reviewFacts], retrieval,
  });
  const saved = aiStore.saveOutput(clientId, who.name, key, answer);
  aiStore.markBriefingSeen(clientId, [
    ...chosenReports.map(({ item, fingerprint }) => ({ ref: `report:${item.id}`, fingerprint })),
    ...incidentUpdates.map(({ detail, fingerprint }) => ({ ref: `incident:${detail.id}`, fingerprint })),
    ...indicatorMoves.map(({ defId, geo, fingerprint }) => ({ ref: `indicator:${defId}|${geo}`, fingerprint })),
  ], now.toISOString());
  stamp(true);
  aiStore.audit(clientId, who.name, options.scheduled ? 'briefing-scheduled' : 'briefing', saved.id, `${saved.id}: ${items.length} new or changed records; model ${generated.meta.model}.`, now.toISOString());
  if (options.scheduled) {
    analysis.createAlert(clientId, { kind: 'ai-briefing', dedupeKey: `briefing-${saved.id}`, title: 'Your briefing is ready', detail: (saved.summary || 'New developments match what you watch.').slice(0, 220), severity: 'info', link: { view: 'Ask Helix', id: saved.id } }, now.toISOString());
  }
  return { answer: saved, message: 'Briefing generated.', generated: true, reviewCount };
}

/** Is this person's scheduled briefing due now? At most one attempt per slot, so a quiet day makes no repeated checks. */
export function briefingDue(settings: ReturnType<AiDeps['aiStore']['getSettings']>, now: Date): boolean {
  const { schedule, hourUtc, lastRunAt } = settings.briefing;
  if (!settings.enabled || schedule === 'off') return false;
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (now.getTime() < slot.getTime()) return false;
  if (schedule === 'weekly' && now.getUTCDay() !== 1) return false; // Mondays
  return !lastRunAt || Date.parse(lastRunAt) < slot.getTime();
}
