import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.SOURCE_DB_PATH = ':memory:';

const { app, buildFeedResponse, sourceStore, syncSources } = await import('./index');

function feedXml(host: string, title: string, summary: string) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><item>
    <title>${title}</title>
    <link>https://${host}/story/1?utm_source=test</link>
    <guid>fixture-story-1</guid>
    <description>${summary}</description>
    <pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate>
  </item></channel></rss>`;
}

test('scheduled source sync persists records, deduplicates, records corrections, and serves the feed', async () => {
  const originalFetch = globalThis.fetch;
  const requestHeaders: string[] = [];
  let version = 1;
  let requestCount = 0;
  globalThis.fetch = async (input, init) => {
    requestCount += 1;
    requestHeaders.push(new Headers(init?.headers).get('if-none-match') ?? '');
    const sourceHost = new URL(String(input)).hostname;
    const title = version === 1 ? 'Fixture report' : 'Corrected fixture report';
    const summary = version === 1 ? 'Original summary.' : 'Corrected summary.';
    return new Response(feedXml(sourceHost, title, summary), {
      status: 200,
      headers: { 'content-type': 'application/rss+xml', etag: `"fixture-v${version}"` },
    });
  };

  const server = app.listen(0);
  try {
    const firstSync = await syncSources(true);
    assert.equal(firstSync.changed, true);
    assert.equal(requestCount, 2);
    assert.equal(sourceStore.getRecords().length, 2);
    assert.ok(sourceStore.getRecords().every((record) => record.retrievedAt && record.sourceUrl));

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await originalFetch(`http://127.0.0.1:${address.port}/api/feed/public`);
    const body = await response.json() as { items: Array<{ headline: string; source: string }>; sources: Array<{ status: string }> };
    assert.equal(response.status, 200);
    assert.equal(body.items.length, 2);
    assert.ok(body.sources.every((source) => source.status === 'healthy'));

    const dueAt = new Date(Date.now() - 1000).toISOString();
    for (const sourceId of ['bbc-world', 'un-news']) {
      sourceStore.markNotModified(sourceId, dueAt, dueAt, `"fixture-v${version}"`, null);
    }
    version = 2;
    const secondSync = await syncSources(false);
    assert.equal(secondSync.changed, true);
    assert.equal(requestCount, 4);
    assert.ok(requestHeaders.slice(2).every((value) => value === '"fixture-v1"'));
    assert.equal(sourceStore.getRecords().length, 2);
    assert.equal(sourceStore.getRecords()[0].headline, 'Corrected fixture report');
    assert.equal(sourceStore.getRecentChanges('bbc-world').length, 1);
    assert.equal(buildFeedResponse(false).items[0].headline, 'Corrected fixture report');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sourceStore.close();
  }
});
