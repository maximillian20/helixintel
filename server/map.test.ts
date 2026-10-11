import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisStore } from './analysis-store';
import { buildSources } from './connectors';
import { AdsbClient, adsbSettings, parseAdsb } from './map-adsb';
import { GeoStore, GEO_SOURCES, parseEonet, parseUsgs, syncGeoSource, usgsFeedLevel, usgsFeedPeriod, usgsUrl, type GeoEvent } from './map-geo';
import { PlaceStore, buildMapData, evaluatePlaceAlerts, geoStatuses, getBoundaries, parseBoundaries, resetBoundaryThrottle, type MapDeps } from './map-service';
import { tileConfig } from './map-routes';
import { SourceStore } from './source-store';
import {
  AIRCRAFT_EXPIRE_AFTER_SEC, AIRCRAFT_STALE_AFTER_SEC, aircraftOpacity, aircraftState, boundsToCircle, clusterFeatures, eventCounts, filterFeatures, inBounds,
  linkDuplicates, resolveRange,
} from '../src/data/mapLogic';
import type { MapFeature, MapFilters } from '../src/data/mapTypes';

process.env.NODE_ENV = 'test';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const usgsBody = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { id: 'us7000abcd', properties: { mag: 6.1, magType: 'mww', place: '42 km SE of Hualien City, Taiwan', time: NOW.getTime() - 2 * HOUR, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd', alert: 'yellow', sig: 572, tsunami: 0, status: 'reviewed', felt: 120, title: 'M 6.1 - 42 km SE of Hualien City, Taiwan' }, geometry: { type: 'Point', coordinates: [121.9, 23.6, 18.4] } },
    { id: 'ci1', properties: { mag: 4.6, place: '12 km NW of Ridgecrest, CA', time: NOW.getTime() - 5 * HOUR, title: 'M 4.6 - 12 km NW of Ridgecrest, CA' }, geometry: { type: 'Point', coordinates: [-117.7, 35.7, 6] } },
    { id: 'bad', properties: { mag: 5, place: 'nowhere', time: 'x' }, geometry: { type: 'Point', coordinates: [1, 2, 3] } },
    { id: 'nogeo', properties: { mag: 5, place: 'x', time: 1 }, geometry: null },
  ],
});

const eonetBody = JSON.stringify({
  events: [
    { id: 'EONET_1', title: 'Typhoon Example', description: null, link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1', closed: null, categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
      sources: [{ id: 'JTWC', url: 'https://example.test/jtwc' }],
      geometry: [{ magnitudeValue: 65, magnitudeUnit: 'kts', date: iso(NOW.getTime() - 30 * HOUR), type: 'Point', coordinates: [130, 20] }, { magnitudeValue: 70, magnitudeUnit: 'kts', date: iso(NOW.getTime() - 4 * HOUR), type: 'Point', coordinates: [131, 21] }] },
    { id: 'EONET_2', title: 'Wildfire Area', description: 'Large fire', link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_2', closed: iso(NOW.getTime() - HOUR), categories: [{ id: 'wildfires', title: 'Wildfires' }], sources: [],
      geometry: [{ magnitudeValue: null, magnitudeUnit: null, date: iso(NOW.getTime() - 6 * HOUR), type: 'Polygon', coordinates: [[[-120, 38], [-119, 38], [-119, 39], [-120, 39], [-120, 38]]] }] },
    { id: 'EONET_3', title: 'No geometry', categories: [], sources: [], geometry: [] },
  ],
});

const memory = () => {
  const source = new SourceStore(':memory:');
  return { source, analysis: new AnalysisStore(source.handle), geo: new GeoStore(source.handle), places: new PlaceStore(source.handle) };
};
const ok = (body: string) => (async () => new Response(body, { status: 200 })) as typeof fetch;

// ------------------------------------------------------------------ parsers

