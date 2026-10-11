import type { AnalysisStore } from './analysis-store';
import { similarity } from './analysis-store';
import { buildAllItems } from './feed-service';
import type { SourceStore } from './source-store';
import { CATALOG, catalogById, stripAliases, type CatalogEntry } from './market-catalog';
import { mapEventToSession } from './market-calendar';
import { LINK_RULES_VERSION, marketCategory, suggestLinks, whyMatters, type LinkSuggestion } from './market-links';
import type { Bar } from './market-providers';
import { WINDOWS, WINDOW_MS, computeReaction, computeReactions, firstAtOrAfter, lastAtOrBefore, type BarSource } from './market-reactions';
import { fisherInference, holmAdjust, median, pearson, quantile, signTestP, spearman, stdev } from './market-stats';
import { assetStatus } from './market-sync';
import type { MarketStore, Snapshot, StoredLink } from './market-store';
import { SEVERITIES, type FeedItemDto, type Severity } from '../src/data/feedTypes';
import { countryName } from '../src/data/countries';
import type {
  AssetChart, AssetWithStatus, AssociationResult, ChartMarker, CorrelationResult, EventAsset, EventView, Granularity,
  MarketAlertSettings, MarketEventSummary, WindowId,
} from '../src/data/marketTypes';

export type MarketDeps = { store: SourceStore; analysis: AnalysisStore; market: MarketStore; env: NodeJS.ProcessEnv; now: Date };

export type EventCluster = MarketEventSummary & { text: string; suggestions: LinkSuggestion[]; countryCodes: string[]; memberKeys: string[] };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const severityRank = (s: string) => { const i = SEVERITIES.indexOf(s as Severity); return i < 0 ? SEVERITIES.length : i; };
const realCountry = (code: string) => code !== 'GLOBAL' && code !== 'UNKNOWN';

/** Bar loader that reads each series from the database once per request. */
export function barCache(market: MarketStore): BarSource {
  const cache = new Map<string, Bar[]>();
  return (assetId, granularity) => {
    const key = `${assetId}|${granularity}`;
    let bars = cache.get(key);
    if (!bars) { bars = market.getBars(assetId, granularity); cache.set(key, bars); }
    return bars;
  };
}

// ---------------------------------------------------------------- events

let clusterCache: { key: string; at: number; value: EventCluster[] } | null = null;
export function clearEventCache() { clusterCache = null; }

function reportClusters(deps: MarketDeps, clientId: string, days: number): EventCluster[] {
  const cacheKey = `${clientId}|${days}`;
  if (clusterCache && clusterCache.key === cacheKey && deps.now.getTime() - clusterCache.at < 20_000) return clusterCache.value;
  const cutoff = deps.now.getTime() - days * DAY;
  const items = buildAllItems(deps.store, clientId)
    .filter((item) => Date.parse(item.publishedAt) >= cutoff && Date.parse(item.publishedAt) <= deps.now.getTime() + HOUR)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id));
  type Draft = { group: string; members: FeedItemDto[]; last: number };
  const byGroup = new Map<string, Draft[]>();
  for (const item of items) {
    const group = marketCategory(item.categories, item.category);
    const drafts = byGroup.get(group) ?? [];
    byGroup.set(group, drafts);
    const published = Date.parse(item.publishedAt);
    const codes = item.countries.map((c) => c.code).filter(realCountry);
    let target: Draft | undefined;
    for (let i = drafts.length - 1, seen = 0; i >= 0 && seen < 80; i -= 1, seen += 1) {
      const draft = drafts[i];
      if (published - draft.last > 2 * DAY) continue;
      const near = draft.members.some((member) => member.url === item.url
        || similarity(member.headline, item.headline) >= 0.5
        || (codes.length > 0 && member.countries.some((c) => codes.includes(c.code)) && similarity(member.headline, item.headline) >= 0.3));
      if (near) { target = draft; break; }
    }
    if (target) { target.members.push(item); target.last = Math.max(target.last, published); } else drafts.push({ group, members: [item], last: published });
  }
  const clusters: EventCluster[] = [];
  for (const drafts of byGroup.values()) for (const draft of drafts) clusters.push(toCluster(draft.members, draft.group));
  clusters.sort((a, b) => Date.parse(b.anchorAt) - Date.parse(a.anchorAt));
  clusterCache = { key: cacheKey, at: deps.now.getTime(), value: clusters };
  return clusters;
}

