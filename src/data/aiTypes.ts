import type { Severity } from './feedTypes';

/**
 * Shared shapes for the AI features. Every AI result carries the evidence it used, the model that produced it and the
 * prompt version, so an analyst can always inspect where a sentence came from.
 */

export type AiState = 'disabled' | 'setup_required' | 'unreachable' | 'model_missing' | 'limit_reached' | 'ready';

export type AiStatusDto = {
  state: AiState;
  /** Plain-language explanation, safe to show to anyone. */
  message: string;
  /** What to do next when state is not ready. */
  steps: string[];
  model: string;
  /** Digest reported by the runtime; part of every cache key. null until the runtime has been reached. */
  modelDigest: string | null;
  /** Host only. Credentials are never returned. */
  endpoint: string | null;
  checkedAt: string;
  queue: { running: number; waiting: number; limit: number; concurrency: number };
  counters: { generated: number; cacheHits: number; failures: number; timeouts: number; rejectedInvalid: number };
  /** Always 0: the service only contacts the one configured Ollama endpoint. Shown so the guarantee is visible. */
  paidProviderCalls: 0;
  autoEnrich: 'off' | 'critical-high' | 'all';
  provider: 'ollama' | 'cloudflare';
  /** Whether private incidents, assessments and saved places may be put into prompts (always true for a model on your own computer). */
  privateRecords: boolean;
  /** Hosted provider only: requests and tokens used today (UTC), counted by this server since it started. */
  usage: { day: string; requests: number; promptTokens: number; completionTokens: number } | null;
  /** Whether this browser has switched AI features off for itself. */
  userEnabled: boolean;
};

/** headline = only the title was available; summary = title plus the publisher's short summary. Full article text is never stored. */
export type EvidenceDepth = 'headline' | 'summary' | 'analyst-record' | 'computed';

export const DEPTH_LABELS: Record<EvidenceDepth, string> = {
  headline: 'Headline only',
  summary: 'Headline and publisher summary',
  'analyst-record': 'Analyst-written record',
  computed: 'Calculated by the app',
};

export type EvidenceKind = 'report' | 'incident' | 'country' | 'indicator' | 'place' | 'market';

export type EvidenceLinkTarget = { view: 'Intelligence Feed' | 'Incidents' | 'Country Assessments' | 'Threat Indicators' | 'Market Impact' | 'Map' | 'SIBs'; id?: string };

export type EvidenceDto = {
  ref: string;
  kind: EvidenceKind;
  id: string;
  title: string;
  excerpt: string;
  url: string | null;
  source: string | null;
  sourceId: string | null;
  publishedAt: string | null;
  retrievedAt: string | null;
  depth: EvidenceDepth;
  severity: Severity | null;
  countries: string[];
  link: EvidenceLinkTarget | null;
  /** Reports in the same group are the same publisher or near-identical text, so they count as one source. */
  independenceGroup: string;
  /** The text contained instruction-like wording. It was passed to the model as data only. */
  flagged: boolean;
  /** Older than the freshness limit for this kind of record. */
  stale: boolean;
  /** Relationship computed by code, for example "potential exposure: 32 km from your saved place X". Never a confirmed impact. */
  note: string | null;
};

export type ClaimBasis = 'reported' | 'corroborated' | 'interpretation' | 'conflict' | 'unknown';

export const BASIS_LABELS: Record<ClaimBasis, string> = {
  reported: 'Reported',
  corroborated: 'Corroborated',
  interpretation: 'AI interpretation',
  conflict: 'Conflicting accounts',
  unknown: 'Unknown or insufficient evidence',
};

export type ClaimDto = {
  text: string;
  basis: ClaimBasis;
  refs: string[];
  /** Number of independent publishers behind the cited reports (syndicated copies count once). */
  independentSources: number;
  /** Every cited report had a headline only, so the claim rests on titles rather than on any description of the event. */
  headlineOnly: boolean;
};

export type FollowUp = { label: string; question?: string; target?: EvidenceLinkTarget };