test('USGS parser keeps source coordinates and native measurements and skips malformed records', () => {
  const events = parseUsgs(usgsBody);
  assert.equal(events.length, 2);
  const [taiwan] = events;
  assert.equal(taiwan.lat, 23.6); assert.equal(taiwan.lng, 121.9);
  assert.equal(taiwan.time, iso(NOW.getTime() - 2 * HOUR));
  assert.deepEqual(taiwan.countryCodes, ['TW']);
  const labels = Object.fromEntries(taiwan.native.map((n) => [n.label, n.value]));
  assert.equal(labels.Magnitude, '6.1 (mww)');
  assert.equal(labels['USGS PAGER alert'], 'yellow');
  assert.equal(labels.Depth, '18.4 km');
  assert.deepEqual(events[1].countryCodes, []); // "CA" is a US state code here, never guessed
  assert.throws(() => parseUsgs('{"nope":1}'), /features/);
  assert.throws(() => parseUsgs('<html>'), /not valid/);
});

test('EONET parser uses the latest dated geometry, thins polygons and keeps the event status', () => {
  const events = parseEonet(eonetBody);
  assert.equal(events.length, 2);
  const storm = events.find((e) => e.id === 'EONET_1')!;
  assert.equal(storm.lat, 21); assert.equal(storm.lng, 131);
  assert.equal(storm.hazardType, 'cyclone');
  assert.equal(storm.time, iso(NOW.getTime() - 4 * HOUR));
  assert.ok(storm.native.some((n) => n.label.startsWith('Magnitude') && n.value === '70 kts'));
  const fire = events.find((e) => e.id === 'EONET_2')!;
  assert.equal(fire.polygon?.length, 5);
  assert.equal(fire.lat, 38.5); assert.equal(fire.lng, -119.5);
  assert.ok(fire.native.some((n) => n.label === 'EONET status' && n.value.startsWith('closed')));
});

