import { missingCredentials } from './connectors';
import { ensureAssessments } from './feed-service';
import type { SourceDefinition, SourceStore, SyncState } from './source-store';
import { GLOBAL_CODE, UNKNOWN_CODE, countryName } from '../src/data/countries';
import { SEVERITIES, type Severity } from '../src/data/feedTypes';
import type {
  Confidence, IndicatorEvidenceItem, IndicatorReading, IndicatorSettings, IndicatorSummary, IndicatorWeek,
} from '../src/data/workspaceTypes';

const DAY = 86_400_000;
export const BASELINE_WEEKS = 8;
export const MIN_BASELINE_WEEKS = 4;
export const MIN_COVERED_DAYS = 6;
const EVIDENCE_CAP = 100;

/** Source reliability labels. High: official issuer with a published method. Medium: editorially reviewed publisher. Low: automated aggregation, unverified. */
export const SOURCE_RELIABILITY: Record<string, { label: Confidence; reason: string }> = {
  gdacs: { label: 'High', reason: 'Official system of the EC Joint Research Centre and UN OCHA; alert levels follow a published method.' },
  'cisa-kev': { label: 'High', reason: 'US government catalog that lists only vulnerabilities with confirmed exploitation in the wild.' },
  'un-news': { label: 'Medium', reason: 'Official UN reporting, but it covers UN-related topics only and is not an independent check.' },
  'bbc-world': { label: 'Medium', reason: 'Established publisher with editorial review; one outlet, so coverage is partial.' },
  gdelt: { label: 'Low', reason: 'Automated aggregation of online news by keyword; headlines are not verified and wording varies by outlet.' },
  reliefweb: { label: 'High', reason: 'Curated by UN OCHA staff; each report credits its original publisher.' },
};

export const CONFIDENCE_POLICY = [
  'Unassessed: not enough genuine data to calculate (insufficient history, source unavailable, or setup required).',
  'Low: fewer than six baseline weeks, a source is stale or unavailable, or the current week is not fully covered.',
  'Medium: the standard case when the calculation is complete.',
  'High: all eight baseline weeks and the current week are fully covered, every source is healthy and rated High reliability, and the count is of real events rather than reporting activity.',
];

type Def = {
  id: string;
  name: string;
  category: string;
  unit: string;
  isReportingActivity: boolean;
  perCountry: boolean;
  sources: string[];
  /** Sources that must have been read on a day for that day to count as covered. */
  coverage: { kind: 'checks'; sources: string[]; minSources: number } | { kind: 'catalog'; source: string; windowDays: number };
  include: (item: Item) => boolean;
  dedupeKey: (item: Item) => string;
  definition: IndicatorReading['definition'];
};

type Item = IndicatorEvidenceItem & { id: string; sourceId: string; categories: string[]; recordId: string; global: boolean };

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NEWS = ['bbc-world', 'un-news', 'gdelt', 'reliefweb'];

