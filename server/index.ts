import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SourceFetchError } from './rss';
import { buildSources, fetchSource, missingCredentials } from './connectors';
import { buildFeedPage, buildOverview, ensureAssessments, updateItemState } from './feed-service';
import { isKnownCountryCode } from '../src/data/countries';
import { REVIEW_STATUSES, SEVERITIES, type FeedFilters } from '../src/data/feedTypes';
import { AnalysisStore } from './analysis-store';
import { runAlertEvaluation } from './alerts';
import { registerWorkspaceRoutes } from './workspace-routes';
import { MarketStore } from './market-store';
import { registerMarketRoutes } from './market-routes';
import { registerMapRoutes } from './map-routes';
import { GeoStore, syncAllGeo } from './map-geo';
import { AdsbClient } from './map-adsb';
import { PlaceStore, evaluatePlaceAlerts } from './map-service';
import { SibStore } from './sib-store';
import { registerSibRoutes } from './sib-routes';
import { runMarketSync } from './market-sync';
import { captureReportSnapshots, clearEventCache, evaluateMarketAlerts } from './market-service';
import { SourceStore, type SourceDefinition, type StoredArticle, type SyncState } from './source-store';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3001);
const defaultPollIntervalMs = 15 * 60 * 1000;
const minPollIntervalMs = 60 * 1000;
const maxPollIntervalMs = 24 * 60 * 60 * 1000;
const pollIntervalMs = Math.min(
  maxPollIntervalMs,
  Math.max(minPollIntervalMs, Number(process.env.SOURCE_POLL_INTERVAL_MS) || defaultPollIntervalMs),
);
const maxRetryDelayMs = 6 * 60 * 60 * 1000;
const manualCheckCooldownMs = 60 * 1000;
const publicSources: SourceDefinition[] = buildSources(pollIntervalMs);

const sourceStore = new SourceStore();
const analysisStore = new AnalysisStore(sourceStore.handle);
const marketStore = new MarketStore(sourceStore.handle);
const geoStore = new GeoStore(sourceStore.handle);
const placeStore = new PlaceStore(sourceStore.handle);
const sibStore = new SibStore(sourceStore.handle);
const adsbClient = new AdsbClient(process.env, fetch, () => new Date());
let geoBusy = false;
let marketTimer: NodeJS.Timeout | undefined;
let geoTimer: NodeJS.Timeout | undefined;
let marketBusy = false;
const eventClients = new Set<Response>();
const syncOwnerId = `${process.pid}-${randomUUID()}`;
let activeSync: Promise<{ attempted: number; changed: boolean }> | null = null;
let scheduler: NodeJS.Timeout | undefined;

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || process.env.APP_URL || 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  let sameHost = false;
  if (origin) {
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch {
      sameHost = false;
    }
  }
  const allowed = !origin || process.env.NODE_ENV !== 'production' || allowedOrigins.has(origin) || sameHost;
  callback(null, { origin: allowed });
}));
app.use(express.json({ limit: '64kb' }));

function publishEvent(event: string, payload: unknown) {
  const encoded = JSON.stringify(payload);
  for (const client of eventClients) {
    try {
      client.write(`event: ${event}\ndata: ${encoded}\n\n`);
    } catch {
      eventClients.delete(client);
    }
  }
}

function sourceStatus(source: SourceDefinition, state: SyncState | undefined, itemCount: number) {
  const intervalMs = source.intervalMs ?? pollIntervalMs;
  const missing = missingCredentials(source, process.env);
  let status: SyncState['status'] = state?.status ?? 'not_checked';
  if (missing.length > 0) status = 'setup_required';
  // A source that last succeeded long ago is stale even if no later attempt has failed yet.
  else if (status === 'healthy' && state?.lastSuccessAt && Date.now() - Date.parse(state.lastSuccessAt) > 3 * intervalMs) status = 'stale';
  const { credential, ...rest } = source;
  return {
    ...rest,
    status,
    itemCount,
    latestPublishedAt: sourceStore.latestPublished(source.id),
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastCheckedAt: state?.lastCheckedAt ?? null,
    nextRunAt: state?.nextRunAt ?? null,
    lastError: state?.lastError ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    updateMode: 'periodic',
    pollIntervalMs: intervalMs,
    setup: credential
      ? { required: missing.length > 0, envVars: credential.envVars, instructions: credential.instructions, signupUrl: credential.signupUrl }
      : null,
  };
}

