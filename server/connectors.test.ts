import assert from 'node:assert/strict';
import test from 'node:test';
import { eiaJson, gdacsXml, gdeltJson, kevJson, reliefWebJson } from './fixtures';
import { parseExtraFeeds, buildSources, fetchSource, missingCredentials, parseEia, parseGdacs, parseGdelt, parseKev, parseReliefWeb, parseAcled } from './connectors';
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
  for (const id of ['aljazeera', 'guardian-world', 'who-news', 'uk-fcdo-travel']) {
    const source = sources.find((candidate) => candidate.id === id);
    assert.ok(source, id);
    assert.match(source!.url, /^https:\/\//);
    assert.match(source!.termsUrl, /^https:\/\//);
    assert.equal(source!.connector, 'rss');
  }
});

test('EXTRA_FEEDS: administrator feeds are validated, named safely and never point at private addresses', () => {
  const raw = JSON.stringify([
    { name: 'Al Jazeera English (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNye-wNBqNL5ZzHSJj3l8Bg' },
    { name: 'Local thing', url: 'https://localhost/feed.xml' },
    { name: 'Private net', url: 'https://192.168.1.5/feed.xml' },
    { name: 'Not https', url: 'http://example.org/feed.xml' },
    { name: 'With password', url: 'https://user:pw@example.org/feed.xml' },
    { name: '', url: 'https://example.org/feed.xml' },
    { name: 'Good feed', url: 'https://example.org/feed.xml' },
    { name: 'Good feed', url: 'https://example.org/other.xml' },
  ]);
  const { sources, problems } = parseExtraFeeds(raw, 900_000);
  assert.deepEqual(sources.map((source) => source.id), ['extra-al-jazeera-english-youtube', 'extra-good-feed', 'extra-good-feed-2']);
  assert.equal(problems.length, 5);
  assert.equal(sources[0].format, 'Atom (YouTube channel)');
  assert.equal(sources[0].connector, 'rss');
  assert.deepEqual(parseExtraFeeds('not json', 900_000).sources, []);
  assert.match(parseExtraFeeds('{"a":1}', 900_000).problems[0], /JSON list/);
  assert.deepEqual(parseExtraFeeds(undefined, 900_000), { sources: [], problems: [] });
  assert.equal(buildSources(900_000, { EXTRA_FEEDS: raw } as NodeJS.ProcessEnv).filter((source) => source.id.startsWith('extra-')).length, 3);
  assert.equal(buildSources(900_000, {} as NodeJS.ProcessEnv).filter((source) => source.id.startsWith('extra-')).length, 0);
});

test('ACLED parser maps documented event fields and the source stays gated without a login', () => {
  const [event] = parseAcled(JSON.stringify({ status: 200, data: [{ event_id_cnty: 'SDN123', event_date: '2026-10-12', event_type: 'Violence against civilians', sub_event_type: 'Attack', actor1: 'Military forces', country: 'Sudan', admin1: 'Khartoum', location: 'Omdurman', latitude: '15.64', longitude: '32.48', fatalities: '4', notes: 'Shelling hit a market.', source: 'Local media' }, { event_date: '2026-10-12' }] }));
  assert.equal(event.headline, 'Attack in Omdurman, Khartoum, Sudan');
  assert.equal(event.publishedAt, '2026-10-12T00:00:00.000Z');
  assert.deepEqual(event.enrichment?.countryCodes, ['SD']);
  assert.equal(event.enrichment?.location?.lat, 15.64);
  assert.match(event.summary, /Reported fatalities: 4/);
  assert.equal(parseAcled(JSON.stringify({ data: [{ event_date: '2026-10-12' }] })).length, 0, 'events without an id or type are skipped');
  const byId = new Map(buildSources(900_000, {}).map((s) => [s.id, s]));
  assert.deepEqual(missingCredentials(byId.get('acled')!, {}), ['ACLED_EMAIL', 'ACLED_PASSWORD']);
  assert.ok(byId.has('us-state-travel'));
});