export const INDICATORS: Def[] = [
  {
    id: 'disaster-alerts',
    name: 'Distinct disaster alerts',
    category: 'Natural hazards',
    unit: 'distinct GDACS alerts per 7 days',
    isReportingActivity: false,
    perCountry: true,
    sources: ['gdacs'],
    coverage: { kind: 'checks', sources: ['gdacs'], minSources: 1 },
    include: (item) => item.sourceId === 'gdacs',
    dedupeKey: (item) => item.recordId,
    definition: {
      sources: ['GDACS (earthquakes, cyclones, floods, volcanoes, droughts, wildfires)'],
      window: 'Latest 7 complete UTC days compared with the previous 8 complete weeks.',
      calculation: 'Count of distinct GDACS events (one per event id) whose publication date falls in the week. Per-country values count an event once for each country GDACS names.',
      baseline: 'Mean and standard deviation of the previous 8 complete weeks that were covered; at least 4 covered weeks are required.',
      minimumCoverage: 'GDACS must have been read successfully on at least 6 of the 7 days of a week. A week below that is shown as missing, not zero.',
      thresholds: 'Automatic: warning at mean + 2 × spread, alert at mean + 3 × spread, where spread is the larger of the standard deviation and √mean. With a zero baseline both fall back to the minimum count. A fixed warning/alert pair can be set instead.',
      risingMeaning: 'More distinct hazard events were alerted than usual. This reflects real events, so a rise indicates worsening hazard conditions, not just more coverage.',
      deduplication: 'One count per GDACS event id; later updates of the same event are not counted again.',
    },
  },
  {
    id: 'kev-additions',
    name: 'Newly exploited vulnerabilities',
    category: 'Cyber',
    unit: 'vulnerabilities added to the CISA KEV catalog per 7 days',
    isReportingActivity: false,
    perCountry: false,
    sources: ['cisa-kev'],
    coverage: { kind: 'catalog', source: 'cisa-kev', windowDays: 90 },
    include: (item) => item.sourceId === 'cisa-kev',
    dedupeKey: (item) => item.recordId,
    definition: {
      sources: ['CISA Known Exploited Vulnerabilities catalog'],
      window: 'Latest 7 complete UTC days compared with the previous 8 complete weeks, by the date CISA added each entry.',
      calculation: 'Count of distinct CVE ids whose "date added" falls in the week. The catalog is cumulative, so history is available as soon as it has been read once, for up to 90 days back.',
      baseline: 'Mean and standard deviation of the previous 8 complete weeks; at least 4 covered weeks are required.',
      minimumCoverage: 'A day is covered when it lies within the retained 90-day window and on or before the last successful read of the catalog.',
      thresholds: 'Same automatic rule as the other indicators (mean + 2 / + 3 × spread, minimum count applies); fixed values can be set.',
      risingMeaning: 'More vulnerabilities were confirmed as exploited. This is a real change in the threat landscape, not reporting volume. It is global and not tied to a country.',
      deduplication: 'One count per CVE id.',
    },
  },
  {
    id: 'reporting-activity',
    name: 'Security reporting activity',
    category: 'Reporting',
    unit: 'unique relevant reports per 7 days (reporting activity, not confirmed events)',
    isReportingActivity: true,
    perCountry: true,
    sources: ['bbc-world', 'un-news', 'gdelt', 'reliefweb'],
    coverage: { kind: 'checks', sources: ['bbc-world', 'un-news', 'gdelt'], minSources: 2 },
    include: (item) => NEWS.includes(item.sourceId) && item.categories.length > 0,
    dedupeKey: (item) => normalise(item.headline),
    definition: {
      sources: ['BBC News World', 'UN News', 'GDELT', 'ReliefWeb (when configured)'],
      window: 'Latest 7 complete UTC days compared with the previous 8 complete weeks, by publication time.',
      calculation: 'Count of unique reports that the rules-based classifier tagged with at least one security-relevant type. Hazard alerts and vulnerabilities are counted by their own indicators.',
      baseline: 'Mean and standard deviation of the previous 8 complete weeks that were covered; at least 4 covered weeks are required.',
      minimumCoverage: 'At least 2 of BBC, UN News and GDELT must have been read successfully on at least 6 of the 7 days of a week.',
      thresholds: 'Automatic rule as above; the minimum count (default 2) keeps tiny numbers from alerting.',
      risingMeaning: 'More reports were published. More reporting can reflect more events, more attention or more outlets covering one story, so a rise is a prompt to look, not proof that conditions worsened.',
      deduplication: 'Reports with the same normalised headline count once. The same story with different wording from another outlet is still counted separately.',
    },
  },
  {
    id: 'high-severity-reports',
    name: 'High-severity reporting',
    category: 'Reporting',
    unit: 'unique High or Critical reports per 7 days (reporting activity, not confirmed events)',
    isReportingActivity: true,
    perCountry: true,
    sources: ['bbc-world', 'un-news', 'gdelt', 'reliefweb'],
    coverage: { kind: 'checks', sources: ['bbc-world', 'un-news', 'gdelt'], minSources: 2 },
    include: (item) => NEWS.includes(item.sourceId) && (item.severity === 'Critical' || item.severity === 'High'),
    dedupeKey: (item) => normalise(item.headline),
    definition: {
      sources: ['BBC News World', 'UN News', 'GDELT', 'ReliefWeb (when configured)'],
      window: 'Latest 7 complete UTC days compared with the previous 8 complete weeks, by publication time.',
      calculation: 'Count of unique reports whose automatic severity is High or Critical. Severity is a rules-based estimate; your own overrides are not applied so the series stays comparable.',
      baseline: 'Mean and standard deviation of the previous 8 complete weeks that were covered; at least 4 covered weeks are required.',
      minimumCoverage: 'Same as security reporting activity.',
      thresholds: 'Automatic rule as above; minimum count applies.',
      risingMeaning: 'More reports describe serious events. This is still reporting activity: a rise suggests worsening conditions only if the reports describe distinct events, so check the contributing reports.',
      deduplication: 'Reports with the same normalised headline count once.',
    },
  },
];