function toCluster(members: FeedItemDto[], group: string): EventCluster {
  const sorted = [...members].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id));
  const anchor = sorted[0];
  const countries = new Map<string, string>();
  for (const m of sorted) for (const c of m.countries) if (realCountry(c.code)) countries.set(c.code, c.name);
  const categoryIds = [...new Set(sorted.flatMap((m) => m.categories))];
  const severity = sorted.reduce<Severity>((best, m) => (severityRank(m.severity) < severityRank(best) ? m.severity : best), anchor.severity);
  const text = `${anchor.headline}. ${anchor.summary} ${sorted.slice(1, 6).map((m) => m.headline).join('. ')}`;
  const suggestions = suggestLinks({ text, categories: categoryIds, countries: [...countries.keys()], severity });
  return {
    key: `report:${anchor.id}`, type: 'report', id: anchor.id, anchorId: anchor.id, title: anchor.headline, severity, category: group, categoryIds,
    countries: [...countries].map(([code, name]) => ({ code, name })), anchorAt: anchor.publishedAt, anchorSource: anchor.source, anchorUrl: anchor.url,
    eventAt: null, retrievedAt: anchor.retrievedAt, summary: anchor.summary,
    members: sorted.map((m) => ({ articleId: m.id, headline: m.headline, url: m.url, source: m.source, publishedAt: m.publishedAt, retrievedAt: m.retrievedAt })),
    text, suggestions, countryCodes: [...countries.keys()], memberKeys: sorted.map((m) => `report:${m.id}`),
  };
}

function incidentClusters(deps: MarketDeps, clientId: string): EventCluster[] {
  const out: EventCluster[] = [];
  const itemsById = new Map(buildAllItems(deps.store, clientId).map((item) => [item.id, item]));
  for (const summary of deps.analysis.listIncidents(clientId).slice(0, 100)) {
    const detail = deps.analysis.getIncident(clientId, summary.id);
    if (detail.evidence.length === 0) continue;
    const evidence = [...detail.evidence].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
    const anchor = evidence[0];
    const categoryIds = [...new Set(evidence.flatMap((e) => itemsById.get(e.articleId)?.categories ?? []))];
    const group = marketCategory(categoryIds, detail.category);
    const countries = detail.countries.filter((c) => realCountry(c.code));
    const text = `${detail.title}. ${detail.summary} ${detail.locationText} ${detail.assets.map((a) => a.name).join(' ')} ${evidence.slice(0, 5).map((e) => e.headline).join('. ')}`;
    out.push({
      key: `incident:${detail.id}`, type: 'incident', id: detail.id, anchorId: anchor.articleId, title: detail.title, severity: detail.severity, category: group, categoryIds,
      countries, anchorAt: anchor.publishedAt, anchorSource: anchor.source, anchorUrl: anchor.url, eventAt: detail.eventAt,
      retrievedAt: anchor.retrievedAt ?? anchor.linkedAt, summary: detail.summary,
      members: evidence.map((e) => ({ articleId: e.articleId, headline: e.headline, url: e.url, source: e.source, publishedAt: e.publishedAt, retrievedAt: e.retrievedAt ?? e.linkedAt })),
      text, suggestions: suggestLinks({ text, categories: categoryIds, countries: countries.map((c) => c.code), severity: detail.severity }),
      countryCodes: countries.map((c) => c.code), memberKeys: [],
    });
  }
  return out;
}

export type EventFilters = { days?: number; severity?: string; category?: string; country?: string; q?: string; all?: boolean; from?: string; to?: string };

