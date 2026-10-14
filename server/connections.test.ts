import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisStore } from './analysis-store';
import { buildConnections } from './connections-routes';
import { SibStore } from './sib-store';
import { SourceStore } from './source-store';
import { EMPTY_FIELDS } from '../src/data/sibTypes';

process.env.NODE_ENV = 'test';
const T0 = '2026-10-10T08:00:00.000Z';
const alice = 'client-alice-00001';
const bob = 'client-bob-000001';

test('connections: nothing saved means an empty graph', () => {
  const store = new SourceStore(':memory:');
  assert.deepEqual(buildConnections(new AnalysisStore(store.handle), new SibStore(store.handle), alice), { nodes: [], edges: [] });
  store.close();
});

test('connections: edges come only from saved links and stay private to the browser', () => {
  const store = new SourceStore(':memory:');
  const analysis = new AnalysisStore(store.handle);
  const sibs = new SibStore(store.handle);
  const input = { title: 'Drone strike', summary: 's', category: 'conflict', locationText: 'Khartoum', lat: null, lng: null, countryCodes: ['SD', 'SS'], severity: 'High' as const, severityRationale: 'Reports.', confidence: 'Medium' as const, owner: null, eventAt: T0 };
  const a = analysis.createIncident(alice, 'Ana', input, [], T0);
  analysis.createIncident(alice, 'Ana', { ...input, title: 'Port closure', countryCodes: ['SD'] }, [], T0);
  analysis.createIncident(bob, 'Bo', { ...input, title: 'Bob only', countryCodes: ['UA'] }, [], T0);
  analysis.setCountryWatch(alice, 'YE', true, T0);
  sibs.create(alice, 'Ana', { fields: { ...EMPTY_FIELDS, title: 'Sudan bulletin', severity: 'High' }, source: { type: 'incident', id: a.id, label: 'x' }, evidence: [] }, T0);
  sibs.create(alice, 'Ana', { fields: { ...EMPTY_FIELDS, title: 'Yemen country bulletin' }, source: { type: 'country', code: 'YE', version: 1, label: 'x' }, evidence: [] }, T0);

  const graph = buildConnections(analysis, sibs, alice);
  const byType = (type: string) => graph.nodes.filter((node) => node.type === type).map((node) => node.label).sort();
  assert.deepEqual(byType('incident'), ['Drone strike', 'Port closure']);
  assert.deepEqual(byType('country'), ['South Sudan', 'Sudan', 'Yemen']);
  assert.deepEqual(byType('sib'), ['Sudan bulletin', 'Yemen country bulletin']);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'affects').length, 3);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'based-on').length, 2);
  assert.ok(graph.edges.every((edge) => graph.nodes.some((n) => n.id === edge.from) && graph.nodes.some((n) => n.id === edge.to)));
  assert.equal(graph.nodes.find((node) => node.id === 'country:YE')!.detail, 'Watched');
  assert.ok(!graph.nodes.some((node) => node.label === 'Bob only'));
  const other = buildConnections(analysis, sibs, bob);
  assert.deepEqual(other.nodes.map((node) => node.type).sort(), ['country', 'incident']);
  store.close();
});
