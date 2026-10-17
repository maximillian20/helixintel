import { z } from 'zod';
import type { AiAnswerDto, AiOutputKind, ClaimDto, EvidenceDto } from '../../src/data/aiTypes';
import { countryName } from '../../src/data/countries';
import type { IncidentDetail } from '../../src/data/workspaceTypes';
import { COUNTRY_CATEGORIES } from '../../src/data/workspaceTypes';
import { NotFoundError } from '../analysis-store';
import { countryDetail } from '../countries-service';
import { buildAllItems } from '../feed-service';
import { computeIndicator, INDICATORS, loadIndicatorData } from '../indicators';
import { CLAIM_JSON, allowedNumbers, claimSchema, cleanStrings, resolveClaims } from './claims';
import { GAPS_JSON, buildAnswer, cacheKey, evidenceKey, evidenceNotes, followUpTargets, gapsAndFollowUps, metaFrom, questionFollowUps, type Actor, type AiDeps, type Section } from './common';
import { privateAllowed, countryDraft, finalise, freshnessOf, incidentDraft, indicatorDraft, reportDraft, type Retrieval } from './evidence';
import { cleanUntrusted, newNonce } from './guard';
import { PROMPT_VERSION, evidenceBlock, systemPrompt } from './prompts';
import { AiPrivacyError } from './service';
import { sha } from './store';

type SectionDef = { key: string; heading: string; interpretation: boolean };

const INCIDENT_SECTIONS: SectionDef[] = [
  { key: 'what_happened', heading: 'What happened or changed', interpretation: false },
  { key: 'supporting_evidence', heading: 'Supporting evidence', interpretation: false },
  { key: 'conflicting_accounts', heading: 'Conflicting accounts', interpretation: false },
  { key: 'operational_impact', heading: 'Potential operational impact (AI interpretation, not confirmed)', interpretation: true },
  { key: 'possible_exposure', heading: 'Possible exposure (potential, not confirmed)', interpretation: true },
  { key: 'proposed_updates', heading: 'Proposed updates for you to consider (nothing is applied)', interpretation: true },
];
const COUNTRY_SECTIONS: SectionDef[] = [
  { key: 'what_changed', heading: 'What changed', interpretation: false },
  { key: 'supporting_evidence', heading: 'Evidence behind the current assessment', interpretation: false },
  { key: 'conflicting_accounts', heading: 'Conflicting accounts', interpretation: false },
  { key: 'operational_impact', heading: 'Potential operational impact (AI interpretation, not confirmed)', interpretation: true },
  { key: 'possible_exposure', heading: 'Possible exposure (potential, not confirmed)', interpretation: true },
  { key: 'proposed_updates', heading: 'Proposed assessment updates for you to consider (nothing is applied)', interpretation: true },
];

function sectionSchema(defs: SectionDef[]) {
  return z.object({ ...Object.fromEntries(defs.map((def) => [def.key, z.array(claimSchema).max(6).default([])])), ...gapsAndFollowUps });
}
function sectionJson(defs: SectionDef[]) {
  return {
    type: 'object',
    properties: { ...Object.fromEntries(defs.map((def) => [def.key, { type: 'array', items: CLAIM_JSON }])), ...GAPS_JSON },
    required: [...defs.map((def) => def.key), 'gaps', 'follow_ups'],
  };
}

const INCIDENT_TASK = (defs: SectionDef[]) => `Help an analyst assess one incident. EVIDENCE contains the incident record (written by the analyst), the reports linked to it, any saved country assessment, and a computed list of potential exposure.
Fill each section with 0 to 4 claims:
${defs.map((def) => `- ${def.key}: ${def.heading}`).join('\n')}
Rules specific to this task:
- "operational_impact", "possible_exposure" and "proposed_updates" are always your interpretation. Word them as possibilities ("could", "may"). Never say an asset IS affected unless the incident record lists it as affected.
- Exposure computed by the app (type=place) is potential only: same country or nearby is not proof of impact.
- "proposed_updates" may suggest the analyst reconsider severity, confidence, status or actions, with the reason and the evidence ids. Do not invent numbers or scores.
- "conflicting_accounts": only when two cited sources actually differ. Otherwise leave it empty.
- Put missing information in "gaps" and 2 to 3 questions worth investigating in "follow_ups".
Schema: {${defs.map((def) => `"${def.key}":[claim]`).join(',')},"gaps":[],"follow_ups":[]} where claim = {"text":"","kind":"fact|interpretation|conflict|unknown","evidence":["E1"]}`;