test('USGS feed choice is incremental: the smallest feed that covers the gap', () => {
  const t = NOW.getTime();
  assert.equal(usgsFeedPeriod(null, t), 'week');
  assert.equal(usgsFeedPeriod(iso(t - 5 * 60_000), t), 'hour');
  assert.equal(usgsFeedPeriod(iso(t - 3 * HOUR), t), 'day');
  assert.equal(usgsFeedPeriod(iso(t - 3 * 86_400_000), t), 'week');
  assert.equal(usgsFeedPeriod(iso(t - 20 * 86_400_000), t), 'month');
  assert.equal(usgsFeedLevel({}), '4.5');
  assert.equal(usgsFeedLevel({ USGS_FEED_LEVEL: '2.5' }), '2.5');
  assert.equal(usgsFeedLevel({ USGS_FEED_LEVEL: 'evil/../x' }), '4.5');
  assert.equal(usgsUrl('4.5', 'day'), 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
});

// ------------------------------------------------------------------ sync, isolation, stale

test('sources are fetched independently; a failing source keeps its stored data and is shown as Stale or unavailable', async () => {
  const { source, geo } = memory();
  try {
    const calls: string[] = [];
    const fetcher = (async (input: unknown) => {
      calls.push(String(input));
      if (String(input).includes('eonet')) return new Response('down', { status: 503 });
      return new Response(usgsBody, { status: 200 });
    }) as typeof fetch;
    const deps = { geo, env: {}, fetcher, now: () => NOW };
    assert.equal(await syncGeoSource(deps, 'usgs'), true);
    assert.equal(await syncGeoSource(deps, 'eonet'), false);
    assert.ok(calls.some((u) => u.includes('4.5_week')));
    let statuses = geoStatuses({ geo, now: NOW });
    assert.equal(statuses.find((s) => s.id === 'usgs')!.status, 'healthy');
    assert.equal(statuses.find((s) => s.id === 'usgs')!.records, 2);
    assert.equal(statuses.find((s) => s.id === 'eonet')!.status, 'unavailable');
    assert.match(statuses.find((s) => s.id === 'eonet')!.lastError ?? '', /503/);
    // Not due again until its interval has passed (no extra request).
    calls.length = 0;
    assert.equal(await syncGeoSource(deps, 'usgs'), false);
    assert.equal(calls.length, 0);
    // Second run, a bit later: uses the hourly feed and upserts without duplicating.
    const later = new Date(NOW.getTime() + 10 * 60_000);
    assert.equal(await syncGeoSource({ ...deps, now: () => later }, 'usgs'), true);
    assert.ok(calls.some((u) => u.includes('4.5_hour')));
    assert.equal(geo.count('usgs'), 2);
    // Long outage: stored data is kept, status turns Stale.
    const wayLater = new Date(NOW.getTime() + 2 * HOUR);
    statuses = geoStatuses({ geo, now: wayLater });
    assert.equal(statuses.find((s) => s.id === 'usgs')!.status, 'stale');
    const failing = (async () => new Response('x', { status: 500 })) as typeof fetch;
    await syncGeoSource({ ...deps, fetcher: failing, now: () => wayLater }, 'usgs', true);
    assert.equal(geo.count('usgs'), 2);
    assert.equal(geoStatuses({ geo, now: wayLater }).find((s) => s.id === 'usgs')!.status, 'stale');
  } finally { source.close(); }
});

// ------------------------------------------------------------------ map data

function seedDeps(): { deps: MapDeps; cleanup: () => void; stores: ReturnType<typeof memory> } {
  const stores = memory();
  const bbc = buildSources(900_000).find((s) => s.id === 'bbc-world')!;
  const gdacs = buildSources(900_000).find((s) => s.id === 'gdacs')!;
  stores.source.saveSuccessfulSync({
    source: bbc, checkedAt: NOW.toISOString(), nextRunAt: iso(NOW.getTime() + 900_000), etag: null, lastModified: null,
    articles: [
      { sourceRecordId: 'n1', canonicalUrl: 'https://n.example.test/1', headline: 'Protesters clash with police in Kenya', summary: 'Unrest in Nairobi.', publishedAt: iso(NOW.getTime() - 3 * HOUR), sourceModifiedAt: null },
      { sourceRecordId: 'n2', canonicalUrl: 'https://n.example.test/2', headline: 'Markets steady as leaders meet', summary: 'No place.', publishedAt: iso(NOW.getTime() - 4 * HOUR), sourceModifiedAt: null },
      { sourceRecordId: 'n3', canonicalUrl: 'https://n.example.test/3', headline: 'Old story from Kenya', summary: '', publishedAt: iso(NOW.getTime() - 20 * 86_400_000), sourceModifiedAt: null },
    ],
  });
  stores.source.saveSuccessfulSync({
    source: gdacs, checkedAt: NOW.toISOString(), nextRunAt: iso(NOW.getTime() + 900_000), etag: null, lastModified: null,
    articles: [{
      sourceRecordId: 'g1', canonicalUrl: 'https://gdacs.example.test/1', headline: 'Green earthquake alert (Magnitude 6.0M, Depth:20km) in Taiwan', summary: 'GDACS', publishedAt: iso(NOW.getTime() - 90 * 60_000), sourceModifiedAt: null,
      enrichment: { category: 'earthquake', countryCodes: ['TW'], location: { lat: 23.5, lng: 121.8, label: 'Taiwan' }, severity: { value: 'Low', reason: 'GDACS alert level Green', method: 'source' } },
    }],
  });
  stores.geo.upsert(parseUsgs(usgsBody), NOW.toISOString());
  stores.geo.upsert(parseEonet(eonetBody), NOW.toISOString());
  return { deps: { store: stores.source, analysis: stores.analysis, geo: stores.geo, env: {}, now: NOW }, stores, cleanup: () => stores.source.close() };
}
const range = [iso(NOW.getTime() - 7 * 86_400_000), NOW.toISOString()] as const;

test('map data combines layers with honest precision, time basis, severity basis and unlocated counts', () => {
  const { deps, cleanup } = seedDeps();
  try {
    const data = buildMapData(deps, 'c1', ...range);
    const by = (id: string) => data.features.find((f) => f.id === id)!;
    const kenya = data.features.find((f) => f.title.includes('Kenya'))!;
    assert.equal(kenya.precision, 'approximate');
    assert.match(kenya.locationLabel, /approximate/i);
    assert.equal(kenya.timeBasis, 'published');
    assert.equal(data.features.some((f) => f.title.includes('Old story')), false); // outside the range
    assert.equal(data.unlocatedTotal, 1); // "Markets steady..." has no place
    assert.equal(data.unlocated[0].reason.length > 0, true);
    const quake = by('usgs:us7000abcd');
    assert.equal(quake.precision, 'source'); assert.equal(quake.timeBasis, 'event');
    assert.equal(quake.severity, 'Unassessed'); // magnitude / PAGER alert are never converted to business severity
    assert.match(quake.severityBasis, /not business-impact|Unassessed/);
    assert.equal(by('eonet:EONET_1').severity, 'Unassessed');
    const gdacs = data.features.find((f) => f.sourceId === 'gdacs')!;
    assert.equal(gdacs.layer, 'gdacs'); assert.equal(gdacs.precision, 'source'); assert.equal(gdacs.severity, 'Low');
    assert.match(gdacs.severityBasis, /alert level/);
    assert.deepEqual(data.geoStatus.map((s) => s.id).sort(), ['eonet', 'usgs']);
  } finally { cleanup(); }
});

test('GDACS and USGS records for the same earthquake are linked but both are kept, and counts differ', () => {
  const { deps, cleanup } = seedDeps();
  try {
    const data = buildMapData(deps, 'c1', ...range);
    const gdacs = data.features.find((f) => f.sourceId === 'gdacs')!;
    const usgs = data.features.find((f) => f.id === 'usgs:us7000abcd')!;
    assert.ok(gdacs.groupId && gdacs.groupId === usgs.groupId);
    const other = data.features.find((f) => f.id === 'usgs:ci1')!;
    assert.equal(other.groupId, null);
    const counts = eventCounts(data.features.filter((f) => f.hazardType === 'earthquake'));
    assert.equal(counts.records, 3); assert.equal(counts.events, 2);
  } finally { cleanup(); }
});

test('incidents use analyst coordinates, else a single country centre, else are listed as unlocated', () => {
  const { deps, stores, cleanup } = seedDeps();
  try {
    const base = {
      title: 'Plant disruption', summary: '', category: 'earthquake', locationText: 'Hualien plant', lat: 24.0, lng: 121.6, countryCodes: ['TW'], severity: 'High' as const,
      severityRationale: 'Site closed', confidence: 'Medium' as const, owner: null, eventAt: iso(NOW.getTime() - HOUR),
    };
    stores.analysis.createIncident('c1', 'tester', base, [], NOW.toISOString());
    stores.analysis.createIncident('c1', 'tester', { ...base, title: 'Country level', lat: null, lng: null, locationText: '' }, [], NOW.toISOString());
    stores.analysis.createIncident('c1', 'tester', { ...base, title: 'Two countries', lat: null, lng: null, countryCodes: ['TW', 'JP'] }, [], NOW.toISOString());
    const data = buildMapData(deps, 'c1', ...range);
    const inc = data.features.filter((f) => f.layer === 'incidents');
    assert.equal(inc.find((f) => f.title === 'Plant disruption')!.precision, 'analyst');
    assert.equal(inc.find((f) => f.title === 'Country level')!.precision, 'approximate');
    assert.equal(inc.some((f) => f.title === 'Two countries'), false);
    assert.ok(data.unlocated.some((u) => u.kind === 'incident' && u.title === 'Two countries'));
    // Another browser sees none of these incidents.
    assert.equal(buildMapData(deps, 'c2', ...range).features.some((f) => f.layer === 'incidents'), false);
  } finally { cleanup(); }
});

// ------------------------------------------------------------------ places and alerts

test('saved-area alerts: geographic wording, dedupe, cooldown, severity and category filters, precise coordinates only, no back-fill', () => {
  const { deps, stores, cleanup } = seedDeps();
  try {
    const rule = { enabled: true, minSeverity: 'Any' as const, categories: [] as string[], cooldownHours: 6, since: null as string | null };
    const mk = (name: string, over: Record<string, unknown> = {}) => stores.places.create('c1', {
      name, kind: 'radius', lat: 23.6, lng: 121.9, radiusKm: 200, bbox: null, notes: '', alert: { ...rule, ...(over.alert as object ?? {}) }, ...over,
    } as never, iso(NOW.getTime() - 3 * HOUR));
    // Created 3 h ago: the 2 h-old USGS quake and the GDACS record are newer than "since".
    const plant = mk('Taiwan plant');
    mk('Kenya office', { lat: -1.3, lng: 36.8, radiusKm: 100 }); // only an approximate (country-centre) marker is near: never matches
    const wrongCategory = mk('Taiwan conflict watch', { alert: { ...rule, categories: ['conflict'] } });
    const strict = mk('Taiwan high only', { alert: { ...rule, minSeverity: 'High' } });
    const off = mk('Taiwan quiet', { alert: { ...rule, enabled: false } });
    const first = evaluatePlaceAlerts(deps, stores.places);
    const alerts = stores.analysis.listAlerts('c1');
    const titles = alerts.items.map((a) => a.title);
    assert.ok(first.created >= 1);
    assert.ok(titles.every((t) => t.includes('Taiwan plant')));
    assert.ok(alerts.items.every((a) => /geographic match, not confirmed business impact/i.test(a.detail)));
    assert.ok(alerts.items.every((a) => a.link?.view === 'Map'));
    // One alert for the earthquake even though two providers report it.
    assert.equal(alerts.items.length, 1);
    void [plant, wrongCategory, strict, off];
    // Second tick: dedupe + cooldown = nothing new.
    assert.equal(evaluatePlaceAlerts(deps, stores.places).created, 0);
    // After the cooldown the same event still does not alert again (dedupe key).
    const later = { ...deps, now: new Date(NOW.getTime() + 7 * HOUR) };
    assert.equal(evaluatePlaceAlerts(later, stores.places).created, 0);
    // Updating a place with alerts newly enabled starts a fresh baseline (no back-fill).
    const updated = stores.places.update('c1', off.id, { ...off, alert: { ...off.alert, enabled: true, since: null } } as never, NOW.toISOString())!;
    assert.equal(updated.alert.since, NOW.toISOString());
    assert.equal(evaluatePlaceAlerts(deps, stores.places).created, 0);
  } finally { cleanup(); }
});

test('places belong to one browser and are validated by the store round-trip', () => {
  const { stores, cleanup } = seedDeps();
  try {
    const place = stores.places.create('c1', { name: 'HQ', kind: 'point', lat: 52.37, lng: 4.9, radiusKm: 25, bbox: null, notes: '', alert: { enabled: false, minSeverity: 'Any', categories: [], cooldownHours: 24, since: null } }, NOW.toISOString());
    assert.equal(stores.places.list('c1').length, 1);
    assert.equal(stores.places.list('c2').length, 0);
    assert.equal(stores.places.remove('c2', place.id), false);
    assert.equal(stores.places.remove('c1', place.id), true);
  } finally { cleanup(); }
});

// ------------------------------------------------------------------ pure logic

const feat = (id: string, over: Partial<MapFeature> = {}): MapFeature => ({
  id, layer: 'usgs', kind: 'hazard', sourceId: 'usgs', sourceName: 'USGS', title: id, summary: '', url: null, time: NOW.toISOString(), timeBasis: 'event', retrievedAt: null,
  lat: 10, lng: 10, precision: 'source', locationLabel: '', polygon: null, category: 'natural-hazard', categoryLabel: 'earthquake', hazardType: 'earthquake', severity: 'Unassessed',
  severityBasis: '', native: [], countries: [], reviewStatus: null, watchlisted: null, refId: id, groupId: null, incidentIds: [], ...over,
});

test('clustering groups nearby records, shows the highest assessed severity and always lets a cluster be opened', () => {
  const list = [
    feat('a', { severity: 'Low', lat: 10, lng: 10 }), feat('b', { severity: 'Critical', lat: 10.01, lng: 10.01 }), feat('c', { severity: 'Unassessed', lat: 10.0, lng: 10.0 }),
    feat('far', { lat: -30, lng: 100 }),
  ];
  const lowZoom = clusterFeatures(list, 3);
  assert.equal(lowZoom.length, 2);
  const big = lowZoom.find((c) => c.records === 3)!;
  assert.equal(big.severity, 'Critical');
  assert.deepEqual(big.counts, { Critical: 1, High: 0, Medium: 0, Low: 1, Unassessed: 1 });
  assert.equal(big.features[0].id, 'b');
  // At the maximum zoom only identical coordinates merge.
  const max = clusterFeatures(list, 11);
  assert.equal(max.length, 3);
  assert.equal(max.find((c) => c.records === 2)!.features.length, 2);
  // Unassessed never outranks an assessed severity.
  assert.equal(clusterFeatures([feat('x', { severity: 'Unassessed' }), feat('y', { severity: 'Low' })], 3)[0].severity, 'Low');
  // Approximate members mark the cluster as not fully precise.
  assert.equal(clusterFeatures([feat('p'), feat('q', { precision: 'approximate' })], 3)[0].allPrecise, false);
});

test('filters combine country, category, severity, source, review status and the searched area', () => {
  const list = [
    feat('1', { countries: [{ code: 'TW', name: 'Taiwan' }], severity: 'High', category: 'natural-hazard', sourceId: 'gdacs', reviewStatus: 'Reviewed' }),
    feat('2', { countries: [{ code: 'TW', name: 'Taiwan' }], severity: 'Low', category: 'conflict', sourceId: 'usgs', reviewStatus: 'Unreviewed', lat: 50, lng: 50 }),
    feat('3', { countries: [{ code: 'KE', name: 'Kenya' }], severity: 'High' }),
  ];
  const f: MapFilters = { country: '', category: '', severity: 'All', source: '', review: 'All', preset: '24h', customFrom: '', customTo: '', area: null };
  assert.equal(filterFeatures(list, f).length, 3);
  assert.deepEqual(filterFeatures(list, { ...f, country: 'TW' }).map((x) => x.id), ['1', '2']);
  assert.deepEqual(filterFeatures(list, { ...f, country: 'TW', severity: 'High' }).map((x) => x.id), ['1']);
  assert.deepEqual(filterFeatures(list, { ...f, category: 'conflict' }).map((x) => x.id), ['2']);
  assert.deepEqual(filterFeatures(list, { ...f, source: 'gdacs', review: 'Reviewed' }).map((x) => x.id), ['1']);
  assert.deepEqual(filterFeatures(list, { ...f, area: [0, 0, 20, 20] }).map((x) => x.id), ['1', '3']);
});

test('time ranges: presets, custom whole UTC days, and whether the range reaches the present', () => {
  const now = NOW.getTime();
  const day = resolveRange({ preset: '24h', customFrom: '', customTo: '' }, now);
  assert.equal(Date.parse(day.to) - Date.parse(day.from), 24 * HOUR); assert.equal(day.includesNow, true);
  const past = resolveRange({ preset: 'custom', customFrom: '2026-10-01', customTo: '2026-10-03' }, now);
  assert.equal(past.from, '2026-10-01T00:00:00.000Z'); assert.equal(past.to, '2026-10-03T23:59:59.999Z'); assert.equal(past.includesNow, false);
  const open = resolveRange({ preset: 'custom', customFrom: '2026-10-05', customTo: '2026-10-11' }, now);
  assert.equal(open.includesNow, true);
  assert.ok(Date.parse(open.to) <= now);
});

test('duplicate linking: same provider is never merged, distance and time limits apply, cyclones get wider limits', () => {
  const t = NOW.getTime();
  const q = (id: string, sourceId: string, lat: number, lng: number, dt: number) => feat(id, { sourceId, lat, lng, time: iso(t + dt), hazardType: 'earthquake' });
  const out = linkDuplicates([
    q('a', 'usgs', 23.6, 121.9, 0), q('b', 'gdacs', 23.5, 121.8, 3 * HOUR), q('c', 'gdacs', 23.5, 121.8, 20 * HOUR), // too late
    q('d', 'usgs', 23.6, 121.9, 0.5 * HOUR), q('e', 'eonet', 40, 10, 0),
  ]);
  const g = (id: string) => out.find((f) => f.id === id)!.groupId;
  assert.ok(g('a') && g('a') === g('b') && g('a') === g('d')); // d joins through b although both are USGS
  assert.equal(g('c'), null); assert.equal(g('e'), null);
  const storms = linkDuplicates([
    feat('s1', { sourceId: 'gdacs', hazardType: 'cyclone', lat: 20, lng: 130, time: iso(t) }),
    feat('s2', { sourceId: 'eonet', hazardType: 'cyclone', lat: 23, lng: 132, time: iso(t + 2 * 86_400_000) }),
  ]);
  assert.equal(storms[0].groupId, storms[1].groupId);
  // Approximate (country-centre) records are never linked.
  const soft = linkDuplicates([q('x', 'usgs', 1, 1, 0), { ...q('y', 'gdacs', 1, 1, 0), precision: 'approximate' }]);
  assert.equal(soft[0].groupId, null);
});

test('bounding box to ADSB circle: centre, covering radius, 250 nm limit, antimeridian', () => {
  const small = boundsToCircle([50, 3, 54, 7], 250);
  assert.equal(small.lat, 52); assert.equal(small.lon, 5); assert.equal(small.tooLarge, false);
  assert.ok(small.radiusNm > 120 && small.radiusNm < 200);
  assert.equal(boundsToCircle([-60, -90, 60, 90], 250).tooLarge, true);
  const wrap = boundsToCircle([-2, 178, 2, -178], 250);
  assert.ok(Math.abs(Math.abs(wrap.lon) - 180) < 0.01);
  assert.equal(wrap.tooLarge, false);
  assert.equal(inBounds(0, 179, [-2, 178, 2, -178]), true);
  assert.equal(inBounds(0, 0, [-2, 178, 2, -178]), false);
});

test('aircraft ageing: fade after the stale threshold, expire after the expiry threshold', () => {
  assert.equal(aircraftState(5), 'fresh');
  assert.equal(aircraftState(AIRCRAFT_STALE_AFTER_SEC + 1), 'stale');
  assert.equal(aircraftState(AIRCRAFT_EXPIRE_AFTER_SEC + 1), 'expired');
  assert.equal(aircraftOpacity(10), 1);
  assert.ok(aircraftOpacity(60) < 1 && aircraftOpacity(60) >= 0.25);
  assert.equal(aircraftOpacity(500), 0);
});

// ------------------------------------------------------------------ ADSB.lol

const adsbBody = JSON.stringify({
  now: NOW.getTime(), total: 3,
  ac: [
    { hex: 'abc123', flight: 'KLM1234 ', r: 'PH-BXA', t: 'B738', alt_baro: 35000, gs: 450.2, track: 87.5, baro_rate: 0, squawk: '1234', lat: 52.3, lon: 4.8, seen_pos: 2.1 },
    { hex: 'def456', alt_baro: 'ground', lat: 52.31, lon: 4.76, seen_pos: 40 },
    { hex: 'nopos', flight: 'X' },
  ],
});

test('ADSB parser keeps only supplied fields and derives the observation time from the position age', () => {
  const { aircraft, total } = parseAdsb(adsbBody, NOW);
  assert.equal(aircraft.length, 2); assert.equal(total, 3);
  const a = aircraft[0];
  assert.equal(a.callsign, 'KLM1234'); assert.equal(a.altitudeFt, 35000); assert.equal(a.speedKt, 450.2); assert.equal(a.headingDeg, 87.5);
  assert.equal(a.observedAt, iso(NOW.getTime() - 2100));
  const b = aircraft[1];
  assert.equal(b.callsign, null); assert.equal(b.altitudeFt, 'ground'); assert.equal(b.speedKt, null); assert.equal(b.headingDeg, null); assert.equal(b.registration, null);
  assert.throws(() => parseAdsb('{}', NOW), /aircraft list/);
});

test('ADSB client: bounded queries, shared cache, coalesced requests, stale fallback and no request when too large or disabled', async () => {
  let calls: string[] = [];
  let mode: 'ok' | 'fail' = 'ok';
  const fetcher = (async (input: unknown) => {
    calls.push(String(input));
    await new Promise((r) => setTimeout(r, 5));
    return mode === 'ok' ? new Response(adsbBody, { status: 200 }) : new Response('nope', { status: 500 });
  }) as typeof fetch;
  let clock = NOW.getTime();
  const client = new AdsbClient({ ADSB_REFRESH_MS: '10000' }, fetcher, () => new Date(clock));
  const bounds: [number, number, number, number] = [52.0, 4.5, 52.6, 5.2];
  const [r1, r2] = await Promise.all([client.query(bounds), client.query([52.05, 4.55, 52.55, 5.15])]);
  assert.equal(calls.length, 1); // two browsers, one upstream request
  assert.match(calls[0], /^https:\/\/api\.adsb\.lol\/v2\/point\/52\.25\/4\.75\/\d+$/);
  assert.equal(r1.status, 'ok'); assert.equal(r1.aircraft.length, 2); assert.equal(r2.aircraft.length, 2);
  assert.equal(r1.providerTotal, 3);
  // Inside the TTL: cached. The visible box is applied to the cached circle.
  clock += 4000;
  const narrow = await client.query([52.305, 4.7, 52.4, 4.9]);
  assert.equal(calls.length, 1); assert.equal(narrow.cached, true); assert.equal(narrow.aircraft.length, 1);
  // After the TTL: a new request. If it fails, the last positions are served with a message (they keep ageing client-side).
  clock += 20_000; mode = 'fail';
  const failed = await client.query(bounds);
  assert.equal(calls.length, 2);
  assert.equal(failed.status, 'ok'); assert.equal(failed.cached, true); assert.match(failed.message ?? '', /last positions/);
  assert.ok(client.lastError);
  clock += 11 * 60_000;
  const gone = await client.query(bounds);
  assert.equal(gone.status, 'unavailable'); assert.equal(gone.aircraft.length, 0);
  // Too large: no upstream request.
  const before = calls.length;
  const wide = await client.query([-60, -90, 60, 90]);
  assert.equal(wide.status, 'too_large'); assert.equal(calls.length, before);
  const off = new AdsbClient({ ADSB_DISABLED: '1' }, fetcher, () => new Date(clock));
  assert.equal((await off.query(bounds)).status, 'disabled'); assert.equal(calls.length, before);
});

test('ADSB settings clamp the refresh interval to the supported range', () => {
  assert.equal(adsbSettings({}).refreshMs, 15_000);
  assert.equal(adsbSettings({ ADSB_REFRESH_MS: '100' }).refreshMs, 5_000);
  assert.equal(adsbSettings({ ADSB_REFRESH_MS: '9999999' }).refreshMs, 120_000);
  assert.equal(adsbSettings({ ADSB_API_BASE: 'https://example.test/' }).base, 'https://example.test');
});

// ------------------------------------------------------------------ tiles and boundaries

test('tile provider is configurable and the default carries OSM attribution and a usage note', () => {
  const d = tileConfig({});
  assert.match(d.url, /tile\.openstreetmap\.org/); assert.match(d.attribution, /OpenStreetMap/); assert.ok(d.productionNote);
  const c = tileConfig({ MAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png', MAP_TILE_ATTRIBUTION: '© Example' });
  assert.equal(c.url, 'https://tiles.example.test/{z}/{x}/{y}.png'); assert.equal(c.attribution, '© Example'); assert.equal(c.productionNote, null);
  assert.match(tileConfig({ MAP_TILE_URL: 'http://insecure.test/{z}/{x}/{y}.png' }).url, /openstreetmap/); // https only
});

const squares = JSON.stringify({
  type: 'FeatureCollection',
  features: Array.from({ length: 25 }, (_, i) => ({
    properties: { ISO_A2: i === 0 ? '-99' : String.fromCharCode(65 + Math.floor(i / 5)) + String.fromCharCode(65 + (i % 5)), ISO_A2_EH: i === 0 ? 'FR' : undefined },
    geometry: { type: 'Polygon', coordinates: [[[i, 0], [i + 0.123456, 0], [i + 0.123456, 1], [i, 0]]] },
  })),
});

test('boundary parsing, caching and failure reporting', async () => {
  const shapes = parseBoundaries(squares);
  assert.ok(shapes.FR); // ISO_A2_EH rescues the -99 placeholder
  assert.equal((shapes.FR.coordinates as number[][][])[0][1][0], 0.12);
  assert.throws(() => parseBoundaries('{"features":[]}'), /too few/);
  const { source, geo } = memory();
  try {
    resetBoundaryThrottle();
    const bad = await getBoundaries(geo, {}, (async () => new Response('x', { status: 500 })) as typeof fetch, NOW);
    assert.equal(bad.status, 'unavailable'); assert.match(bad.message ?? '', /500/);
    const throttled = await getBoundaries(geo, {}, ok(squares), NOW);
    assert.equal(throttled.status, 'unavailable'); // not retried within 30 minutes
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const good = await getBoundaries(geo, {}, ok(squares), later);
    assert.equal(good.status, 'ok');
    const cached = await getBoundaries(geo, {}, (async () => { throw new Error('should not fetch'); }) as typeof fetch, later);
    assert.equal(cached.status, 'ok'); assert.ok(Object.keys(cached.shapes).length >= 20);
  } finally { source.close(); }
});

void GEO_SOURCES; void ({} as GeoEvent);
