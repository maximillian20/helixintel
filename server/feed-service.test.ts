import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFeedPage, ensureAssessments, updateItemState } from './feed-service';
import { SourceStore } from './source-store';
import type { NormalizedArticle, SourceDefinition } from './source-store';
import { DEFAULT_FEED_FILTERS, type FeedFilters } from '../src/data/feedTypes';

const bbc: SourceDefinition = {
  id: 'bbc-world', name: 'BBC News World', url: 'https://feeds.example.test/bbc.xml', format: 'RSS 2.0',
  coverage: 'test', cadence: 'test', attribution: 'BBC News World', termsUrl: 'https://example.test/terms',
};

function article(n: number, headline: string, summary: string, publishedAt: string): NormalizedArticle {
  return { sourceRecordId: `s${n}`, canonicalUrl: `https://news.example.test/${n}`, headline, summary, publishedAt, sourceModifiedAt: null };
}

const fixtures: NormalizedArticle[] = [
  article(1, 'Several injured in attack on airport in Saudi capital Riyadh', 'Yemen Houthis said they struck it.', '2026-10-10T20:00:00.000Z'),
  article(2, 'Drone attack on Riyadh airport', 'Saudi officials confirm damage.', '2026-10-10T18:00:00.000Z'),
  article(3, 'Four dead after Hurricane Isaias lashes US', 'Thousands without power.', '2026-10-10T17:00:00.000Z'),
  article(4, 'Expedition hopes to find Amelia Earhart plane', 'Remote island search.', '2026-10-10T16:00:00.000Z'),
  article(5, 'Strike kills 12 in Gaza', 'Israeli military says it targeted militants.', '2026-10-10T15:00:00.000Z'),
  article(6, 'Leaders call for worldwide climate action', 'A summit opens.', '2026-10-10T14:00:00.000Z'),
  article(7, 'Council approves cycle lanes', 'Three roads covered.', '2026-10-10T13:00:00.000Z'),
];

function seed(store: SourceStore, articles = fixtures, checkedAt = '2026-10-10T21:00:00.000Z') {
  return store.saveSuccessfulSync({ source: bbc, articles, checkedAt, nextRunAt: checkedAt, etag: null, lastModified: null });
}

const filters = (patch: Partial<FeedFilters>): FeedFilters => ({ ...DEFAULT_FEED_FILTERS, ...patch });
const ids = (page: { items: Array<{ id: string }> }) => page.items.map((item) => item.id.split('/').pop());
const A = 'client-aaaaaaaa';
const B = 'client-bbbbbbbb';
const id = (n: number) => `bbc-world:https://news.example.test/${n}`;

test('every stored item gets a severity and countries; unknown stays Unassessed/Unknown', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  const page = buildFeedPage(store, A, DEFAULT_FEED_FILTERS, 1, 20);
  assert.equal(page.total, 7);
  assert.equal(page.datasetTotal, 7);
  const byId = new Map(page.items.map((item) => [item.id, item]));
  assert.equal(byId.get(id(1))?.severity, 'High');
  assert.equal(byId.get(id(4))?.severity, 'Unassessed');
  assert.equal(byId.get(id(4))?.countryStatus, 'unknown');
  assert.equal(byId.get(id(6))?.countryStatus, 'global');
  assert.equal(byId.get(id(7))?.severity, 'Unassessed');
  assert.ok(page.items.every((item) => item.reviewStatus === 'Unreviewed' && !item.watchlisted));
  assert.equal(ensureAssessments(store), 0, 'second call must not reclassify');
});

test('severity, country and review filters combine and apply across pages', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ severity: 'High' }), 1, 5)).sort(), ['1', '2', '5']);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ severity: 'High', country: 'SA' }), 1, 5)).sort(), ['1', '2']);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ country: 'GLOBAL' }), 1, 5)), ['6']);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ country: 'UNKNOWN' }), 1, 5)).sort(), ['4', '7']);
  updateItemState(store, A, id(1), { reviewStatus: 'Reviewed' });
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ severity: 'High', country: 'SA', review: 'Unreviewed' }), 1, 5)), ['2']);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ severity: 'High', country: 'SA', review: 'Reviewed' }), 1, 5)), ['1']);
  assert.equal(buildFeedPage(store, A, filters({ severity: 'Critical' }), 1, 5).total, 0);

  const first = buildFeedPage(store, A, DEFAULT_FEED_FILTERS, 1, 5);
  const second = buildFeedPage(store, A, DEFAULT_FEED_FILTERS, 2, 5);
  assert.equal(first.totalPages, 2);
  assert.equal(first.items.length, 5);
  assert.equal(second.items.length, 2);
  assert.equal(buildFeedPage(store, A, DEFAULT_FEED_FILTERS, 99, 5).page, 2, 'page is clamped');
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ severity: 'Unassessed' }), 1, 5)).sort(), ['4', '6', '7']);
});

