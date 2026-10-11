import type { AnalysisStore } from './analysis-store';
import { INDICATORS, computeIndicator, loadIndicatorData, type IndicatorContext, type IndicatorData } from './indicators';
import { buildAllItems } from './feed-service';
import { countryName } from '../src/data/countries';
import { RATING_RANK, type IndicatorReading } from '../src/data/workspaceTypes';

const LEVEL_RANK: Record<string, number> = { Normal: 0, Warning: 1, Alert: 2 };

export type AlertRunResult = { created: number };

/**
 * Threshold-crossing alerts for watched indicators.
 * - An alert fires when the level rises to Warning or Alert from a lower level.
 * - A cooldown (per indicator) suppresses further alerts; a suppressed crossing is kept pending and fires once the cooldown ends if the level is still elevated.
 * - A fall back to Normal re-arms the indicator.
 */
export function evaluateIndicatorAlerts(analysis: AnalysisStore, ctx: IndicatorContext, data: IndicatorData, clientId: string): number {
  let created = 0;
  const nowIso = ctx.now.toISOString();
  for (const watch of analysis.watchedIndicators(clientId)) {
    const def = INDICATORS.find((entry) => entry.id === watch.indicatorId);
    if (!def) continue;
    const settings = analysis.getIndicatorSettings(clientId, watch.indicatorId, watch.geo);
    const reading = computeIndicator(def, watch.geo, settings, ctx, data);
    const rank = LEVEL_RANK[reading.level];
    if (rank === undefined) continue; // no calculable level: keep the previous state
    const state = analysis.getIndicatorState(clientId, watch.indicatorId, watch.geo);
    const previousRank = LEVEL_RANK[state?.lastLevel ?? 'Normal'] ?? 0;
    if (rank <= previousRank) {
      if (rank < previousRank || !state) analysis.saveIndicatorState(clientId, watch.indicatorId, watch.geo, reading.level, state?.lastAlertAt ?? null, nowIso);
      continue;
    }
    const cooldownEnds = state?.lastAlertAt ? Date.parse(state.lastAlertAt) + settings.cooldownHours * 3_600_000 : 0;
    if (ctx.now.getTime() < cooldownEnds) continue; // pending: state keeps the lower level so it fires after the cooldown
    const week = reading.weeks[reading.weeks.length - 1];
    const fired = analysis.createAlert(clientId, {
      kind: 'indicator',
      dedupeKey: `ind:${watch.indicatorId}:${watch.geo}:${reading.level}:${week.end}`,
      title: `${reading.name} (${reading.geoName}): ${reading.level}`,
      detail: describeCrossing(reading),
      severity: reading.level === 'Alert' ? 'critical' : 'warning',
      link: { view: 'Threat Indicators', id: `${watch.indicatorId}|${watch.geo}` },
    }, nowIso);
    if (fired) created += 1;
    analysis.saveIndicatorState(clientId, watch.indicatorId, watch.geo, reading.level, fired ? nowIso : state?.lastAlertAt ?? null, nowIso);
  }
  return created;
}

function describeCrossing(reading: IndicatorReading) {
  const parts = [
    `${reading.current} in the week ${reading.weeks[reading.weeks.length - 1].start} to ${reading.weeks[reading.weeks.length - 1].end}`,
    `${reading.level === 'Alert' ? 'alert' : 'warning'} threshold ${reading.level === 'Alert' ? reading.alertThreshold : reading.warnThreshold}`,
  ];
  if (reading.baselineMean !== null) parts.push(`baseline mean ${reading.baselineMean.toFixed(1)} over ${reading.baselineWeeks} weeks`);
  return `${parts.join('; ')}. ${reading.isReportingActivity ? 'This is reporting activity, not a confirmed event count.' : 'Counts distinct source records.'} Confidence: ${reading.confidence}.`;
}

/** New High or Critical reports about watched countries, published after the country was added to the watchlist. */
export function evaluateCountryAlerts(analysis: AnalysisStore, ctx: IndicatorContext, clientId: string): number {
  const watched = analysis.watchedSince(clientId);
  if (watched.size === 0) return 0;
  let created = 0;
  const nowMs = ctx.now.getTime();
  const perCountry = new Map<string, number>();
  for (const item of buildAllItems(ctx.store, clientId)) {
    if (item.severity !== 'Critical' && item.severity !== 'High') continue;
    if (nowMs - Date.parse(item.publishedAt) > 48 * 3_600_000) continue;
    for (const country of item.countries) {
      const since = watched.get(country.code);
      if (!since || Date.parse(item.publishedAt) < Date.parse(since)) continue;
      if ((perCountry.get(country.code) ?? 0) >= 5) continue;
      const fired = analysis.createAlert(clientId, {
        kind: 'country-report',
        dedupeKey: `rep:${country.code}:${item.id}`,
        title: `${item.severity} report on ${countryName(country.code)}: ${item.headline}`.slice(0, 200),
        detail: `${item.source}, published ${item.publishedAt}. Severity is ${item.assessmentMethod === 'manual' ? 'your override' : 'an automatic estimate'}: ${item.severityRationale}`.slice(0, 600),
        severity: item.severity === 'Critical' ? 'critical' : 'warning',
        link: { view: 'Country Assessments', id: country.code },
      }, ctx.now.toISOString());
      if (fired) { created += 1; perCountry.set(country.code, (perCountry.get(country.code) ?? 0) + 1); }
    }
  }
  return created;
}

/** A material change: any category rating moved by at least one step between the two latest saved versions. */
export function countryAssessmentChangeAlert(analysis: AnalysisStore, clientId: string, code: string, nowIso: string): boolean {
  if (!analysis.getWatchedCountries(clientId).includes(code)) return false;
  const versions = analysis.listAssessmentVersions(clientId, code);
  if (versions.length < 2) return false;
  const [latest, previous] = [versions[0], versions[1]];
  const changes: string[] = [];
  for (const [category, now] of Object.entries(latest.categories)) {
    const before = previous.categories[category as keyof typeof previous.categories];
    if (now.rating === 'Unassessed' || before.rating === 'Unassessed') continue;
    const delta = RATING_RANK[now.rating] - RATING_RANK[before.rating];
    if (delta !== 0) changes.push(`${category}: ${before.rating} to ${now.rating}`);
  }
  if (changes.length === 0) return false;
  return analysis.createAlert(clientId, {
    kind: 'country-assessment',
    dedupeKey: `asm:${code}:v${latest.version}`,
    title: `Assessment changed for ${countryName(code)} (version ${latest.version})`,
    detail: `${changes.join('; ')}. Saved by ${latest.assessor}.`,
    severity: 'warning',
    link: { view: 'Country Assessments', id: code },
  }, nowIso);
}

export function runAlertEvaluation(analysis: AnalysisStore, ctx: IndicatorContext, only?: string): AlertRunResult {
  let created = 0;
  const clients = analysis.clientsWithWatches().filter((id) => !only || id === only);
  if (clients.length === 0) return { created };
  const data = loadIndicatorData(ctx);
  for (const clientId of clients) {
    try {
      created += evaluateIndicatorAlerts(analysis, ctx, data, clientId);
      created += evaluateCountryAlerts(analysis, ctx, clientId);
    } catch (error) {
      console.warn('[alerts] evaluation failed for one workspace', error instanceof Error ? error.message : error);
    }
  }
  return { created };
}
