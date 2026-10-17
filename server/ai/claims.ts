import { z } from 'zod';
import type { ClaimBasis, ClaimDto, EvidenceDto } from '../../src/data/aiTypes';
import { numbersIn, stripModelLinks, ungroundedNumbers } from './guard';

/**
 * Turns the model's claims into claims the app is willing to show. The model proposes; this code decides:
 *  - citations that do not exist are dropped, and a factual claim with no valid citation is removed;
 *  - "reported" versus "corroborated" is counted from independent publishers, never taken from the model;
 *  - numbers the cited evidence does not contain remove the claim;
 *  - links and addresses are stripped from the text.
 */

export const claimSchema = z.object({
  text: z.string().min(3).max(600),
  kind: z.enum(['fact', 'interpretation', 'unknown', 'conflict']),
  evidence: z.array(z.string().max(8)).max(8).default([]),
});
export type RawClaim = z.infer<typeof claimSchema>;

export const CLAIM_JSON = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    kind: { type: 'string', enum: ['fact', 'interpretation', 'unknown', 'conflict'] },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'kind', 'evidence'],
} as const;

export const STRING_ARRAY_JSON = { type: 'array', items: { type: 'string' } } as const;

type EvidenceLike = Pick<EvidenceDto, 'ref' | 'kind' | 'depth' | 'independenceGroup' | 'publishedAt'> & { text: string; title?: string };

function dateNumbers(iso: string | null): string[] {
  if (!iso) return [];
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!match) return [];
  return match.slice(1).filter(Boolean).flatMap((part) => [part, String(Number(part))]);
}

export function allowedNumbers(items: EvidenceLike[], extra: string[] = []): Set<string> {
  const set = new Set<string>();
  for (const item of items) {
    for (const n of numbersIn(`${item.title ?? ''} ${item.text}`)) set.add(n);
    for (const n of dateNumbers(item.publishedAt)) set.add(n);
  }
  for (const text of extra) for (const n of numbersIn(text)) set.add(n);
  return set;
}

export type ResolveOptions = {
  /** Every claim is shown as AI interpretation (used for impact and exposure sections). */
  forceInterpretation?: boolean;
  maxClaims?: number;
  /** Extra numbers allowed in addition to those in the cited evidence (for example figures supplied by code). */
  extraAllowed?: string[];
  /** Remove a claim when its text breaks a content rule (for example a market forecast). */
  reject?: (text: string) => boolean;
};

export function resolveClaims(raw: RawClaim[], evidence: EvidenceLike[], options: ResolveOptions = {}): { claims: ClaimDto[]; removed: number } {
  const byRef = new Map(evidence.map((item) => [item.ref, item]));
  const everything = allowedNumbers(evidence, options.extraAllowed);
  const claims: ClaimDto[] = [];
  let removed = 0;
  for (const claim of raw.slice(0, options.maxClaims ?? 12)) {
    const text = stripModelLinks(claim.text);
    const cited = [...new Set(claim.evidence.map((ref) => ref.trim().toUpperCase()))].filter((ref) => byRef.has(ref));
    const items = cited.map((ref) => byRef.get(ref)!);
    const kind = options.forceInterpretation && claim.kind !== 'unknown' ? 'interpretation' : claim.kind;
    if ((kind === 'fact') && items.length === 0) { removed += 1; continue; }
    if (kind === 'conflict' && items.length < 2) { removed += 1; continue; }
    if (!text || options.reject?.(text)) { removed += 1; continue; }

    const allowed = items.length > 0 && kind !== 'interpretation' ? allowedNumbers(items, options.extraAllowed) : everything;
    if (ungroundedNumbers(text, allowed).length > 0) { removed += 1; continue; }

    const reports = items.filter((item) => item.kind === 'report');
    const independentSources = new Set(reports.map((item) => item.independenceGroup)).size;
    let basis: ClaimBasis;
    if (kind === 'unknown') basis = 'unknown';
    else if (kind === 'interpretation') basis = 'interpretation';
    else if (kind === 'conflict') basis = 'conflict';
    else basis = independentSources >= 2 ? 'corroborated' : 'reported';
    claims.push({ text, basis, refs: cited, independentSources, headlineOnly: reports.length > 0 && reports.length === items.length && reports.every((item) => item.depth === 'headline') });
  }
  return { claims, removed };
}

/** Plain strings from the model (gaps, follow-ups): links stripped, bounded, no invented numbers. */
export function cleanStrings(values: string[], max: number, maxLength: number, allowed?: Set<string>): string[] {
  return values
    .map((value) => stripModelLinks(value).slice(0, maxLength))
    .filter((value) => value.length >= 3 && (!allowed || ungroundedNumbers(value, allowed).length === 0))
    .slice(0, max);
}
