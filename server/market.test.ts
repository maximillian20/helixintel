import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisStore } from './analysis-store';
import { barCloseForDate, dailyCloseUtc, easterSunday, firstDailyCloseAtOrAfter, isTradingDay, localToUtc, mapEventToSession, nyseEarlyCloses, nyseHolidays } from './market-calendar';
import { CATALOG, catalogById, searchCatalog, stripAliases } from './market-catalog';
import { marketCategory, suggestLinks } from './market-links';
import { parseCoinbaseCandles, parseFredObservations, parseTiingoDaily, type Bar } from './market-providers';
import { computeReaction, computeReactions } from './market-reactions';
import {
  MIN_OBSERVED, associations, captureReportSnapshots, clearEventCache, correlations, eventView, evaluateMarketAlerts, findEvent, listEvents, mergedLinks, type MarketDeps,
} from './market-service';
import { fisherInference, holmAdjust, median, pearson, quantile, signTestP, spearman } from './market-stats';
import { MarketStore } from './market-store';
import { assetStatus, backoffMs, resetSyncState, runMarketSync } from './market-sync';
import { buildSources } from './connectors';
import { SourceStore, type NormalizedArticle } from './source-store';

process.env.NODE_ENV = 'test';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = new Date('2026-10-11T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const asset = (id: string) => stripAliases(catalogById.get(id)!);
const ETH = 'crypto:ETH-USD:COINBASE';
const BTC = 'crypto:BTC-USD:COINBASE';
const XOM = 'stock:XOM:XNYS';
const SPY = 'stock:SPY:ARCX';

const bar = (t: string, closeAt: number, c: number): Bar => ({ t, closeAt, o: c, h: c, l: c, c, rawClose: null });
function hourly(from: number, to: number, price: (closeAt: number) => number): Bar[] {
  const out: Bar[] = [];
  for (let at = from; at <= to; at += HOUR) out.push(bar(iso(at - HOUR), at, price(at)));
  return out;
}
const source = (bars: Record<string, Bar[]>) => (assetId: string, gran: string) => bars[`${assetId}|${gran}`] ?? [];

// ------------------------------------------------------------------ calendar

test('NYSE holidays follow the published rules, including observed dates and Good Friday', () => {
  assert.deepEqual(easterSunday(2026), { m: 4, d: 5 });
  const h = nyseHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) assert.ok(h.has(d), d);
  assert.equal(h.size, 10);
  assert.equal(isTradingDay('XNYS', '2026-07-04'), false); // Saturday
  assert.equal(isTradingDay('XNYS', '2026-07-03'), false); // observed Independence Day
  assert.equal(isTradingDay('XNYS', '2027-12-31'), true); // Saturday New Year's Day 2028 is not observed on the Friday
  assert.equal(isTradingDay('24x7', '2026-12-25'), true);
  assert.ok(nyseEarlyCloses(2026).has('2026-11-27'));
  assert.ok(nyseEarlyCloses(2026).has('2026-12-24'));
});

test('close times respect daylight saving and early closes', () => {
  assert.equal(iso(dailyCloseUtc('XNYS', '2026-07-01')), '2026-07-01T20:00:00.000Z');
  assert.equal(iso(dailyCloseUtc('XNYS', '2026-12-01')), '2026-12-01T21:00:00.000Z');
  assert.equal(iso(dailyCloseUtc('XNYS', '2026-11-27')), '2026-11-27T18:00:00.000Z');
  assert.equal(iso(localToUtc('2026-03-08', 16, 0, 'America/New_York')), '2026-03-08T20:00:00.000Z'); // DST begins that morning
  assert.equal(iso(barCloseForDate('DAILY_SPOT', '2026-10-09')), '2026-10-10T00:00:00.000Z');
});

test('out-of-hours events map to the next session and the mapping is disclosed', () => {
  const sat = mapEventToSession('XNYS', Date.parse('2026-10-03T15:00:00Z'));
  assert.equal(sat.state, 'weekend');
  assert.equal(iso(sat.firstCloseAfter!), '2026-10-05T20:00:00.000Z');
  assert.match(sat.note, /weekend/);
  const after = mapEventToSession('XNYS', Date.parse('2026-10-02T22:00:00Z'));
  assert.equal(after.state, 'after-close');
  const open = mapEventToSession('XNYS', Date.parse('2026-10-02T15:00:00Z'));
  assert.equal(open.state, 'open');
  assert.match(open.note, /pre-publication|before publication/);
  const holiday = mapEventToSession('XNYS', Date.parse('2026-11-26T15:00:00Z'));
  assert.equal(holiday.state, 'holiday');
  assert.match(holiday.note, /Thanksgiving/);
  assert.equal(iso(firstDailyCloseAtOrAfter('XNYS', Date.parse('2026-11-26T15:00:00Z'))), '2026-11-27T18:00:00.000Z');
  assert.equal(mapEventToSession('24x7', Date.now()).state, 'continuous');
});

// ------------------------------------------------------------------ provider parsing and asset identity

