import { z } from 'zod';
import type { AiAnswerDto, EvidenceDto } from '../../src/data/aiTypes';
import { countryName } from '../../src/data/countries';
import { NotFoundError, ValidationError } from '../analysis-store';
import { buildAllItems } from '../feed-service';
import { computeIndicator, getDefinition, loadIndicatorData } from '../indicators';
import { associations, eventView, findEvent, type MarketDeps } from '../market-service';
import { CLAIM_JSON, claimSchema, cleanStrings, resolveClaims } from './claims';
import { GAPS_JSON, buildAnswer, cacheKey, evidenceKey, evidenceNotes, followUpTargets, gapsAndFollowUps, metaFrom, questionFollowUps, type Actor, type AiDeps, type Section } from './common';
import { requirePrivate } from './assist';
import { finalise, freshnessOf, indicatorDraft, indicatorFacts, reportDraft, type Retrieval } from './evidence';
import { cleanUntrusted, containsForecast, newNonce } from './guard';
import { PROMPT_VERSION, evidenceBlock, systemPrompt } from './prompts';
import { sha } from './store';

type Facts = AiAnswerDto['facts'];

function sectionSchema(keys: string[]) {
  return z.object({ ...Object.fromEntries(keys.map((key) => [key, z.array(claimSchema).max(5).default([])])), ...gapsAndFollowUps });
}
function sectionJson(keys: string[]) {
  return { type: 'object', properties: { ...Object.fromEntries(keys.map((key) => [key, { type: 'array', items: CLAIM_JSON }])), ...GAPS_JSON }, required: [...keys, 'gaps', 'follow_ups'] };
}

type Spec = {
  kind: 'indicator-explain' | 'market-explain';
  promptVersion: string;
  title: string;
  subjectKey: string;
  task: string;
  sections: Array<{ key: string; heading: string; interpretation: boolean }>;
  facts: Facts;
  retrieval: Retrieval;
  extraNotes: string[];
};

async function run(deps: AiDeps, who: Actor, spec: Spec, options: { refresh?: boolean; signal?: AbortSignal }): Promise<AiAnswerDto> {
  const { ai, aiStore, now } = deps;
  await ai.status();
  const factText = spec.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
  const key = cacheKey(deps, spec.kind, spec.promptVersion, spec.subjectKey, evidenceKey(spec.retrieval.items), factText);
  if (!options.refresh) {
    const hit = aiStore.findCached(who.clientId, spec.kind, key);
    if (hit) {
      ai.counters.cacheHits += 1;
      aiStore.audit(who.clientId, who.name, `${spec.kind}-cached`, spec.title, `Reused ${hit.id}; the model was not called.`, now.toISOString());
      return hit;
    }
  }
  const keys = spec.sections.map((section) => section.key);
  const nonce = newNonce();
  const user = [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    'NUMBERS CALCULATED BY THE APP (use these exactly; you may not add or change any number):', ...spec.facts.map((fact) => `- ${cleanUntrusted(`${fact.label}: ${fact.value}`, 420)}`),
    `EVIDENCE (ids ${spec.retrieval.items.map((item) => item.ref).join(', ')}):`, evidenceBlock(spec.retrieval.items, nonce),
  ].join('\n');
  const options2 = { extraAllowed: [factText], reject: containsForecast };
  const generated = await ai.generate({
    task: spec.kind, system: systemPrompt(spec.task), user, schema: sectionSchema(keys), jsonSchema: sectionJson(keys), signal: options.signal,
    check: (value) => {
      const record = value as Record<string, unknown>;
      const ok = spec.sections.some((section) => resolveClaims((record[section.key] as never[]) ?? [], spec.retrieval.items, { ...options2, forceInterpretation: section.interpretation }).claims.length > 0);
      if (!ok) throw new Error('No claim survived. Cite evidence ids such as ["E1"], use only the numbers given, and do not forecast or advise trades.');
    },
  });
  const record = generated.value as Record<string, unknown>;
  const sections: Section[] = [];
  let removed = 0;
  for (const section of spec.sections) {
    const resolved = resolveClaims((record[section.key] as never[]) ?? [], spec.retrieval.items, { ...options2, forceInterpretation: section.interpretation, maxClaims: 4 });
    removed += resolved.removed;
    if (resolved.claims.length > 0) sections.push({ heading: section.heading, items: resolved.claims });
  }
  const answer = buildAnswer(deps, spec.kind, {
    title: spec.title, question: null, summary: sections[0]?.items[0]?.text ?? '', claims: [], sections,
    gaps: cleanStrings(((record.gaps as string[]) ?? []).filter((gap) => !containsForecast(gap)), 5, 300), followUps: [...questionFollowUps((record.follow_ups as string[]) ?? []), ...followUpTargets(spec.retrieval.items)],
    removedClaims: removed, notes: [...spec.extraNotes, ...evidenceNotes(spec.retrieval)], meta: metaFrom(generated, spec.promptVersion), facts: spec.facts, retrieval: spec.retrieval,
  });
  const saved = aiStore.saveOutput(who.clientId, who.name, key, answer);
  aiStore.audit(who.clientId, who.name, spec.kind, spec.title, `${saved.id}: ${sections.reduce((n, s) => n + s.items.length, 0)} claims; ${removed} removed; model ${generated.meta.model}.`, now.toISOString());
  return saved;
}

