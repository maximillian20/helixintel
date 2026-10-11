import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analystSummary,
  countryAssessments,
  dashboardMetrics,
  incidents,
  intelligenceFeed,
  priorityIntelligence,
  trendData,
} from '../src/data/demo';
import { z } from 'zod';
import { fetchRssSource, SourceFetchError } from './rss';
import { buildFeedPage, ensureAssessments, updateItemState } from './feed-service';
import { isKnownCountryCode } from '../src/data/countries';
import { REVIEW_STATUSES, SEVERITIES, type FeedFilters } from '../src/data/feedTypes';
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
const publicSources: SourceDefinition[] = [
  {
    id: 'bbc-world',
    name: 'BBC News World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    format: 'RSS 2.0',
    coverage: 'International news, English-language world desk',
    cadence: `${Math.round(pollIntervalMs / 60000)}-minute polling; 15-minute article cache`,
    attribution: 'BBC News World',
    termsUrl: 'https://www.bbc.co.uk/usingthebbc/terms-of-use/#15metadataandrssfeeds',
  },
  {
    id: 'un-news',
    name: 'UN News',
    url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
    format: 'RSS 2.0',
    coverage: 'Global affairs and United Nations reporting, English-language feed',
    cadence: `${Math.round(pollIntervalMs / 60000)}-minute polling; 15-minute article cache`,
    attribution: 'UN News',
    termsUrl: 'https://news.un.org/en/',
  },
];

const sourceStore = new SourceStore();
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
  return {
    ...source,
    status: state?.status ?? 'not_checked',
    itemCount,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastCheckedAt: state?.lastCheckedAt ?? null,
    nextRunAt: state?.nextRunAt ?? null,
    lastError: state?.lastError ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    updateMode: 'periodic',
    pollIntervalMs,
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
  const publicItems = records.slice(0, 250).map((record: StoredArticle) => ({
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
  const allFailed = sources.length > 0 && sources.every((source) => source.status === 'unavailable' || source.status === 'stale');

  return {
    fetchedAt: lastUpdatedAt,
    items: publicItems,
    sources,
    cached,
    stale: sources.some((source) => source.status === 'stale'),
    error: allFailed ? 'All configured public sources are currently unavailable; showing retained data when available.' : undefined,
  };
}

async function syncOneSource(source: SourceDefinition, force: boolean) {
  const currentState = sourceStore.getSyncState(source.id);
  const nowMs = Date.now();
  if (!force && currentState?.nextRunAt && Date.parse(currentState.nextRunAt) > nowMs) return false;
  if (force && currentState?.lastAttemptAt && nowMs - Date.parse(currentState.lastAttemptAt) < manualCheckCooldownMs) return false;

  const attemptedAt = new Date(nowMs).toISOString();
  try {
    const result = await fetchRssSource(source, {
      etag: currentState?.etag ?? null,
      lastModified: currentState?.lastModified ?? null,
    });
    const checkedAt = new Date().toISOString();
    const nextRunAt = new Date(Date.now() + pollIntervalMs).toISOString();
    if (result.notModified) {
      sourceStore.markNotModified(source.id, checkedAt, nextRunAt, result.etag, result.lastModified);
      publishEvent('source-sync-updated', { sourceId: source.id, status: 'healthy', lastCheckedAt: checkedAt });
      return false;
    }

    const changes = sourceStore.saveSuccessfulSync({
      source,
      articles: result.articles,
      checkedAt,
      nextRunAt,
      etag: result.etag,
      lastModified: result.lastModified,
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
      error instanceof Error ? error.message.slice(0, 500) : 'Source request failed.',
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

function syncSources(force = false) {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const acquired = sourceStore.acquireSyncLease(
      syncOwnerId,
      new Date(),
      new Date(Date.now() + 120000),
    );
    if (!acquired) return { attempted: 0, changed: false };
    try {
      const changed = await Promise.all(publicSources.map((source) => syncOneSource(source, force)));
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

app.get('/api/dashboard', (_req: Request, res: Response) => {
  res.json({
    metrics: dashboardMetrics,
    trend: trendData,
    priority: priorityIntelligence,
    summary: analystSummary,
    incidents,
    countries: countryAssessments,
  });
});

app.get('/api/feed', (_req: Request, res: Response) => {
  res.json({ items: intelligenceFeed, total: intelligenceFeed.length, mode: 'demo' });
});

app.get('/api/feed/public', async (req: Request, res: Response) => {
  const result = await syncSources(req.query.refresh === 'true');
  res.json(buildFeedResponse(!result.changed));
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

app.get('/api/incidents', (_req: Request, res: Response) => {
  res.json({ items: incidents, total: incidents.length });
});

app.get('/api/countries', (_req: Request, res: Response) => {
  res.json({ items: countryAssessments, total: countryAssessments.length });
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
}

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, () => {
    console.log(`Global Security Intelligence API listening on http://localhost:${port}`);
    ensureAssessments(sourceStore);
    startBackgroundSync();
  });

  const shutdown = () => {
    if (scheduler) clearInterval(scheduler);
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

export { app, buildFeedResponse, syncSources, sourceStore };
export default app;