test('provider parsers keep complete bars only and skip missing observations', () => {
  const now = Date.parse('2026-10-11T12:30:00Z');
  const t = (iso0: string) => Date.parse(iso0) / 1000;
  const coinbase = JSON.stringify([[t('2026-10-11T12:00:00Z'), 99, 101, 100, 100.5, 5], [t('2026-10-11T11:00:00Z'), 98, 102, 99, 100, 7], ['bad']]);
  const bars = parseCoinbaseCandles(coinbase, 3600, now);
  assert.equal(bars.length, 1); // the 12:00 bar closes at 13:00, after now
  assert.equal(iso(bars[0].closeAt), '2026-10-11T12:00:00.000Z');
  const tiingo = JSON.stringify([
    { date: '2026-10-08T00:00:00.000Z', close: 200, adjClose: 100, adjOpen: 99, adjHigh: 101, adjLow: 98, splitFactor: 1, divCash: 0 },
    { date: '2026-10-09T00:00:00.000Z', close: 202, adjClose: 101, adjOpen: 100, adjHigh: 102, adjLow: 99 },
    { date: '2026-10-12T00:00:00.000Z', close: 1, adjClose: 1, adjOpen: 1, adjHigh: 1, adjLow: 1 },
  ]);
  const days = parseTiingoDaily(tiingo, 'XNYS', now);
  assert.equal(days.length, 2);
  assert.equal(days[0].c, 100);
  assert.equal(days[0].rawClose, 200); // adjusted and raw prices are both kept
  const fred = parseFredObservations(JSON.stringify({ observations: [{ date: '2026-10-07', value: '.' }, { date: '2026-10-08', value: '5000.5' }] }), 'XNYS', now);
  assert.equal(fred.length, 1);
  assert.equal(fred[0].c, 5000.5);
});

test('listings of one company stay distinct and unsupported listings are labelled', () => {
  const shell = CATALOG.filter((entry) => entry.companyKey === 'shell');
  assert.deepEqual(shell.map((s) => s.id).sort(), ['stock:SHEL:XLON', 'stock:SHEL:XNYS']);
  assert.deepEqual(new Set(shell.map((s) => s.currency)), new Set(['GBP', 'USD']));
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length);
  assert.equal(catalogById.get('stock:SHEL:XLON')!.provider, 'none');
  assert.equal(catalogById.get('stock:SHEL:XNYS')!.adjustment, 'split-dividend adjusted');
  assert.ok(searchCatalog('shell').length >= 2);
  assert.equal(searchCatalog('bitcoin', 'crypto').length, 1);
  assert.equal(searchCatalog('bitcoin', 'stock').length, 0);
});

// ------------------------------------------------------------------ return calculations

test('crypto windows: reference, measurement times, returns, pre-event and benchmark-adjusted values', () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const ref0 = Date.parse('2026-10-05T10:00:00Z');
  const eth = hourly(start, NOW.getTime(), (at) => (at <= ref0 ? 100 : 100 + (at - ref0) / HOUR));
  const btc = hourly(start, NOW.getTime(), (at) => (at <= ref0 ? 1000 : 1000 * (1 + 0.001 * ((at - ref0) / HOUR))));
  const bars = source({ [`${ETH}|1h`]: eth, [`${BTC}|1h`]: btc });
  const anchor = Date.parse('2026-10-05T10:20:00Z');
  const [h1, h24, d7] = computeReactions(asset(ETH), asset(BTC), anchor, NOW.getTime(), bars);
  assert.equal(h1.status, 'ok');
  assert.equal(h1.referenceAt, '2026-10-05T10:00:00.000Z');
  assert.equal(h1.measuredAt, '2026-10-05T11:00:00.000Z'); // bar nearest to anchor + 1h (11:20)
  assert.ok(Math.abs(h1.returnPct! - 1) < 1e-9);
  assert.ok(Math.abs(h1.benchmarkReturnPct! - 0.1) < 1e-9);
  assert.ok(Math.abs(h1.adjustedPct! - 0.9) < 1e-9);
  assert.equal(h1.preReturnPct, 0);
  assert.equal(h1.preFromAt, '2026-10-05T09:00:00.000Z');
  assert.equal(h24.measuredAt, '2026-10-06T10:00:00.000Z');
  assert.ok(Math.abs(h24.returnPct! - 24) < 1e-9);
  assert.ok(Math.abs(h24.adjustedPct! - 21.6) < 1e-9);
  assert.equal(d7.status, 'pending'); // 2026-10-12 is still in the future
});

test('windows that are not complete are Pending, never partial numbers', () => {
  const start = Date.parse('2026-10-08T00:00:00Z');
  const eth = hourly(start, NOW.getTime(), () => 100);
  const bars = source({ [`${ETH}|1h`]: eth, [`${BTC}|1h`]: hourly(start, NOW.getTime(), () => 1000) });
  const anchor = Date.parse('2026-10-11T10:30:00Z');
  const reactions = computeReactions(asset(ETH), asset(BTC), anchor, NOW.getTime(), bars);
  assert.equal(reactions[0].status, 'ok'); // 11:30 -> bar at 12:00 exists
  assert.equal(reactions[1].status, 'pending');
  assert.equal(reactions[2].status, 'pending');
  assert.equal(reactions[1].returnPct, null);
  assert.match(reactions[1].reason, /Window not complete/);
});

