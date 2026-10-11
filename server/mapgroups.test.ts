import assert from 'node:assert/strict';
import test from 'node:test';
import { groupForMap } from '../src/data/mapGroups';
import { SEVERITY_COLORS, type FeedItemDto, type Severity } from '../src/data/feedTypes';

function item(id: string, severity: Severity, location: FeedItemDto['location'], countryStatus: FeedItemDto['countryStatus'] = 'identified'): FeedItemDto {
  return { id, severity, location, countryStatus, publishedAt: '2026-10-10T10:00:00.000Z' } as FeedItemDto;
}
const at = (lat: number, lng: number, precision: 'event' | 'approximate' = 'event') => ({ lat, lng, precision, label: 'x' });

test('severity colours match the specified palette', () => {
  assert.deepEqual(SEVERITY_COLORS, { Critical: '#DC2626', High: '#F97316', Medium: '#F59E0B', Low: '#22C55E', Unassessed: '#94A3B8' });
});

test('grouped markers take the highest assessed severity and report a breakdown', () => {
  const { groups } = groupForMap([
    item('a', 'Low', at(10, 20)), item('b', 'Critical', at(10, 20)), item('c', 'Medium', at(10, 20)),
    item('d', 'Unassessed', at(40, 40)), item('e', 'Unassessed', at(40, 40)), item('f', 'Low', at(40, 40)),
  ], 'All');
  const first = groups.find((group) => group.key.includes('10.00,20.00'))!;
  assert.equal(first.severity, 'Critical');
  assert.deepEqual(first.counts, { Critical: 1, High: 0, Medium: 1, Low: 1, Unassessed: 0 });
  assert.equal(first.items[0].id, 'b', 'most severe report first');
  const second = groups.find((group) => group.key.includes('40.00,40.00'))!;
  assert.equal(second.severity, 'Low', 'an assessed report outranks Unassessed');
  const onlyUnassessed = groupForMap([item('g', 'Unassessed', at(1, 1))], 'All').groups[0];
  assert.equal(onlyUnassessed.severity, 'Unassessed');
});

test('the severity filter changes markers, colours and counts consistently', () => {
  const items = [item('a', 'Low', at(10, 20)), item('b', 'Critical', at(10, 20)), item('c', 'Low', at(40, 40)), item('d', 'High', null, 'global')];
  const low = groupForMap(items, 'Low');
  assert.equal(low.groups.length, 2);
  assert.ok(low.groups.every((group) => group.severity === 'Low'));
  assert.equal(low.matching.length, 2);
  assert.equal(low.locatedCount, 2);
  const high = groupForMap(items, 'High');
  assert.equal(high.groups.length, 0);
  assert.deepEqual(high.unlocated, { total: 1, global: 1, unknown: 0, multiple: 0 });
});

test('unlocated reports are excluded from the map and split into global, unknown and multi-country', () => {
  const result = groupForMap([
    item('a', 'High', null, 'global'), item('b', 'High', null, 'unknown'), item('c', 'High', null, 'identified'), item('d', 'High', at(1, 2)),
  ], 'All');
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.unlocated, { total: 3, global: 1, unknown: 1, multiple: 1 });
  assert.equal(result.locatedCount, 1);
});

test('approximate and event locations at similar coordinates stay separate markers', () => {
  const { groups } = groupForMap([item('a', 'Low', at(10, 20, 'event')), item('b', 'Low', at(10, 20, 'approximate'))], 'All');
  assert.equal(groups.length, 2);
});
