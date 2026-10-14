import assert from 'node:assert/strict';
import test from 'node:test';
import { gdacsXml, gdeltJson, kevJson } from './fixtures';

process.env.NODE_ENV = 'test';
process.env.SOURCE_DB_PATH = ':memory:';
for (const name of ['RELIEFWEB_APPNAME', 'EIA_API_KEY']) delete process.env[name];

const { app, buildFeedResponse, sourceStore, syncSources } = await import('./index');

const rss = (host: string, title: string) => `<?xml version="1.0"?><rss version="2.0"><channel><item>
  <title>${title}</title><link>https://${host}/story/1?utm_source=test</link><guid>story-1</guid>
  <description>Summary.</description><pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

test('multi-source sync: failures are isolated, cached data survives, recovery works, no duplicates', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let unDown = true;
  let gdacsDown = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const host = new URL(String(input)).hostname;
    calls.push(host);
    if (host === 'news.un.org' && unDown) throw new Error('The operation was aborted due to timeout');
    if (host === 'www.gdacs.org' && gdacsDown) return new Response('Service Unavailable', { status: 503 });
    if (host === 'feeds.bbci.co.uk' || host === 'news.un.org') return new Response(rss(host, `Report from ${host}`), { status: 200 });
    if (host === 'www.gdacs.org') return new Response(gdacsXml, { status: 200 });
    if (host === 'api.gdeltproject.org') return new Response(gdeltJson, { status: 200 });
    if (host === 'www.cisa.gov') return new Response(kevJson(new Date()), { status: 200 });
    throw new Error(`unexpected request to ${host}`);
  }) as typeof fetch;

  const server = app.listen(0);
  try {
    await syncSources(true);
    const statuses = () => new Map(buildFeedResponse(false).sources.map((source) => [source.id, source.status]));
    let status = statuses();
    assert.equal(status.get('un-news'), 'unavailable', 'the failing source is reported honestly');
    for (const id of ['bbc-world', 'gdacs', 'gdelt', 'cisa-kev']) assert.equal(status.get(id), 'healthy', id);
    for (const id of ['reliefweb', 'eia']) assert.equal(status.get(id), 'setup_required', id);
    assert.ok(!calls.includes('api.reliefweb.int') && !calls.includes('api.eia.gov'), 'credential-gated sources are never called');
    const counts = () => Object.fromEntries(['bbc-world', 'gdacs', 'gdelt', 'cisa-kev'].map((id) => [id, sourceStore.getRecords(id).length]));
    assert.deepEqual(counts(), { 'bbc-world': 1, gdacs: 2, gdelt: 2, 'cisa-kev': 2 });

    // Overview model: same items, severity from the source, locations only where supported.
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await originalFetch(`http://127.0.0.1:${address.port}/api/feed/overview`, { headers: { 'x-client-id': 'client-integration' } });
    const overview = await response.json() as { items: Array<{ sourceId: string; severity: string; assessmentMethod: string; location: { precision: string } | null; countryStatus: string; headline: string }>; total: number; unlocated: number };
    const quake = overview.items.find((item) => item.headline.startsWith('Orange earthquake'))!;
    assert.deepEqual([quake.severity, quake.assessmentMethod, quake.location?.precision], ['High', 'source', 'event']);
    const kev = overview.items.filter((item) => item.sourceId === 'cisa-kev');
    assert.ok(kev.every((item) => item.location === null && item.countryStatus === 'global'));
    const sudan = overview.items.find((item) => item.headline.startsWith('Airstrike hits market in Sudan'))!;
    assert.equal(sudan.location?.precision, 'approximate', 'single country in the headline is mapped at the country centre');
    assert.equal(sudan.severity === 'Unassessed', false);
    assert.equal(overview.unlocated, overview.items.filter((item) => item.location === null).length);

    // A repeat check does not create duplicates.
    const dueAt = new Date(Date.now() - 1000).toISOString();
    const makeDue = () => { for (const id of ['bbc-world', 'un-news', 'gdacs', 'gdelt', 'cisa-kev']) sourceStore.markNotModified(id, dueAt, dueAt, null, null); };
    makeDue();
    unDown = false;
    await syncSources(false);
    assert.equal(statuses().get('un-news'), 'healthy', 'recovers once the source answers again');
    assert.equal(sourceStore.getRecords('un-news').length, 1, 'its reports arrive after recovery');
    assert.deepEqual(counts(), { 'bbc-world': 1, gdacs: 2, gdelt: 2, 'cisa-kev': 2 });

    // A source that fails after succeeding keeps its cached reports and is marked stale, not erased.
    gdacsDown = true;
    makeDue();
    await syncSources(false);
    assert.equal(statuses().get('gdacs'), 'stale');
    assert.equal(sourceStore.getRecords('gdacs').length, 2);
    assert.equal(statuses().get('bbc-world'), 'healthy');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sourceStore.close();
  }
});
