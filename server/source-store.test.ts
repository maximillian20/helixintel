import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceStore } from './source-store';
import type { NormalizedArticle, SourceDefinition } from './source-store';

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

const article: NormalizedArticle = {
  sourceRecordId: 'story-5',
  canonicalUrl: 'https://news.example.test/story/5',
  headline: 'Example international report',
  summary: 'Original publisher summary.',
  publishedAt: '2026-10-07T12:00:00.000Z',
  sourceModifiedAt: null,
};

function save(store: SourceStore, articles: NormalizedArticle[], checkedAt: string) {
  return store.saveSuccessfulSync({
    source,
    articles,
    checkedAt,
    nextRunAt: '2026-10-07T12:15:00.000Z',
    etag: '"fixture-v1"',
    lastModified: null,
  });
}

test('repeated syncs upsert by canonical URL without duplicate records', () => {
  const store = new SourceStore(':memory:');
  try {
    assert.deepEqual(save(store, [article], '2026-10-07T12:00:00.000Z'), { newCount: 1, updatedCount: 0 });
    assert.deepEqual(save(store, [article], '2026-10-07T12:05:00.000Z'), { newCount: 0, updatedCount: 0 });
    assert.equal(store.getRecords().length, 1);
    assert.equal(store.getRecords()[0].sourceName, source.name);
    assert.equal(store.getRecords()[0].retrievedAt, '2026-10-07T12:05:00.000Z');
    assert.equal(store.getSyncState(source.id)?.etag, '"fixture-v1"');
  } finally {
    store.close();
  }
});

test('corrected publisher content creates history and failures retain stale records', () => {
  const store = new SourceStore(':memory:');
  try {
    save(store, [article], '2026-10-07T12:00:00.000Z');
    const corrected = {
      ...article,
      sourceRecordId: 'revised-story-5',
      headline: 'Corrected report headline',
      summary: 'Corrected publisher summary.',
    };

    assert.deepEqual(save(store, [corrected], '2026-10-07T12:10:00.000Z'), { newCount: 0, updatedCount: 1 });
    assert.equal(store.getRecords().length, 1);
    assert.equal(store.getRecords()[0].sourceRecordId, 'revised-story-5');
    assert.deepEqual(store.getRecentChanges(source.id)[0].fields.map((field) => field.field), ['headline', 'summary']);

    store.markFailure(source.id, '2026-10-07T12:20:00.000Z', '2026-10-07T12:40:00.000Z', 'fixture offline');
    assert.equal(store.getSyncState(source.id)?.status, 'stale');
    assert.equal(store.getRecords().length, 1);
    assert.equal(store.getRecords()[0].headline, 'Corrected report headline');
  } finally {
    store.close();
  }
});

test('only one poller owns the sync lease at a time', () => {
  const store = new SourceStore(':memory:');
  try {
    const now = new Date('2026-10-07T12:00:00.000Z');
    const leaseUntil = new Date('2026-10-07T12:02:00.000Z');

    assert.equal(store.acquireSyncLease('worker-a', now, leaseUntil), true);
    assert.equal(store.acquireSyncLease('worker-b', now, leaseUntil), false);
    assert.equal(store.releaseSyncLease('worker-a'), true);
    assert.equal(store.acquireSyncLease('worker-b', now, leaseUntil), true);
  } finally {
    store.close();
  }
});