test('review state persists, records time, can be reverted, and survives re-fetching', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  const reviewed = updateItemState(store, A, id(2), { reviewStatus: 'Reviewed' }, new Date('2026-10-11T08:00:00.000Z'));
  assert.equal(reviewed?.item.reviewStatus, 'Reviewed');
  assert.equal(reviewed?.item.reviewedAt, '2026-10-11T08:00:00.000Z');
  seed(store, [article(2, 'Drone attack on Riyadh airport (updated)', 'Saudi officials confirm damage.', '2026-10-10T18:00:00.000Z')], '2026-10-11T09:00:00.000Z');
  const after = buildFeedPage(store, A, DEFAULT_FEED_FILTERS, 1, 20).items.find((item) => item.id === id(2));
  assert.equal(after?.headline, 'Drone attack on Riyadh airport (updated)');
  assert.equal(after?.reviewStatus, 'Reviewed');
  assert.equal(after?.reviewedAt, '2026-10-11T08:00:00.000Z');
  const back = updateItemState(store, A, id(2), { reviewStatus: 'Unreviewed' });
  assert.equal(back?.item.reviewStatus, 'Unreviewed');
  assert.equal(back?.item.reviewedAt, null);
});

test('state is per client', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  updateItemState(store, A, id(1), { reviewStatus: 'Reviewed', watchlisted: true, severityOverride: 'Critical' });
  const forB = buildFeedPage(store, B, DEFAULT_FEED_FILTERS, 1, 20);
  const item = forB.items.find((entry) => entry.id === id(1));
  assert.equal(item?.reviewStatus, 'Unreviewed');
  assert.equal(item?.watchlisted, false);
  assert.equal(item?.severity, 'High');
  assert.equal(forB.watchlistTotal, 0);
});

test('severity override is applied, filterable, and survives reclassification', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  const result = updateItemState(store, A, id(4), { severityOverride: 'Moderate' }, new Date('2026-10-11T08:00:00.000Z'));
  assert.equal(result?.item.severity, 'Moderate');
  assert.equal(result?.item.assessedSeverity, 'Unassessed');
  assert.equal(result?.item.severityOverridden, true);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ severity: 'Moderate' }), 1, 20)).sort(), ['3', '4']);
  assert.ok(!ids(buildFeedPage(store, A, filters({ severity: 'Unassessed' }), 1, 20)).includes('4'));

  const stale = [...store.getAssessments().values()].map((row) => ({ ...row, severity: 'Watch', classifierVersion: 'old' }));
  store.saveAssessments(stale);
  assert.equal(ensureAssessments(store), 7);
  const after = buildFeedPage(store, A, DEFAULT_FEED_FILTERS, 1, 20).items.find((item) => item.id === id(4));
  assert.equal(after?.severity, 'Moderate', 'manual override preserved');
  assert.equal(after?.assessedSeverity, 'Unassessed', 'automatic assessment refreshed');

  const cleared = updateItemState(store, A, id(4), { severityOverride: null });
  assert.equal(cleared?.item.severity, 'Unassessed');
  assert.equal(cleared?.item.severityOverridden, false);
});

test('watchlist add, remove, combined filters and counts', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  assert.equal(buildFeedPage(store, A, filters({ watchlistOnly: true }), 1, 20).watchlistTotal, 0);
  assert.equal(buildFeedPage(store, A, filters({ watchlistOnly: true }), 1, 20).total, 0);
  updateItemState(store, A, id(1), { watchlisted: true });
  updateItemState(store, A, id(5), { watchlisted: true });
  const onList = buildFeedPage(store, A, filters({ watchlistOnly: true }), 1, 20);
  assert.deepEqual(ids(onList).sort(), ['1', '5']);
  assert.equal(onList.watchlistTotal, 2);
  const none = buildFeedPage(store, A, filters({ watchlistOnly: true, country: 'US' }), 1, 20);
  assert.equal(none.total, 0);
  assert.equal(none.watchlistTotal, 2, 'saved reports exist but are excluded by other filters');
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ watchlistOnly: true, country: 'PS' }), 1, 20)), ['5']);
  updateItemState(store, A, id(1), { watchlisted: false });
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ watchlistOnly: true }), 1, 20)), ['5']);
});

test('state survives closing and reopening the database file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gsi-'));
  const path = join(directory, 'store.sqlite');
  try {
    const first = new SourceStore(path);
    seed(first);
    updateItemState(first, A, id(3), { reviewStatus: 'Reviewed', watchlisted: true, severityOverride: 'High' });
    first.close();
    const second = new SourceStore(path);
    const item = buildFeedPage(second, A, DEFAULT_FEED_FILTERS, 1, 20).items.find((entry) => entry.id === id(3));
    assert.equal(item?.reviewStatus, 'Reviewed');
    assert.equal(item?.watchlisted, true);
    assert.equal(item?.severity, 'High');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('search matches headline, source and country names', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ search: 'hurricane' }), 1, 20)), ['3']);
  assert.deepEqual(ids(buildFeedPage(store, A, filters({ search: 'palestine' }), 1, 20)), ['5']);
});

test('updating a missing report returns undefined', () => {
  const store = new SourceStore(':memory:');
  seed(store);
  assert.equal(updateItemState(store, A, 'nope', { watchlisted: true }), undefined);
});
