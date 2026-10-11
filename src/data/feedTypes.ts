export const SEVERITIES = ['Critical', 'High', 'Moderate', 'Watch', 'Unassessed'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REVIEW_STATUSES = ['Reviewed', 'Unreviewed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type ConfidenceLevel = 'High' | 'Medium' | 'Low' | 'Not assessed';
export type CountryStatus = 'identified' | 'global' | 'unknown';

export type CountryRef = { code: string; name: string };

export type FeedItemDto = {
  id: string;
  headline: string;
  summary: string;
  url: string;
  source: string;
  sourceUrl: string;
  attribution: string;
  publishedAt: string;
  sourceModifiedAt: string | null;
  retrievedAt: string;
  lastCheckedAt: string;
  verificationStatus: string;
  /** Effective severity: the user's override when set, otherwise the automatic assessment. */
  severity: Severity;
  assessedSeverity: Severity;
  severityOverridden: boolean;
  severityOverriddenAt: string | null;
  severityRationale: string;
  assessmentConfidence: ConfidenceLevel;
  categories: string[];
  categoryLabels: string[];
  corroboratingReports: number;
  countries: CountryRef[];
  countryStatus: CountryStatus;
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  watchlisted: boolean;
  watchlistedAt: string | null;
};

export type FeedPage = {
  items: FeedItemDto[];
  /** Number of items matching the current filters (all pages). */
  total: number;
  /** Number of items in the whole feed dataset, ignoring filters. */
  datasetTotal: number;
  /** Number of items this client has on their watchlist, ignoring other filters. */
  watchlistTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type FeedFilters = {
  severity: 'All' | Severity;
  /** 'All', an ISO 3166-1 alpha-2 style code, 'GLOBAL' or 'UNKNOWN'. */
  country: string;
  review: 'All' | ReviewStatus;
  watchlistOnly: boolean;
  search: string;
};

export const DEFAULT_FEED_FILTERS: FeedFilters = {
  severity: 'All',
  country: 'All',
  review: 'All',
  watchlistOnly: false,
  search: '',
};

export function hasActiveFilters(filters: FeedFilters) {
  return filters.severity !== 'All'
    || filters.country !== 'All'
    || filters.review !== 'All'
    || filters.watchlistOnly
    || filters.search.trim() !== '';
}

export function buildFeedQueryString(filters: FeedFilters, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (filters.severity !== 'All') params.set('severity', filters.severity);
  if (filters.country !== 'All') params.set('country', filters.country);
  if (filters.review !== 'All') params.set('review', filters.review);
  if (filters.watchlistOnly) params.set('watchlist', 'true');
  if (filters.search.trim()) params.set('q', filters.search.trim());
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params.toString();
}

/** The single filter implementation, used by the server for the full dataset and by the demo view. */
export function matchesFilters(item: FeedItemDto, filters: FeedFilters) {
  if (filters.severity !== 'All' && item.severity !== filters.severity) return false;
  if (filters.country !== 'All' && !item.countries.some((country) => country.code === filters.country)) return false;
  if (filters.review !== 'All' && item.reviewStatus !== filters.review) return false;
  if (filters.watchlistOnly && !item.watchlisted) return false;
  const query = filters.search.trim().toLowerCase();
  if (query) {
    const haystack = [
      item.headline,
      item.summary,
      item.source,
      item.severity,
      ...item.countries.map((country) => country.name),
    ].join(' ').toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}
