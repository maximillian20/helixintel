import { z } from 'zod';
import type { AiAnswerDto } from '../../src/data/aiTypes';
import type { FeedItemDto } from '../../src/data/feedTypes';
import type { SibAiMeta, SibEvidence, SibFields, SibRecord, SibSourceRef } from '../../src/data/sibTypes';
import { NotFoundError, ValidationError } from '../analysis-store';
import type { SibStore } from '../sib-store';
import { allowedNumbers } from './claims';
import { buildAnswer, evidenceNotes, metaFrom, type Actor, type AiDeps } from './common';
import { countryEvidence, incidentEvidence, requirePrivate, type Built } from './assist';
import { finalise, freshnessOf, reportDraft } from './evidence';
import { newNonce, stripModelLinks, ungroundedNumbers } from './guard';
import { PROMPT_VERSION, evidenceBlock, systemPrompt } from './prompts';

export type SibPrefill = { fields: SibFields; source: SibSourceRef; evidence: SibEvidence[] };

export type SibDraftInput =
  | { type: 'incident'; id: string }
  | { type: 'country'; code: string }
  | { type: 'reports'; ids: string[] };

const NO_EMPLOYEE = 'No employee impact can be assessed from the available evidence.';
const NO_OPERATIONS = 'No operational impact can be assessed from the available evidence.';

const draftSchema = z.object({
  summary: z.string().min(10).max(1000),
  situation: z.string().min(10).max(2400),
  employee_impact: z.string().min(5).max(1100),
  operations_impact: z.string().min(5).max(1100),
  actions: z.array(z.string().min(3).max(280)).min(1).max(6),
  uncertainties: z.string().min(3).max(1000),
  review_in_days: z.number().int().min(1).max(30),
});

const draftJson = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, situation: { type: 'string' }, employee_impact: { type: 'string' }, operations_impact: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } }, uncertainties: { type: 'string' }, review_in_days: { type: 'integer' },
  },
  required: ['summary', 'situation', 'employee_impact', 'operations_impact', 'actions', 'uncertainties', 'review_in_days'],
};

const TASK = `Draft a Security Information Bulletin for employees and operations managers, using only the evidence. A person will edit and approve it; you only prepare the first draft.
- "summary": executive summary, 2 to 4 sentences: what happened, where, and why it matters.
- "situation": what is currently reported, newest first, naming who reports it; point out disagreements and gaps. At most 8 sentences.
- "employee_impact": possible effects on employees (safety, travel, working conditions). Use "may" or "could". If the evidence gives no basis, write exactly: ${NO_EMPLOYEE}
- "operations_impact": possible effects on sites, suppliers, routes or services. Same wording rule. If no basis, write exactly: ${NO_OPERATIONS}
- "actions": 2 to 6 suggested actions for the reader to review, each starting with a verb and proportionate to the evidence (monitor, verify with the sources, check on named assets, brief travellers). Nothing drastic unless the evidence supports it.
- "uncertainties": what is not known, disputed, or based on headlines only.
- "review_in_days": a whole number from 1 to 30; shorter when the situation is changing quickly.
After each statement in "summary" and "situation", put the evidence id in square brackets, for example "... [E2]". Use no other square brackets. Do not state severity levels, approval, or distribution; people decide those.
Schema: {"summary":"","situation":"","employee_impact":"","operations_impact":"","actions":[""],"uncertainties":"","review_in_days":7}`;

/** Replaces [E3] markers by numbered source labels that match the bulletin's own source list; unknown markers are removed. */
export function convertMarkers(text: string, items: Array<{ ref: string; kind: string; id: string; url: string | null; title: string }>, evidence: SibEvidence[]): string {
  const label = (ref: string): string | null => {
    const item = items.find((entry) => entry.ref === ref.toUpperCase());
    if (!item) return null;
    if (item.kind === 'report') {
      const index = evidence.findIndex((entry) => (item.url && entry.url === item.url) || entry.headline.trim().toLowerCase() === item.title.trim().toLowerCase());
      return index >= 0 ? String(index + 1) : null;
    }
    if (item.kind === 'incident') return item.id;
    if (item.kind === 'country') return `${item.id} assessment`;
    return null;
  };
  return text
    .replace(/\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\]/gi, (_match, group: string) => {
      const labels = [...new Set(group.split(/[,;]/).map((ref) => label(ref.trim())).filter((value): value is string => value !== null))];
      return labels.length > 0 ? `[${labels.join(', ')}]` : '';
    })
    .replace(/\[\s*E\d+[^\]]*\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}

function reportsBuilt(deps: AiDeps, items: FeedItemDto[]): Built {
  const drafts = items.map((item) => reportDraft(item, deps.now));
  const finalised = finalise(drafts);
  return {
    retrieval: { items: finalised, filters: [`${items.length} selected report${items.length === 1 ? '' : 's'}`, 'Only records your browser may access'], considered: items.length, freshness: freshnessOf(deps, finalised) },
    facts: [], title: `Bulletin draft from ${items.length} selected report${items.length === 1 ? '' : 's'}`, subjectKey: items.map((item) => item.id).join(','), extraNotes: [],
  };
}

