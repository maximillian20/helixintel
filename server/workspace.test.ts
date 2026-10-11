import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import { AnalysisStore, computeTrends } from './analysis-store';
import { countryAssessmentChangeAlert, evaluateCountryAlerts, evaluateIndicatorAlerts } from './alerts';
import { INDICATORS, autoThresholds, computeIndicator, loadIndicatorData, type IndicatorContext } from './indicators';
import { SourceStore, type NormalizedArticle, type SourceDefinition } from './source-store';
import { buildSources } from './connectors';

process.env.NODE_ENV = 'test';
process.env.SOURCE_DB_PATH = ':memory:';

const DAY = 86_400_000;
const NOW = new Date('2026-10-11T12:00:00.000Z');
const sources = buildSources(15 * 60_000);
const def = (id: string) => INDICATORS.find((entry) => entry.id === id)!;
const sourceDef = (id: string) => sources.find((source) => source.id === id)!;

/** Day offset 0 = 2026-10-10 (the latest complete day). */
const dayAt = (offset: number, hour = 10) => new Date(Date.UTC(2026, 9, 10, hour) - offset * DAY).toISOString();

function seedChecks(store: SourceStore, sourceId: string, fromOffset: number, toOffset: number, skip: number[] = []) {
  for (let offset = toOffset; offset <= fromOffset; offset += 1) {
    if (skip.includes(offset)) continue;
    store.handle.prepare('INSERT INTO source_checks (source_id, day, successes, failures) VALUES (?, ?, 1, 0) ON CONFLICT(source_id, day) DO NOTHING')
      .run(sourceId, dayAt(offset).slice(0, 10));
  }
}

function saveRecords(store: SourceStore, source: SourceDefinition, articles: NormalizedArticle[], checkedAt = NOW.toISOString()) {
  store.saveSuccessfulSync({ source, articles, checkedAt, nextRunAt: new Date(NOW.getTime() + 900_000).toISOString(), etag: null, lastModified: null });
}

function gdacsEvent(id: string, publishedAt: string, code = 'SD'): NormalizedArticle {
  return {
    sourceRecordId: id, canonicalUrl: `https://www.gdacs.org/report.aspx?eventid=${id}`, headline: `Flood alert ${id}`, summary: 'Flood.',
    publishedAt, sourceModifiedAt: null, enrichment: { category: 'flood', countryCodes: [code] },
  };
}

function ctxFor(store: SourceStore, now = NOW): IndicatorContext {
  return { store, sources, env: {}, now };
}
const autoSettings = { mode: 'auto' as const, warn: null, alert: null, minCount: 2, cooldownHours: 24, watched: false };

/** Eight baseline weeks (offsets 7..62) with the given counts, newest first, plus the current week (offsets 0..6). */
function seedGdacs(store: SourceStore, baseline: number[], current: number, opts: { skipDays?: number[]; checks?: boolean } = {}) {
  const articles: NormalizedArticle[] = [];
  let n = 0;
  baseline.forEach((count, index) => {
    for (let i = 0; i < count; i += 1) articles.push(gdacsEvent(`b${index}-${i}-${n++}`, dayAt(7 + index * 7 + (i % 7))));
  });
  for (let i = 0; i < current; i += 1) articles.push(gdacsEvent(`c${i}`, dayAt(i % 7)));
  saveRecords(store, sourceDef('gdacs'), articles);
  if (opts.checks !== false) seedChecks(store, 'gdacs', 62, 0, opts.skipDays);
}

test('indicator: counts, baseline, thresholds, level and trend from covered weeks', () => {
  const store = new SourceStore(':memory:');
  try {
    seedGdacs(store, [1, 2, 1, 2, 1, 2, 1, 2], 9);
    const reading = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctxFor(store), loadIndicatorData(ctxFor(store)));
    assert.equal(reading.current, 9);
    assert.equal(reading.baselineWeeks, 8);
    assert.equal(reading.baselineMean, 1.5);
    assert.equal(reading.level, 'Alert');
    assert.equal(reading.trend, 'Rising');
    assert.ok(reading.warnThreshold! < reading.alertThreshold!);
    assert.equal(reading.confidence, 'High');
    assert.equal(reading.weeks.length, 9);
    assert.equal(reading.weeks[8].evidence.length, 9, 'every contributing record is listed');
    assert.equal(reading.isReportingActivity, false);
  } finally { store.close(); }
});

