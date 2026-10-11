import type { Severity } from './feedTypes';

export type AssetClass = 'stock' | 'index' | 'crypto';
export type Instrument = 'equity' | 'etf' | 'equity-index' | 'commodity-spot' | 'crypto';
export type CalendarId = 'XNYS' | '24x7' | 'DAILY_SPOT';
export type ProviderId = 'coinbase' | 'tiingo' | 'fred' | 'none';
export type Granularity = '1h' | '1d';

export type AssetInfo = {
  /** Stable identifier that includes the venue, so two listings of one company never collide. */
  id: string;
  class: AssetClass;
  instrument: Instrument;
  symbol: string;
  name: string;
  /** Groups listings of the same company (e.g. an ADR and the home-market share). */
  companyKey: string | null;
  exchange: string;
  mic: string | null;
  currency: string;
  timezone: string;
  calendar: CalendarId;
  provider: ProviderId;
  providerSymbol: string;
  adjustment: 'split-dividend adjusted' | 'index level (not adjusted)' | 'not adjusted (spot price)' | 'not applicable (crypto)' | 'none';
  granularities: Granularity[];
  sectors: string[];
  benchmarkId: string | null;
  note: string | null;
};

export type AssetFreshness = 'live' | 'delayed' | 'stale' | 'unavailable' | 'setup_required' | 'unsupported' | 'not_fetched';

export type AssetStatus = {
  status: AssetFreshness;
  label: string;
  detail: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  latestBarClose: string | null;
  nextRunAt: string | null;
  error: string | null;
};

export type AssetWithStatus = AssetInfo & { status: AssetStatus; watched: boolean };

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  covers: string;
  credential: { envVar: string; configured: boolean; signupUrl: string } | null;
  limits: string;
  license: string;
  attribution: string;
  delay: string;
  verified: string;
};

export type Relevance = 'Direct' | 'Sector and geography' | 'Sector' | 'Broad market' | 'Analyst-added';
export type LinkStatus = 'suggested' | 'confirmed' | 'rejected';
export type WindowId = '1h' | '24h' | '7d';
export type ReactionStatus = 'ok' | 'pending' | 'unsupported' | 'missing';

export type WindowReaction = {
  window: WindowId;
  status: ReactionStatus;
  reason: string;
  referenceAt: string | null;
  referencePrice: number | null;
  measuredAt: string | null;
  measuredPrice: number | null;
  returnPct: number | null;
  benchmarkReturnPct: number | null;
  /** Asset return minus benchmark return over the same measurement timestamps, in percentage points. */
  adjustedPct: number | null;
  benchmarkNote: string;
  preReturnPct: number | null;
  preFromAt: string | null;
};

export type LinkExplanation = {
  ruleId: string;
  relevance: Relevance;
  basis: string;
  pathway: string;
  alternatives: string[];
};

export type EventMember = { articleId: string; headline: string; url: string; source: string; publishedAt: string; retrievedAt: string };

export type MarketEventSummary = {
  /** Stable key, e.g. report:<earliest article id> or incident:<id>. */
  key: string;
  type: 'report' | 'incident';
  /** Id the user selected; links are stored against it. */
  id: string;
  /** Id of the earliest member, used as the stable cluster key. */
  anchorId: string;
  title: string;
  severity: Severity;
  category: string;
  categoryIds: string[];
  countries: Array<{ code: string; name: string }>;
  /** Earliest public report time among the de-duplicated coverage. */
  anchorAt: string;
  anchorSource: string;
  anchorUrl: string;
  /** When the event occurred, if recorded (incidents only). */
  eventAt: string | null;
  retrievedAt: string;
  members: EventMember[];
  summary: string;
};

export type EventAsset = {
  asset: AssetWithStatus;
  link: { status: LinkStatus; origin: 'suggested' | 'user'; explanation: LinkExplanation | null; updatedAt: string | null; updatedBy: string | null };
  reactions: WindowReaction[];
  benchmark: { id: string; symbol: string; name: string } | null;
  sessionNote: string;
  why: WhyMatters;
};

export type WhyMatters = {
  supporting: string[];
  pathway: string;
  alternatives: string[];
  caution: string;
};

export type EventView = {
  event: MarketEventSummary;
  sessionNotes: Array<{ calendar: string; note: string }>;
  assets: EventAsset[];
  computedAt: string;
};

export type ChartBar = { t: string; close: number; open: number; high: number; low: number };

export type ChartMarker = {
  eventId: string;
  anchorId: string;
  at: string;
  title: string;
  source: string;
  url: string;
  severity: Severity;
  category: string;
  countries: Array<{ code: string; name: string }>;
  relevance: Relevance;
  linkStatus: LinkStatus;
  basis: string;
  pathway: string;
  memberCount: number;
  eventAt: string | null;
};

export type AssetChart = {
  asset: AssetWithStatus;
  granularity: Granularity;
  bars: ChartBar[];
  markers: ChartMarker[];
  barsTotal: number;
  from: string | null;
  to: string | null;
  priceBasis: string;
  computedAt: string;
};

export type AssociationLabel = 'Preliminary association' | 'Historically observed association' | 'Insufficient history';

export type AssociationResult = {
  asset: { id: string; symbol: string; name: string };
  category: string;
  country: string | null;
  exposure: string | null;
  window: WindowId;
  measure: 'benchmark-adjusted' | 'raw';
  label: AssociationLabel;
  distinctEvents: number;
  usedEvents: number;
  overlappingExcluded: number;
  pendingOrMissing: number;
  period: { from: string | null; to: string | null };
  median: number | null;
  q1: number | null;
  q3: number | null;
  stdev: number | null;
  positiveShare: number | null;
  negativeShare: number | null;
  zeroShare: number | null;
  signTestP: number | null;
  adjustedP: number | null;
  comparisons: number;
  exploratory: boolean;
  notes: string[];
  events: Array<{ anchorId: string; title: string; at: string; valuePct: number }>;
};

export type CorrelationResult = {
  asset: { id: string; symbol: string; name: string };
  category: string;
  country: string | null;
  seriesX: string;
  seriesY: string;
  method: string;
  observations: number;
  nonZeroDays: number;
  window: { from: string | null; to: string | null };
  pearson: number | null;
  spearman: number | null;
  ci95: [number, number] | null;
  pValue: number | null;
  adjustedP: number | null;
  comparisons: number;
  status: 'ok' | 'Insufficient history';
  needed: string;
  notes: string[];
};

export type MarketAlertSettings = {
  linkAlerts: boolean;
  moveAlerts: boolean;
  movePct: number;
  moveWindow: '1h' | '24h';
  cooldownHours: number;
};