test('stocks have daily data only: 1h is Unsupported, after-close news is measured at the next session close', () => {
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const xom = dates.map((d, i) => bar(d, barCloseForDate('XNYS', d), 100 + i));
  const spy = dates.map((d, i) => bar(d, barCloseForDate('XNYS', d), 500 + i * 2));
  const bars = source({ [`${XOM}|1d`]: xom, [`${SPY}|1d`]: spy });
  const anchor = Date.parse('2026-10-02T22:00:00Z'); // Friday after the close
  const [h1, h24, d7] = computeReactions(asset(XOM), asset(SPY), anchor, NOW.getTime(), bars);
  assert.equal(h1.status, 'unsupported');
  assert.match(h1.reason, /daily/i);
  assert.equal(h24.status, 'ok');
  assert.equal(h24.referenceAt, '2026-10-02T20:00:00.000Z');
  assert.equal(h24.measuredAt, '2026-10-05T20:00:00.000Z'); // Monday close: the first close at or after Saturday 22:00
  assert.ok(Math.abs(h24.returnPct! - (105 / 104 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(h24.benchmarkReturnPct! - (510 / 508 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(h24.adjustedPct! - (h24.returnPct! - h24.benchmarkReturnPct!)) < 1e-12);
  assert.equal(d7.status, 'pending'); // Friday 22:00 + 7d: the next close after that is Monday 10-12, which is in the future
});

test('the 7-day stock window is pending until the next close exists, and a missing benchmark bar blocks the adjusted figure', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const xom = dates.map((d, i) => bar(d, barCloseForDate('XNYS', d), 100 + i));
  const spy = dates.filter((d) => d !== '2026-10-06').map((d, i) => bar(d, barCloseForDate('XNYS', d), 500 + i));
  const bars = source({ [`${XOM}|1d`]: xom, [`${SPY}|1d`]: spy });
  const anchor = Date.parse('2026-10-02T22:00:00Z');
  const r24 = computeReaction(asset(XOM), asset(SPY), '24h', anchor, NOW.getTime(), bars);
  assert.equal(r24.status, 'ok');
  assert.ok(r24.benchmarkReturnPct !== null); // 10-02 and 10-05 both exist in the benchmark
  const anchor2 = Date.parse('2026-10-05T22:00:00Z');
  const r2 = computeReaction(asset(XOM), asset(SPY), '24h', anchor2, NOW.getTime(), bars);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.measuredAt, '2026-10-06T20:00:00.000Z');
  assert.equal(r2.benchmarkReturnPct, null);
  assert.equal(r2.adjustedPct, null);
  assert.match(r2.benchmarkNote, /same bar times/);
  const r7 = computeReaction(asset(XOM), asset(SPY), '7d', anchor, NOW.getTime(), bars);
  assert.equal(r7.status, 'pending');
});

test('missing prices and unsupported listings are reported honestly', () => {
  const none = source({});
  assert.equal(computeReaction(asset(XOM), asset(SPY), '24h', NOW.getTime() - 3 * DAY, NOW.getTime(), none).status, 'missing');
  const shell = computeReaction(asset('stock:SHEL:XLON'), null, '24h', NOW.getTime() - 3 * DAY, NOW.getTime(), none);
  assert.equal(shell.status, 'unsupported');
  assert.match(shell.reason, /free price provider/);
  // History that starts after the event gives no pre-publication reference.
  const late = source({ [`${XOM}|1d`]: [bar('2026-10-08', barCloseForDate('XNYS', '2026-10-08'), 100)] });
  const r = computeReaction(asset(XOM), null, '24h', Date.parse('2026-10-01T15:00:00Z'), NOW.getTime(), late);
  assert.equal(r.status, 'missing');
  assert.match(r.reason, /starts after the event/);
  // A gap larger than the tolerance is not bridged.
  const gap = source({ [`${XOM}|1d`]: [bar('2026-09-01', barCloseForDate('XNYS', '2026-09-01'), 100), bar('2026-10-08', barCloseForDate('XNYS', '2026-10-08'), 100)] });
  assert.equal(computeReaction(asset(XOM), null, '24h', Date.parse('2026-10-01T15:00:00Z'), NOW.getTime(), gap).status, 'missing');
});

// ------------------------------------------------------------------ link rules

test('link suggestions explain themselves and separate direct, sector and broad-market evidence', () => {
  const oil = suggestLinks({ text: 'Drone strike hits oil terminal near the Strait of Hormuz', categories: ['armed-attack'], countries: ['IR'], severity: 'High' });
  const xom = oil.find((s) => s.assetId === XOM)!;
  assert.equal(xom.relevance, 'Sector and geography');
  assert.match(xom.explanation.basis, /Iran/);
  assert.match(xom.explanation.basis, /oil terminal|oil|hormuz/i);
  assert.ok(xom.explanation.alternatives.length >= 3);
  assert.ok(oil.some((s) => s.assetId === 'index:BRENT'));
  assert.ok(oil.some((s) => s.assetId === 'stock:LMT:XNYS' && s.relevance === 'Sector'));
  const direct = suggestLinks({ text: 'Chevron says production halted after attack', categories: ['armed-attack'], countries: [], severity: 'Medium' });
  assert.equal(direct.find((s) => s.assetId === 'stock:CVX:XNYS')!.relevance, 'Direct');
  assert.equal(direct[0].relevance, 'Direct');
  // Ticker-like words are not treated as company mentions.
  const noise = suggestLinks({ text: 'The UPS and BP monitors failed; ZS and CF are abbreviations', categories: [], countries: [], severity: 'Low' });
  assert.equal(noise.length, 0);
  // Both listings of Shell are suggested separately.
  const shell = suggestLinks({ text: 'Shell plc halts output', categories: [], countries: [], severity: 'Low' }).map((s) => s.assetId);
  assert.ok(shell.includes('stock:SHEL:XNYS') && shell.includes('stock:SHEL:XLON'));
  // Broad-market context only for Critical events.
  assert.ok(suggestLinks({ text: 'x', categories: [], countries: [], severity: 'Critical' }).some((s) => s.relevance === 'Broad market'));
  assert.ok(!suggestLinks({ text: 'x', categories: [], countries: [], severity: 'High' }).some((s) => s.relevance === 'Broad market'));
  const cyber = suggestLinks({ text: 'Ransomware attack on hospital network', categories: ['cyber'], countries: [], severity: 'Medium' });
  assert.ok(cyber.some((s) => s.assetId === 'stock:CRWD:XNAS'));
  assert.equal(marketCategory(['cyber']), 'cyber');
  assert.equal(marketCategory([], 'earthquake'), 'natural-hazard');
});

// ------------------------------------------------------------------ statistics

test('statistics helpers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.ok(Math.abs(signTestP([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])! - 2 / 1024) < 1e-12);
  assert.equal(signTestP([0, 0]), null);
  assert.deepEqual(holmAdjust([0.01, 0.04, 0.03]).map((v) => Number(v.toFixed(2))), [0.03, 0.06, 0.06]);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8])! - 1) < 1e-12);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])! - 1) < 1e-12);
  const f = fisherInference(0.5, 30)!;
  assert.ok(f.ci[0] < 0.5 && f.ci[1] > 0.5 && f.p < 0.01);
  assert.equal(fisherInference(0.5, 3), null);
});