// ---------------------------------------------------------------- Threat Indicators

const INDICATOR_TASK = `Explain one threat indicator to an analyst. The indicator's numbers, baseline, thresholds and level were calculated by the app from stored reports and are listed under NUMBERS; EVIDENCE E1 repeats them and later items are some of the reports counted.
Sections (0 to 4 claims each):
- explanation: what the numbers say in plain words (current level against baseline, trend, how much history there is). Use the given numbers exactly.
- caveats: what limits the reading (reporting activity is not the same as events, coverage gaps, small baselines, source outages).
- questions_to_ask: questions an analyst could investigate next. Not predictions.
Never predict incidents or say something will happen. A rising count is a change in reporting, which may or may not reflect real events.
Schema: {"explanation":[claim],"caveats":[claim],"questions_to_ask":[claim],"gaps":[],"follow_ups":[]} where claim = {"text":"","kind":"fact|interpretation|conflict|unknown","evidence":["E1"]}`;

export async function explainIndicator(deps: AiDeps, who: Actor, input: { indicatorId: string; geo: string }, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AiAnswerDto> {
  const def = getDefinition(input.indicatorId);
  if (!def) throw new NotFoundError('Unknown indicator.');
  const geo = def.perCountry ? input.geo : 'ALL';
  const ctx = { store: deps.store, sources: deps.sources, env: deps.env, now: deps.now };
  const reading = computeIndicator(def, geo, deps.analysis.getIndicatorSettings(who.clientId, def.id, geo), ctx, loadIndicatorData(ctx));
  if (reading.current === null) throw new ValidationError(`There is nothing to explain yet: ${reading.notes[0] ?? `the indicator is ${reading.dataStatus.replace('_', ' ')}`}.`);
  const byId = new Map(buildAllItems(deps.store, who.clientId).map((item) => [item.id, item]));
  const latestWeek = reading.weeks.at(-1);
  const reports = (latestWeek?.evidence ?? []).map((entry) => byId.get(entry.articleId)).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 5);
  const history = reading.weeks.filter((week) => week.value !== null).slice(-8).map((week) => `${week.start}: ${week.value}`).join('; ');
  const facts: Facts = [...indicatorFacts(reading), { label: 'Weekly values (oldest to newest)', value: history || 'none' }];
  const items = finalise([indicatorDraft(reading, def.id, geo), ...reports.map((item) => reportDraft(item, deps.now))]);
  const retrieval: Retrieval = { items, filters: [`${reading.name}, ${reading.geoName}`, 'Numbers calculated by the app; the model only explains them'], considered: reports.length, freshness: freshnessOf(deps, items) };
  return run(deps, who, {
    kind: 'indicator-explain', promptVersion: PROMPT_VERSION.indicator, title: `Explain: ${reading.name} (${reading.geoName})`, subjectKey: `${def.id}|${geo}|${reading.current}|${reading.level}|${reading.trend}`,
    task: INDICATOR_TASK, sections: [
      { key: 'explanation', heading: 'What the numbers say', interpretation: false },
      { key: 'caveats', heading: 'Caveats', interpretation: true },
      { key: 'questions_to_ask', heading: 'Questions worth investigating (not predictions)', interpretation: true },
    ], facts, retrieval, extraNotes: ['All measurements above were calculated by the app. The model explains them and cannot change them.'],
  }, options);
}

// ---------------------------------------------------------------- Market Impact

const MARKET_TASK = `Explain how an event might relate to market assets, for an analyst. Relevance (why the app linked the asset), the observed price reaction and the statistical association were all calculated by the app and appear under NUMBERS. Keep these three ideas separate and never blur them: a link is not a reaction, and a reaction or association is not proof of cause.
Sections (0 to 4 claims each):
- exposure_pathways: plausible ways the event could matter to the asset (supply, demand, sentiment, regulation, logistics), as possibilities.
- alternative_explanations: other things that could explain a price move around the same time, including general market moves and scheduled news.
- limitations: what the observed data cannot show (few events, overlapping events, market hours, benchmark adjustment, delayed prices).
Forbidden: forecasts, targets, "will rise/fall", guarantees, buy/sell advice. You may restate the given numbers exactly; you may not add any.
Schema: {"exposure_pathways":[claim],"alternative_explanations":[claim],"limitations":[claim],"gaps":[],"follow_ups":[]} where claim = {"text":"","kind":"fact|interpretation|conflict|unknown","evidence":["E1"]}`;

