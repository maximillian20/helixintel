import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError, type AnalysisStore } from './analysis-store';
import { CATALOG, catalogById, searchCatalog } from './market-catalog';
import { MARKET_CATEGORIES } from './market-links';
import { PROVIDERS } from './market-providers';
import { MIN_CORR_NONZERO, MIN_CORR_OBS, MIN_OBSERVED, MIN_PRELIMINARY, assetChart, associations, correlations, eventView, findEvent, listEvents, withStatus, type MarketDeps } from './market-service';
import type { MarketStore } from './market-store';
import type { SourceStore } from './source-store';
import { SEVERITIES } from '../src/data/feedTypes';
import type { MarketAlertSettings, ProviderInfo } from '../src/data/marketTypes';

type Deps = {
  app: Express;
  store: SourceStore;
  analysis: AnalysisStore;
  market: MarketStore;
  requireClientId: (req: Request, res: Response) => string | null;
  publish: (event: string, payload: unknown) => void;
  /** Starts a background sync soon; never awaited by a request. */
  kick: () => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

const short = (max: number) => z.string().max(max);

export function registerMarketRoutes(deps: Deps) {
  const { app, market, requireClientId, publish } = deps;
  const clock = () => deps.now?.() ?? new Date();
  const env = () => deps.env ?? process.env;
  const ctx = (): MarketDeps => ({ store: deps.store, analysis: deps.analysis, market, env: env(), now: clock() });
  const actorOf = (req: Request, clientId: string) => {
    const name = (req.header('x-analyst-name') ?? '').replace(/[^\p{L}\p{N} .'_-]/gu, '').trim().slice(0, 60);
    return name || `Browser ${clientId.slice(0, 6)}`;
  };

  const route = (handler: (req: Request, res: Response, clientId: string, actor: string) => unknown) => (req: Request, res: Response) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    try {
      res.set('Cache-Control', 'no-store');
      const result = handler(req, res, clientId, actorOf(req, clientId));
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError) res.status(404).json({ error: error.message });
      else if (error instanceof ValidationError) res.status(400).json({ error: error.message });
      else if (error instanceof z.ZodError) res.status(400).json({ error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      else { console.error('Market request failed', error); res.status(500).json({ error: 'The request could not be completed.' }); }
    }
  };
  const changed = (kind: string) => publish('market-updated', { kind });
  const assetId = z.string().min(3).max(60).refine((id) => catalogById.has(id), 'Unknown asset');

  app.get('/api/market/meta', route(() => {
    const providers: ProviderInfo[] = PROVIDERS.map((p) => ({ ...p, credential: p.credential ? { ...p.credential, configured: Boolean(env()[p.credential.envVar]?.trim()) } : null }));
    return {
      providers, categories: MARKET_CATEGORIES, severities: SEVERITIES, serverTime: clock().toISOString(),
      thresholds: { preliminary: MIN_PRELIMINARY, observed: MIN_OBSERVED, correlationObservations: MIN_CORR_OBS, correlationEventDays: MIN_CORR_NONZERO },
      method: [
        'Anchor: the earliest public report time among de-duplicated coverage. Event time and retrieval time are kept separately.',
        'Reference price: the close of the last completed bar at or before the anchor (a pre-publication price).',
        'Measured price: the close of the completed bar nearest to anchor + window (never before the publication time). A window is Pending until a bar at or after its end exists. Actual bar times are shown for every figure.',
        'Benchmark-adjusted return: asset return minus benchmark return over the same two bar times (percentage points).',
        'Stocks and indices have daily data only: the 1-hour window is Unsupported for them. Crypto trades 24/7 and has hourly data.',
        'Prices are split- and dividend-adjusted where the provider supplies them (Tiingo); index levels and spot prices are not adjusted.',
        'A price change after a report is an observation, not proof that the report caused it.',
      ],
    };
  }));

  app.get('/api/market/assets', route((req, _res, clientId) => {
    const q = z.object({ q: short(100).optional(), class: z.enum(['stock', 'index', 'crypto']).optional() }).parse(req.query);
    const watched = new Set(market.watched(clientId));
    const found = searchCatalog(q.q ?? '', q.class).slice(0, 40);
    return { items: found.map((entry) => withStatus(ctx(), entry, watched)), total: found.length };
  }));

  app.get('/api/market/watchlist', route((_req, _res, clientId) => {
    const watched = new Set(market.watched(clientId));
    const ids = market.watched(clientId);
    return { items: ids.map((id) => catalogById.get(id)).filter((e): e is NonNullable<typeof e> => Boolean(e)).map((entry) => withStatus(ctx(), entry, watched)), settings: market.getAlertSettings(clientId) };
  }));

  app.post('/api/market/watchlist', route((req, res, clientId) => {
    const { assetId: id } = z.object({ assetId }).parse(req.body);
    market.watch(clientId, id, clock().toISOString());
    deps.kick();
    changed('watchlist');
    res.status(201).json({ ok: true });
    return undefined;
  }));

  app.delete('/api/market/watchlist', route((req, _res, clientId) => {
    const { assetId: id } = z.object({ assetId }).parse(req.query);
    market.unwatch(clientId, id);
    changed('watchlist');
    return { ok: true };
  }));

  app.get('/api/market/alert-settings', route((_req, _res, clientId) => market.getAlertSettings(clientId)));
  app.put('/api/market/alert-settings', route((req, _res, clientId) => {
    const body = z.object({
      linkAlerts: z.boolean(), moveAlerts: z.boolean(), movePct: z.number().min(0.5).max(50), moveWindow: z.enum(['1h', '24h']), cooldownHours: z.number().int().min(1).max(168),
    }).parse(req.body) as MarketAlertSettings;
    market.saveAlertSettings(clientId, body, clock().toISOString());
    changed('alert-settings');
    return body;
  }));

  app.get('/api/market/events', route((req, _res, clientId) => {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(120).optional(), severity: short(20).optional(), category: short(30).optional(), country: short(8).optional(),
      q: short(200).optional(), all: z.enum(['0', '1']).optional(), from: short(10).optional(), to: short(10).optional(),
    }).parse(req.query);
    const { events, total } = listEvents(ctx(), clientId, { ...q, all: q.all === '1' });
    return {
      total,
      items: events.map((e) => ({
        key: e.key, type: e.type, title: e.title, severity: e.severity, category: e.category, countries: e.countries, anchorAt: e.anchorAt, anchorSource: e.anchorSource,
        members: e.members.length, suggestedAssets: e.suggestions.length,
      })),
    };
  }));

  app.get('/api/market/event', route((req, _res, clientId) => {
    const { key } = z.object({ key: short(120).min(3) }).parse(req.query);
    const event = findEvent(ctx(), clientId, key);
    if (!event) throw new NotFoundError('Event not found.');
    return eventView(ctx(), clientId, event);
  }));

  app.put('/api/market/event/link', route((req, _res, clientId, actor) => {
    const body = z.object({ key: short(120), assetId, status: z.enum(['confirmed', 'rejected', 'reset']) }).parse(req.body);
    const event = findEvent(ctx(), clientId, body.key);
    if (!event) throw new NotFoundError('Event not found.');
    const suggestion = event.suggestions.find((s) => s.assetId === body.assetId);
    if (body.status === 'reset') {
      for (const key of [event.key, ...event.memberKeys]) market.deleteLink(clientId, key, body.assetId);
    } else {
      market.setLink(clientId, {
        eventKey: event.key, assetId: body.assetId, status: body.status, origin: suggestion ? 'suggested' : 'user', ruleId: suggestion?.ruleId ?? null,
        explanation: suggestion?.explanation ?? null, updatedAt: clock().toISOString(), updatedBy: actor,
      });
      if (body.status === 'confirmed') deps.kick();
    }
    changed('links');
    return { ok: true };
  }));

  app.get('/api/market/chart', route((req, _res, clientId) => {
    const q = z.object({
      assetId, granularity: z.enum(['1h', '1d']).optional(), from: short(10).optional(), to: short(10).optional(),
      country: short(8).optional(), category: short(30).optional(), severity: short(20).optional(),
    }).parse(req.query);
    const chart = assetChart(ctx(), clientId, q.assetId, q);
    if (!chart) throw new NotFoundError('Unknown asset.');
    return chart;
  }));

  app.get('/api/market/associations', route((req, _res, clientId) => {
    const q = z.object({
      assetId: assetId.optional(), category: short(30).optional(), country: short(8).optional(), window: z.enum(['1h', '24h', '7d']).optional(), dims: short(60).optional(),
    }).parse(req.query);
    const dims = (q.dims ?? '').split(',').filter((d): d is 'category' | 'country' | 'exposure' => ['category', 'country', 'exposure'].includes(d));
    return associations(ctx(), clientId, { ...q, dims });
  }));

  app.get('/api/market/correlations', route((req, _res, clientId) => {
    const q = z.object({ assetId, category: short(30).optional(), country: short(8).optional() }).parse(req.query);
    return { items: correlations(ctx(), clientId, q) };
  }));

  void CATALOG;
}