export function getDefinition(id: string) {
  return INDICATORS.find((def) => def.id === id);
}

// ------------------------------------------------------------------ data

export type IndicatorContext = {
  store: SourceStore;
  sources: SourceDefinition[];
  env: NodeJS.ProcessEnv;
  now: Date;
};

export type IndicatorData = {
  items: Item[];
  checks: Map<string, Map<string, number>>;
  states: Map<string, SyncState>;
};

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function loadIndicatorData(ctx: IndicatorContext): IndicatorData {
  ensureAssessments(ctx.store, ctx.now);
  const assessments = ctx.store.getAssessments();
  const enrichments = ctx.store.getEnrichments();
  const items: Item[] = [];
  for (const record of ctx.store.getRecords()) {
    const row = assessments.get(record.id);
    if (!row) continue;
    const severity: Severity = SEVERITIES.find((value) => value === row.severity) ?? 'Unassessed';
    const enrichment = enrichments.get(record.id);
    items.push({
      id: record.id, articleId: record.id, sourceId: record.sourceId, source: record.sourceName, headline: record.headline,
      url: record.canonicalUrl, publishedAt: record.publishedAt, severity, categories: row.categories,
      countries: row.countryCodes, recordId: record.sourceRecordId, global: Boolean(enrichment?.global),
    });
  }
  const checks = new Map<string, Map<string, number>>();
  for (const source of ctx.sources) {
    checks.set(source.id, new Map(ctx.store.getChecks(source.id).filter((row) => row.successes > 0).map((row) => [row.day, row.successes])));
  }
  return { items, checks, states: new Map(ctx.store.getSyncStates().map((state) => [state.sourceId, state])) };
}

function dependencyStatus(source: SourceDefinition, state: SyncState | undefined, env: NodeJS.ProcessEnv, nowMs: number) {
  if (missingCredentials(source, env).length > 0) return 'setup_required';
  if (!state || !state.lastSuccessAt) return state?.lastAttemptAt ? 'unavailable' : 'not_checked';
  if (state.status === 'unavailable') return 'unavailable';
  const interval = source.intervalMs ?? 15 * 60_000;
  if (state.status === 'stale' || nowMs - Date.parse(state.lastSuccessAt) > 3 * interval) return 'stale';
  return 'healthy';
}

// ------------------------------------------------------------------ calculation

export function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

/** Thresholds from the baseline. A zero baseline falls back to the minimum count (documented in the definition). */
export function autoThresholds(baseline: number[], minCount: number) {
  const m = mean(baseline);
  const spread = Math.max(stdev(baseline), Math.sqrt(m));
  const warn = Math.max(minCount, Math.ceil(m + 2 * spread));
  const alert = Math.max(warn + 1, Math.ceil(m + 3 * spread));
  return { warn, alert };
}

export function geoLabel(geo: string) {
  return geo === 'ALL' ? 'Worldwide' : countryName(geo);
}