const COUNTRY_TASK = (defs: SectionDef[]) => `Help an analyst review one country assessment. EVIDENCE contains the saved assessment (written by the analyst), recent reports, open incidents and calculated indicators. TRENDS FROM THE ASSESSMENT HISTORY are given separately and are calculated by the app.
Fill each section with 0 to 4 claims:
${defs.map((def) => `- ${def.key}: ${def.heading}`).join('\n')}
Rules specific to this task:
- You must not create risk scores or numbers. Ratings use the analyst's own scale (Low, Moderate, Elevated, High, Severe).
- "proposed_updates": say which category the analyst might re-rate and why, citing evidence. Never state that a rating has changed.
- "operational_impact" and "possible_exposure" are possibilities, not findings.
- Put missing information in "gaps" and 2 to 3 questions worth investigating in "follow_ups".
Schema: {${defs.map((def) => `"${def.key}":[claim]`).join(',')},"gaps":[],"follow_ups":[]} where claim = {"text":"","kind":"fact|interpretation|conflict|unknown","evidence":["E1"]}`;

const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLng - aLng) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/** Potential exposure, computed by code from the person's saved places and the assets on their other incidents. */
export function potentialExposure(deps: AiDeps, clientId: string, scope: { countries: string[]; lat: number | null; lng: number | null; excludeIncidentId?: string }): string[] {
  const lines: string[] = [];
  for (const place of deps.places.list(clientId)) {
    if (scope.lat === null || scope.lng === null) break;
    if (place.kind === 'bbox' && place.bbox) {
      const [s, w, n, e] = place.bbox;
      if (scope.lat >= s && scope.lat <= n && scope.lng >= w && scope.lng <= e) lines.push(`The coordinates are inside your saved area "${place.name}".`);
    } else if (place.lat !== null && place.lng !== null) {
      const km = haversineKm(scope.lat, scope.lng, place.lat, place.lng);
      const limit = place.kind === 'radius' && place.radiusKm ? place.radiusKm : 50;
      if (km <= limit) lines.push(`Your saved place "${place.name}" is ${Math.round(km)} km from the coordinates (inside its ${limit} km range).`);
    }
  }
  for (const summary of deps.analysis.listIncidents(clientId, {})) {
    if (summary.id === scope.excludeIncidentId) continue;
    const detail = deps.analysis.getIncident(clientId, summary.id);
    for (const asset of detail.assets) {
      if (asset.countryCode && scope.countries.includes(asset.countryCode)) lines.push(`${asset.kind} "${asset.name}" in ${countryName(asset.countryCode)} (recorded on ${detail.id}) is in the same country. Country-level only: nothing shows it is affected.`);
    }
  }
  return [...new Set(lines)].slice(0, 8);
}

function exposureDraft(lines: string[]) {
  const text = lines.length > 0 ? lines.join(' ') : 'No saved place or recorded asset is near or in the same country.';
  return {
    ref: '', kind: 'place' as const, id: 'exposure', title: 'Potential exposure computed by this app', excerpt: text, url: null, source: 'Your saved places and recorded assets', sourceId: null, publishedAt: null, retrievedAt: null,
    depth: 'computed' as const, severity: null, countries: [], link: null, independenceGroup: 'exposure', flagged: false, stale: false, note: 'potential only, not confirmed', text: '', fingerprint: sha(lines),
  };
}

type Built = { retrieval: Retrieval; facts: AiAnswerDto['facts']; title: string; subjectKey: string; extraNotes: string[] };

function incidentEvidence(deps: AiDeps, clientId: string, detail: IncidentDetail): Built {
  const all = buildAllItems(deps.store, clientId);
  const byId = new Map(all.map((item) => [item.id, item]));
  const linked = [...detail.evidence].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const present = linked.map((link) => byId.get(link.articleId)).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 8);
  const missing = linked.length - linked.filter((link) => byId.has(link.articleId)).length;
  const latest = deps.analysis.latestAssessments(clientId);
  const exposure = potentialExposure(deps, clientId, { countries: detail.countries.map((c) => c.code), lat: detail.lat, lng: detail.lng, excludeIncidentId: detail.id });
  const drafts = [
    incidentDraft(detail, deps.now),
    ...present.map((item) => reportDraft(item, deps.now)),
    ...detail.countries.slice(0, 2).flatMap((c) => (latest.get(c.code) ? [countryDraft(c.code, latest.get(c.code)!, deps.now)] : [])),
    exposureDraft(exposure),
  ];
  const items = finalise(drafts);
  const facts = [
    { label: 'Known affected assets (recorded on this incident)', value: detail.assets.length ? detail.assets.map((a) => `${a.kind}: ${a.name}`).join('; ') : 'None recorded' },
    { label: 'Potential exposure (computed, not confirmed)', value: exposure.length ? exposure.join(' ') : 'No saved place or other recorded asset is near or in the same country.' },
    { label: 'Linked reports', value: `${linked.length}${missing ? ` (${missing} no longer in the feed)` : ''}` },
  ];
  const retrieval: Retrieval = { items, filters: [`Incident ${detail.id} and its linked reports`, 'Only records your browser may access'], considered: linked.length, freshness: freshnessOf(deps, items) };
  return { retrieval, facts, title: `Assessment help: ${detail.title}`, subjectKey: `${detail.id}:${detail.updatedAt}`, extraNotes: missing ? [`${missing} linked report${missing === 1 ? ' is' : 's are'} no longer in the feed, so ${missing === 1 ? 'it was' : 'they were'} not shown to the model.`] : [] };
}