function buildFeedResponse(cached: boolean) {
  const records = sourceStore.getRecords();
  const states = new Map(sourceStore.getSyncStates().map((state) => [state.sourceId, state]));
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.sourceId, (counts.get(record.sourceId) ?? 0) + 1);
  const sources = publicSources.map((source) => sourceStatus(source, states.get(source.id), counts.get(source.id) ?? 0));
  const lastUpdatedAt = sources
    .map((source) => source.lastSuccessAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  const publicItems = records.slice(0, 600).map((record: StoredArticle) => ({
    id: record.id,
    sourceRecordId: record.sourceRecordId,
    headline: record.headline,
    summary: record.summary,
    url: record.canonicalUrl,
    source: record.sourceName,
    sourceUrl: record.sourceUrl,
    publishedAt: record.publishedAt,
    sourceModifiedAt: record.sourceModifiedAt,
    retrievedAt: record.retrievedAt,
    lastCheckedAt: record.lastCheckedAt,
    verificationStatus: record.verificationStatus,
    attribution: record.attribution,
  }));
  const active = sources.filter((source) => source.status !== 'setup_required');
  const allFailed = active.length > 0 && active.every((source) => source.status === 'unavailable' || source.status === 'stale');

  return {
    fetchedAt: lastUpdatedAt,
    items: publicItems,
    sources,
    cached,
    stale: sources.some((source) => source.status === 'stale'),
    error: allFailed ? 'All configured public sources are currently unavailable; showing retained data when available.' : undefined,
  };
}

function redact(message: string) {
  let safe = message;
  for (const name of ['EIA_API_KEY', 'ENTSOE_API_TOKEN', 'RELIEFWEB_APPNAME']) {
    const value = process.env[name]?.trim();
    if (value) safe = safe.split(value).join('[redacted]');
  }
  return safe;
}

async function syncOneSource(source: SourceDefinition, force: boolean) {
  if (missingCredentials(source, process.env).length > 0) return false; // "Setup required": never called without credentials
  const currentState = sourceStore.getSyncState(source.id);
  const nowMs = Date.now();
  const intervalMs = source.intervalMs ?? pollIntervalMs;
  if (!force && currentState?.nextRunAt && Date.parse(currentState.nextRunAt) > nowMs) return false;
  if (force && currentState?.lastAttemptAt && nowMs - Date.parse(currentState.lastAttemptAt) < manualCheckCooldownMs) return false;

  const attemptedAt = new Date(nowMs).toISOString();
  try {
    const result = await fetchSource(source, {
      fetcher: fetch,
      env: process.env,
      now: new Date(),
      checkpoint: { etag: currentState?.etag ?? null, lastModified: currentState?.lastModified ?? null },
    });
    const checkedAt = new Date().toISOString();
    const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    if (result.notModified) {
      sourceStore.markNotModified(source.id, checkedAt, nextRunAt, result.etag ?? null, result.lastModified ?? null);
      publishEvent('source-sync-updated', { sourceId: source.id, status: 'healthy', lastCheckedAt: checkedAt });
      return false;
    }

    const changes = sourceStore.saveSuccessfulSync({
      source,
      articles: result.articles,
      checkedAt,
      nextRunAt,
      etag: result.etag ?? null,
      lastModified: result.lastModified ?? null,
    });
    if (changes.newCount > 0 || changes.updatedCount > 0) {
      publishEvent('public-feed-updated', {
        sourceId: source.id,
        lastCheckedAt: checkedAt,
        ...changes,
      });
    }
    publishEvent('source-sync-updated', {
      sourceId: source.id,
      status: 'healthy',
      lastCheckedAt: checkedAt,
      ...changes,
    });
    return changes.newCount > 0 || changes.updatedCount > 0;
  } catch (error) {
    const previousFailures = currentState?.consecutiveFailures ?? 0;
    const exponentialDelay = Math.min(60_000 * (2 ** Math.min(previousFailures + 1, 8)), maxRetryDelayMs);
    const requestedDelay = error instanceof SourceFetchError ? error.retryAfterMs ?? 0 : 0;
    const retryDelay = Math.min(Math.max(exponentialDelay, requestedDelay), maxRetryDelayMs);
    const nextRunAt = new Date(Date.now() + retryDelay).toISOString();
    const failure = sourceStore.markFailure(
      source.id,
      attemptedAt,
      nextRunAt,
      redact(error instanceof Error ? error.message : 'Source request failed.').slice(0, 500),
    );
    console.warn(`[source-sync] ${source.id} ${failure.status}: ${error instanceof Error ? error.message : 'request failed'}`);
    publishEvent('source-sync-updated', {
      sourceId: source.id,
      status: failure.status,
      lastAttemptAt: attemptedAt,
      nextRunAt,
    });
    return false;
  }
}

