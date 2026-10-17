import { z } from 'zod';
import type { AiAnswerDto, AiMeta, AiOutputKind, ClaimDto, EvidenceDto, FollowUp } from '../../src/data/aiTypes';
import { cleanStrings, type RawClaim } from './claims';
import type { Retrieval, RetrievalDeps } from './evidence';
import { AiService } from './service';
import { AiStore, sha } from './store';

export type AiDeps = RetrievalDeps & { ai: AiService; aiStore: AiStore };

export type Actor = { clientId: string; name: string };

export type Section = { heading: string; items: ClaimDto[] };

/** Public evidence shape: the prompt text and internal fingerprint stay on the server. */
export function publicEvidence(items: Retrieval['items']): EvidenceDto[] {
  return items.map(({ text: _text, fingerprint: _fingerprint, ...rest }) => rest);
}

export function evidenceKey(items: Retrieval['items']) {
  return sha(items.map((item) => [item.ref, item.kind, item.id, item.fingerprint]));
}

export function cacheKey(deps: AiDeps, kind: string, promptVersion: string, ...parts: unknown[]) {
  return sha(kind, promptVersion, deps.ai.modelVersion, ...parts);
}

export function metaFrom(generated: { meta: Omit<AiMeta, 'promptVersion'> }, promptVersion: string): AiMeta {
  return { ...generated.meta, promptVersion };
}

/** A visible "no model was used" meta for answers that needed no generation. */
export function noModelMeta(deps: AiDeps, promptVersion: string): AiMeta {
  return { model: 'none (no model call was needed)', modelDigest: null, promptVersion, generatedAt: deps.now.toISOString(), durationMs: 0, attempts: 0 };
}

/** Notes that code (not the model) adds so the reader knows how solid the evidence is. */
export function evidenceNotes(retrieval: Pick<Retrieval, 'items' | 'considered' | 'freshness'>, options: { expectRecent?: boolean; reportsUsed?: number } = {}): string[] {
  const notes: string[] = [];
  const reports = retrieval.items.filter((item) => item.kind === 'report');
  if (reports.length > 0 && reports.every((item) => item.depth === 'headline')) notes.push('Every report used had a headline only. No article text or publisher summary was available, so descriptions are limited to what the headlines say.');
  else if (reports.some((item) => item.depth === 'headline')) notes.push(`${reports.filter((item) => item.depth === 'headline').length} of ${reports.length} reports had a headline only.`);
  notes.push('Full article text is not stored by this app. Answers are based on headlines and the publisher\'s short summaries.');
  if (retrieval.considered > reports.length && reports.length > 0) notes.push(`${reports.length} of ${retrieval.considered} matching reports were used (the best matches, at most four per publisher).`);
  const flagged = retrieval.items.filter((item) => item.flagged).length;
  if (flagged > 0) notes.push(`${flagged} item${flagged === 1 ? '' : 's'} contained instruction-like wording. ${flagged === 1 ? 'It was' : 'They were'} passed to the model as data only and shown here so you can judge.`);
  const stale = retrieval.items.filter((item) => item.stale).length;
  if (stale > 0) notes.push(`${stale} item${stale === 1 ? ' is' : 's are'} old (reports over 72 hours, incidents over 30 days or assessments over 90 days).`);
  if (options.expectRecent && retrieval.freshness.newestReportAt) {
    const hours = Math.round((Date.parse(retrieval.freshness.generatedAt) - Date.parse(retrieval.freshness.newestReportAt)) / 3_600_000);
    if (hours >= 12) notes.push(`The newest matching report is ${hours} hours old.`);
  }
  if (retrieval.freshness.staleSources.length > 0) notes.push(`These sources are stale or unavailable, so recent events from them may be missing: ${retrieval.freshness.staleSources.slice(0, 6).join(', ')}.`);
  const independent = new Set(reports.map((item) => item.independenceGroup)).size;
  if (reports.length > independent) notes.push(`${reports.length} reports come from ${independent} independent source group${independent === 1 ? '' : 's'}: reports from the same publisher or with near-identical wording count once.`);
  return notes;
}

export function followUpTargets(items: Retrieval['items']): FollowUp[] {
  const targets: FollowUp[] = [];
  for (const item of items) {
    if (!item.link || item.kind === 'report') continue;
    if (targets.some((target) => target.target?.id === item.link!.id && target.target?.view === item.link!.view)) continue;
    targets.push({ label: item.kind === 'incident' ? `Open ${item.id}` : item.kind === 'country' ? `Open the ${item.title.split(' country')[0]} assessment` : `Open ${item.title}`, target: item.link });
  }
  return targets.slice(0, 4);
}

export function questionFollowUps(values: string[], limit = 3): FollowUp[] {
  return cleanStrings(values, limit, 160).map((question) => ({ label: question, question }));
}

export const gapsAndFollowUps = {
  gaps: z.array(z.string().max(300)).max(6).default([]),
  follow_ups: z.array(z.string().max(160)).max(4).default([]),
};

export const GAPS_JSON = {
  gaps: { type: 'array', items: { type: 'string' } },
  follow_ups: { type: 'array', items: { type: 'string' } },
};

export function rawClaimsOf(value: unknown): RawClaim[] {
  return Array.isArray(value) ? (value as RawClaim[]) : [];
}

export type AnswerParts = Omit<AiAnswerDto, 'id' | 'status' | 'cached'>;

export function buildAnswer(deps: AiDeps, kind: AiOutputKind, parts: Omit<AnswerParts, 'kind' | 'evidence' | 'filters' | 'considered' | 'freshness'> & { retrieval: Retrieval }): AnswerParts {
  const { retrieval, ...rest } = parts;
  void deps;
  return { kind, ...rest, evidence: publicEvidence(retrieval.items), filters: retrieval.filters, considered: retrieval.considered, freshness: retrieval.freshness };
}