test('indicator: a week the source was not read is missing, not zero', () => {
  const store = new SourceStore(':memory:');
  try {
    // Skip checks on every day of baseline week 3 (offsets 28..34).
    seedGdacs(store, [1, 2, 1, 2, 1, 2, 1, 2], 3, { skipDays: [28, 29, 30, 31, 32, 33, 34] });
    const reading = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctxFor(store), loadIndicatorData(ctxFor(store)));
    assert.equal(reading.weeks[4].value, null);
    assert.equal(reading.baselineWeeks, 7);
    assert.ok(reading.notes.some((note) => note.includes('too little coverage')));
    assert.notEqual(reading.confidence, 'High', 'a coverage gap rules out High confidence');
  } finally { store.close(); }
});

test('indicator: a source that was never read shows Source unavailable, and a missing current week is Insufficient data', () => {
  const store = new SourceStore(':memory:');
  try {
    const empty = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctxFor(store), loadIndicatorData(ctxFor(store)));
    assert.equal(empty.level, 'Source unavailable');
    assert.equal(empty.current, null);
    assert.equal(empty.confidence, 'Unassessed');
    assert.equal(empty.trend, 'Insufficient history');

    seedGdacs(store, [1, 1, 1, 1, 1, 1, 1, 1], 0, { skipDays: [0, 1, 2, 3, 4, 5, 6] });
    const gap = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctxFor(store), loadIndicatorData(ctxFor(store)));
    assert.equal(gap.current, null);
    assert.equal(gap.level, 'Insufficient data');
  } finally { store.close(); }
});

test('indicator: too little history is Insufficient history, not a reading', () => {
  const store = new SourceStore(':memory:');
  try {
    seedGdacs(store, [1, 1, 1], 4);
    seedChecks(store, 'gdacs', 62, 28, [28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
    const store2 = new SourceStore(':memory:');
    try {
      saveRecords(store2, sourceDef('gdacs'), [gdacsEvent('x1', dayAt(1))]);
      seedChecks(store2, 'gdacs', 20, 0);
      const reading = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctxFor(store2), loadIndicatorData(ctxFor(store2)));
      assert.equal(reading.baselineWeeks, 2);
      assert.equal(reading.level, 'Insufficient data');
      assert.equal(reading.trend, 'Insufficient history');
      assert.equal(reading.confidence, 'Unassessed');
      assert.equal(reading.warnThreshold, null);
    } finally { store2.close(); }
  } finally { store.close(); }
});

test('indicator: zero baseline uses the minimum count and gives no percentage change', () => {
  const store = new SourceStore(':memory:');
  try {
    seedGdacs(store, [0, 0, 0, 0, 0, 0, 0, 0], 3);
    const reading = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctxFor(store), loadIndicatorData(ctxFor(store)));
    assert.equal(reading.baselineMean, 0);
    assert.equal(reading.changePct, null);
    assert.equal(reading.warnThreshold, 2);
    assert.equal(reading.alertThreshold, 3);
    assert.equal(reading.level, 'Alert');
    assert.equal(reading.trend, 'Rising');
    assert.deepEqual(autoThresholds([0, 0, 0, 0], 5), { warn: 5, alert: 6 });
  } finally { store.close(); }
});

test('indicator: below the minimum count no threshold level applies, and a country filter only counts that country', () => {
  const store = new SourceStore(':memory:');
  try {
    seedGdacs(store, [0, 0, 0, 0, 0, 0, 0, 0], 1);
    const ctx = ctxFor(store);
    const reading = computeIndicator(def('disaster-alerts'), 'ALL', autoSettings, ctx, loadIndicatorData(ctx));
    assert.equal(reading.level, 'Normal');
    const other = computeIndicator(def('disaster-alerts'), 'FR', autoSettings, ctx, loadIndicatorData(ctx));
    assert.equal(other.current, 0, 'zero with coverage is a real zero');
    assert.equal(other.geoName, 'France');
  } finally { store.close(); }
});

