import { catalogById, stripAliases } from './market-catalog';
import { lastDailyCloseAtOrBefore } from './market-calendar';
import { fetchBars, missingKey, ProviderError, PROVIDER_SPACING_MS, credentialName } from './market-providers';
import type { MarketStore } from './market-store';
import type { AssetInfo, AssetStatus, Granularity, ProviderId } from '../src/data/marketTypes';

const HOUR = 3_600_000;

/** Granularity used to describe an asset's freshness: the finest one it has. */
export const primaryGranularity = (asset: AssetInfo): Granularity | null => (asset.granularities.includes('1h') ? '1h' : asset.granularities.includes('1d') ? '1d' : null);

const LAG_MS: Partial<Record<ProviderId, number>> = { tiingo: 12 * HOUR, fred: 48 * HOUR, coinbase: 2 * HOUR };

export function assetStatus(asset: AssetInfo, market: MarketStore, env: NodeJS.ProcessEnv, now: Date): AssetStatus {
  const base: AssetStatus = { status: 'not_fetched', label: 'Not fetched', detail: '', lastSuccessAt: null, lastAttemptAt: null, latestBarClose: null, nextRunAt: null, error: null };
  const gran = primaryGranularity(asset);
  if (asset.provider === 'none' || !gran) return { ...base, status: 'unsupported', label: 'Unsupported', detail: asset.note ?? 'No price provider is configured for this listing.' };
  const key = missingKey(asset.provider, env);
  const state = market.getState(asset.id, gran);
  const last = market.lastBar(asset.id, gran);
  const common = { ...base, lastSuccessAt: state?.lastSuccessAt ?? null, lastAttemptAt: state?.lastAttemptAt ?? null, nextRunAt: state?.nextRunAt ?? null, latestBarClose: last ? new Date(last.closeAt).toISOString() : null, error: state?.lastError ?? null };
  if (key && !last) return { ...common, status: 'setup_required', label: 'Setup required', detail: `Set ${key} on the server to fetch prices for this asset.` };
  if (!last) {
    if (state?.lastError) return { ...common, status: 'unavailable', label: 'Unavailable', detail: `The provider could not be reached: ${state.lastError}` };
    return { ...common, status: 'not_fetched', label: 'Not fetched yet', detail: 'Prices are fetched in the background for watched assets, assets with confirmed links and benchmarks.' };
  }
  const failing = (state?.failCount ?? 0) > 0;
  const age = now.getTime() - last.closeAt;
  const lag = LAG_MS[asset.provider] ?? 12 * HOUR;
  let fresh: 'live' | 'delayed' | 'stale';
  if (gran === '1h') fresh = age <= 2 * HOUR ? 'live' : age <= 6 * HOUR ? 'delayed' : 'stale';
  else {
    const expected = asset.calendar === '24x7' ? now.getTime() - lag - ((now.getTime() - lag) % 86_400_000) : lastDailyCloseAtOrBefore(asset.calendar, now.getTime() - lag).close;
    const behind = expected - last.closeAt;
    fresh = behind <= 0 ? 'delayed' : behind <= 2.5 * 86_400_000 ? 'delayed' : 'stale';
  }
  const dailyNote = gran === '1d' ? 'End-of-day data: the newest value is the last completed session.' : 'Hourly bars are shown once complete.';
  if (failing) return { ...common, status: 'stale', label: 'Stale', detail: `Showing the last stored prices; the latest refresh failed (${state?.lastError ?? 'unknown error'}). Retrying with backoff.` };
  if (fresh === 'stale') return { ...common, status: 'stale', label: 'Stale', detail: `The newest stored bar closed ${new Date(last.closeAt).toISOString()}. ${dailyNote}` };
  if (fresh === 'delayed') return { ...common, status: 'delayed', label: 'Delayed', detail: dailyNote };
  return { ...common, status: 'live', label: 'Live', detail: dailyNote };
}

/** Assets that need prices: everything watched, everything with a confirmed link, and the benchmarks of those. */
export function targetAssetIds(market: MarketStore): string[] {
  const ids = new Set<string>([...market.allWatchedAssetIds(), ...market.confirmedAssetIds()]);
  for (const id of [...ids]) {
    const bench = catalogById.get(id)?.benchmarkId;
    if (bench) ids.add(bench);
  }
  return [...ids].filter((id) => {
    const asset = catalogById.get(id);
    return asset && asset.provider !== 'none';
  });
}