function countryEvidence(deps: AiDeps, clientId: string, code: string): Built {
  const detail = countryDetail(deps.store, deps.analysis, clientId, code, deps.now.getTime());
  if (!detail) throw new NotFoundError('Unknown country.');
  const all = buildAllItems(deps.store, clientId);
  const byId = new Map(all.map((item) => [item.id, item]));
  const linkedIds = detail.evidence.filter((evidence) => evidence.refType === 'report').map((evidence) => evidence.refId);
  const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, Unassessed: 4 };
  const recent = all.filter((item) => item.countries.some((c) => c.code === code) && deps.now.getTime() - Date.parse(item.publishedAt) <= 30 * 86_400_000)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const chosen = [...new Map([...linkedIds.map((id) => byId.get(id)), ...recent].filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.id, item])).values()].slice(0, 9);
  const drafts: Array<ReturnType<typeof reportDraft> | ReturnType<typeof incidentDraft> | ReturnType<typeof countryDraft> | ReturnType<typeof indicatorDraft> | ReturnType<typeof exposureDraft>> = [];
  if (detail.latest) drafts.push(countryDraft(code, detail.latest, deps.now));
  drafts.push(...chosen.map((item) => reportDraft(item, deps.now)));
  for (const summary of detail.incidents.filter((incident) => incident.status !== 'Closed').slice(0, 3)) drafts.push(incidentDraft(deps.analysis.getIncident(clientId, summary.id), deps.now));
  const ctx = { store: deps.store, sources: deps.sources, env: deps.env, now: deps.now };
  const data = loadIndicatorData(ctx);
  let indicators = 0;
  for (const def of INDICATORS) {
    if (!def.perCountry || indicators >= 2) continue;
    const reading = computeIndicator(def, code, deps.analysis.getIndicatorSettings(clientId, def.id, code), ctx, data);
    if (reading.current !== null && (reading.level === 'Warning' || reading.level === 'Alert' || reading.trend === 'Rising')) { drafts.push(indicatorDraft(reading, def.id, code)); indicators += 1; }
  }
  const exposure = potentialExposure(deps, clientId, { countries: [code], lat: null, lng: null });
  drafts.push(exposureDraft(exposure));
  const items = finalise(drafts);
  const facts: AiAnswerDto['facts'] = [
    { label: 'Latest saved assessment', value: detail.latest ? `Version ${detail.latest.version}, ${detail.latest.assessedAt.slice(0, 10)}, by ${detail.latest.assessor}` : 'None saved yet' },
    ...COUNTRY_CATEGORIES.flatMap((category) => {
      const rating = detail.latest?.categories[category.id]?.rating;
      if (!rating || rating === 'Unassessed') return [];
      const change = detail.trends[category.id].changes.find((c) => c.windowDays === 30 && c.steps !== null) ?? detail.trends[category.id].changes.find((c) => c.windowDays === 7 && c.steps !== null);
      return [{ label: `${category.label} (analyst rating)`, value: `${rating}; trend ${detail.trends[category.id].trend}${change?.from ? ` (was ${change.from} on ${change.fromDate?.slice(0, 10)})` : ''}` }];
    }),
    { label: 'Reports in the last 30 days', value: String(detail.evidenceSummary.reports30d) },
    { label: 'Potential exposure (computed, not confirmed)', value: exposure.length ? exposure.join(' ') : 'No recorded asset or saved place is in this country.' },
  ];
  const retrieval: Retrieval = { items, filters: [`${countryName(code)}: latest assessment, reports from the last 30 days, open incidents, indicators`, 'Only records your browser may access'], considered: recent.length, freshness: freshnessOf(deps, items) };
  return { retrieval, facts, title: `Assessment help: ${countryName(code)}`, subjectKey: `${code}:${detail.latest?.version ?? 0}`, extraNotes: detail.latest ? [] : ['No assessment has been saved for this country yet, so there is nothing for the model to review beyond the reports.'] };
}