test('indicator: reporting activity de-duplicates repeated headlines and is labelled as reporting', () => {
  const store = new SourceStore(':memory:');
  try {
    const bbc = sourceDef('bbc-world');
    const un = sourceDef('un-news');
    const mk = (id: string, headline: string, at: string): NormalizedArticle => ({ sourceRecordId: id, canonicalUrl: `https://news.example.test/${id}`, headline, summary: 'Troops fired rockets and killed civilians.', publishedAt: at, sourceModifiedAt: null });
    saveRecords(store, bbc, [mk('1', 'Rocket attack kills 5 in Sudan', dayAt(1)), mk('2', 'Another attack in Sudan kills two', dayAt(2))]);
    saveRecords(store, un, [mk('3', 'Rocket attack kills 5 in Sudan!', dayAt(1))]);
    for (const id of ['bbc-world', 'un-news', 'gdelt']) seedChecks(store, id, 62, 0);
    const ctx = ctxFor(store);
    const reading = computeIndicator(def('reporting-activity'), 'ALL', autoSettings, ctx, loadIndicatorData(ctx));
    assert.equal(reading.current, 2);
    assert.equal(reading.isReportingActivity, true);
    assert.ok(reading.notes.some((note) => note.includes('reporting activity')));
    assert.notEqual(reading.confidence, 'High');
  } finally { store.close(); }
});

test('indicator: sources that need credentials show Setup required', () => {
  const store = new SourceStore(':memory:');
  try {
    const eiaLike = { ...def('disaster-alerts'), sources: ['reliefweb'], coverage: { kind: 'checks' as const, sources: ['reliefweb'], minSources: 1 } };
    const reading = computeIndicator(eiaLike, 'ALL', autoSettings, ctxFor(store), loadIndicatorData(ctxFor(store)));
    assert.equal(reading.level, 'Setup required');
    assert.equal(reading.dataStatus, 'setup_required');
  } finally { store.close(); }
});

test('indicator: KEV history is available from one successful read of the cumulative catalog', () => {
  const store = new SourceStore(':memory:');
  try {
    const articles: NormalizedArticle[] = [];
    for (let week = 0; week < 9; week += 1) {
      for (let i = 0; i < 2; i += 1) {
        articles.push({ sourceRecordId: `CVE-${week}-${i}`, canonicalUrl: `https://nvd.nist.gov/vuln/detail/CVE-${week}-${i}`, headline: `Vendor: bug CVE-${week}-${i}`, summary: 'x', publishedAt: dayAt(week * 7 + i).slice(0, 10) + 'T00:00:00.000Z', sourceModifiedAt: null, enrichment: { category: 'known exploited vulnerability', global: true } });
      }
    }
    saveRecords(store, sourceDef('cisa-kev'), articles);
    seedChecks(store, 'cisa-kev', 0, 0);
    const ctx = ctxFor(store);
    const reading = computeIndicator(def('kev-additions'), 'ALL', autoSettings, ctx, loadIndicatorData(ctx));
    assert.equal(reading.current, 2);
    assert.equal(reading.baselineWeeks, 8);
    assert.equal(reading.level, 'Normal');
    assert.equal(reading.trend, 'Stable');
  } finally { store.close(); }
});

