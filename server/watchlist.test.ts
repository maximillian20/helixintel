import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisStore } from './analysis-store';
import { PlaceStore } from './map-service';
import { SourceStore } from './source-store';
import { buildWatchlist } from './watchlist-routes';

process.env.NODE_ENV = 'test';
const T0 = '2026-10-10T08:00:00.000Z';
const alice = 'client-alice-00001';
const bob = 'client-bob-000001';

function setup() {
  const store = new SourceStore(':memory:');
  return { store, analysis: new AnalysisStore(store.handle), places: new PlaceStore(store.handle) };
}

test('an empty browser has nothing watched and no invented items', () => {
  const { store, analysis, places } = setup();
  const result = buildWatchlist(analysis, places, alice);
  assert.deepEqual({ ...result, alerts: result.alerts.length }, { countries: [], indicators: [], places: [], alerts: 0, unread: 0 });
  store.close();
});

test('lists only this browser\'s watches, places and alerts', () => {
  const { store, analysis, places } = setup();
  analysis.setCountryWatch(alice, 'SD', true, T0);
  analysis.setCountryWatch(bob, 'UA', true, T0);
  const incident = analysis.createIncident(alice, 'Ana', {
    title: 'Drone strike', summary: 's', category: 'conflict', locationText: 'Khartoum', lat: null, lng: null, countryCodes: ['SD'],
    severity: 'High', severityRationale: 'Two reports.', confidence: 'Medium', owner: null, eventAt: T0,
  }, [], T0);
  analysis.addCountryEvidence(alice, 'Ana', 'SD', { refType: 'incident', refId: incident.id, category: 'security', note: '', label: 'Drone strike', url: null, source: null, eventTime: null }, T0);
  analysis.saveCountryAssessment(alice, 'Ana', 'SD', { summary: 'x', confidence: 'Medium', categories: { security: { rating: 'Severe', confidence: 'High', rationale: 'r', evidenceIds: [analysis.listCountryEvidence(alice, 'SD')[0].id] } } }, T0);
  analysis.saveIndicatorSettings(alice, 'high-severity-reports', 'SD', { watched: true }, T0);
  analysis.saveIndicatorState(alice, 'high-severity-reports', 'SD', 'warning', T0, T0);
  analysis.saveIndicatorSettings(alice, 'no-such-indicator', 'ALL', { watched: true }, T0);
  places.create(alice, { name: 'Port', kind: 'point', lat: 1, lng: 2, radiusKm: null, bbox: null, notes: '', alert: { enabled: true, minSeverity: 'High', categories: [], cooldownHours: 6, since: null } } as never, T0);
  analysis.createAlert(alice, { kind: 'x', dedupeKey: 'k1', title: 'A', detail: 'd', severity: 'warning', link: null }, T0);
  analysis.createAlert(bob, { kind: 'x', dedupeKey: 'k2', title: 'B', detail: 'd', severity: 'info', link: null }, T0);

  const a = buildWatchlist(analysis, places, alice);
  assert.equal(a.countries.length, 1);
  assert.equal(a.countries[0].name, 'Sudan');
  assert.equal(a.countries[0].openIncidents, 1);
  assert.equal(a.countries[0].highestRating, 'Severe');
  assert.equal(a.indicators.length, 1, 'unknown indicator ids are skipped');
  assert.equal(a.indicators[0].lastLevel, 'warning');
  assert.equal(a.indicators[0].geoName, 'Sudan');
  assert.equal(a.places.length, 1);
  assert.equal(a.places[0].alert.enabled, true);
  assert.deepEqual(a.alerts.map((alert) => alert.title), ['A']);
  assert.equal(a.unread, 1);

  const b = buildWatchlist(analysis, places, bob);
  assert.deepEqual(b.countries.map((c) => c.code), ['UA']);
  assert.equal(b.countries[0].highestRating, null);
  assert.equal(b.places.length, 0);
  store.close();
});
