import type { AssetInfo, Granularity, WindowId, WindowReaction } from '../src/data/marketTypes';
import type { Bar } from './market-providers';
import { firstDailyCloseAtOrAfter } from './market-calendar';

/**
 * Method (documented in the UI):
 *  - Anchor: the earliest public report time among de-duplicated coverage.
 *  - Reference price: close of the last completed bar at or before the anchor (a pre-publication price).
 *  - Measured price: close of the completed bar nearest to anchor + window (ties go to the later bar), never earlier than the anchor.
 *    The window counts as complete only once a bar at or after anchor + window exists. The actual bar times are always shown.
 *  - Return = measured / reference - 1, on split/dividend-adjusted closes where the provider supplies them.
 *  - Benchmark return uses the benchmark's prices at exactly the same two bar times; otherwise it is left empty.
 *  - Benchmark-adjusted return = asset return minus benchmark return (percentage points).
 *  - Pre-event comparison: return over the same window length ending at the reference time.
 */

export const WINDOW_MS: Record<WindowId, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };
export const WINDOWS: WindowId[] = ['1h', '24h', '7d'];
const DATA_LAG_MS = 6 * 3_600_000;

export type BarSource = (assetId: string, granularity: Granularity) => Bar[];

export function lastAtOrBefore(bars: Bar[], ms: number): Bar | null {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeAt <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 ? bars[found] : null;
}

export function firstAtOrAfter(bars: Bar[], ms: number): Bar | null {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeAt >= ms) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found >= 0 ? bars[found] : null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const blank = (window: WindowId, status: WindowReaction['status'], reason: string, extra: Partial<WindowReaction> = {}): WindowReaction => ({
  window, status, reason, referenceAt: null, referencePrice: null, measuredAt: null, measuredPrice: null, returnPct: null,
  benchmarkReturnPct: null, adjustedPct: null, benchmarkNote: '', preReturnPct: null, preFromAt: null, ...extra,
});

/** Largest gap between the wanted time and the bar used before the data is treated as missing. */
const maxGap = (asset: AssetInfo, granularity: Granularity) => (granularity === '1h' ? 6 * 3_600_000 : asset.calendar === '24x7' ? 2 * 86_400_000 : 5 * 86_400_000);

function expectedClose(asset: AssetInfo, granularity: Granularity, targetMs: number) {
  return granularity === '1h' ? Math.ceil(targetMs / 3_600_000) * 3_600_000 : firstDailyCloseAtOrAfter(asset.calendar, targetMs);
}

/** Chooses the bar series for a window: hourly when the asset has it and it reaches back to the anchor, otherwise daily. */
function chooseSeries(asset: AssetInfo, window: WindowId, anchorMs: number, bars: BarSource): { granularity: Granularity; series: Bar[] } | { reason: string } {
  if (asset.provider === 'none' || asset.granularities.length === 0) return { reason: asset.note ?? 'No price source is configured for this listing.' };
  if (asset.granularities.includes('1h')) {
    const hourly = bars(asset.id, '1h');
    if (hourly.length > 0 && hourly[0].closeAt <= anchorMs) return { granularity: '1h', series: hourly };
  }
  if (window === '1h') {
    return { reason: asset.granularities.includes('1h') ? 'Stored hourly history does not reach back to this event.' : 'Only daily prices are available for this asset, so a 1-hour window cannot be measured.' };
  }
  if (asset.granularities.includes('1d')) return { granularity: '1d', series: bars(asset.id, '1d') };
  return { reason: 'Daily prices are not available for this asset.' };
}

export function computeReaction(asset: AssetInfo, benchmark: AssetInfo | null, window: WindowId, anchorMs: number, nowMs: number, bars: BarSource): WindowReaction {
  const chosen = chooseSeries(asset, window, anchorMs, bars);
  if ('reason' in chosen) return blank(window, 'unsupported', chosen.reason);
  const { granularity, series } = chosen;
  if (series.length === 0) return blank(window, 'missing', 'No prices have been fetched for this asset yet.');
  const ref = lastAtOrBefore(series, anchorMs);
  if (!ref) return blank(window, 'missing', 'Stored price history starts after the event, so there is no pre-publication reference price.');
  if (anchorMs - ref.closeAt > maxGap(asset, granularity)) return blank(window, 'missing', 'The last price before publication is too old (data gap), so no reference price is used.');

  const target = anchorMs + WINDOW_MS[window];
  const after = firstAtOrAfter(series, target);
  const before = lastAtOrBefore(series, target);
  const measured = after && before && before.closeAt > anchorMs && target - before.closeAt < after.closeAt - target ? before : after;
  const base = { referenceAt: iso(ref.closeAt), referencePrice: ref.c };
  if (!measured) {
    const expected = expectedClose(asset, granularity, target);
    if (expected + DATA_LAG_MS > nowMs) return blank(window, 'pending', `Window not complete: waiting for the first price at or after ${iso(target)} (next expected bar ${iso(expected)}).`, base);
    return blank(window, 'missing', `No price bar is stored for the expected time ${iso(expected)}; the provider has not supplied it.`, base);
  }
  if (Math.abs(measured.closeAt - target) > maxGap(asset, granularity)) return blank(window, 'missing', 'The next available price is too far after the window end (data gap).', base);

  const returnPct = (measured.c / ref.c - 1) * 100;
  const out: WindowReaction = { ...blank(window, 'ok', 'Measured.', base), measuredAt: iso(measured.closeAt), measuredPrice: measured.c, returnPct };

  const preFrom = lastAtOrBefore(series, ref.closeAt - WINDOW_MS[window]);
  if (preFrom && ref.closeAt - preFrom.closeAt <= WINDOW_MS[window] + maxGap(asset, granularity)) {
    out.preReturnPct = (ref.c / preFrom.c - 1) * 100;
    out.preFromAt = iso(preFrom.closeAt);
  }

  if (!benchmark) {
    out.benchmarkNote = asset.benchmarkId === null ? 'No benchmark is defined for this asset.' : 'The benchmark is not available.';
  } else if (benchmark.provider === 'none') {
    out.benchmarkNote = `Benchmark ${benchmark.symbol} has no price source.`;
  } else {
    const bSeries = bars(benchmark.id, granularity);
    const bRef = bSeries.find((bar) => bar.closeAt === ref.closeAt);
    const bMeasured = bSeries.find((bar) => bar.closeAt === measured.closeAt);
    if (bRef && bMeasured) {
      out.benchmarkReturnPct = (bMeasured.c / bRef.c - 1) * 100;
      out.adjustedPct = returnPct - out.benchmarkReturnPct;
      out.benchmarkNote = `Benchmark ${benchmark.symbol} measured at the same two bar times.`;
    } else {
      out.benchmarkNote = `Benchmark ${benchmark.symbol} has no price at exactly the same bar times (${bSeries.length === 0 ? 'no benchmark prices stored' : 'timestamps differ or data missing'}), so no adjusted return is shown.`;
    }
  }
  return out;
}

export function computeReactions(asset: AssetInfo, benchmark: AssetInfo | null, anchorMs: number, nowMs: number, bars: BarSource): WindowReaction[] {
  return WINDOWS.map((window) => computeReaction(asset, benchmark, window, anchorMs, nowMs, bars));
}