async function runSections(deps: AiDeps, who: Actor, kind: AiOutputKind, defs: SectionDef[], task: string, promptVersion: string, built: Built, options: { refresh?: boolean; signal?: AbortSignal }): Promise<AiAnswerDto> {
  const { ai, aiStore, now } = deps;
  const { retrieval } = built;
  await ai.status();
  const factText = built.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
  const key = cacheKey(deps, kind, promptVersion, built.subjectKey, evidenceKey(retrieval.items), factText);
  if (!options.refresh) {
    const hit = aiStore.findCached(who.clientId, kind, key);
    if (hit) {
      ai.counters.cacheHits += 1;
      aiStore.audit(who.clientId, who.name, `${kind}-cached`, built.title, `Reused ${hit.id}; the model was not called.`, now.toISOString());
      return hit;
    }
  }
  const nonce = newNonce();
  const user = [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    'CALCULATED BY THE APP (reliable, not for you to change):', ...built.facts.map((fact) => `- ${cleanUntrusted(`${fact.label}: ${fact.value}`, 400)}`),
    `EVIDENCE (ids ${retrieval.items.map((item) => item.ref).join(', ')}):`, evidenceBlock(retrieval.items, nonce),
  ].join('\n');
  const schema = sectionSchema(defs);
  const generated = await ai.generate({
    task: kind, system: systemPrompt(task), user, schema, jsonSchema: sectionJson(defs), signal: options.signal,
    check: (value) => {
      const record = value as Record<string, unknown>;
      const survived = defs.some((def) => resolveClaims((record[def.key] as never[]) ?? [], retrieval.items, { forceInterpretation: def.interpretation, extraAllowed: [factText] }).claims.length > 0);
      if (!survived) throw new Error('No claim survived. Cite evidence ids such as ["E1"] for every fact and use only numbers that appear in the cited evidence.');
    },
  });
  const record = generated.value as Record<string, unknown>;
  let removed = 0;
  const sections: Section[] = [];
  for (const def of defs) {
    const resolved = resolveClaims((record[def.key] as never[]) ?? [], retrieval.items, { forceInterpretation: def.interpretation, extraAllowed: [factText], maxClaims: 5 });
    removed += resolved.removed;
    if (resolved.claims.length > 0) sections.push({ heading: def.heading, items: resolved.claims });
  }
  const allowed = allowedNumbers(retrieval.items, [factText]);
  const first: ClaimDto | undefined = sections[0]?.items[0];
  const answer = buildAnswer(deps, kind, {
    title: built.title, question: null, summary: first?.text ?? '', claims: [], sections,
    gaps: cleanStrings(((record.gaps as string[]) ?? []), 6, 300, allowed), followUps: [...questionFollowUps((record.follow_ups as string[]) ?? []), ...followUpTargets(retrieval.items)],
    removedClaims: removed, notes: [...built.extraNotes, 'Proposed updates are suggestions only. This tool never changes a rating, severity, status or review state; apply anything you agree with yourself in the editor.', ...evidenceNotes(retrieval)],
    meta: metaFrom(generated, promptVersion), facts: built.facts, retrieval,
  });
  const saved = aiStore.saveOutput(who.clientId, who.name, key, answer);
  aiStore.audit(who.clientId, who.name, kind, built.title, `${saved.id}: ${sections.reduce((n, s) => n + s.items.length, 0)} claims from ${retrieval.items.length} records; ${removed} removed; model ${generated.meta.model}; nothing in the record was changed.`, now.toISOString());
  return saved;
}

export function requirePrivate(deps: AiDeps, what: string) {
  if (!privateAllowed(deps)) throw new AiPrivacyError(`${what} uses your private records, which would be sent to a third-party AI service. That is switched off. Use a model on your own computer, or set AI_ALLOW_PRIVATE_RECORDS=1 if you accept sending them (see docs/AI.md).`);
}

export function assistIncident(deps: AiDeps, who: Actor, incidentId: string, options: { refresh?: boolean; signal?: AbortSignal } = {}) {
  requirePrivate(deps, 'The incident assistant');
  const detail = deps.analysis.getIncident(who.clientId, incidentId);
  return runSections(deps, who, 'incident-assist', INCIDENT_SECTIONS, INCIDENT_TASK(INCIDENT_SECTIONS), PROMPT_VERSION.incident, incidentEvidence(deps, who.clientId, detail), options);
}

export function assistCountry(deps: AiDeps, who: Actor, code: string, options: { refresh?: boolean; signal?: AbortSignal } = {}) {
  requirePrivate(deps, 'The country assistant');
  return runSections(deps, who, 'country-assist', COUNTRY_SECTIONS, COUNTRY_TASK(COUNTRY_SECTIONS), PROMPT_VERSION.country, countryEvidence(deps, who.clientId, code), options);
}

export { incidentEvidence, countryEvidence };
export type { Built, EvidenceDto };
