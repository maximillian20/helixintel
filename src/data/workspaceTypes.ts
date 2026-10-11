import type { CountryRef, Severity } from './feedTypes';

// ------------------------------------------------------------------ incidents

export const INCIDENT_STATUSES = ['New', 'Investigating', 'Monitoring', 'Closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CONFIDENCE_LEVELS = ['Unassessed', 'Low', 'Medium', 'High'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const IMPACT_AREAS = ['Operational', 'Business', 'Human rights', 'Other'] as const;
export type ImpactArea = (typeof IMPACT_AREAS)[number];

export const ASSET_KINDS = ['Site', 'Supplier', 'Route'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export type EvidenceLink = {
  articleId: string;
  headline: string;
  url: string;
  source: string;
  /** When the source published the report. */
  publishedAt: string;
  /** When this app retrieved it, if the record still exists. */
  retrievedAt: string | null;
  severity: Severity | null;
  linkedAt: string;
  linkedBy: string;
};

export type IncidentAsset = { id: number; kind: AssetKind; name: string; notes: string; countryCode: string | null };
export type IncidentImpact = { id: number; area: ImpactArea; text: string; createdAt: string; author: string };
export type IncidentAction = {
  id: number;
  text: string;
  owner: string | null;
  dueDate: string | null;
  status: 'Open' | 'Done';
  completedAt: string | null;
  createdAt: string;
};
export type AuditEntry = { id: number; at: string; actor: string; type: string; detail: string };

export type IncidentSummary = {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  status: IncidentStatus;
  owner: string | null;
  countries: CountryRef[];
  eventAt: string | null;
  createdAt: string;
  updatedAt: string;
  reportCount: number;
  openActions: number;
};

export type IncidentDetail = IncidentSummary & {
  summary: string;
  locationText: string;
  lat: number | null;
  lng: number | null;
  severityRationale: string;
  confidence: Confidence;
  closedAt: string | null;
  reopenedCount: number;
  evidence: EvidenceLink[];
  assets: IncidentAsset[];
  impacts: IncidentImpact[];
  actions: IncidentAction[];
  audit: AuditEntry[];
};

export type IncidentInput = {
  title: string;
  summary: string;
  category: string;
  locationText: string;
  lat: number | null;
  lng: number | null;
  countryCodes: string[];
  severity: Severity;
  severityRationale: string;
  confidence: Confidence;
  owner: string | null;
  eventAt: string | null;
};

export type DuplicateSuggestion = { id: string; title: string; status: IncidentStatus; reasons: string[] };

// ------------------------------------------------------------------ country assessments

export const COUNTRY_CATEGORIES = [
  { id: 'security', label: 'Security' },
  { id: 'political', label: 'Political stability' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'travel', label: 'Travel' },
  { id: 'supply-chain', label: 'Supply chain' },
  { id: 'human-rights', label: 'Human rights' },
] as const;
export type CountryCategoryId = (typeof COUNTRY_CATEGORIES)[number]['id'];

export const RATINGS = ['Low', 'Moderate', 'Elevated', 'High', 'Severe'] as const;
export type Rating = (typeof RATINGS)[number];
export const RATING_RANK: Record<Rating, number> = { Low: 1, Moderate: 2, Elevated: 3, High: 4, Severe: 5 };

export const TRENDS = ['Improving', 'Stable', 'Deteriorating', 'Insufficient history'] as const;
export type Trend = (typeof TRENDS)[number];

export type CountryEvidence = {
  id: number;
  refType: 'report' | 'incident';
  refId: string;
  category: CountryCategoryId;
  note: string;
  label: string;
  url: string | null;
  source: string | null;
  /** Publication time for reports; creation time for incidents. */
  eventTime: string | null;
  addedAt: string;
  addedBy: string;
};

export type CategoryAssessment = {
  rating: Rating | 'Unassessed';
  rationale: string;
  confidence: Confidence;
  evidenceIds: number[];
};

export type AssessmentVersion = {
  version: number;
  countryCode: string;
  assessedAt: string;
  assessor: string;
  summary: string;
  confidence: Confidence;
  categories: Record<CountryCategoryId, CategoryAssessment>;
  /** Evidence as it was when this version was saved. */
  evidence: CountryEvidence[];
};

export type CategoryChange = {
  windowDays: 7 | 30 | 90;
  /** Present only when a real earlier version rated this category. */
  from: Rating | null;
  fromDate: string | null;
  steps: number | null;
};

export type CategoryTrend = { trend: Trend; changes: CategoryChange[] };

export type CountryDirectoryEntry = {
  code: string;
  name: string;
  watched: boolean;
  assessedAt: string | null;
  highestRating: Rating | 'Unassessed';
  reportCount30d: number;
  incidentCount: number;
  openIncidents: number;
  disasterAlerts30d: number;
};

export type CountryDetail = {
  code: string;
  name: string;
  watched: boolean;
  latest: AssessmentVersion | null;
  versions: Array<Pick<AssessmentVersion, 'version' | 'assessedAt' | 'assessor' | 'confidence'>>;
  trends: Record<CountryCategoryId, CategoryTrend>;
  evidence: CountryEvidence[];
  incidents: IncidentSummary[];
  assets: Array<IncidentAsset & { incidentId: string; incidentTitle: string }>;
  evidenceSummary: {
    reports30d: number;
    reportsBySuggestedCategory: Record<CountryCategoryId, number>;
    disasterAlerts30d: number;
    latestReportPublishedAt: string | null;
  };
  recentReports: Array<{
    articleId: string;
    headline: string;
    url: string;
    source: string;
    publishedAt: string;
    severity: Severity;
    suggestedCategory: CountryCategoryId | null;
    suggestionBasis: string;
  }>;
};

export const SCORING_METHOD = {
  name: 'Analyst-assigned ordinal rating',
  summary: 'Each category is rated by an analyst on a five-step scale (Low, Moderate, Elevated, High, Severe). A rating can only be saved with a written rationale and at least one linked report or incident as evidence for that country.',
  automated: 'No automated country score is calculated. A defensible weighting method has not been configured, so automated scores are shown as Unassessed. The evidence summary (report and alert counts) is context only: it is not a rating and article volume is not used as risk.',
  scale: 'The scale is an ordered index of conditions, not a probability that an incident will occur.',
  missing: 'A category with no rating is shown as Unassessed. Missing data is never treated as low risk.',
  trend: 'Trend compares the latest version with the most recent earlier version that is at least 30 days old (otherwise 7 days). Without such a version the trend is Insufficient history.',
};

// ------------------------------------------------------------------ indicators and alerts

export type IndicatorLevel = 'Normal' | 'Warning' | 'Alert' | 'No threshold' | 'Insufficient data' | 'Source unavailable' | 'Setup required';
export type IndicatorTrend = 'Rising' | 'Stable' | 'Falling' | 'Insufficient history';

export type IndicatorEvidenceItem = {
  articleId: string;
  headline: string;
  url: string;
  source: string;
  publishedAt: string;
  severity: Severity;
  countries: string[];
};

export type IndicatorWeek = {
  /** First day (UTC) of the 7-day window. */
  start: string;
  /** Last day (UTC) of the window, inclusive. */
  end: string;
  /** null when the source was not read for enough of the week, so it is missing rather than zero. */
  value: number | null;
  coveredDays: number;
  complete: boolean;
  evidence: IndicatorEvidenceItem[];
};

export type IndicatorSettings = {
  mode: 'auto' | 'fixed';
  warn: number | null;
  alert: number | null;
  minCount: number;
  cooldownHours: number;
  watched: boolean;
};

export type IndicatorReading = {
  id: string;
  name: string;
  category: string;
  geo: string;
  geoName: string;
  unit: string;
  isReportingActivity: boolean;
  /** False for global indicators such as vulnerabilities, where a country filter does not apply. */
  perCountry: boolean;
  definition: {
    sources: string[];
    window: string;
    calculation: string;
    baseline: string;
    minimumCoverage: string;
    thresholds: string;
    risingMeaning: string;
    deduplication: string;
  };
  dependencies: Array<{ sourceId: string; name: string; status: string; lastSuccessAt: string | null; latestPublishedAt: string | null; reliability: string; reliabilityReason: string }>;
  /** live: all sources healthy; stale: last data kept but a source is stale/unavailable; otherwise nothing could be calculated. */
  dataStatus: 'live' | 'stale' | 'unavailable' | 'setup_required' | 'no_data';
  level: IndicatorLevel;
  trend: IndicatorTrend;
  current: number | null;
  baselineMean: number | null;
  baselineSd: number | null;
  baselineWeeks: number;
  changePct: number | null;
  warnThreshold: number | null;
  alertThreshold: number | null;
  thresholdBasis: string;
  confidence: Confidence;
  confidenceReason: string;
  notes: string[];
  weeks: IndicatorWeek[];
  settings: IndicatorSettings;
  computedAt: string;
};

export type IndicatorSummary = Pick<IndicatorReading,
  'id' | 'name' | 'category' | 'geo' | 'geoName' | 'unit' | 'perCountry' | 'dataStatus' | 'level' | 'trend' | 'current' | 'baselineMean' | 'confidence' | 'isReportingActivity' | 'computedAt'> & {
  watched: boolean;
  sparkline: Array<number | null>;
  blockedBy: string | null;
};

export type AlertDto = {
  id: number;
  kind: string;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  link: { view: string; id?: string } | null;
  createdAt: string;
  readAt: string | null;
};
