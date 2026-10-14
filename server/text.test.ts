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

test('YouTube channel feeds: title, video link, date and description are read', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
    <title>Example Channel</title><entry><id>yt:video:abc123</id><yt:videoId>abc123</yt:videoId><title>Aid convoy reaches the city</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/><published>2026-10-14T09:00:00+00:00</published><updated>2026-10-14T09:30:00+00:00</updated>
    <media:group><media:title>Aid convoy reaches the city</media:title><media:description>Trucks arrived after a week.&#10;Subscribe for more.</media:description></media:group></entry></feed>`;
  const source = buildSources(900_000, { EXTRA_FEEDS: JSON.stringify([{ name: 'Example (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtest' }]) } as NodeJS.ProcessEnv).find((candidate) => candidate.id.startsWith('extra-'))!;
  const [video] = parseRssArticles(xml, source);
  assert.equal(video.headline, 'Aid convoy reaches the city');
  assert.equal(video.canonicalUrl, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(video.summary, 'Trucks arrived after a week. Subscribe for more.');
  assert.equal(video.publishedAt, '2026-10-14T09:00:00.000Z');
});