export function listEvents(deps: MarketDeps, clientId: string, filters: EventFilters = {}): { events: EventCluster[]; total: number } {
  const days = Math.min(Math.max(filters.days ?? 14, 1), 120);
  let events = [...incidentClusters(deps, clientId), ...reportClusters(deps, clientId, days)];
  snapshotIncidents(deps, clientId, events.filter((e) => e.type === 'incident'));
  if (!filters.all) events = events.filter((e) => e.suggestions.length > 0 || deps.market.linksFor(clientId, [e.key, ...e.memberKeys]).length > 0);
  if (filters.severity && filters.severity !== 'All') events = events.filter((e) => e.severity === filters.severity);
  if (filters.category && filters.category !== 'All') events = events.filter((e) => e.category === filters.category);
  if (filters.country && filters.country !== 'All') events = events.filter((e) => e.countryCodes.includes(filters.country!));
  if (filters.from) events = events.filter((e) => e.anchorAt >= filters.from!);
  if (filters.to) events = events.filter((e) => e.anchorAt <= `${filters.to}T23:59:59.999Z`);
  if (filters.q?.trim()) { const q = filters.q.trim().toLowerCase(); events = events.filter((e) => `${e.title} ${e.summary}`.toLowerCase().includes(q)); }
  events.sort((a, b) => Date.parse(b.anchorAt) - Date.parse(a.anchorAt));
  return { events: events.slice(0, 150), total: events.length };
}

export function findEvent(deps: MarketDeps, clientId: string, key: string): EventCluster | null {
  if (key.startsWith('incident:')) return incidentClusters(deps, clientId).find((e) => e.key === key) ?? null;
  const id = key.replace(/^report:/, '');
  return reportClusters(deps, clientId, 120).find((e) => e.key === `report:${id}` || e.members.some((m) => m.articleId === id)) ?? null;
}

// ---------------------------------------------------------------- point-in-time snapshots

const snapshotOf = (event: EventCluster, clientId: string, now: Date): Snapshot => ({
  eventKey: event.key, clientId: event.type === 'incident' ? clientId : '', type: event.type, anchorId: event.anchorId, title: event.title, anchorAt: event.anchorAt,
  snapshotAt: now.toISOString(), categories: event.categoryIds.length > 0 ? event.categoryIds : [event.category], countries: event.countryCodes, severity: event.severity,
  links: event.suggestions.map((s) => ({ assetId: s.assetId, ruleId: s.ruleId, relevance: s.relevance })),
});

/**
 * Freezes how an event was classified and which assets the rules linked at the time the app first saw it.
 * Historical associations use only these frozen records, never today's classification of an older event.
 */
export function captureReportSnapshots(deps: MarketDeps, days = 30): number {
  const existing = deps.market.snapshotKeys('');
  let created = 0;
  for (const event of reportClusters(deps, '', days)) {
    if (event.suggestions.length === 0 || existing.has(event.key)) continue;
    if (event.members.some((m) => existing.has(`report:${m.articleId}`))) continue; // same coverage already frozen under another anchor
    if (deps.market.insertSnapshot(snapshotOf(event, '', deps.now))) created += 1;
  }
  return created;
}

function snapshotIncidents(deps: MarketDeps, clientId: string, incidents: EventCluster[]) {
  const existing = deps.market.snapshotKeys(clientId);
  for (const event of incidents) if (event.suggestions.length > 0 && !existing.has(event.key)) deps.market.insertSnapshot(snapshotOf(event, clientId, deps.now));
}

// ---------------------------------------------------------------- links and views

export function withStatus(deps: MarketDeps, entry: CatalogEntry | ReturnType<typeof stripAliases>, watched: Set<string>): AssetWithStatus {
  const info = 'aliases' in entry ? stripAliases(entry) : entry;
  return { ...info, status: assetStatus(info, deps.market, deps.env, deps.now), watched: watched.has(info.id) };
}

type MergedLink = { entry: CatalogEntry; link: EventAsset['link'] };

export function mergedLinks(deps: MarketDeps, clientId: string, event: EventCluster): MergedLink[] {
  const stored = new Map<string, StoredLink>();
  for (const link of deps.market.linksFor(clientId, [event.key, ...event.memberKeys])) stored.set(link.assetId, link);
  const out: MergedLink[] = [];
  const seen = new Set<string>();
  for (const s of event.suggestions) {
    const entry = catalogById.get(s.assetId);
    if (!entry) continue;
    seen.add(s.assetId);
    const st = stored.get(s.assetId);
    out.push({ entry, link: { status: st?.status ?? 'suggested', origin: 'suggested', explanation: st?.explanation ?? s.explanation, updatedAt: st?.updatedAt ?? null, updatedBy: st?.updatedBy ?? null } });
  }
  for (const [assetId, st] of stored) {
    const entry = catalogById.get(assetId);
    if (!entry || seen.has(assetId)) continue;
    out.push({ entry, link: { status: st.status, origin: st.origin, explanation: st.explanation, updatedAt: st.updatedAt, updatedBy: st.updatedBy } });
  }
  return out;
}