export type FreshnessDto = {
  newestReportAt: string | null;
  oldestReportAt: string | null;
  lastSourceSuccessAt: string | null;
  staleSources: string[];
  generatedAt: string;
};

export type AiMeta = {
  model: string;
  modelDigest: string | null;
  promptVersion: string;
  generatedAt: string;
  durationMs: number;
  attempts: number;
};

export type AiOutputKind = 'ask' | 'incident-assist' | 'country-assist' | 'briefing' | 'indicator-explain' | 'market-explain' | 'sib-draft';

export type AiAnswerDto = {
  id: string;
  kind: AiOutputKind;
  title: string;
  question: string | null;
  summary: string;
  claims: ClaimDto[];
  evidence: EvidenceDto[];
  /** Filters applied BEFORE retrieval, in plain words. */
  filters: string[];
  considered: number;
  freshness: FreshnessDto;
  gaps: string[];
  followUps: FollowUp[];
  /** Extra labelled sections (for assists and briefings). */
  sections: Array<{ heading: string; items: ClaimDto[] }>;
  /** Claims the model produced that were removed because they cited nothing valid. */
  removedClaims: number;
  notes: string[];
  meta: AiMeta;
  cached: boolean;
  status: 'active' | 'dismissed';
  /** Facts calculated by code and passed through unchanged (indicator and market numbers). */
  facts: Array<{ label: string; value: string }>;
};

export type AiOutputSummary = Pick<AiAnswerDto, 'id' | 'kind' | 'title' | 'question' | 'status'> & { generatedAt: string; model: string };

// ---------------------------------------------------------------- report enrichment

export type EnrichmentDto = {
  articleId: string;
  summary: string;
  keyFacts: string[];
  category: string | null;
  countries: Array<{ code: string; name: string }>;
  organisations: string[];
  eventDate: string | null;
  /** ISO 639-1 code of the language the source is written in. The summary above is always in English. */
  language: string;
  /** Set when the summary was translated; the original headline and text stay untouched in the feed. */
  translatedFrom: string | null;
  suggestedSeverity: Severity;
  severityRationale: string;
  depth: EvidenceDepth;
  meta: AiMeta;
};

/** What the browser receives: the stored AI content plus per-person state. Nothing here changes the feed's own severity. */
export type EnrichmentView = EnrichmentDto & {
  /** What the feed shows for this person (source or rules severity, or their own override). Kept separate from the suggestion. */
  feedSeverity: Severity;
  feedSeverityIsOverride: boolean;
  /** The headline or summary changed after this was generated. */
  outdated: boolean;
  dismissed: boolean;
};

// ---------------------------------------------------------------- related events

export type RelatedKind = 'repeated-reporting' | 'independent-corroboration' | 'possibly-related';

export type RelatedSuggestion = {
  id: string;
  kind: RelatedKind;
  /** The existing incident or report this suggestion points to. */
  target: { type: 'incident' | 'report'; id: string; title: string; url: string | null; source: string | null; publishedAt: string | null; severity: Severity | null };
  reasons: string[];
  /** Why this is, or is not, independent corroboration. */
  independence: string;
  score: number;
};

// ---------------------------------------------------------------- settings and map

export type AiSettingsDto = {
  enabled: boolean;
  briefing: { schedule: 'off' | 'daily' | 'weekly'; hourUtc: number; lastGeneratedAt: string | null; lastRunAt: string | null };
};

export type MapQueryFilters = {
  severity: 'All' | Severity;
  category: string;
  country: string;
  review: 'All' | 'Reviewed' | 'Unreviewed';
  preset: '24h' | '7d' | 'custom';
  customFrom: string;
  customTo: string;
};

export type MapQueryResult = {
  filters: MapQueryFilters;
  /** Words matched against titles and summaries (for example "ship" and "vessel" for "maritime"). */
  keywords: string[];
  understood: string[];
  ignored: string[];
  method: 'rules' | 'rules+model';
};

export type AiAuditEntry = { id: number; at: string; actor: string; action: string; subject: string; detail: string };