/** Background market work: freeze new event classifications, fetch due prices, evaluate watchlist alerts. */
async function marketTick() {
  if (marketBusy) return;
  marketBusy = true;
  try {
    const now = () => new Date();
    const deps = { store: sourceStore, analysis: analysisStore, market: marketStore, env: process.env, now: now() };
    clearEventCache();
    captureReportSnapshots(deps);
    // MARKET_SYNC_DISABLED=1 stops price fetching (events, snapshots and alerts keep working on stored prices).
    if (process.env.MARKET_SYNC_DISABLED !== '1') {
      const result = await runMarketSync({ market: marketStore, env: process.env, fetcher: fetch, now });
      if (result.fetched.length > 0) publishEvent('market-updated', { kind: 'prices' });
    }
    const { created } = evaluateMarketAlerts({ ...deps, now: now() });
    if (created > 0) publishEvent('alerts-updated', {});
  } catch (error) {
    console.warn('[market] tick failed', error instanceof Error ? error.message : error);
  } finally {
    marketBusy = false;
  }
}

/** Background map work: incremental USGS/EONET fetches (each source isolated), then saved-area alerts. */
async function geoTick() {
  if (geoBusy) return;
  geoBusy = true;
  try {
    if (process.env.MAP_SYNC_DISABLED !== '1') {
      const changed = await syncAllGeo({ geo: geoStore, env: process.env, fetcher: fetch, now: () => new Date() });
      if (changed) publishEvent('map-updated', {});
    }
    const { created } = evaluatePlaceAlerts({ store: sourceStore, analysis: analysisStore, geo: geoStore, env: process.env, now: new Date() }, placeStore);
    if (created > 0) publishEvent('alerts-updated', {});
  } catch (error) {
    console.warn('[map] tick failed', error instanceof Error ? error.message : error);
  } finally {
    geoBusy = false;
  }
}

function syncSources(force = false) {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const acquired = sourceStore.acquireSyncLease(
      syncOwnerId,
      new Date(),
      new Date(Date.now() + 180000),
    );
    if (!acquired) return { attempted: 0, changed: false };
    try {
      const changed = await Promise.all(publicSources.map((source) => syncOneSource(source, force)));
      try {
        const { created } = runAlertEvaluation(analysisStore, { store: sourceStore, sources: publicSources, env: process.env, now: new Date() });
        if (created > 0) publishEvent('alerts-updated', {});
      } catch (error) {
        console.warn('[alerts] evaluation failed', error instanceof Error ? error.message : error);
      }
      return { attempted: publicSources.length, changed: changed.some(Boolean) };
    } finally {
      sourceStore.releaseSyncLease(syncOwnerId);
    }
  })()
    .finally(() => { activeSync = null; });
  return activeSync;
}

app.get('/api/events', (req: Request, res: Response) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  eventClients.add(res);

  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  const states = sourceStore.getSyncStates();
  res.json({
    status: 'ok',
    mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'live',
    timestamp: new Date().toISOString(),
    sourceSync: {
      scheduler: scheduler ? 'running' : 'stopped',
      pollIntervalMs,
      healthy: states.filter((state) => state.status === 'healthy').length,
      stale: states.filter((state) => state.status === 'stale').length,
      unavailable: states.filter((state) => state.status === 'unavailable').length,
    },
  });
});

app.get('/api/feed/public', async (req: Request, res: Response) => {
  // Only an explicit refresh waits for the sources; normal requests answer from the cache immediately,
  // so one slow or failing source can never delay the page.
  if (req.query.refresh === 'true') {
    const result = await syncSources(true);
    res.json(buildFeedResponse(!result.changed));
    return;
  }
  void syncSources(false);
  res.json(buildFeedResponse(true));
});

app.get('/api/sources', (_req: Request, res: Response) => {
  const states = new Map(sourceStore.getSyncStates().map((state) => [state.sourceId, state]));
  const items = publicSources.map((source) => sourceStatus(
    source,
    states.get(source.id),
    sourceStore.getRecords(source.id).length,
  ));
  res.json({ items, total: items.length });
});

app.get('/api/sources/:id/history', (req: Request, res: Response) => {
  const sourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!sourceId || !publicSources.some((source) => source.id === sourceId)) {
    res.status(404).json({ error: 'Source not found.' });
    return;
  }
  const items = sourceStore.getRecentChanges(sourceId);
  res.json({ items, total: items.length });
});

const clientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

function requireClientId(req: Request, res: Response): string | null {
  const parsed = clientIdSchema.safeParse(req.header('x-client-id'));
  if (!parsed.success) {
    res.status(400).json({ error: 'A valid X-Client-Id header is required.' });
    return null;
  }
  return parsed.data;
}

const feedQuerySchema = z.object({
  severity: z.enum(['All', ...SEVERITIES] as const).default('All'),
  country: z.string().refine((value) => value === 'All' || isKnownCountryCode(value), 'Unknown country code.').default('All'),
  review: z.enum(['All', ...REVIEW_STATUSES] as const).default('All'),
  watchlist: z.enum(['true', 'false']).default('false'),
  q: z.string().max(200).default(''),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});

const feedStateSchema = z.object({
  articleId: z.string().min(1).max(2048),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  watchlisted: z.boolean().optional(),
  severityOverride: z.enum(SEVERITIES).nullable().optional(),
}).refine(
  (value) => value.reviewStatus !== undefined || value.watchlisted !== undefined || value.severityOverride !== undefined,
  { message: 'Provide at least one field to change.' },
);

app.get('/api/feed/overview', (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;
  res.json(buildOverview(sourceStore, clientId));
});

app.get('/api/feed/items', (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;
  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    return;
  }
  const query = parsed.data;
  const filters: FeedFilters = {
    severity: query.severity,
    country: query.country,
    review: query.review,
    watchlistOnly: query.watchlist === 'true',
    search: query.q,
  };
  try {
    res.set('Cache-Control', 'no-store');
    res.json(buildFeedPage(sourceStore, clientId, filters, query.page, query.pageSize));
  } catch (error) {
    console.error('Could not build feed page', error);
    res.status(500).json({ error: 'Could not read the stored reports.' });
  }
});

app.patch('/api/feed/state', (req: Request, res: Response) => {
  const clientId = requireClientId(req, res);
  if (!clientId) return;
  const parsed = feedStateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    return;
  }
  const { articleId, ...patch } = parsed.data;
  try {
    const result = updateItemState(sourceStore, clientId, articleId, patch);
    if (!result) {
      res.status(404).json({ error: 'Report not found.' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    console.error('Could not save report state', error);
    res.status(500).json({ error: 'Could not save the change.' });
  }
});

registerWorkspaceRoutes({
  app, store: sourceStore, analysis: analysisStore, sources: publicSources, requireClientId, publish: publishEvent,
});

registerMarketRoutes({
  app, store: sourceStore, analysis: analysisStore, market: marketStore, requireClientId, publish: publishEvent,
  kick: () => { if (process.env.NODE_ENV !== 'test') setTimeout(() => { void marketTick(); }, 250); },
});

registerSibRoutes({ app, analysis: analysisStore, sibs: sibStore, requireClientId, publish: publishEvent });

registerMapRoutes({
  app, store: sourceStore, analysis: analysisStore, geo: geoStore, places: placeStore, adsb: adsbClient, requireClientId, publish: publishEvent,
});

const distDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
if (process.env.NODE_ENV === 'production' && existsSync(distDirectory)) {
  app.use(express.static(distDirectory, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
    res.sendFile(resolve(distDirectory, 'index.html'));
  });
}

function startBackgroundSync() {
  void syncSources(false);
  scheduler = setInterval(() => { void syncSources(false); }, Math.min(pollIntervalMs, minPollIntervalMs));
  scheduler.unref();
  void marketTick();
  marketTimer = setInterval(() => { void marketTick(); }, 60_000);
  marketTimer.unref();
  void geoTick();
  geoTimer = setInterval(() => { void geoTick(); }, 60_000);
  geoTimer.unref();
}

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, () => {
    console.log(`Global Security Intelligence API listening on http://localhost:${port}`);
    const purged = sourceStore.purgeDemoRecords();
    if (purged > 0) console.log(`Removed ${purged} demo record(s) from an earlier version.`);
    ensureAssessments(sourceStore);
    startBackgroundSync();
  });

  const shutdown = () => {
    if (scheduler) clearInterval(scheduler);
    if (marketTimer) clearInterval(marketTimer);
    if (geoTimer) clearInterval(geoTimer);
    for (const client of eventClients) client.end();
    eventClients.clear();
    server.close(() => {
      sourceStore.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export { app, buildFeedResponse, syncSources, sourceStore, analysisStore };
export default app;
