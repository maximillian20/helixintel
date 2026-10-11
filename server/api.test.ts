import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.SOURCE_DB_PATH = ':memory:';

let server: Server;
let base = '';
const client = 'client-api-test-1';
const headers = { 'x-client-id': client, 'content-type': 'application/json' };
const id = 'bbc-world:https://news.example.test/api-1';

before(async () => {
  const module = await import('./index');
  module.sourceStore.saveSuccessfulSync({
    source: {
      id: 'bbc-world', name: 'BBC News World', url: 'https://feeds.example.test/bbc.xml', format: 'RSS 2.0',
      coverage: 'test', cadence: 'test', attribution: 'BBC News World', termsUrl: 'https://example.test/terms',
    },
    articles: [
      { sourceRecordId: 'a1', canonicalUrl: 'https://news.example.test/api-1', headline: 'Drone strike kills 12 in Sudan', summary: 'Khartoum market hit.', publishedAt: '2026-10-10T10:00:00.000Z', sourceModifiedAt: null },
      { sourceRecordId: 'a2', canonicalUrl: 'https://news.example.test/api-2', headline: 'Council approves cycle lanes', summary: 'Three roads.', publishedAt: '2026-10-10T09:00:00.000Z', sourceModifiedAt: null },
    ],
    checkedAt: '2026-10-10T11:00:00.000Z', nextRunAt: '2026-10-10T11:15:00.000Z', etag: null, lastModified: null,
  });
  server = createServer(module.app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const module = await import('./index');
  module.sourceStore.close();
});

test('requires a client id and validates query values', async () => {
  assert.equal((await fetch(`${base}/api/feed/items`)).status, 400);
  assert.equal((await fetch(`${base}/api/feed/items?severity=Nope`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/feed/items?country=ZZ`, { headers })).status, 400);
});

test('lists, filters, reviews, watchlists and overrides through the HTTP API', async () => {
  const all = await (await fetch(`${base}/api/feed/items`, { headers })).json() as { total: number; items: Array<{ id: string; severity: string }> };
  assert.equal(all.total, 2);
  const high = await (await fetch(`${base}/api/feed/items?severity=High&country=SD`, { headers })).json() as { total: number };
  assert.equal(high.total, 1);

  const patch = (body: unknown) => fetch(`${base}/api/feed/state`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await patch({ articleId: id })).status, 400);
  assert.equal((await patch({ articleId: 'missing', watchlisted: true })).status, 404);
  const saved = await (await patch({ articleId: id, reviewStatus: 'Reviewed', watchlisted: true, severityOverride: 'Critical' })).json() as { item: { reviewStatus: string; severity: string; watchlisted: boolean }; watchlistTotal: number };
  assert.equal(saved.item.reviewStatus, 'Reviewed');
  assert.equal(saved.item.severity, 'Critical');
  assert.equal(saved.watchlistTotal, 1);

  const watch = await (await fetch(`${base}/api/feed/items?watchlist=true&review=Reviewed&severity=Critical`, { headers })).json() as { total: number };
  assert.equal(watch.total, 1);
  const otherClient = await (await fetch(`${base}/api/feed/items?watchlist=true`, { headers: { 'x-client-id': 'client-someone-else' } })).json() as { total: number; watchlistTotal: number };
  assert.equal(otherClient.total, 0);
  assert.equal(otherClient.watchlistTotal, 0);
});