const REL_RANK: Record<string, number> = { Direct: 0, 'Sector and geography': 1, Sector: 2, 'Broad market': 3, 'Analyst-added': 4 };

export function eventView(deps: MarketDeps, clientId: string, event: EventCluster): EventView {
  const bars = barCache(deps.market);
  const watched = new Set(deps.market.watched(clientId));
  const anchorMs = Date.parse(event.anchorAt);
  const rows = mergedLinks(deps, clientId, event).sort((a, b) => {
    const rank = (m: MergedLink) => (m.link.status === 'rejected' ? 9 : m.link.status === 'confirmed' ? -1 : REL_RANK[m.link.explanation?.relevance ?? 'Analyst-added'] ?? 5);
    return rank(a) - rank(b) || a.entry.name.localeCompare(b.entry.name);
  });
  const assets: EventAsset[] = rows.map(({ entry, link }) => {
    const info = stripAliases(entry);
    const bench = info.benchmarkId ? catalogById.get(info.benchmarkId) ?? null : null;
    const sessionNote = mapEventToSession(info.calendar, anchorMs).note;
    return {
      asset: withStatus(deps, entry, watched), link,
      reactions: computeReactions(info, bench ? stripAliases(bench) : null, anchorMs, deps.now.getTime(), bars),
      benchmark: bench ? { id: bench.id, symbol: bench.symbol, name: bench.name } : null,
      sessionNote,
      why: whyMatters({
        explanation: link.explanation, origin: link.origin, severity: event.severity, source: event.anchorSource, memberCount: event.members.length,
        category: event.category, countries: event.countries.map((c) => c.name), anchorAt: event.anchorAt, sessionNote,
      }),
    };
  });
  const notes = new Map<string, string>();
  for (const a of assets) notes.set(a.asset.calendar, mapEventToSession(a.asset.calendar, anchorMs).note);
  const { text: _t, suggestions: _s, countryCodes: _c, memberKeys: _m, ...summary } = event;
  return { event: summary, sessionNotes: [...notes].map(([calendar, note]) => ({ calendar, note })), assets, computedAt: deps.now.toISOString() };
}

// ---------------------------------------------------------------- chart

export type ChartFilters = { granularity?: Granularity; from?: string; to?: string; country?: string; category?: string; severity?: string };

