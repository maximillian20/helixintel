import { z } from 'zod';
import type { AiAnswerDto } from '../../src/data/aiTypes';
import { SEVERITIES } from '../../src/data/feedTypes';
import { CLAIM_JSON, allowedNumbers, claimSchema, cleanStrings, resolveClaims } from './claims';
import { GAPS_JSON, buildAnswer, cacheKey, evidenceKey, evidenceNotes, followUpTargets, gapsAndFollowUps, metaFrom, noModelMeta, questionFollowUps, type Actor, type AiDeps } from './common';
import { parseQuestion, retrieve, type Scope } from './evidence';
import { newNonce } from './guard';
import { ASK_TASK, PROMPT_VERSION, evidenceBlock, systemPrompt } from './prompts';

const askSchema = z.object({ claims: z.array(claimSchema).min(1).max(10), ...gapsAndFollowUps });

const askJson = {
  type: 'object',
  properties: { claims: { type: 'array', items: CLAIM_JSON }, ...GAPS_JSON },
  required: ['claims', 'gaps', 'follow_ups'],
};

export const scopeSchema = z.object({
  days: z.number().int().min(1).max(180).optional(),
  country: z.string().max(8).optional(),
  severity: z.enum(SEVERITIES).optional(),
  review: z.enum(['Reviewed', 'Unreviewed']).optional(),
  watchlistOnly: z.boolean().optional(),
}).strict();

export type AskInput = { question: string; scope?: Scope; refresh?: boolean };

/**
 * Ask Helix. Order matters: the question is turned into filters by plain code, retrieval applies those filters to the
 * records this browser may access, and only then does the model see the (bounded) evidence.
 */
export async function askHelix(deps: AiDeps, who: Actor, input: AskInput, signal?: AbortSignal): Promise<AiAnswerDto> {
  const { ai, aiStore, now } = deps;
  const question = input.question.replace(/\s+/g, ' ').trim().slice(0, 400);
  const filters = parseQuestion(question, now, input.scope);
  const retrieval = retrieve(deps, who.clientId, filters);
  const expectRecent = filters.from !== null && now.getTime() - filters.from.getTime() <= 72 * 3_600_000;

  if (retrieval.items.length === 0) {
    const answer = buildAnswer(deps, 'ask', {
      title: question, question, summary: 'Your accessible records do not contain anything that matches this question.',
      claims: [{ text: 'No reports, incidents, assessments or indicators matched these filters, so there is nothing to base an answer on.', basis: 'unknown', refs: [], independentSources: 0, headlineOnly: false }],
      sections: [], gaps: ['Try a wider time range, fewer filters, or different keywords.'], followUps: [], removedClaims: 0,
      notes: evidenceNotes(retrieval, { expectRecent }).slice(-2), meta: noModelMeta(deps, PROMPT_VERSION.ask), facts: [], retrieval,
    });
    const saved = aiStore.saveOutput(who.clientId, who.name, `none-${question}`, answer);
    aiStore.audit(who.clientId, who.name, 'ask', question, 'No matching records; the model was not called.', now.toISOString());
    return saved;
  }

  await ai.status();
  const key = cacheKey(deps, 'ask', PROMPT_VERSION.ask, question.toLowerCase(), retrieval.filters, evidenceKey(retrieval.items));
  if (!input.refresh) {
    const hit = aiStore.findCached(who.clientId, 'ask', key);
    if (hit) {
      ai.counters.cacheHits += 1;
      aiStore.audit(who.clientId, who.name, 'ask-cached', question, `Reused ${hit.id}; the model was not called.`, now.toISOString());
      return hit;
    }
  }

  const nonce = newNonce();
  const user = [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    `QUESTION: ${question}`,
    `FILTERS ALREADY APPLIED: ${retrieval.filters.join('; ')}`,
    `EVIDENCE (${retrieval.items.length} items; ids ${retrieval.items.map((item) => item.ref).join(', ')}):`,
    evidenceBlock(retrieval.items, nonce),
  ].join('\n');

  const generated = await ai.generate({
    task: 'ask', system: systemPrompt(ASK_TASK), user, schema: askSchema, jsonSchema: askJson, signal,
    check: (value) => {
      if (resolveClaims(value.claims, retrieval.items).claims.length === 0) throw new Error('No claim survived: cite evidence ids such as ["E1"] for every fact, and use only numbers that appear in the cited evidence.');
    },
  });

  const { claims, removed } = resolveClaims(generated.value.claims, retrieval.items);
  const allowed = allowedNumbers(retrieval.items);
  const answer = buildAnswer(deps, 'ask', {
    title: question, question, summary: claims[0]?.text ?? '', claims, sections: [],
    gaps: cleanStrings(generated.value.gaps, 6, 300, allowed), followUps: [...questionFollowUps(generated.value.follow_ups), ...followUpTargets(retrieval.items)],
    removedClaims: removed, notes: evidenceNotes(retrieval, { expectRecent }), meta: metaFrom(generated, PROMPT_VERSION.ask), facts: [], retrieval,
  });
  const saved = aiStore.saveOutput(who.clientId, who.name, key, answer);
  aiStore.audit(who.clientId, who.name, 'ask', question, `${saved.id}: ${claims.length} claims from ${retrieval.items.length} records (${retrieval.items.map((item) => item.id).slice(0, 12).join(', ')}); ${removed} removed; model ${generated.meta.model}.`, now.toISOString());
  return saved;
}