// ------------------------------------------------------------------ sync, freshness, backoff

function candlesFor(url: string): Response {
  const u = new URL(url);
  const gran = Number(u.searchParams.get('granularity'));
  const start = Date.parse(u.searchParams.get('start')!), end = Date.parse(u.searchParams.get('end')!);
  const rows: number[][] = [];
  for (let t = Math.ceil(start / (gran * 1000)) * gran * 1000; t < end; t += gran * 1000) rows.push([t / 1000, 99, 101, 100, 100 + (t / 1000 / gran) % 7, 1]);
  return new Response(JSON.stringify(rows.reverse()), { status: 200 });
}

/** Clock that advances one second per call so provider spacing is exercised without real waiting. */
function at(start: Date) {
  let k = 0;
  return () => new Date(start.getTime() + (k += 1000));
}

function memoryStores() {
  const source = new SourceStore(':memory:');
  return { source, analysis: new AnalysisStore(source.handle), market: new MarketStore(source.handle) };
}

test('background sync is incremental, backs off on failure, and shows setup, stale and unavailable states', async () => {
  const { source, market } = memoryStores();
  try {
    market.watch('c1', ETH, NOW.toISOString());
    market.watch('c1', XOM, NOW.toISOString());
    market.watch('c1', 'stock:SHEL:XLON', NOW.toISOString());
    let calls: string[] = [];
    const fetcher = (async (input: unknown) => { calls.push(String(input)); return candlesFor(String(input)); }) as typeof fetch;
    resetSyncState();
    let now = new Date(NOW);
    const first = await runMarketSync({ market, env: {}, fetcher, now: at(now) });
    assert.ok(first.fetched.includes(`${ETH}:1h`) && first.fetched.includes(`${ETH}:1d`));
    assert.ok(!calls.some((url) => url.includes('tiingo'))); // no credential: not called
    assert.ok(market.barCount(ETH, '1h') > 600);
    // Setup required is reported without any request; the unsupported listing is never fetched.
    assert.equal(assetStatus(asset(XOM), market, {}, now).status, 'setup_required');
    assert.match(assetStatus(asset(XOM), market, {}, now).detail, /TIINGO_API_TOKEN/);
    assert.equal(assetStatus(asset('stock:SHEL:XLON'), market, {}, now).status, 'unsupported');
    assert.equal(assetStatus(asset(ETH), market, {}, now).status, 'live');
    // A second tick inside the refresh interval makes no requests.
    calls = [];
    await runMarketSync({ market, env: {}, fetcher, now: at(new Date(now.getTime() + 60_000)) });
    assert.equal(calls.length, 0);
    // Later: incremental request starts at the last stored bar, not at the beginning.
    now = new Date(NOW.getTime() + 2 * HOUR);
    calls = [];
    const before = market.barCount(ETH, '1h');
    await runMarketSync({ market, env: {}, fetcher, now: at(now) });
    const hourlyCall = calls.find((url) => url.includes('ETH-USD') && url.includes('granularity=3600'))!;
    assert.ok(Date.parse(new URL(hourlyCall).searchParams.get('start')!) >= NOW.getTime() - 3 * HOUR);
    assert.equal(calls.filter((url) => url.includes('ETH-USD') && url.includes('granularity=3600')).length, 1);
    assert.ok(calls.some((url) => url.includes('BTC-USD'))); // the benchmark is fetched too
    assert.ok(market.barCount(ETH, '1h') > before);
    // Failure: backoff grows, last data is kept and shown as stale.
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    now = new Date(NOW.getTime() + 10 * HOUR);
    const bad = await runMarketSync({ market, env: {}, fetcher: failing, now: at(now) });
    assert.ok(bad.failed.includes(`${ETH}:1h`));
    const state = market.getState(ETH, '1h')!;
    assert.equal(state.failCount, 1);
    assert.ok(Date.parse(state.nextRunAt!) > now.getTime());
    const status = assetStatus(asset(ETH), market, {}, now);
    assert.equal(status.status, 'stale');
    assert.match(status.detail, /refresh failed/);
    assert.ok(backoffMs(3) === 4 * backoffMs(1) && backoffMs(30) === 6 * HOUR);
    // Never fetched and failing -> Unavailable.
    assert.equal(assetStatus(asset('crypto:SOL-USD:COINBASE'), market, {}, now).status, 'not_fetched');
  } finally { source.close(); }
});