test('alerts: threshold crossings create persistent alerts, respect the cooldown and do not repeat', () => {
  const store = new SourceStore(':memory:');
  try {
    const analysis = new AnalysisStore(store.handle);
    seedGdacs(store, [1, 1, 1, 1, 1, 1, 1, 1], 3);
    const client = 'client-alerts-1';
    const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 11, hour, minute));
    const run = (now: Date) => { const ctx = ctxFor(store, now); return evaluateIndicatorAlerts(analysis, ctx, loadIndicatorData(ctx), client); };
    const iso = (now: Date) => now.toISOString();

    analysis.saveIndicatorSettings(client, 'disaster-alerts', 'ALL', { mode: 'fixed', warn: 2, alert: 10, minCount: 2, cooldownHours: 1, watched: true }, iso(at(12)));
    assert.equal(run(at(12)), 1, 'Warning fires');
    assert.equal(run(at(12, 5)), 0, 'no repeat while the level is unchanged');
    assert.equal(analysis.listAlerts(client).items.length, 1);

    analysis.saveIndicatorSettings(client, 'disaster-alerts', 'ALL', { warn: 5, alert: 10 }, iso(at(12, 10)));
    assert.equal(run(at(12, 10)), 0);
    assert.equal(analysis.getIndicatorState(client, 'disaster-alerts', 'ALL')?.lastLevel, 'Normal', 'falling back re-arms');

    analysis.saveIndicatorSettings(client, 'disaster-alerts', 'ALL', { warn: 1, alert: 3 }, iso(at(12, 30)));
    assert.equal(run(at(12, 30)), 0, 'Alert crossing inside the cooldown is held back');
    assert.equal(analysis.listAlerts(client).items.length, 1);
    assert.equal(run(at(13, 30)), 1, 'fires after the cooldown if still elevated');
    const list = analysis.listAlerts(client);
    assert.equal(list.items.length, 2);
    assert.equal(list.unread, 2);
    assert.equal(list.items[0].severity, 'critical');
    assert.equal(analysis.listAlerts('someone-else-1').items.length, 0, 'alerts are private to the workspace');
    analysis.markAlertsRead(client, 'all');
    assert.equal(analysis.listAlerts(client).unread, 0);
  } finally { store.close(); }
});

test('country trends use only real earlier versions', () => {
  const store = new SourceStore(':memory:');
  try {
    const analysis = new AnalysisStore(store.handle);
    const client = 'client-trend-1';
    store.saveSuccessfulSync({ source: sourceDef('bbc-world'), articles: [{ sourceRecordId: 'r1', canonicalUrl: 'https://news.example.test/sd1', headline: 'Rocket attack kills 5 in Sudan', summary: 'x', publishedAt: dayAt(1), sourceModifiedAt: null }], checkedAt: NOW.toISOString(), nextRunAt: NOW.toISOString(), etag: null, lastModified: null });
    const id = store.getRecords()[0].id;
    analysis.addCountryEvidence(client, 'Ana', 'SD', { refType: 'report', refId: id, category: 'security', note: '', label: 'Rocket attack', url: null, source: 'BBC', eventTime: dayAt(1) }, '2026-08-01T10:00:00.000Z');
    assert.throws(() => analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: '', confidence: 'Medium', categories: { security: { rating: 'High', rationale: '', evidenceIds: [1] } } }, '2026-08-01T10:00:00.000Z'), /rationale/);
    assert.throws(() => analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: '', confidence: 'Medium', categories: { security: { rating: 'High', rationale: 'x', evidenceIds: [999] } } }, '2026-08-01T10:00:00.000Z'), /evidence/);
    assert.throws(() => analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: '', confidence: 'Medium', categories: {} }, '2026-08-01T10:00:00.000Z'), /Rate at least one/);
    analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: 'v1', confidence: 'Medium', categories: { security: { rating: 'Elevated', rationale: 'Attacks reported.', confidence: 'Medium', evidenceIds: [1] } } }, '2026-08-01T10:00:00.000Z');
    let versions = analysis.listAssessmentVersions(client, 'SD');
    assert.equal(computeTrends(versions, NOW.getTime()).security.trend, 'Insufficient history');
    analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: 'v2', confidence: 'Medium', categories: { security: { rating: 'Severe', rationale: 'Escalation.', confidence: 'Medium', evidenceIds: [1] } } }, NOW.toISOString());
    versions = analysis.listAssessmentVersions(client, 'SD');
    const trends = computeTrends(versions, NOW.getTime());
    assert.equal(trends.security.trend, 'Deteriorating');
    assert.equal(trends.security.changes.find((c) => c.windowDays === 30)?.steps, 2);
    assert.equal(trends.security.changes.find((c) => c.windowDays === 90)?.steps, null, 'no version is 90 days old, so no 90-day change is shown');
    assert.equal(trends.security.changes.find((c) => c.windowDays === 7)?.from, 'Elevated');
    assert.equal(trends.travel.trend, 'Insufficient history', 'unrated categories have no trend');
    assert.equal(versions[0].categories.travel.rating, 'Unassessed', 'missing categories stay Unassessed');
    assert.equal(analysis.listAssessmentVersions('other-client-1', 'SD').length, 0);
  } finally { store.close(); }
});

