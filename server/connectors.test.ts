import assert from 'node:assert/strict';
import test from 'node:test';
import { eiaJson, gdacsXml, gdeltJson, kevJson, reliefWebJson } from './fixtures';
import { buildSources, fetchSource, missingCredentials, parseEia, parseGdacs, parseGdelt, parseKev, parseReliefWeb } from './connectors';
import { SourceFetchError } from './rss';

const now = new Date('2026-10-11T08:00:00Z');

test('GDACS: keeps publication date, source alert level, coordinates and countries; skips undated items', () => {
  const items = parseGdacs(gdacsXml);
  assert.equal(items.length, 2, 'the item without a publication date is skipped, not given a made-up one');
  const quake = items[0];
  assert.equal(quake.publishedAt, '2026-10-10T04:32:21.000Z');
  assert.equal(quake.sourceModifiedAt, '2026-10-10T06:20:05.000Z');
  assert.equal(quake.canonicalUrl, 'https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1570467', 'episode id is dropped so updates upsert one row');
  assert.equal(quake.enrichment?.severity?.value, 'High');
  assert.equal(quake.enrichment?.severity?.method, 'source');
  assert.deepEqual(quake.enrichment?.countryCodes, ['PH']);
  assert.deepEqual([quake.enrichment?.location?.lat, quake.enrichment?.location?.lng], [10.5, 125.9]);
  assert.equal(quake.enrichment?.category, 'earthquake');
  const fire = items[1];
  assert.equal(fire.enrichment?.severity?.value, 'Low');
  assert.deepEqual([fire.enrichment?.location?.lat, fire.enrichment?.location?.lng], [-20.949, 130.189], 'georss:point is used when geo:Point is absent');
  assert.throws(() => parseGdacs('<html>not rss</html>'), SourceFetchError);
});

test('CISA KEV: only recent additions, date-only publication, global scope, no coordinates', () => {
  const items = parseKev(kevJson(now), now);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.enrichment?.global && !item.enrichment.location));
  const byCve = new Map(items.map((item) => [item.sourceRecordId, item]));
  assert.equal(byCve.get('CVE-2026-1111')?.enrichment?.severity?.value, 'High');
  assert.equal(byCve.get('CVE-2026-2222')?.enrichment?.severity?.value, 'Medium');
  assert.equal(byCve.get('CVE-2026-2222')?.enrichment?.severity?.method, 'rules');
  assert.match(byCve.get('CVE-2026-1111')?.publishedAt ?? '', /T00:00:00\.000Z$/);
  assert.throws(() => parseKev('<html>', now), SourceFetchError);
});

test('GDELT: parses first-seen time, strips tracking, drops syndicated duplicates, rejects text errors', () => {
  const items = parseGdelt(gdeltJson);
  assert.equal(items.length, 2);
  assert.equal(items[0].canonicalUrl, 'https://news.example.test/a');
  assert.equal(items[0].publishedAt, '2026-10-11T08:15:00.000Z');
  assert.ok(items.every((item) => item.enrichment === undefined), 'no coordinates or countries are invented');
  assert.throws(() => parseGdelt('Your query was too short or too long.'), SourceFetchError);
  assert.deepEqual(parseGdelt(''), []);
});

test('ReliefWeb and EIA parsers map documented response shapes', () => {
  const [report] = parseReliefWeb(reliefWebJson);
  assert.equal(report.publishedAt, '2026-10-09T00:00:00.000Z', 'original publication date, not the date ReliefWeb created the record');
  assert.deepEqual(report.enrichment?.countryCodes, ['SD']);
  assert.ok(!report.summary.includes('##'));
  const prices = parseEia(eiaJson);
  assert.equal(prices.length, 2);
  assert.match(prices[0].headline, /Brent crude oil spot price: \$81\.25/);
});

test('credentials: connectors without them are reported as missing and never fetched', async () => {
  const sources = buildSources(900_000);
  const byId = new Map(sources.map((source) => [source.id, source]));
  assert.deepEqual(missingCredentials(byId.get('reliefweb')!, {}), ['RELIEFWEB_APPNAME']);
  assert.deepEqual(missingCredentials(byId.get('eia')!, { EIA_API_KEY: 'abc' }), []);
  assert.deepEqual(missingCredentials(byId.get('gdacs')!, {}), []);
  assert.equal(byId.get('cisa-kev')!.intervalMs, 6 * 60 * 60 * 1000);
  assert.equal(byId.has('entsoe'), false, 'a source with no working connector is not listed');
});

test('network errors are retried with backoff, then reported; HTTP 429 carries Retry-After', async () => {
  const gdacs = buildSources(900_000).find((source) => source.id === 'gdacs')!;
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls < 2) throw new Error('The operation was aborted due to timeout');
    return new Response(gdacsXml, { status: 200 });
  }) as typeof fetch;
  const result = await fetchSource(gdacs, { fetcher: flaky, env: {}, checkpoint: { etag: null, lastModified: null }, now });
  assert.equal(calls, 2);
  assert.equal(result.articles.length, 2);
  const limited = (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch;
  await assert.rejects(
    fetchSource(gdacs, { fetcher: limited, env: {}, checkpoint: { etag: null, lastModified: null }, now }),
    (error: unknown) => error instanceof SourceFetchError && error.retryAfterMs === 120_000,
  );
});

test('registry: source ids are unique and every source names its publisher terms', () => {
  const sources = buildSources(900_000);
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  for (const id of ['aljazeera', 'guardian-world', 'who-don', 'uk-fcdo-travel']) {
    const source = sources.find((candidate) => candidate.id === id);
    assert.ok(source, id);
    assert.match(source!.url, /^https:\/\//);
    assert.match(source!.termsUrl, /^https:\/\//);
    assert.equal(source!.connector, 'rss');
  }
});