export function assetChart(deps: MarketDeps, clientId: string, assetId: string, filters: ChartFilters = {}): AssetChart | null {
  const entry = catalogById.get(assetId);
  if (!entry) return null;
  const info = stripAliases(entry);
  const watched = new Set(deps.market.watched(clientId));
  const gran: Granularity = filters.granularity && info.granularities.includes(filters.granularity) ? filters.granularity : info.granularities.includes('1h') ? '1h' : '1d';
  const nowMs = deps.now.getTime();
  const defaultSpan = gran === '1h' ? 14 * DAY : 180 * DAY;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : nowMs;
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00Z`) : toMs - defaultSpan;
  const all = info.granularities.length > 0 ? deps.market.getBars(assetId, gran, fromMs, toMs) : [];
  const bars = all.slice(-2500);
  const events = [...incidentClusters(deps, clientId), ...reportClusters(deps, clientId, Math.min(120, Math.ceil((nowMs - fromMs) / DAY) + 1))];
  const markers: ChartMarker[] = [];
  for (const event of events) {
    const at = Date.parse(event.anchorAt);
    if (at < fromMs || at > toMs) continue;
    if (filters.severity && filters.severity !== 'All' && event.severity !== filters.severity) continue;
    if (filters.category && filters.category !== 'All' && event.category !== filters.category) continue;
    if (filters.country && filters.country !== 'All' && !event.countryCodes.includes(filters.country)) continue;
    const link = mergedLinks(deps, clientId, event).find((m) => m.entry.id === assetId && m.link.status !== 'rejected');
    if (!link) continue;
    markers.push({
      eventId: event.key, anchorId: event.anchorId, at: event.anchorAt, title: event.title, source: event.anchorSource, url: event.anchorUrl, severity: event.severity,
      category: event.category, countries: event.countries, relevance: link.link.explanation?.relevance ?? 'Analyst-added', linkStatus: link.link.status,
      basis: link.link.explanation?.basis ?? 'Added by you; no rule-based evidence.', pathway: link.link.explanation?.pathway ?? '', memberCount: event.members.length, eventAt: event.eventAt,
    });
  }
  markers.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    asset: withStatus(deps, entry, watched), granularity: gran,
    bars: bars.map((b) => ({ t: new Date(b.closeAt).toISOString(), open: b.o, high: b.h, low: b.l, close: b.c })),
    markers, barsTotal: all.length, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    priceBasis: `${info.adjustment}; ${info.currency}; ${info.exchange}; provider ${info.provider}. Each point is the close of a completed ${gran === '1h' ? 'hourly' : 'daily'} bar, plotted at its close time.`,
    computedAt: deps.now.toISOString(),
  };
}

// ---------------------------------------------------------------- historical associations

export const MIN_PRELIMINARY = 5;
export const MIN_OBSERVED = 20;

export type AssociationFilters = { assetId?: string; category?: string; country?: string; window?: WindowId; dims?: Array<'category' | 'country' | 'exposure'> };

type AssocEvent = { snap: Snapshot; anchorMs: number; relevance: string };

export function associations(deps: MarketDeps, clientId: string, filters: AssociationFilters = {}): { results: AssociationResult[]; exploratory: boolean; comparisons: number } {
  const bars = barCache(deps.market);
  const nowMs = deps.now.getTime();
  const dims = new Set(filters.dims && filters.dims.length > 0 ? filters.dims : ['category']);
  const snaps = deps.market.snapshots(clientId);
  const byAsset = new Map<string, AssocEvent[]>();
  for (const snap of snaps) {
    const seen = new Set<string>();
    for (const link of snap.links) {
      if (seen.has(link.assetId)) continue;
      seen.add(link.assetId);
      const list = byAsset.get(link.assetId) ?? [];
      list.push({ snap, anchorMs: Date.parse(snap.anchorAt), relevance: link.relevance });
      byAsset.set(link.assetId, list);
    }
  }
  const raw: AssociationResult[] = [];
  const windows = filters.window ? [filters.window] : WINDOWS;
  for (const [assetId, events] of byAsset) {
    if (filters.assetId && filters.assetId !== assetId) continue;
    const entry = catalogById.get(assetId);
    if (!entry || entry.provider === 'none') continue;
    const info = stripAliases(entry);
    const bench = info.benchmarkId ? catalogById.get(info.benchmarkId) ?? null : null;
    const sorted = [...events].sort((a, b) => a.anchorMs - b.anchorMs);
    for (const window of windows) {
      // Overlap: keep the earliest event of any chain whose windows touch; later ones share its price movement.
      const overlapped = new Set<string>();
      let chainEnd = -Infinity;
      for (const ev of sorted) {
        if (ev.anchorMs < chainEnd) overlapped.add(ev.snap.eventKey);
        else chainEnd = ev.anchorMs + WINDOW_MS[window];
      }
      const groups = new Map<string, { category: string; country: string | null; exposure: string | null; events: AssocEvent[] }>();
      for (const ev of sorted) {
        const category = marketCategory(ev.snap.categories);
        if (filters.category && filters.category !== category) continue;
        const countries = dims.has('country') ? (ev.snap.countries.length > 0 ? ev.snap.countries : ['']) : [null as string | null];
        for (const country of countries) {
          if (filters.country && filters.country !== country) continue;
          const exposure = dims.has('exposure') ? ev.relevance : null;
          const key = `${category}|${country ?? ''}|${exposure ?? ''}`;
          const group = groups.get(key) ?? { category, country: country || null, exposure, events: [] };
          group.events.push(ev);
          groups.set(key, group);
        }
      }
      for (const group of groups.values()) {
        const values: Array<{ anchorId: string; title: string; at: string; valuePct: number }> = [];
        let pendingOrMissing = 0, overlappingExcluded = 0;
        for (const ev of group.events) {
          if (overlapped.has(ev.snap.eventKey)) { overlappingExcluded += 1; continue; }
          const reaction = computeReaction(info, bench ? stripAliases(bench) : null, window, ev.anchorMs, nowMs, bars);
          const value = info.benchmarkId ? reaction.adjustedPct : reaction.returnPct;
          // The classification must have been frozen before the outcome could be seen.
          if (reaction.status !== 'ok' || value === null || Date.parse(ev.snap.snapshotAt) > Date.parse(reaction.measuredAt!)) { pendingOrMissing += 1; continue; }
          values.push({ anchorId: ev.snap.anchorId, title: ev.snap.title, at: ev.snap.anchorAt, valuePct: value });
        }
        const nums = values.map((v) => v.valuePct);
        const enough = nums.length >= MIN_PRELIMINARY;
        const notes: string[] = [];
        if (!enough) notes.push(`Insufficient history: at least ${MIN_PRELIMINARY} distinct, non-overlapping events with completed windows are needed; this group has ${nums.length}.`);
        if (overlappingExcluded > 0) notes.push(`${overlappingExcluded} event(s) were excluded because their ${window} windows overlap an earlier event on the same asset.`);
        if (pendingOrMissing > 0) notes.push(`${pendingOrMissing} event(s) were not used because the window is pending, unsupported, missing data, or the classification was recorded after the outcome was observable.`);
        raw.push({
          asset: { id: info.id, symbol: info.symbol, name: info.name }, category: group.category, country: group.country, exposure: group.exposure, window,
          measure: info.benchmarkId ? 'benchmark-adjusted' : 'raw', label: 'Insufficient history',
          distinctEvents: group.events.length, usedEvents: nums.length, overlappingExcluded, pendingOrMissing,
          period: { from: values[0]?.at ?? null, to: values[values.length - 1]?.at ?? null },
          median: enough ? median(nums) : null, q1: enough ? quantile(nums, 0.25) : null, q3: enough ? quantile(nums, 0.75) : null, stdev: enough ? stdev(nums) : null,
          positiveShare: enough ? nums.filter((v) => v > 0).length / nums.length : null,
          negativeShare: enough ? nums.filter((v) => v < 0).length / nums.length : null,
          zeroShare: enough ? nums.filter((v) => v === 0).length / nums.length : null,
          signTestP: enough ? signTestP(nums) : null, adjustedP: null, comparisons: 0, exploratory: false, notes, events: enough ? values : [],
        });
      }
    }
  }
  const exploratory = !(filters.assetId && filters.category);
  const tested = raw.filter((r) => r.signTestP !== null);
  const adjusted = holmAdjust(tested.map((r) => r.signTestP!));
  tested.forEach((r, i) => {
    r.adjustedP = adjusted[i];
    r.comparisons = tested.length;
    r.exploratory = exploratory;
    const supported = r.usedEvents >= MIN_OBSERVED && r.adjustedP < 0.05;
    r.label = supported ? 'Historically observed association' : 'Preliminary association';
    if (!supported) r.notes.push(r.usedEvents < MIN_OBSERVED ? `Fewer than ${MIN_OBSERVED} events: the pattern may be chance.` : 'Not statistically supported after correcting for multiple comparisons.');
  });
  raw.sort((a, b) => b.usedEvents - a.usedEvents || a.asset.symbol.localeCompare(b.asset.symbol));
  return { results: raw.slice(0, 300), exploratory, comparisons: tested.length };
}

// ---------------------------------------------------------------- correlations

export const MIN_CORR_OBS = 60;
export const MIN_CORR_NONZERO = 10;
const CORR_DAYS = 365;

export function correlations(deps: MarketDeps, clientId: string, filters: { assetId: string; category?: string; country?: string }): CorrelationResult[] {
  const entry = catalogById.get(filters.assetId);
  if (!entry || entry.provider === 'none' || !entry.granularities.includes('1d')) return [];
  const info = stripAliases(entry);
  const bars = barCache(deps.market);
  const series = bars(info.id, '1d');
  const bench = info.benchmarkId ? bars(info.benchmarkId, '1d') : null;
  const nowMs = deps.now.getTime();
  const fromMs = nowMs - CORR_DAYS * DAY;
  const benchByClose = new Map((bench ?? []).map((b, i) => [b.closeAt, i]));
  const days: Array<{ closeAt: number; y: number }> = [];
  for (let i = 1; i < series.length; i += 1) {
    const cur = series[i], prev = series[i - 1];
    if (cur.closeAt < fromMs || cur.closeAt - prev.closeAt > 5 * DAY) continue;
    let y = (cur.c / prev.c - 1) * 100;
    if (bench) {
      const bi = benchByClose.get(cur.closeAt), bp = benchByClose.get(prev.closeAt);
      if (bi === undefined || bp === undefined || bp !== bi - 1) continue;
      y -= (bench[bi].c / bench[bp].c - 1) * 100;
    }
    days.push({ closeAt: cur.closeAt, y });
  }
  const snaps = deps.market.snapshots(clientId).filter((s) => s.links.some((l) => l.assetId === info.id));
  const categories = filters.category ? [filters.category] : [...new Set(snaps.map((s) => marketCategory(s.categories)))];
  const out: CorrelationResult[] = [];
  const seriesY = `${info.symbol} ${bench ? 'benchmark-adjusted' : 'raw'} close-to-close return (%), one value per ${info.calendar === 'XNYS' ? 'trading session' : 'UTC day'}`;
  for (const category of categories) {
    const counts = new Map<number, number>();
    for (const snap of snaps) {
      if (marketCategory(snap.categories) !== category) continue;
      if (filters.country && !snap.countries.includes(filters.country)) continue;
      const bar = firstAtOrAfter(series, Date.parse(snap.anchorAt) + 1);
      if (!bar || Date.parse(snap.snapshotAt) > bar.closeAt) continue; // classification must predate the outcome day
      counts.set(bar.closeAt, (counts.get(bar.closeAt) ?? 0) + 1);
    }
    const x = days.map((d) => counts.get(d.closeAt) ?? 0), y = days.map((d) => d.y);
    const nonZero = x.filter((v) => v > 0).length;
    const base = {
      asset: { id: info.id, symbol: info.symbol, name: info.name }, category, country: filters.country ?? null,
      seriesX: `Number of distinct "${category}" events linked to ${info.symbol} whose first following close is that day (classified before that close)`, seriesY,
      method: 'Pearson and Spearman correlation, same-day alignment, no lag, 95% interval by Fisher z-transform (normal approximation).',
      observations: days.length, nonZeroDays: nonZero,
      window: { from: days[0] ? new Date(days[0].closeAt).toISOString() : null, to: days.length ? new Date(days[days.length - 1].closeAt).toISOString() : null },
      adjustedP: null, comparisons: 0,
    };
    if (days.length < MIN_CORR_OBS || nonZero < MIN_CORR_NONZERO) {
      out.push({ ...base, pearson: null, spearman: null, ci95: null, pValue: null, status: 'Insufficient history',
        needed: `At least ${MIN_CORR_OBS} aligned days and ${MIN_CORR_NONZERO} days with an event; found ${days.length} and ${nonZero}.`,
        notes: ['Only events classified before their outcome day are counted, so history builds up from when this module started recording.'] });
      continue;
    }
    const r = pearson(x, y), rho = spearman(x, y);
    const inf = r === null ? null : fisherInference(r, days.length);
    out.push({ ...base, pearson: r, spearman: rho, ci95: inf?.ci ?? null, pValue: inf?.p ?? null, status: 'ok', needed: '',
      notes: ['Event days are rare and returns are heavy-tailed, so read Spearman alongside Pearson. A correlation does not show cause.', ...(r === null ? ['The event series is constant, so no correlation is defined.'] : [])] });
  }
  const tested = out.filter((r) => r.pValue !== null);
  const adj = holmAdjust(tested.map((r) => r.pValue!));
  tested.forEach((r, i) => { r.adjustedP = adj[i]; r.comparisons = tested.length; });
  return out;
}

// ---------------------------------------------------------------- alerts

const settingsEnabled = (s: MarketAlertSettings) => s.linkAlerts || s.moveAlerts;

/**
 * In-app alerts for the watchlist. Dedupe: one alert per (event, asset) or per (asset, bar). Cooldown: after an alert for an asset,
 * further alerts of that kind for the same asset are suppressed (not queued) for the configured hours.
 */
export function evaluateMarketAlerts(deps: MarketDeps): { created: number } {
  let created = 0;
  const nowIso = deps.now.toISOString();
  const nowMs = deps.now.getTime();
  const bars = barCache(deps.market);
  const clients = deps.market.clientsWithWatch();
  let events: EventCluster[] | null = null;
  for (const clientId of clients) {
    const settings = deps.market.getAlertSettings(clientId);
    if (!settingsEnabled(settings)) continue;
    const watched = deps.market.watched(clientId);
    const cooling = (key: string) => { const at = deps.market.alertedAt(clientId, key); return at !== null && nowMs < Date.parse(at) + settings.cooldownHours * HOUR; };
    if (settings.linkAlerts) {
      events ??= reportClusters(deps, '', 2);
      const recent = events.filter((e) => nowMs - Date.parse(e.anchorAt) <= 6 * HOUR && e.suggestions.length > 0).sort((a, b) => Date.parse(b.anchorAt) - Date.parse(a.anchorAt));
      for (const event of recent) {
        const links = mergedLinks(deps, clientId, event).filter((m) => m.link.status !== 'rejected' && watched.includes(m.entry.id));
        for (const { entry, link } of links) {
          const state = link.status === 'confirmed' ? 'confirmed link' : 'suggested link';
          const stateKey = `link:${entry.id}`;
          if (cooling(stateKey)) continue;
          const made = deps.analysis.createAlert(clientId, {
            kind: 'market-link', dedupeKey: `market-link:${event.key}:${entry.id}`, severity: 'info',
            title: `Watchlist: ${entry.symbol} has a ${state} to a new report`,
            detail: `"${event.title}" (${event.anchorSource}, ${event.anchorAt}). ${link.explanation?.basis ?? ''} This is a suggested link for review, not a market signal.`,
            link: { view: 'Market Impact', id: event.key },
          }, nowIso);
          if (made) { created += 1; deps.market.markAlerted(clientId, stateKey, nowIso); }
        }
      }
    }
    if (settings.moveAlerts) {
      for (const assetId of watched) {
        const entry = catalogById.get(assetId);
        if (!entry || entry.provider === 'none') continue;
        const info = stripAliases(entry);
        const gran: Granularity = settings.moveWindow === '1h' ? '1h' : info.granularities.includes('1h') ? '1h' : '1d';
        if (settings.moveWindow === '1h' && !info.granularities.includes('1h')) continue;
        const series = bars(assetId, gran);
        const last = series[series.length - 1];
        if (!last || nowMs - last.closeAt > (gran === '1h' ? 6 * HOUR : 4 * DAY)) continue; // stale data never raises an alert
        const span = settings.moveWindow === '1h' ? HOUR : DAY;
        const ref = lastAtOrBefore(series, last.closeAt - span);
        if (!ref || last.closeAt - ref.closeAt > span * 2) continue;
        const move = (last.c / ref.c - 1) * 100;
        if (Math.abs(move) < settings.movePct) continue;
        const stateKey = `move:${assetId}`;
        if (cooling(stateKey)) continue;
        const made = deps.analysis.createAlert(clientId, {
          kind: 'market-move', dedupeKey: `market-move:${assetId}:${last.t}`, severity: Math.abs(move) >= settings.movePct * 2 ? 'warning' : 'info',
          title: `${info.symbol} moved ${move >= 0 ? '+' : ''}${move.toFixed(1)}% over ${settings.moveWindow}`,
          detail: `Observed change between ${new Date(ref.closeAt).toISOString()} and ${new Date(last.closeAt).toISOString()} (${info.adjustment}). This is an observation, not an explanation or a forecast.`,
          link: { view: 'Market Impact', id: assetId },
        }, nowIso);
        if (made) { created += 1; deps.market.markAlerted(clientId, stateKey, nowIso); }
      }
    }
  }
  return { created };
}

export { CATALOG, LINK_RULES_VERSION, countryName };