test('alerts: watched countries get alerts for new serious reports and for material assessment changes, without repeats', () => {
  const store = new SourceStore(':memory:');
  try {
    const analysis = new AnalysisStore(store.handle);
    const client = 'client-country-alert';
    saveRecords(store, sourceDef('bbc-world'), [
      { sourceRecordId: 'n1', canonicalUrl: 'https://news.example.test/n1', headline: 'Drone strike kills 12 in Sudan', summary: 'Khartoum market hit.', publishedAt: dayAt(-0.3), sourceModifiedAt: null },
      { sourceRecordId: 'n2', canonicalUrl: 'https://news.example.test/n2', headline: 'Council approves cycle lanes', summary: 'Three roads.', publishedAt: dayAt(-0.3), sourceModifiedAt: null },
    ]);
    const ctx = ctxFor(store);
    assert.equal(evaluateCountryAlerts(analysis, ctx, client), 0, 'nothing is watched yet');
    analysis.setCountryWatch(client, 'SD', true, '2026-10-10T00:00:00.000Z');
    assert.equal(evaluateCountryAlerts(analysis, ctx, client), 1);
    assert.equal(evaluateCountryAlerts(analysis, ctx, client), 0, 'the same report never alerts twice');
    assert.equal(analysis.listAlerts('other-client-xyz').items.length, 0);

    const id = store.getRecords().find((record) => record.sourceRecordId === 'n1')!.id;
    analysis.addCountryEvidence(client, 'Ana', 'SD', { refType: 'report', refId: id, category: 'security', note: '', label: 'Drone strike', url: null, source: 'BBC', eventTime: dayAt(0) }, '2026-10-01T00:00:00.000Z');
    const categories = (rating: 'Elevated' | 'High') => ({ security: { rating, rationale: 'Attacks.', confidence: 'Medium' as const, evidenceIds: [1] } });
    analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: '', confidence: 'Medium', categories: categories('Elevated') }, '2026-10-02T00:00:00.000Z');
    assert.equal(countryAssessmentChangeAlert(analysis, client, 'SD', NOW.toISOString()), false, 'a first version is not a change');
    analysis.saveCountryAssessment(client, 'Ana', 'SD', { summary: '', confidence: 'Medium', categories: categories('High') }, '2026-10-05T00:00:00.000Z');
    assert.equal(countryAssessmentChangeAlert(analysis, client, 'SD', NOW.toISOString()), true);
    assert.equal(countryAssessmentChangeAlert(analysis, client, 'SD', NOW.toISOString()), false);
    const kinds = analysis.listAlerts(client).items.map((alert) => alert.kind).sort();
    assert.deepEqual(kinds, ['country-assessment', 'country-report']);
  } finally { store.close(); }
});

// ------------------------------------------------------------------ HTTP: feed to incident, permissions, persistence

let server: Server;
let base = '';
const alice = 'client-alice-0001';
const bob = 'client-bob-000001';
const headersFor = (client: string, name?: string) => ({ 'x-client-id': client, 'content-type': 'application/json', ...(name ? { 'x-analyst-name': name } : {}) });
const reportOne = 'bbc-world:https://news.example.test/ws-1';
const reportTwo = 'bbc-world:https://news.example.test/ws-2';