const refreshAfterSuccess = (asset: AssetInfo, gran: Granularity) => (gran === '1h' ? 5 * 60_000 : asset.provider === 'coinbase' ? HOUR : 3 * HOUR);
export const backoffMs = (failCount: number) => Math.min(6 * HOUR, 2 * 60_000 * 2 ** Math.max(0, failCount - 1));

export type SyncDeps = { market: MarketStore; env: NodeJS.ProcessEnv; fetcher: typeof fetch; now: () => Date; onUpdate?: (assetId: string) => void };

const lastRequest = new Map<ProviderId, number>();
let running = false;

/** Resets throttling state (tests). */
export function resetSyncState() { lastRequest.clear(); running = false; }

/**
 * One scheduler tick: fetch whatever is due, respecting per-provider spacing, backoff and credentials.
 * Incremental: only bars after the last stored one are requested; a re-adjusted history triggers a full refetch.
 */
export async function runMarketSync(deps: SyncDeps): Promise<{ fetched: string[]; failed: string[]; skipped: number }> {
  const result = { fetched: [] as string[], failed: [] as string[], skipped: 0 };
  if (running) return result;
  running = true;
  try {
    for (const id of targetAssetIds(deps.market)) {
      const asset = stripAliases(catalogById.get(id)!);
      for (const gran of asset.granularities) {
        const now = deps.now();
        const state = deps.market.getState(id, gran);
        if (state?.nextRunAt && Date.parse(state.nextRunAt) > now.getTime()) { result.skipped += 1; continue; }
        const key = missingKey(asset.provider, deps.env);
        const stamp = now.toISOString();
        if (key) {
          deps.market.saveState({ assetId: id, granularity: gran, lastAttemptAt: stamp, lastSuccessAt: state?.lastSuccessAt ?? null, lastError: `${key} is not set`, errorKind: 'setup', failCount: 0, nextRunAt: new Date(now.getTime() + 30 * 60_000).toISOString(), needsFull: false });
          result.skipped += 1;
          continue;
        }
        const spacing = PROVIDER_SPACING_MS[asset.provider];
        if (now.getTime() - (lastRequest.get(asset.provider) ?? 0) < spacing) { result.skipped += 1; continue; }
        lastRequest.set(asset.provider, now.getTime());
        const last = deps.market.lastBar(id, gran);
        try {
          const fetched = await fetchBars({ asset, granularity: gran, lastT: state?.needsFull ? null : last?.t ?? null, now, env: deps.env, fetcher: deps.fetcher, full: state?.needsFull });
          let needsFull = false;
          if (fetched.replaced) deps.market.replaceBars(id, gran, fetched.bars, stamp);
          else {
            const overlap = last ? fetched.bars.find((bar) => bar.t === last.t) : undefined;
            // Adjusted histories change when a split or dividend is applied; a changed overlapping value means older bars are stale.
            if (last && overlap && asset.provider === 'tiingo' && Math.abs(overlap.c / last.c - 1) > 1e-6) needsFull = true;
            else deps.market.upsertBars(id, gran, fetched.bars, stamp);
          }
          deps.market.saveState({
            assetId: id, granularity: gran, lastAttemptAt: stamp, lastSuccessAt: stamp, lastError: null, errorKind: null, failCount: 0,
            nextRunAt: new Date(now.getTime() + (needsFull ? 0 : refreshAfterSuccess(asset, gran))).toISOString(), needsFull,
          });
          result.fetched.push(`${id}:${gran}`);
          deps.onUpdate?.(id);
        } catch (error) {
          const perr = error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : 'Fetch failed.');
          const failCount = (state?.failCount ?? 0) + 1;
          const wait = perr.kind === 'rate' ? Math.max(perr.retryAfterMs ?? 0, 15 * 60_000) : perr.kind === 'setup' ? 30 * 60_000 : backoffMs(failCount);
          deps.market.saveState({
            assetId: id, granularity: gran, lastAttemptAt: stamp, lastSuccessAt: state?.lastSuccessAt ?? null, lastError: perr.message, errorKind: perr.kind,
            failCount, nextRunAt: new Date(now.getTime() + wait).toISOString(), needsFull: state?.needsFull ?? false,
          });
          result.failed.push(`${id}:${gran}`);
        }
      }
    }
  } finally {
    running = false;
  }
  return result;
}

export { credentialName };