export function computeIndicator(
  def: Def,
  geo: string,
  settings: IndicatorSettings,
  ctx: IndicatorContext,
  data: IndicatorData,
): IndicatorReading {
  const nowMs = ctx.now.getTime();
  const today = Math.floor(nowMs / DAY) * DAY;
  const effectiveGeo = def.perCountry ? geo : 'ALL';
  const notes: string[] = [];

  const sourceDefs = def.sources.map((id) => ctx.sources.find((source) => source.id === id)).filter((source): source is SourceDefinition => Boolean(source));
  const dependencies = sourceDefs.map((source) => {
    const state = data.states.get(source.id);
    const reliability = SOURCE_RELIABILITY[source.id] ?? { label: 'Unassessed' as Confidence, reason: 'No reliability assessment has been made for this source.' };
    return {
      sourceId: source.id, name: source.name, status: dependencyStatus(source, state, ctx.env, nowMs),
      lastSuccessAt: state?.lastSuccessAt ?? null, latestPublishedAt: ctx.store.latestPublished(source.id),
      reliability: reliability.label, reliabilityReason: reliability.reason,
    };
  });
  const required = def.coverage.kind === 'checks' ? def.coverage.sources : [def.coverage.source];
  const requiredDeps = dependencies.filter((dep) => required.includes(dep.sourceId));
  const allSetup = requiredDeps.length > 0 && requiredDeps.every((dep) => dep.status === 'setup_required');

  // Coverage of each day.
  const covered = (day: string, sourceId: string) => (data.checks.get(sourceId)?.has(day) ?? false);
  let catalogFirst = '';
  let catalogLast = '';
  if (def.coverage.kind === 'catalog') {
    const days = [...(data.checks.get(def.coverage.source)?.keys() ?? [])].sort();
    catalogFirst = days[0] ?? '';
    catalogLast = days[days.length - 1] ?? '';
  }
  const dayCovered = (day: string) => {
    if (def.coverage.kind === 'catalog') {
      if (!catalogFirst) return false;
      return day >= dayKey(Date.parse(`${catalogFirst}T00:00:00Z`) - def.coverage.windowDays * DAY) && day <= catalogLast;
    }
    return def.coverage.sources.filter((id) => covered(day, id)).length >= def.coverage.minSources;
  };

  // Eligible, de-duplicated items by week.
  const windowStart = today - (BASELINE_WEEKS + 1) * 7 * DAY;
  const seen = new Set<string>();
  const eligible = data.items
    .filter((item) => {
      const t = Date.parse(item.publishedAt);
      return t >= windowStart && t < today && def.include(item)
        && (effectiveGeo === 'ALL' || item.countries.includes(effectiveGeo));
    })
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .filter((item) => {
      const key = def.dedupeKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const weeks: IndicatorWeek[] = [];
  for (let k = BASELINE_WEEKS; k >= 0; k -= 1) {
    const startMs = today - (k + 1) * 7 * DAY;
    const endMs = startMs + 6 * DAY;
    let coveredDays = 0;
    for (let d = 0; d < 7; d += 1) if (dayCovered(dayKey(startMs + d * DAY))) coveredDays += 1;
    const inWeek = eligible.filter((item) => {
      const t = Date.parse(item.publishedAt);
      return t >= startMs && t < startMs + 7 * DAY;
    });
    const complete = coveredDays >= MIN_COVERED_DAYS;
    weeks.push({
      start: dayKey(startMs), end: dayKey(endMs), value: complete ? inWeek.length : null, coveredDays, complete,
      evidence: inWeek.slice(-EVIDENCE_CAP).reverse().map((item) => ({
        articleId: item.articleId, headline: item.headline, url: item.url, source: item.source,
        publishedAt: item.publishedAt, severity: item.severity, countries: item.countries,
      })),
    });
  }

  const currentWeek = weeks[weeks.length - 1];
  const baselineValues = weeks.slice(0, -1).map((week) => week.value).filter((value): value is number => value !== null);
  const baselineWeeks = baselineValues.length;
  const current = currentWeek.value;
  const baselineMean = baselineWeeks > 0 ? mean(baselineValues) : null;
  const baselineSd = baselineWeeks > 1 ? stdev(baselineValues) : null;

  const anyUnhealthy = requiredDeps.some((dep) => dep.status === 'stale' || dep.status === 'unavailable');
  const neverRead = requiredDeps.length > 0 && requiredDeps.every((dep) => !dep.lastSuccessAt);
  let dataStatus: IndicatorReading['dataStatus'] = 'live';
  if (allSetup) dataStatus = 'setup_required';
  else if (neverRead) dataStatus = 'unavailable';
  else if (anyUnhealthy) dataStatus = 'stale';
  else if (!currentWeek.complete && baselineWeeks === 0) dataStatus = 'no_data';

  if (dataStatus === 'stale') notes.push('A required source is stale or unavailable. The last successfully retrieved data is shown and may be out of date.');
  if (!currentWeek.complete) notes.push(`The latest week was only read on ${currentWeek.coveredDays} of 7 days, so its value is missing rather than zero.`);
  const gaps = weeks.slice(0, -1).filter((week) => !week.complete).length;
  if (gaps > 0) notes.push(`${gaps} of the previous ${BASELINE_WEEKS} weeks have too little coverage and are excluded from the baseline.`);
  if (def.coverage.kind === 'checks') {
    for (const id of def.coverage.sources) {
      const daysIn = (week: IndicatorWeek) => { let n = 0; for (let d = 0; d < 7; d += 1) if (covered(dayKey(Date.parse(`${week.start}T00:00:00Z`) + d * DAY), id)) n += 1; return n; };
      const earlier = weeks.slice(0, -1).filter((week) => week.complete);
      if (earlier.length > 0) {
        const avg = mean(earlier.map(daysIn));
        if (avg >= 5 && daysIn(currentWeek) <= 3) notes.push(`Coverage change: ${id} was read on ${daysIn(currentWeek)} of 7 days this week but on ${avg.toFixed(1)} days on average before.`);
      }
    }
  }
  if (geo !== 'ALL' && !def.perCountry) notes.push('This indicator is global; the country filter does not apply.');
  if (def.isReportingActivity) notes.push('Counts are reporting activity, not confirmed event counts.');

  // Thresholds, level and trend.
  let warnThreshold: number | null = null;
  let alertThreshold: number | null = null;
  let thresholdBasis = '';
  if (settings.mode === 'fixed' && settings.warn !== null && settings.alert !== null) {
    warnThreshold = settings.warn;
    alertThreshold = settings.alert;
    thresholdBasis = 'Fixed thresholds set by you.';
  } else if (baselineWeeks >= MIN_BASELINE_WEEKS) {
    ({ warn: warnThreshold, alert: alertThreshold } = autoThresholds(baselineValues, settings.minCount));
    thresholdBasis = baselineValues.every((value) => value === 0)
      ? `Baseline is zero in all ${baselineWeeks} weeks, so thresholds fall back to the minimum count (${settings.minCount}).`
      : `Automatic: warning at mean + 2 × spread, alert at mean + 3 × spread over ${baselineWeeks} covered weeks, never below the minimum count (${settings.minCount}).`;
  } else {
    thresholdBasis = `Not available: ${baselineWeeks} of the required ${MIN_BASELINE_WEEKS} baseline weeks have enough coverage.`;
  }

  let level: IndicatorReading['level'];
  if (dataStatus === 'setup_required') level = 'Setup required';
  else if (dataStatus === 'unavailable') level = 'Source unavailable';
  else if (current === null || warnThreshold === null || alertThreshold === null) level = 'Insufficient data';
  else if (current < settings.minCount) level = 'Normal';
  else if (current >= alertThreshold) level = 'Alert';
  else if (current >= warnThreshold) level = 'Warning';
  else level = 'Normal';
  if (current !== null && current < settings.minCount && warnThreshold !== null) notes.push(`The current count (${current}) is below the minimum count (${settings.minCount}), so no threshold level is applied.`);

  let trend: IndicatorReading['trend'] = 'Insufficient history';
  let changePct: number | null = null;
  if (current !== null && baselineMean !== null && baselineWeeks >= MIN_BASELINE_WEEKS) {
    const spread = Math.max(baselineSd ?? 0, Math.sqrt(baselineMean));
    if (baselineMean === 0) {
      trend = current >= Math.max(1, settings.minCount) ? 'Rising' : 'Stable';
      notes.push('The baseline is zero, so no percentage change is shown.');
    } else {
      changePct = ((current - baselineMean) / baselineMean) * 100;
      const diff = current - baselineMean;
      trend = Math.abs(changePct) >= 25 && Math.abs(diff) >= Math.max(1, spread) ? (diff > 0 ? 'Rising' : 'Falling') : 'Stable';
    }
  } else if (level !== 'Setup required' && level !== 'Source unavailable') {
    notes.push(`Insufficient history: ${baselineWeeks} of ${MIN_BASELINE_WEEKS} covered baseline weeks needed. Readings begin when the app first reads the sources, so history builds week by week.`);
  }

  // Confidence.
  let confidence: Confidence;
  let confidenceReason: string;
  if (level === 'Insufficient data' || level === 'Source unavailable' || level === 'Setup required') {
    confidence = 'Unassessed';
    confidenceReason = 'Not enough genuine data to calculate this reading.';
  } else if (baselineWeeks < 6 || dataStatus === 'stale' || !currentWeek.complete || currentWeek.coveredDays < 7) {
    confidence = 'Low';
    confidenceReason = baselineWeeks < 6 ? `Only ${baselineWeeks} baseline weeks are available.` : dataStatus === 'stale' ? 'A required source is stale or unavailable.' : 'The latest week was not fully covered.';
  } else if (!def.isReportingActivity && baselineWeeks === BASELINE_WEEKS && gaps === 0 && requiredDeps.every((dep) => dep.reliability === 'High' && dep.status === 'healthy')) {
    confidence = 'High';
    confidenceReason = 'Full baseline and current-week coverage from healthy, high-reliability sources counting real events.';
  } else {
    confidence = 'Medium';
    confidenceReason = def.isReportingActivity ? 'Complete calculation, but it counts reporting activity from sources of mixed reliability.' : 'Complete calculation with the standard caveats.';
  }

  return {
    id: def.id, name: def.name, category: def.category, geo: effectiveGeo, geoName: geoLabel(effectiveGeo), unit: def.unit,
    isReportingActivity: def.isReportingActivity, perCountry: def.perCountry, definition: def.definition, dependencies, dataStatus, level, trend,
    current, baselineMean, baselineSd, baselineWeeks, changePct, warnThreshold, alertThreshold, thresholdBasis,
    confidence, confidenceReason, notes, weeks, settings, computedAt: ctx.now.toISOString(),
  };
}

export function toSummary(reading: IndicatorReading): IndicatorSummary {
  const blocking = reading.dependencies.find((dep) => dep.status === 'setup_required' || dep.status === 'unavailable' || dep.status === 'not_checked');
  return {
    id: reading.id, name: reading.name, category: reading.category, geo: reading.geo, geoName: reading.geoName, unit: reading.unit, perCountry: reading.perCountry,
    dataStatus: reading.dataStatus, level: reading.level, trend: reading.trend, current: reading.current, baselineMean: reading.baselineMean,
    confidence: reading.confidence, isReportingActivity: reading.isReportingActivity, computedAt: reading.computedAt,
    watched: reading.settings.watched, sparkline: reading.weeks.map((week) => week.value),
    blockedBy: reading.level === 'Setup required' || reading.level === 'Source unavailable' ? (blocking ? `${blocking.name}: ${blocking.status.replace('_', ' ')}` : null) : null,
  };
}

/** Countries that have indicator-relevant reports in the window, busiest first. */
export function activeGeos(data: IndicatorData, now: Date, limit = 8) {
  const start = now.getTime() - (BASELINE_WEEKS + 1) * 7 * DAY;
  const counts = new Map<string, number>();
  for (const item of data.items) {
    if (Date.parse(item.publishedAt) < start) continue;
    for (const code of item.countries) {
      if (code === GLOBAL_CODE || code === UNKNOWN_CODE) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([code]) => code);
}