async function call(method: string, path: string, client: string, body?: unknown, name?: string) {
  const response = await fetch(`${base}${path}`, { method, headers: headersFor(client, name), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  const module = await import('./index');
  const now = new Date();
  module.sourceStore.saveSuccessfulSync({
    source: sourceDef('bbc-world'),
    articles: [
      { sourceRecordId: 'w1', canonicalUrl: 'https://news.example.test/ws-1', headline: 'Drone strike kills 12 in Sudan', summary: 'Khartoum market hit.', publishedAt: new Date(now.getTime() - 3_600_000).toISOString(), sourceModifiedAt: null },
      { sourceRecordId: 'w2', canonicalUrl: 'https://news.example.test/ws-2', headline: 'Second drone strike reported in Sudan', summary: 'Khartoum again.', publishedAt: new Date(now.getTime() - 1_800_000).toISOString(), sourceModifiedAt: null },
    ],
    checkedAt: now.toISOString(), nextRunAt: now.toISOString(), etag: null, lastModified: null,
  });
  server = createServer(module.app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  (await import('./index')).sourceStore.close();
});

test('http: every workspace route needs a client id', async () => {
  for (const path of ['/api/workspace/incidents', '/api/workspace/countries', '/api/workspace/indicators', '/api/workspace/alerts']) {
    assert.equal((await fetch(`${base}${path}`)).status, 400, path);
  }
});

test('http: create an incident from a feed item, link more reports without duplicates, audit trail records actors', async () => {
  const prefill = await call('POST', '/api/workspace/incidents/prefill', alice, { articleIds: [reportOne] });
  assert.equal(prefill.status, 200);
  assert.equal(prefill.body.input.title, 'Drone strike kills 12 in Sudan');
  assert.deepEqual(prefill.body.input.countryCodes, ['SD']);
  assert.equal(prefill.body.reports[0].url, 'https://news.example.test/ws-1');
  assert.equal(prefill.body.duplicates.length, 0);

  const created = await call('POST', '/api/workspace/incidents', alice, { articleIds: [reportOne] }, 'Ana Analyst');
  assert.equal(created.status, 201);
  const id = created.body.id as string;
  assert.equal(created.body.status, 'New');
  assert.equal(created.body.evidence[0].url, 'https://news.example.test/ws-1');
  assert.equal(created.body.evidence[0].linkedBy, 'Ana Analyst');
  assert.ok(created.body.evidence[0].retrievedAt, 'retrieval time is kept separate from publication time');
  assert.ok(created.body.evidence[0].publishedAt);

  const second = await call('POST', `/api/workspace/incidents/${id}/reports`, alice, { articleIds: [reportOne, reportTwo] }, 'Ana Analyst');
  assert.deepEqual({ linked: second.body.linked, skipped: second.body.skipped }, { linked: 1, skipped: 1 });
  const again = await call('POST', `/api/workspace/incidents/${id}/reports`, alice, { articleIds: [reportTwo] });
  assert.equal(again.body.linked, 0);
  assert.equal((await call('GET', `/api/workspace/incidents/${id}`, alice)).body.evidence.length, 2);

  const dup = await call('POST', '/api/workspace/incidents/prefill', alice, { articleIds: [reportTwo] });
  assert.ok(dup.body.duplicates.some((d: any) => d.id === id && d.reasons.includes('Shares a linked report')));

  assert.equal((await call('POST', '/api/workspace/incidents/prefill', alice, { articleIds: ['nope'] })).status, 404);
});

test('http: edits, severity rationale, status changes, reopening, impacts, assets and actions are saved and audited', async () => {
  const id = (await call('GET', '/api/workspace/incidents', alice)).body.items[0].id as string;
  const bad = await call('PATCH', `/api/workspace/incidents/${id}`, alice, { severity: 'Critical', severityRationale: '' });
  assert.equal(bad.status, 400);
  const ok = await call('PATCH', `/api/workspace/incidents/${id}`, alice, { severity: 'High', severityRationale: 'Two reports of civilian deaths.', confidence: 'Medium', owner: 'Dana', status: 'Investigating', title: 'Khartoum drone strikes' }, 'Ana Analyst');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'Investigating');
  await call('PATCH', `/api/workspace/incidents/${id}`, alice, { status: 'Closed' }, 'Ana Analyst');
  const reopened = await call('PATCH', `/api/workspace/incidents/${id}`, alice, { status: 'Monitoring' }, 'Ana Analyst');
  assert.equal(reopened.body.reopenedCount, 1);
  assert.equal(reopened.body.closedAt, null);

  assert.equal((await call('POST', `/api/workspace/incidents/${id}/assets`, alice, { kind: 'Supplier', name: 'Nile Logistics', notes: '', countryCode: 'SD' })).status, 201);
  assert.equal((await call('POST', `/api/workspace/incidents/${id}/impacts`, alice, { area: 'Operational', text: 'Port access limited.' }, 'Ana Analyst')).status, 201);
  const action = await call('POST', `/api/workspace/incidents/${id}/actions`, alice, { text: 'Confirm staff safety', owner: 'Dana', dueDate: '2026-10-20' }, 'Ana Analyst');
  assert.equal(action.status, 201);
  const detail = (await call('GET', `/api/workspace/incidents/${id}`, alice)).body;
  const actionId = detail.actions[0].id;
  assert.equal((await call('PATCH', `/api/workspace/incidents/${id}/actions/${actionId}`, alice, { status: 'Done' }, 'Ana Analyst')).status, 200);
  const after = (await call('GET', `/api/workspace/incidents/${id}`, alice)).body;
  assert.equal(after.actions[0].status, 'Done');
  assert.ok(after.actions[0].completedAt);
  assert.equal(after.title, 'Khartoum drone strikes');
  assert.equal(after.assets[0].name, 'Nile Logistics');
  const types = after.audit.map((entry: any) => entry.type);
  for (const expected of ['created', 'report-linked', 'status', 'reopened']) assert.ok(types.some((t: string) => t.includes(expected)), `audit has ${expected}: ${types.join(',')}`);
  assert.ok(after.audit.every((entry: any) => entry.actor && entry.at));
  assert.ok(after.audit.some((entry: any) => entry.actor === 'Ana Analyst'));

  const filtered = await call('GET', '/api/workspace/incidents?status=Monitoring&severity=High&country=SD&q=khartoum&owner=Dana', alice);
  assert.equal(filtered.body.total, 1);
  assert.equal((await call('GET', '/api/workspace/incidents?status=Closed', alice)).body.total, 0);
  assert.equal((await call('GET', '/api/workspace/incidents?status=Bogus', alice)).status, 400);

  const suggestions = await call('GET', `/api/workspace/incidents/${id}/suggestions`, alice);
  assert.equal(suggestions.status, 200);
  assert.ok(Array.isArray(suggestions.body.items));
});

test('http: another workspace cannot see or change incidents, evidence or alerts', async () => {
  const id = (await call('GET', '/api/workspace/incidents', alice)).body.items[0].id as string;
  assert.equal((await call('GET', '/api/workspace/incidents', bob)).body.total, 0);
  assert.equal((await call('GET', `/api/workspace/incidents/${id}`, bob)).status, 404);
  assert.equal((await call('PATCH', `/api/workspace/incidents/${id}`, bob, { title: 'hijack' })).status, 404);
  assert.equal((await call('POST', `/api/workspace/incidents/${id}/reports`, bob, { articleIds: [reportOne] })).status, 404);
  assert.equal((await call('POST', `/api/workspace/incidents/${id}/actions`, bob, { text: 'x', owner: null, dueDate: null })).status, 404);
  assert.equal((await call('DELETE', `/api/workspace/incidents/${id}/reports/${encodeURIComponent(reportOne)}`, bob)).status, 404);
  assert.equal((await call('GET', `/api/workspace/incidents/${id}`, alice)).body.title, 'Khartoum drone strikes');
  assert.equal((await call('GET', '/api/workspace/incidents/..%2f..%2fetc', alice)).status, 400);
});

test('http: country assessments need evidence for that country, are versioned, and stay private', async () => {
  const detail0 = await call('GET', '/api/workspace/countries/SD', alice);
  assert.equal(detail0.status, 200);
  assert.equal(detail0.body.latest, null);
  assert.equal(detail0.body.trends.security.trend, 'Insufficient history');
  assert.ok(detail0.body.recentReports.length >= 2);
  assert.equal((await call('GET', '/api/workspace/countries/ZZ', alice)).status, 404);

  const wrongCountry = await call('POST', '/api/workspace/countries/FR/evidence', alice, { refType: 'report', refId: reportOne, category: 'security' });
  assert.equal(wrongCountry.status, 400);
  const ev = await call('POST', '/api/workspace/countries/SD/evidence', alice, { refType: 'report', refId: reportOne, category: 'security', note: 'Civilian deaths' }, 'Ana Analyst');
  assert.equal(ev.status, 201);
  const noEvidence = await call('POST', '/api/workspace/countries/SD/assessments', alice, { summary: '', categories: { travel: { rating: 'High', rationale: 'x', evidenceIds: [] } } });
  assert.equal(noEvidence.status, 400);
  const evidenceId = (await call('GET', '/api/workspace/countries/SD', alice)).body.evidence[0].id;
  const saved = await call('POST', '/api/workspace/countries/SD/assessments', alice, { summary: 'Active conflict.', confidence: 'Medium', categories: { security: { rating: 'High', rationale: 'Drone strikes with civilian deaths.', confidence: 'Medium', evidenceIds: [evidenceId] } } }, 'Ana Analyst');
  assert.equal(saved.status, 201);
  assert.equal(saved.body.version, 1);
  assert.equal(saved.body.assessor, 'Ana Analyst');
  assert.equal(saved.body.categories.travel.rating, 'Unassessed');

  const bobView = await call('GET', '/api/workspace/countries/SD', bob);
  assert.equal(bobView.body.latest, null);
  assert.equal(bobView.body.evidence.length, 0);

  assert.equal((await call('PUT', '/api/workspace/countries/SD/watch', alice, { watched: true })).status, 200);
  const directory = (await call('GET', '/api/workspace/countries?q=sud', alice)).body;
  const row = directory.items.find((entry: any) => entry.code === 'SD');
  assert.equal(row.watched, true);
  assert.equal(row.highestRating, 'High');
  assert.ok(row.reportCount30d >= 2);
  assert.equal(directory.items.find((entry: any) => entry.code === 'FR').highestRating, 'Unassessed', 'no data is never low risk');
});

test('http: indicators report their dependencies and missing history honestly, settings persist', async () => {
  const list = await call('GET', '/api/workspace/indicators', alice);
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 4);
  const gdacs = list.body.items.find((item: any) => item.id === 'disaster-alerts' && item.geo === 'ALL');
  assert.ok(['Source unavailable', 'Insufficient data'].includes(gdacs.level), gdacs.level);
  assert.equal(gdacs.confidence, 'Unassessed');
  const report = list.body.items.find((item: any) => item.id === 'reporting-activity' && item.geo === 'ALL');
  assert.equal(report.isReportingActivity, true);

  const detail = (await call('GET', '/api/workspace/indicators/reporting-activity?geo=SD', alice)).body;
  assert.equal(detail.geo, 'SD');
  assert.equal(detail.weeks.length, 9);
  assert.equal(detail.trend, 'Insufficient history');
  assert.ok(detail.definition.minimumCoverage);

  assert.equal((await call('PUT', '/api/workspace/indicators/reporting-activity/settings?geo=SD', alice, { mode: 'fixed', warn: 10, alert: 5 })).status, 400);
  const saved = await call('PUT', '/api/workspace/indicators/reporting-activity/settings?geo=SD', alice, { mode: 'fixed', warn: 3, alert: 6, minCount: 1, cooldownHours: 12, watched: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.watched, true);
  assert.equal((await call('GET', '/api/workspace/indicators/reporting-activity?geo=SD', alice)).body.settings.warn, 3);
  assert.equal((await call('GET', '/api/workspace/indicators/reporting-activity?geo=SD', bob)).body.settings.watched, false);
  assert.equal((await call('GET', '/api/workspace/indicators/nope', alice)).status, 404);
});

test('http: the old demo endpoints for these modules are gone', async () => {
  assert.equal((await fetch(`${base}/api/incidents`)).status, 404);
  assert.equal((await fetch(`${base}/api/countries`)).status, 404);
});
