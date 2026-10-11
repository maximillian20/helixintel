import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError, type AnalysisStore } from './analysis-store';
import { ADSB_DOCS_URL, ADSB_LICENCE, ADSB_MAX_RADIUS_NM, ADSB_MIN_REFRESH_MS, AdsbClient, adsbSettings } from './map-adsb';
import { GEO_SOURCES, syncAllGeo, type GeoStore } from './map-geo';
import { MAX_FEATURES, PlaceStore, buildMapData, countryRisk, getBoundaries, type MapDeps } from './map-service';
import type { SourceStore } from './source-store';
import { SEVERITIES } from '../src/data/feedTypes';
import { AIRCRAFT_EXPIRE_AFTER_SEC, AIRCRAFT_STALE_AFTER_SEC } from '../src/data/mapLogic';
import type { MapConfig } from '../src/data/mapTypes';

type Deps = {
  app: Express;
  store: SourceStore;
  analysis: AnalysisStore;
  geo: GeoStore;
  places: PlaceStore;
  adsb: AdsbClient;
  requireClientId: (req: Request, res: Response) => string | null;
  publish: (event: string, payload: unknown) => void;
  fetcher?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CATEGORY_IDS = ['conflict', 'political', 'humanitarian', 'cyber', 'natural-hazard', 'other'];

export function tileConfig(env: NodeJS.ProcessEnv): MapConfig['tiles'] {
  const custom = env.MAP_TILE_URL?.trim();
  const url = custom && /^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(custom) ? custom : DEFAULT_TILE_URL;
  const isDefault = url === DEFAULT_TILE_URL;
  const maxZoom = Math.min(19, Math.max(3, Number(env.MAP_TILE_MAX_ZOOM) || (isDefault ? 18 : 18)));
  return {
    url,
    attribution: isDefault ? DEFAULT_TILE_ATTRIBUTION : (env.MAP_TILE_ATTRIBUTION?.trim() || 'Map tiles: provider configured by MAP_TILE_URL'),
    maxZoom,
    provider: isDefault ? 'OpenStreetMap standard tiles' : (env.MAP_TILE_PROVIDER?.trim() || 'Custom tile provider'),
    productionNote: isDefault
      ? "OpenStreetMap's public tile servers are for light use under the OSMF tile usage policy (no bulk or offline downloading). For production traffic, set MAP_TILE_URL (and MAP_TILE_ATTRIBUTION) to a self-hosted or commercial tile provider."
      : null,
  };
}

export function registerMapRoutes(deps: Deps) {
  const { app, requireClientId, geo, places, adsb, publish } = deps;
  const clock = () => deps.now?.() ?? new Date();
  const env = () => deps.env ?? process.env;
  const ctx = (): MapDeps => ({ store: deps.store, analysis: deps.analysis, geo, env: env(), now: clock() });
  let lastManualRefresh = 0;

  const route = (handler: (req: Request, res: Response, clientId: string) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    try {
      res.set('Cache-Control', 'no-store');
      const result = await handler(req, res, clientId);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError) res.status(404).json({ error: error.message });
      else if (error instanceof ValidationError) res.status(400).json({ error: error.message });
      else if (error instanceof z.ZodError) res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      else { console.error('Map request failed', error); res.status(500).json({ error: 'The request could not be completed.' }); }
    }
  };

  app.get('/api/map/config', route((): MapConfig => {
    const a = adsbSettings(env());
    return {
      tiles: tileConfig(env()),
      adsb: { enabled: a.enabled, refreshMs: a.refreshMs, minRefreshMs: ADSB_MIN_REFRESH_MS, maxRadiusNm: ADSB_MAX_RADIUS_NM, base: a.base, contactConfirmed: a.contactConfirmed, licence: ADSB_LICENCE, docsUrl: ADSB_DOCS_URL },
      aircraft: { staleAfterSec: AIRCRAFT_STALE_AFTER_SEC, expireAfterSec: AIRCRAFT_EXPIRE_AFTER_SEC },
      boundaries: { enabled: env().MAP_COUNTRY_BOUNDARIES_DISABLED !== '1' },
      serverTime: clock().toISOString(),
    };
  }));

  app.get('/api/map/data', route((req, _res, clientId) => {
    const q = z.object({ from: z.string().datetime(), to: z.string().datetime() }).parse(req.query);
    if (Date.parse(q.from) > Date.parse(q.to)) throw new ValidationError('The start of the time range is after its end.');
    if (Date.parse(q.to) - Date.parse(q.from) > 92 * 86_400_000) throw new ValidationError('The time range can cover at most 92 days.');
    return buildMapData(ctx(), clientId, q.from, q.to);
  }));

  app.get('/api/map/aircraft', route(async (req) => {
    const q = z.object({
      south: z.coerce.number().min(-90).max(90), north: z.coerce.number().min(-90).max(90), west: z.coerce.number().min(-180).max(180), east: z.coerce.number().min(-180).max(180),
    }).parse(req.query);
    if (q.south > q.north) throw new ValidationError('south must not be greater than north.');
    return adsb.query([q.south, q.west, q.north, q.east]);
  }));

  app.get('/api/map/countries', route((_req, _res, clientId) => countryRisk(ctx(), clientId)));
  app.get('/api/map/boundaries', route(async () => {
    if (env().MAP_COUNTRY_BOUNDARIES_DISABLED === '1') return { status: 'unavailable', message: 'Country outlines are switched off (MAP_COUNTRY_BOUNDARIES_DISABLED=1).', fetchedAt: null, source: '', attribution: '', shapes: {} };
    return getBoundaries(geo, env(), deps.fetcher ?? fetch, clock());
  }));

  /** "Retry": asks the server to re-check USGS and EONET now. At most once a minute. */
  app.post('/api/map/refresh', route(async (_req, res) => {
    const nowMs = clock().getTime();
    if (nowMs - lastManualRefresh < 60_000) { res.status(429).json({ error: 'A refresh was requested less than a minute ago.' }); return undefined; }
    lastManualRefresh = nowMs;
    const changed = await syncAllGeo({ geo, env: env(), fetcher: deps.fetcher ?? fetch, now: clock }, true);
    if (changed) publish('map-updated', {});
    return { ok: true, changed };
  }));

  const placeInput = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['point', 'radius', 'bbox']),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    radiusKm: z.number().min(1).max(3000).nullable(),
    bbox: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180)]).nullable(),
    notes: z.string().max(500),
    alert: z.object({
      enabled: z.boolean(), minSeverity: z.enum(['Any', ...SEVERITIES]), categories: z.array(z.enum(CATEGORY_IDS as [string, ...string[]])).max(6),
      cooldownHours: z.number().int().min(1).max(168), since: z.string().datetime().nullable(),
    }),
  }).superRefine((v, ctx2) => {
    if (v.kind === 'bbox') {
      if (!v.bbox || v.bbox[0] >= v.bbox[2]) ctx2.addIssue({ code: 'custom', message: 'A bounding box needs south < north.', path: ['bbox'] });
    } else {
      if (v.lat === null || v.lng === null) ctx2.addIssue({ code: 'custom', message: 'A point or radius needs a latitude and longitude.', path: ['lat'] });
      if (v.kind === 'radius' && v.radiusKm === null) ctx2.addIssue({ code: 'custom', message: 'A radius area needs a radius in km.', path: ['radiusKm'] });
      if (v.kind === 'point' && v.alert.enabled && v.radiusKm === null) ctx2.addIssue({ code: 'custom', message: 'Alerts for a point need an alert radius in km.', path: ['radiusKm'] });
    }
  });

  app.get('/api/map/places', route((_req, _res, clientId) => ({ items: places.list(clientId) })));
  app.post('/api/map/places', route((req, res, clientId) => {
    const input = placeInput.parse(req.body);
    if (places.list(clientId).length >= 100) throw new ValidationError('At most 100 saved places are allowed.');
    const created = places.create(clientId, input, clock().toISOString());
    publish('map-updated', {});
    res.status(201).json(created);
    return undefined;
  }));
  app.put('/api/map/places/:id', route((req, _res, clientId) => {
    const updated = places.update(clientId, String(req.params.id), placeInput.parse(req.body), clock().toISOString());
    if (!updated) throw new NotFoundError('Place not found.');
    publish('map-updated', {});
    return updated;
  }));
  app.delete('/api/map/places/:id', route((req, _res, clientId) => {
    if (!places.remove(clientId, String(req.params.id))) throw new NotFoundError('Place not found.');
    publish('map-updated', {});
    return { ok: true };
  }));

  void GEO_SOURCES; void MAX_FEATURES;
}