test('Tiingo: a re-adjusted history triggers a full refetch and prices carry adjustment metadata', async () => {
  const { source, market } = memoryStores();
  try {
    market.watch('c1', XOM, NOW.toISOString());
    const env = { TIINGO_API_TOKEN: 'secret-token' };
    let factor = 1;
    const seenHeaders: string[] = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      seenHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
      assert.ok(!String(url).includes('secret-token')); // the token travels in a header, not in the URL
      const rows = ['2026-10-07', '2026-10-08', '2026-10-09'].map((d, i) => ({ date: `${d}T00:00:00.000Z`, close: 100 + i, adjClose: (100 + i) * factor, adjOpen: 100, adjHigh: 110, adjLow: 90 }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as typeof fetch;
    resetSyncState();
    let now = new Date(NOW);
    await runMarketSync({ market, env, fetcher, now: at(now) });
    assert.equal(market.barCount(XOM, '1d'), 3);
    assert.equal(seenHeaders[0], 'Token secret-token');
    assert.equal(market.lastBar(XOM, '1d')!.rawClose, 102);
    factor = 0.5; // a split/dividend has re-based the adjusted history
    now = new Date(NOW.getTime() + 4 * HOUR);
    await runMarketSync({ market, env, fetcher, now: at(now) });
    assert.equal(market.getState(XOM, '1d')!.needsFull, true);
    assert.equal(market.lastBar(XOM, '1d')!.c, 102); // incremental data was not mixed into the old adjusted series
    now = new Date(now.getTime() + 3 * 60_000);
    await runMarketSync({ market, env, fetcher, now: at(now) });
    assert.equal(market.getState(XOM, '1d')!.needsFull, false);
    assert.equal(market.lastBar(XOM, '1d')!.c, 51);
    assert.equal(market.getBars(XOM, '1d')[0].c, 50);
  } finally { source.close(); }
});

// ------------------------------------------------------------------ events, dedup, snapshots, links, watchlist, alerts

const bbc = () => buildSources(900_000).find((s) => s.id === 'bbc-world')!;
const un = () => buildSources(900_000).find((s) => s.id === 'un-news')!;
const article = (id: string, headline: string, at: string, summary = 'Fighting continued near the Hormuz oil terminal in Iran, with oil tanker traffic halted.'): NormalizedArticle => ({
  sourceRecordId: id, canonicalUrl: `https://news.example.test/${id}`, headline, summary, publishedAt: at, sourceModifiedAt: null,
});
function save(store: SourceStore, src: ReturnType<typeof bbc>, articles: NormalizedArticle[], at = NOW) {
  store.saveSuccessfulSync({ source: src, articles, checkedAt: at.toISOString(), nextRunAt: iso(at.getTime() + 900_000), etag: null, lastModified: null });
}

function eventFixture(now = NOW) {
  const stores = memoryStores();
  save(stores.source, bbc(), [
    article('a1', 'Drone attack hits Hormuz oil terminal in Iran', iso(now.getTime() - 3 * HOUR)),
    article('a3', 'Gardening club meets on Tuesday', iso(now.getTime() - 5 * HOUR), 'Tea and cake.'),
  ], now);
  save(stores.source, un(), [article('a2', 'Drone attack hits Hormuz oil terminal in Iran, officials say', iso(now.getTime() - 2 * HOUR))], now);
  const deps: MarketDeps = { store: stores.source, analysis: stores.analysis, market: stores.market, env: {}, now };
  return { ...stores, deps };
}

test('coverage of one event is de-duplicated and anchored to the earliest public report', () => {
  const { source, deps } = eventFixture();
  try {
    clearEventCache();
    const { events } = listEvents(deps, 'c1', { all: true });
    const attack = events.filter((e) => e.title.includes('Hormuz'));
    assert.equal(attack.length, 1);
    assert.equal(attack[0].members.length, 2);
    assert.equal(attack[0].anchorId, 'a1'.length ? attack[0].members[0].articleId : '');
    assert.equal(attack[0].anchorAt, iso(NOW.getTime() - 3 * HOUR)); // earliest publication, not retrieval
    assert.equal(attack[0].retrievedAt, NOW.toISOString()); // retrieval time kept separately
    assert.ok(attack[0].suggestions.some((s) => s.assetId === XOM));
    // Unrelated reports without market links are hidden by default.
    assert.equal(listEvents(deps, 'c1').events.some((e) => e.title.includes('Gardening')), false);
    assert.equal(listEvents(deps, 'c1', { all: true }).events.some((e) => e.title.includes('Gardening')), true);
  } finally { source.close(); }
});

test('snapshots freeze the classification once and are not rewritten later', () => {
  const { source, market, deps } = eventFixture();
  try {
    clearEventCache();
    assert.equal(captureReportSnapshots(deps), 1);
    const first = market.snapshots('c1')[0];
    assert.ok(first.links.some((l) => l.assetId === XOM));
    assert.equal(first.snapshotAt, NOW.toISOString());
    clearEventCache();
    assert.equal(captureReportSnapshots({ ...deps, now: new Date(NOW.getTime() + DAY) }), 0);
    assert.equal(market.snapshots('c1')[0].snapshotAt, NOW.toISOString());
  } finally { source.close(); }
});

test('suggested, confirmed and rejected links are kept apart and persist; watchlists persist per browser', () => {
  const { source, market, deps } = eventFixture();
  try {
    clearEventCache();
    const event = listEvents(deps, 'c1').events.find((e) => e.title.includes('Hormuz'))!;
    assert.equal(mergedLinks(deps, 'c1', event).find((m) => m.entry.id === XOM)!.link.status, 'suggested');
    const suggestion = event.suggestions.find((s) => s.assetId === XOM)!;
    market.setLink('c1', { eventKey: event.key, assetId: XOM, status: 'confirmed', origin: 'suggested', ruleId: suggestion.ruleId, explanation: suggestion.explanation, updatedAt: NOW.toISOString(), updatedBy: 'Ana' });
    market.setLink('c1', { eventKey: event.key, assetId: 'stock:LMT:XNYS', status: 'rejected', origin: 'suggested', ruleId: 'x', explanation: null, updatedAt: NOW.toISOString(), updatedBy: 'Ana' });
    market.setLink('c1', { eventKey: event.key, assetId: ETH, status: 'confirmed', origin: 'user', ruleId: null, explanation: null, updatedAt: NOW.toISOString(), updatedBy: 'Ana' });
    const links = mergedLinks(deps, 'c1', event);
    assert.equal(links.find((m) => m.entry.id === XOM)!.link.status, 'confirmed');
    assert.ok(links.find((m) => m.entry.id === XOM)!.link.explanation);
    assert.equal(links.find((m) => m.entry.id === 'stock:LMT:XNYS')!.link.status, 'rejected');
    assert.equal(links.find((m) => m.entry.id === ETH)!.link.origin, 'user');
    assert.equal(mergedLinks(deps, 'other-client', event).find((m) => m.entry.id === XOM)!.link.status, 'suggested');
    // The view labels the user-added link as not rule-based.
    const view = eventView(deps, 'c1', findEvent(deps, 'c1', event.key)!);
    const eth = view.assets.find((a) => a.asset.id === ETH)!;
    assert.match(eth.why.supporting[0], /added this link yourself/);
    assert.match(eth.why.caution, /not evidence|not proof|observation/i);
    assert.ok(view.assets.find((a) => a.asset.id === XOM)!.reactions.every((r) => r.status !== 'ok')); // no prices yet: nothing is invented
    assert.ok(view.sessionNotes.length >= 1);
    // Watchlists survive a new store instance on the same database.
    market.watch('c1', ETH, NOW.toISOString());
    market.watch('c1', ETH, NOW.toISOString());
    const reopened = new MarketStore(source.handle);
    assert.deepEqual(reopened.watched('c1'), [ETH]);
    assert.deepEqual(reopened.watched('c2'), []);
    reopened.unwatch('c1', ETH);
    assert.deepEqual(market.watched('c1'), []);
  } finally { source.close(); }
});

test('alerts: link alerts dedupe per event and respect the cooldown; move alerts need fresh data', () => {
  const { source, market, analysis, deps } = eventFixture();
  try {
    market.watch('c1', XOM, NOW.toISOString());
    market.saveAlertSettings('c1', { linkAlerts: true, moveAlerts: false, movePct: 5, moveWindow: '24h', cooldownHours: 24 }, NOW.toISOString());
    clearEventCache();
    assert.equal(evaluateMarketAlerts(deps).created, 1);
    assert.equal(evaluateMarketAlerts(deps).created, 0); // same event and asset: deduplicated
    assert.match(analysis.listAlerts('c1').items[0].detail, /not a market signal/);
    // A second event for the same asset inside the cooldown is suppressed ...
    const later = new Date(NOW.getTime() + 2 * HOUR);
    save(source, bbc(), [article('b1', 'Missile strike on Kharg oil export terminal, Iran', iso(later.getTime() - HOUR), 'Pipeline and crude loading halted in Iran.')], later);
    clearEventCache();
    assert.equal(evaluateMarketAlerts({ ...deps, now: later }).created, 0);
    // ... and allowed after it ends.
    const after = new Date(NOW.getTime() + 26 * HOUR);
    save(source, bbc(), [article('b2', 'Second strike on Abadan oil refinery, Iran', iso(after.getTime() - HOUR), 'Crude refinery in Iran ablaze after attack.')], after);
    clearEventCache();
    assert.equal(evaluateMarketAlerts({ ...deps, now: after }).created, 1);
    // Move alerts
    market.saveAlertSettings('c1', { linkAlerts: false, moveAlerts: true, movePct: 5, moveWindow: '24h', cooldownHours: 12 }, NOW.toISOString());
    const d1 = '2026-10-08', d2 = '2026-10-09';
    market.upsertBars(XOM, '1d', [bar(d1, barCloseForDate('XNYS', d1), 100), bar(d2, barCloseForDate('XNYS', d2), 107)], NOW.toISOString());
    assert.equal(evaluateMarketAlerts(deps).created, 1);
    assert.equal(evaluateMarketAlerts(deps).created, 0);
    const alert = analysis.listAlerts('c1').items.find((a) => a.kind === 'market-move')!;
    assert.match(alert.title, /\+7\.0%/);
    assert.match(alert.detail, /not an explanation or a forecast/);
    // Stale data never alerts.
    market.saveAlertSettings('c1', { linkAlerts: false, moveAlerts: true, movePct: 1, moveWindow: '24h', cooldownHours: 1 }, NOW.toISOString());
    assert.equal(evaluateMarketAlerts({ ...deps, now: new Date(NOW.getTime() + 20 * DAY) }).created, 0);
  } finally { source.close(); }
});

// ------------------------------------------------------------------ associations and correlations

function seedHistory(market: MarketStore, count: number, snapshotLag = 10 * 60_000, spacingDays = 2) {
  const start = Date.parse('2026-08-01T00:00:00Z');
  market.upsertBars(ETH, '1h', hourly(start, NOW.getTime(), (at) => 100 * 1.001 ** ((at - start) / HOUR)), NOW.toISOString());
  market.upsertBars(BTC, '1h', hourly(start, NOW.getTime(), () => 1000), NOW.toISOString());
  for (let i = 0; i < count; i += 1) {
    const anchor = start + (3 + i * spacingDays) * DAY + 17 * 60_000;
    market.insertSnapshot({
      eventKey: `report:e${i}`, clientId: '', type: 'report', anchorId: `e${i}`, title: `Event ${i}`, anchorAt: iso(anchor), snapshotAt: iso(anchor + snapshotLag),
      categories: ['armed-attack'], countries: ['IR'], severity: 'High', links: [{ assetId: ETH, ruleId: 'entity-mention', relevance: 'Direct' }],
    });
  }
}

test('associations: distinct non-overlapping events, labelled by sample size and corrected significance', () => {
  const { source, analysis, market } = memoryStores();
  try {
    seedHistory(market, 25);
    const deps: MarketDeps = { store: source, analysis, market, env: {}, now: NOW };
    const exact = associations(deps, 'c1', { assetId: ETH, category: 'conflict', window: '24h' });
    assert.equal(exact.exploratory, false);
    const r = exact.results[0];
    assert.equal(r.measure, 'benchmark-adjusted');
    assert.equal(r.distinctEvents, 25);
    assert.equal(r.usedEvents, 25);
    assert.equal(r.overlappingExcluded, 0);
    assert.ok(r.median! > 2 && r.median! < 3);
    assert.equal(r.positiveShare, 1);
    assert.equal(r.negativeShare, 0);
    assert.ok(r.adjustedP! < 0.001);
    assert.equal(r.label, 'Historically observed association');
    assert.ok(r.usedEvents >= MIN_OBSERVED);
    // The 7-day windows overlap one another: only the first event of each chain is used and the rest are flagged.
    const week = associations(deps, 'c1', { assetId: ETH, category: 'conflict', window: '7d' }).results[0];
    assert.ok(week.overlappingExcluded > 0);
    assert.ok(week.usedEvents < 25);
    assert.ok(week.notes.some((n) => /overlap/.test(n)));
    // Scanning many windows/assets is exploratory and corrected for the number of tests.
    const scan = associations(deps, 'c1', {});
    assert.equal(scan.exploratory, true);
    assert.ok(scan.comparisons >= 1);
    const h1 = scan.results.find((x) => x.window === '1h')!;
    assert.ok(h1.adjustedP! >= h1.signTestP!);
  } finally { source.close(); }
});

test('associations: small samples show Insufficient history and the classification must predate the outcome', () => {
  const { source, analysis, market } = memoryStores();
  try {
    seedHistory(market, 4);
    const deps: MarketDeps = { store: source, analysis, market, env: {}, now: NOW };
    const small = associations(deps, 'c1', { assetId: ETH, category: 'conflict', window: '24h' }).results[0];
    assert.equal(small.label, 'Insufficient history');
    assert.equal(small.median, null);
    assert.equal(small.signTestP, null);
    assert.equal(small.usedEvents, 4);
    // Classifications recorded after the window had closed are not allowed to explain the outcome.
    const late = memoryStores();
    seedHistory(late.market, 25, 3 * DAY);
    const lateRes = associations({ store: late.source, analysis: late.analysis, market: late.market, env: {}, now: NOW }, 'c1', { assetId: ETH, category: 'conflict', window: '24h' }).results[0];
    assert.equal(lateRes.usedEvents, 0);
    assert.equal(lateRes.label, 'Insufficient history');
    assert.equal(lateRes.pendingOrMissing, 25);
    late.source.close();
    // Grouping by geography uses the frozen country list.
    const byCountry = associations(deps, 'c1', { assetId: ETH, window: '24h', dims: ['category', 'country'] }).results;
    assert.equal(byCountry[0].country, 'IR');
  } finally { source.close(); }
});

test('correlations need aligned daily series, enough observations and event days; otherwise Insufficient history', () => {
  const { source, analysis, market } = memoryStores();
  try {
    const start = Date.parse('2026-07-20T00:00:00Z');
    const days = 80;
    const eventDays = new Set<number>();
    for (let d = 3; d < days - 2; d += 5) eventDays.add(d);
    let price = 100;
    const eth: Bar[] = [], btc: Bar[] = [];
    for (let d = 0; d < days; d += 1) {
      const date = iso(start + d * DAY).slice(0, 10);
      const closeAt = barCloseForDate('24x7', date);
      price *= eventDays.has(d) ? 1.03 : d % 2 === 0 ? 1.001 : 0.999;
      eth.push(bar(date, closeAt, price));
      btc.push(bar(date, closeAt, 1000));
    }
    market.upsertBars(ETH, '1d', eth, NOW.toISOString());
    market.upsertBars(BTC, '1d', btc, NOW.toISOString());
    const deps: MarketDeps = { store: source, analysis, market, env: {}, now: NOW };
    const snap = (d: number) => market.insertSnapshot({
      eventKey: `report:c${d}`, clientId: '', type: 'report', anchorId: `c${d}`, title: `E${d}`, anchorAt: iso(start + d * DAY + 12 * HOUR), snapshotAt: iso(start + d * DAY + 13 * HOUR),
      categories: ['armed-attack'], countries: [], severity: 'High', links: [{ assetId: ETH, ruleId: 'entity-mention', relevance: 'Direct' }],
    });
    [...eventDays].slice(0, 3).forEach(snap);
    const few = correlations(deps, 'c1', { assetId: ETH, category: 'conflict' })[0];
    assert.equal(few.status, 'Insufficient history');
    assert.match(few.needed, /at least/i);
    [...eventDays].slice(3).forEach(snap);
    const ok = correlations(deps, 'c1', { assetId: ETH, category: 'conflict' })[0];
    assert.equal(ok.status, 'ok');
    assert.equal(ok.observations, days - 1);
    assert.equal(ok.nonZeroDays, eventDays.size);
    assert.ok(ok.pearson! > 0.9);
    assert.ok(ok.spearman! > 0.5);
    assert.ok(ok.ci95![0] < ok.pearson! && ok.ci95![1] > ok.pearson!);
    assert.match(ok.method, /Pearson/);
    assert.match(ok.seriesY, /benchmark-adjusted/);
    assert.ok(ok.pValue! < 0.001);
    // Stocks (daily, no stored prices) have no series at all.
    assert.equal(correlations(deps, 'c1', { assetId: 'stock:SHEL:XLON' }).length, 0);
  } finally { source.close(); }
});