export async function draftSibWithAi(
  deps: AiDeps & { sibs: SibStore; prefill: (clientId: string, input: SibDraftInput) => { prefill: SibPrefill; built?: Built; reports?: FeedItemDto[] } },
  who: Actor,
  input: SibDraftInput,
  signal?: AbortSignal,
): Promise<{ sib: SibRecord; output: AiAnswerDto }> {
  const { ai, aiStore, now } = deps;
  if (input.type !== 'reports') requirePrivate(deps, 'A bulletin drafted from an incident or country assessment');
  const resolved = deps.prefill(who.clientId, input);
  const { prefill } = resolved;
  const built: Built = resolved.built ?? reportsBuilt(deps, resolved.reports ?? []);
  const items = built.retrieval.items;
  if (items.length === 0) throw new ValidationError('There is no evidence to draft from.');
  await ai.status();

  const factText = built.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
  const allowed = allowedNumbers(items, [factText]);
  const nonce = newNonce();
  const user = [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    `BULLETIN TOPIC: ${prefill.fields.title}`,
    ...(built.facts.length ? ['CALCULATED BY THE APP:', ...built.facts.map((fact) => `- ${fact.label}: ${fact.value}`)] : []),
    `EVIDENCE (ids ${items.map((item) => item.ref).join(', ')}):`,
    evidenceBlock(items, nonce),
  ].join('\n');

  const generated = await ai.generate({
    task: 'sib-draft', system: systemPrompt(TASK), user, schema: draftSchema, jsonSchema: draftJson, signal, maxTokens: 1800,
    check: (value) => {
      const text = [value.summary, value.situation, value.employee_impact, value.operations_impact, value.uncertainties, ...value.actions].join(' ');
      const bad = ungroundedNumbers(text.replace(/\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/gi, ''), allowed);
      if (bad.length > 0) throw new Error(`The draft contains numbers that are not in the evidence (${bad.join(', ')}). Use only numbers from the evidence.`);
      if (!/\[\s*E\d+/i.test(value.summary) && !/\[\s*E\d+/i.test(value.situation)) throw new Error('Cite the evidence id after each statement in the summary and situation, for example [E2].');
    },
  });
  const draft = generated.value;
  const evidence = prefill.evidence;
  const tidy = (text: string) => stripModelLinks(convertMarkers(text, items, evidence));
  const reports = items.filter((item) => item.kind === 'report');
  const notes: string[] = [];
  if (reports.some((item) => item.depth === 'headline')) notes.push(`${reports.filter((item) => item.depth === 'headline').length} of ${reports.length} source reports had a headline only.`);
  const review = new Date(now.getTime() + draft.review_in_days * 86_400_000).toISOString().slice(0, 10);
  const ageHours = built.retrieval.freshness.newestReportAt ? Math.round((now.getTime() - Date.parse(built.retrieval.freshness.newestReportAt)) / 3_600_000) : null;
  const uncertainties = [
    tidy(draft.uncertainties),
    'Impact statements are potential and unconfirmed. Nothing here shows that any person, site or supplier has been affected unless a source says so.',
    ...notes,
    ageHours !== null && ageHours >= 12 ? `The newest source was ${ageHours} hours old when this was drafted.` : '',
  ].filter(Boolean).join('\n');

  const fields: SibFields = {
    ...prefill.fields,
    summary: tidy(draft.summary),
    situation: tidy(draft.situation),
    employeeImpact: draft.employee_impact.trim() === NO_EMPLOYEE ? NO_EMPLOYEE : tidy(draft.employee_impact),
    operationsImpact: draft.operations_impact.trim() === NO_OPERATIONS ? NO_OPERATIONS : tidy(draft.operations_impact),
    actions: [...prefill.fields.actions, ...draft.actions.map((action) => stripModelLinks(convertMarkers(action, items, evidence))).filter(Boolean)].slice(0, 30),
    uncertainties,
    nextReviewDate: review,
  };

  const output = aiStore.saveOutput(who.clientId, who.name, `sib-${now.getTime()}`, buildAnswer(deps, 'sib-draft', {
    title: `Bulletin draft: ${prefill.fields.title}`, question: null, summary: fields.summary, claims: [],
    sections: [
      { heading: 'Executive summary', items: [{ text: fields.summary, basis: 'interpretation', refs: [], independentSources: 0, headlineOnly: false }] },
      { heading: 'Current situation', items: [{ text: fields.situation, basis: 'interpretation', refs: [], independentSources: 0, headlineOnly: false }] },
      { heading: 'Suggested actions for review', items: draft.actions.map((action) => ({ text: stripModelLinks(action), basis: 'interpretation' as const, refs: [], independentSources: 0, headlineOnly: false })) },
    ],
    gaps: [], followUps: [], removedClaims: 0, notes: ['A new bulletin draft was created. Nothing is approved or sent.', ...evidenceNotes(built.retrieval)],
    meta: metaFrom(generated, PROMPT_VERSION.sib), facts: built.facts, retrieval: built.retrieval,
  }));
  const ai_: SibAiMeta = {
    model: generated.meta.model, modelDigest: generated.meta.modelDigest, promptVersion: PROMPT_VERSION.sib, generatedAt: generated.meta.generatedAt,
    recordIds: items.map((item) => `${item.kind}:${item.id}`), outputId: output.id, confirmedBy: null, confirmedAt: null,
  };
  const sib = deps.sibs.create(who.clientId, who.name, { fields, source: prefill.source, evidence, ai: ai_ }, now.toISOString());
  aiStore.audit(who.clientId, who.name, 'sib-draft', sib.id, `Created draft ${sib.id} from ${prefill.source.label} with ${generated.meta.model} (output ${output.id}). Status Draft; not approved, not sent.`, now.toISOString());
  return { sib, output };
}

export { incidentEvidence, countryEvidence, NotFoundError };