export async function explainMarket(deps: AiDeps & { market: MarketDeps['market'] }, who: Actor, input: { eventKey: string; assetId?: string }, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AiAnswerDto> {
  const mdeps: MarketDeps = { store: deps.store, analysis: deps.analysis, market: deps.market, env: deps.env, now: deps.now };
  const event = findEvent(mdeps, who.clientId, input.eventKey);
  if (event && event.type === 'incident') requirePrivate(deps, 'Explaining an event that comes from one of your incidents');
  if (!event) throw new NotFoundError('Event not found.');
  const view = eventView(mdeps, who.clientId, event);
  const assets = (input.assetId ? view.assets.filter((entry) => entry.asset.id === input.assetId) : view.assets.filter((entry) => entry.link.status !== 'rejected').slice(0, 3));
  if (assets.length === 0) throw new ValidationError('No market asset is linked to this event, so there is nothing to explain yet.');

  const facts: Facts = [
    { label: 'Event', value: `${view.event.title} (${view.event.severity}, ${view.event.category}); earliest report ${view.event.anchorAt.slice(0, 16).replace('T', ' ')} UTC from ${view.event.anchorSource}; ${view.event.members.length} de-duplicated report${view.event.members.length === 1 ? '' : 's'}` },
  ];
  for (const entry of assets) {
    const a = entry.asset;
    facts.push({ label: `${a.symbol}: why it is linked (relevance, not a reaction)`, value: entry.link.explanation ? `${entry.link.explanation.relevance}. ${entry.link.explanation.basis}` : 'Added by an analyst' });
    const measured = entry.reactions.filter((reaction) => reaction.status === 'ok');
    facts.push({
      label: `${a.symbol}: observed price reaction (measured, not causal)`,
      value: measured.length > 0
        ? measured.map((reaction) => `${reaction.window}: ${reaction.returnPct === null ? 'n/a' : `${reaction.returnPct.toFixed(2)}%`}${reaction.adjustedPct === null ? '' : `, ${reaction.adjustedPct.toFixed(2)} points versus ${entry.benchmark?.symbol ?? 'benchmark'}`}`).join('; ')
        : `No window could be measured yet (${[...new Set(entry.reactions.map((reaction) => reaction.status))].join(', ') || 'no prices'}).`,
    });
    const assoc = associations(mdeps, who.clientId, { assetId: a.id, category: event.categoryIds[0], window: '24h' }).results.slice(0, 1);
    facts.push({
      label: `${a.symbol}: statistical association across past similar events`,
      value: assoc.length > 0
        ? assoc.map((result) => `${result.label}; ${result.usedEvents} comparable events, median ${result.median === null ? 'n/a' : `${result.median.toFixed(2)}%`}, sign-test p ${result.signTestP === null ? 'n/a' : result.signTestP.toFixed(3)}${result.adjustedP === null ? '' : `, adjusted p ${result.adjustedP.toFixed(3)}`}`).join('; ')
        : 'Not enough comparable past events to calculate an association.',
    });
  }
  const byId = new Map(buildAllItems(deps.store, who.clientId).map((item) => [item.id, item]));
  const reports = view.event.members.map((member) => byId.get(member.articleId)).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 4);
  const marketDraft = {
    ref: '', kind: 'market' as const, id: view.event.key, title: `Market view of: ${view.event.title}`, excerpt: assets.flatMap((entry) => (entry.why ? [`${entry.asset.symbol}: ${entry.why.pathway} Alternatives noted by the app: ${entry.why.alternatives.join(' ')} ${entry.why.caution}`] : [])).join(' ').slice(0, 900),
    url: null, source: 'Calculated by this app', sourceId: null, publishedAt: view.computedAt, retrievedAt: null, depth: 'computed' as const, severity: view.event.severity,
    countries: view.event.countries.map((country) => country.code), link: { view: 'Market Impact' as const, id: view.event.key }, independenceGroup: 'market', flagged: false, stale: false, note: null, text: '', fingerprint: sha(view.event.key, view.computedAt.slice(0, 13)),
  };
  const items = finalise([marketDraft, ...reports.map((item) => reportDraft(item, deps.now))]);
  const retrieval: Retrieval = { items, filters: [`Event: ${view.event.title}`, `Assets: ${assets.map((entry) => entry.asset.symbol).join(', ')}`], considered: view.event.members.length, freshness: freshnessOf(deps, items) };
  void countryName;
  return run(deps, who, {
    kind: 'market-explain', promptVersion: PROMPT_VERSION.market, title: `Market view: ${view.event.title}`, subjectKey: `${view.event.key}|${assets.map((entry) => entry.asset.id).join(',')}`,
    task: MARKET_TASK, sections: [
      { key: 'exposure_pathways', heading: 'Plausible exposure pathways (AI interpretation)', interpretation: true },
      { key: 'alternative_explanations', heading: 'Alternative explanations (AI interpretation)', interpretation: true },
      { key: 'limitations', heading: 'What this cannot show', interpretation: true },
    ], facts, retrieval,
    extraNotes: ['Relevance, observed reaction and statistical association are three different things and are shown separately above. Prices are not a forecast and nothing here is trading advice.'],
  }, options);
}

export type { EvidenceDto };
