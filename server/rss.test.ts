import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRssSource, parseRssArticles, SourceFetchError } from './rss';
import type { SourceDefinition } from './source-store';

const source: SourceDefinition = {
  id: 'fixture-source',
  name: 'Fixture Publisher',
  url: 'https://feed.example.test/rss.xml',
  format: 'RSS 2.0',
  coverage: 'Test fixture only',
  cadence: 'test',
  attribution: 'Fixture Publisher',
  termsUrl: 'https://feed.example.test/terms',
};

const fixtureRss = `<?xml version="1.0"?>
<rss version="2.0"><channel><item>
  <title>Example international report</title>
  <link>https://news.example.test/story?id=5&amp;utm_source=feed#section</link>
  <description><![CDATA[Publisher description &amp; context.]]></description>
  <guid>story-5</guid>
  <pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate>
</item></channel></rss>`;

test('RSS parsing keeps provenance and canonicalizes tracking URLs', () => {
  const [article] = parseRssArticles(fixtureRss, source);

  assert.equal(article.sourceRecordId, 'story-5');
  assert.equal(article.canonicalUrl, 'https://news.example.test/story?id=5');
  assert.equal(article.headline, 'Example international report');
  assert.equal(article.publishedAt, '2026-10-07T12:00:00.000Z');
  assert.equal(article.sourceModifiedAt, null);
});

test('Atom entries with alternate links normalize correctly', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <id>tag:example.test,2026:7</id><title>Atom update</title>
    <link rel="alternate" href="https://news.example.test/atom-update" />
    <updated>2026-10-07T12:30:00Z</updated><summary>Short source summary</summary>
  </entry></feed>`;
  const [article] = parseRssArticles(atom, source);

  assert.equal(article.sourceRecordId, 'tag:example.test,2026:7');
  assert.equal(article.canonicalUrl, 'https://news.example.test/atom-update');
  assert.equal(article.publishedAt, '2026-10-07T12:30:00.000Z');
  assert.equal(article.sourceModifiedAt, '2026-10-07T12:30:00.000Z');
});

test('conditional requests reuse ETag and accept not-modified responses', async () => {
  let requestHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return new Response(null, { status: 304, headers: { etag: '"fixture-v2"' } });
  };

  const result = await fetchRssSource(source, { etag: '"fixture-v1"', lastModified: null }, fetcher);

  assert.equal(requestHeaders?.get('if-none-match'), '"fixture-v1"');
  assert.equal(result.notModified, true);
  assert.equal(result.etag, '"fixture-v2"');
});

test('rate limits expose Retry-After without spinning retries', async () => {
  const fetcher: typeof fetch = async () => new Response('rate limited', {
    status: 429,
    headers: { 'retry-after': '60' },
  });

  await assert.rejects(
    fetchRssSource(source, { etag: null, lastModified: null }, fetcher),
    (error: unknown) => error instanceof SourceFetchError && error.retryAfterMs === 60000,
  );
});
