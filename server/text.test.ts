import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRssArticles } from './rss';
import { SourceStore } from './source-store';
import { buildSources } from './connectors';
import { plainText } from './text';

test('plainText removes tags, decodes entities and drops the trailing "Continue reading" link', () => {
  const html = '<p>Trump said &amp; did things</p><ul><li><p><a href="https://x.test/?a=1&amp;b=2"><strong>Sign up</strong></a></p></li></ul><p>It&#39;s a &quot;test&quot;.</p> <a href="https://x.test">Continue reading...</a>';
  assert.equal(plainText(html), 'Trump said & did things Sign up It\'s a "test".');
});

test('plainText handles entity-escaped HTML as sent by some feeds', () => {
  assert.equal(plainText('&lt;p&gt;Hello &lt;a href="https://x.test"&gt;world&lt;/a&gt;&lt;/p&gt;'), 'Hello world');
  assert.equal(plainText('Plain headline with AT&T'), 'Plain headline with AT&T');
});

test('feed summaries and headlines are stored as plain text', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>Rally &amp;amp; vote</title><link>https://x.test/a?utm_source=z</link><guid>g1</guid>
    <pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Body &lt;strong&gt;text&lt;/strong&gt;&lt;/p&gt; &lt;a href="https://x.test/a"&gt;Continue reading...&lt;/a&gt;</description></item></channel></rss>`;
  const source = buildSources(900_000).find((candidate) => candidate.id === 'guardian-world')!;
  const [article] = parseRssArticles(xml, source);
  assert.equal(article.summary, 'Body text');
  assert.ok(!/[<>]/.test(article.headline + article.summary));
});

test('stored records saved with HTML are repaired once', () => {
  const store = new SourceStore(':memory:');
  const db = store.handle as unknown as { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => { summary: string } } };
  db.prepare(`INSERT INTO source_records (id, source_id, source_name, source_url, source_record_id, canonical_url, headline, summary, published_at, retrieved_at, last_checked_at, verification_status, attribution)
    VALUES ('r1','guardian-world','G','https://x.test','g1','https://x.test/a','Head','<p>Hi <b>there</b></p>','2026-10-14T10:00:00.000Z','2026-10-14T10:00:00.000Z','2026-10-14T10:00:00.000Z','publisher_provided','G')`).run();
  assert.equal(store.cleanStoredText(), 1);
  assert.equal(db.prepare('SELECT summary FROM source_records WHERE id = ?').get('r1').summary, 'Hi there');
  assert.equal(store.cleanStoredText(), 0);
  store.close();
});
