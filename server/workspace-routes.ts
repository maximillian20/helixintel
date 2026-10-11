import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError, similarity, type AnalysisStore, type ReportSnapshot } from './analysis-store';
import { countryAssessmentChangeAlert, runAlertEvaluation } from './alerts';
import { countryDetail, countryDirectory, suggestCategory } from './countries-service';
import { buildAllItems } from './feed-service';
import {
  INDICATORS, activeGeos, computeIndicator, getDefinition, loadIndicatorData, toSummary, CONFIDENCE_POLICY, type IndicatorContext,
} from './indicators';
import type { SourceDefinition, SourceStore } from './source-store';
import { isKnownCountryCode } from '../src/data/countries';
import { SEVERITIES, type FeedItemDto } from '../src/data/feedTypes';
import {
  ASSET_KINDS, CONFIDENCE_LEVELS, COUNTRY_CATEGORIES, IMPACT_AREAS, INCIDENT_STATUSES, RATINGS, SCORING_METHOD,
  type DuplicateSuggestion, type IncidentInput,
} from '../src/data/workspaceTypes';

type Deps = {
  app: Express;
  store: SourceStore;
  analysis: AnalysisStore;
  sources: SourceDefinition[];
  requireClientId: (req: Request, res: Response) => string | null;
  publish: (event: string, payload: unknown) => void;
  now?: () => Date;
};

const text = (max: number) => z.string().max(max);
const articleIds = z.array(z.string().min(1).max(2048)).min(1).max(25);

const incidentFields = {
  title: text(200), summary: text(4000), category: text(100), locationText: text(200),
  lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable(),
  countryCodes: z.array(z.string().max(8)).max(20), severity: z.enum(SEVERITIES), severityRationale: text(2000),
  confidence: z.enum(CONFIDENCE_LEVELS), owner: text(100).nullable(), eventAt: text(40).nullable(),
};

function actorOf(req: Request, clientId: string) {
  const name = (req.header('x-analyst-name') ?? '').replace(/[^\p{L}\p{N} .'_-]/gu, '').trim().slice(0, 60);
  return name || `Browser ${clientId.slice(0, 6)}`;
}

function snapshots(items: FeedItemDto[], ids: string[]): ReportSnapshot[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new NotFoundError('One or more reports no longer exist.');
  return ids.map((id) => {
    const item = byId.get(id)!;
    return { articleId: item.id, headline: item.headline, url: item.url, source: item.source, publishedAt: item.publishedAt };
  });
}

/** Fields that the feed supports; everything else stays empty rather than guessed. */
export function prefillIncident(items: FeedItemDto[]): IncidentInput {
  const first = items[0];
  const codes = [...new Set(items.flatMap((item) => item.countries.map((country) => country.code)))].filter((code) => isKnownCountryCode(code) && code !== 'GLOBAL' && code !== 'UNKNOWN');
  const rank = (severity: string) => SEVERITIES.indexOf(severity as never);
  const top = [...items].sort((a, b) => rank(a.severity) - rank(b.severity))[0];
  const located = items.find((item) => item.location?.precision === 'event');
  const published = items.map((item) => Date.parse(item.publishedAt)).filter((t) => !Number.isNaN(t));
  return {
    title: first.headline.slice(0, 200),
    summary: first.summary.slice(0, 4000),
    category: first.category || first.categoryLabels[0] || '',
    locationText: located?.location?.label ?? '',
    lat: located?.location?.lat ?? null,
    lng: located?.location?.lng ?? null,
    countryCodes: codes,
    severity: top.severity,
    severityRationale: top.severity === 'Unassessed' ? '' : `Pre-filled from the feed's ${top.assessmentMethod === 'manual' ? 'analyst override' : 'automatic assessment'} of "${top.headline}". ${top.severityRationale} Review before relying on it.`.slice(0, 2000),
    confidence: 'Unassessed',
    owner: null,
    eventAt: published.length > 0 ? new Date(Math.min(...published)).toISOString() : null,
  };
}

export function registerWorkspaceRoutes(deps: Deps) {
  const { app, store, analysis, sources, requireClientId, publish } = deps;
  const clock = () => deps.now?.() ?? new Date();
  const context = (): IndicatorContext => ({ store, sources, env: process.env, now: clock() });

  /** Wraps a handler: validates the client id, converts store errors to HTTP statuses. */
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
      else {
        console.error('Workspace request failed', error);
        res.status(500).json({ error: 'The request could not be completed.' });
      }
    }
  };
  const changed = (kind: string) => publish('workspace-updated', { kind });
  const incidentId = (req: Request) => z.string().regex(/^INC-[A-Z0-9-]{4,16}$/).parse(req.params.id);
  const countryCode = (req: Request) => {
    const code = String(req.params.code ?? '').toUpperCase();
    if (!isKnownCountryCode(code)) throw new NotFoundError('Unknown country.');
    return code;
  };

  // ------------------------------------------------------------ incidents

  app.get('/api/workspace/incidents', route((req, _res, clientId) => {
    const query = z.object({
      q: text(200).optional(), country: text(8).optional(), severity: z.enum(SEVERITIES).optional(), status: z.enum(INCIDENT_STATUSES).optional(),
      owner: text(100).optional(), from: text(40).optional(), to: text(40).optional(),
    }).parse(req.query);
    const items = analysis.listIncidents(clientId, query);
    return { items, total: items.length };
  }));

  app.post('/api/workspace/incidents/prefill', route((req, _res, clientId) => {
    const { articleIds: ids } = z.object({ articleIds }).parse(req.body);
    const items = buildAllItems(store, clientId);
    const reports = snapshots(items, ids);
    const input = prefillIncident(ids.map((id) => items.find((item) => item.id === id)!));
    const duplicates: DuplicateSuggestion[] = analysis.suggestDuplicates(clientId, { title: input.title, category: input.category, countryCodes: input.countryCodes, articleIds: ids });
    return { input, reports, duplicates };
  }));

  app.post('/api/workspace/incidents', route((req, res, clientId, actor) => {
    const body = z.object({ articleIds: articleIds.optional(), input: z.object(incidentFields).partial().optional() }).parse(req.body);
    const items = buildAllItems(store, clientId);
    const ids = body.articleIds ?? [];
    const reports = snapshots(items, ids);
    const base = ids.length > 0 ? prefillIncident(ids.map((id) => items.find((item) => item.id === id)!)) : {
      title: '', summary: '', category: '', locationText: '', lat: null, lng: null, countryCodes: [], severity: 'Unassessed' as const,
      severityRationale: '', confidence: 'Unassessed' as const, owner: null, eventAt: null,
    };
    const created = analysis.createIncident(clientId, actor, { ...base, ...body.input }, reports, clock().toISOString());
    changed('incidents');
    res.status(201).json(created);
    return undefined;
  }));

  app.get('/api/workspace/incidents/:id', route((req, _res, clientId) => analysis.getIncident(clientId, incidentId(req))));

  app.patch('/api/workspace/incidents/:id', route((req, _res, clientId, actor) => {
    const patch = z.object({ ...Object.fromEntries(Object.entries(incidentFields).map(([key, schema]) => [key, schema.optional()])), status: z.enum(INCIDENT_STATUSES).optional() })
      .strict().parse(req.body) as Partial<IncidentInput> & { status?: (typeof INCIDENT_STATUSES)[number] };
    const result = analysis.updateIncident(clientId, actor, incidentId(req), patch, clock().toISOString());
    changed('incidents');
    return result;
  }));

  app.post('/api/workspace/incidents/:id/reports', route((req, _res, clientId, actor) => {
    const { articleIds: ids } = z.object({ articleIds }).parse(req.body);
    const reports = snapshots(buildAllItems(store, clientId), ids);
    const result = analysis.linkReports(clientId, actor, incidentId(req), reports, clock().toISOString());
    changed('incidents');
    return result;
  }));

  app.delete('/api/workspace/incidents/:id/reports/:articleId', route((req, _res, clientId, actor) => {
    const result = analysis.unlinkReport(clientId, actor, incidentId(req), String(req.params.articleId), clock().toISOString());
    changed('incidents');
    return result;
  }));

  app.post('/api/workspace/incidents/:id/assets', route((req, res, clientId, actor) => {
    const body = z.object({ kind: z.enum(ASSET_KINDS), name: text(200).min(1), notes: text(1000).default(''), countryCode: text(8).nullable().default(null) }).parse(req.body);
    const result = analysis.addAsset(clientId, actor, incidentId(req), body, clock().toISOString());
    changed('incidents');
    res.status(201).json(result);
    return undefined;
  }));
  app.delete('/api/workspace/incidents/:id/assets/:itemId', route((req, _res, clientId, actor) => {
    const result = analysis.removeAsset(clientId, actor, incidentId(req), Number(req.params.itemId), clock().toISOString());
    changed('incidents');
    return result ?? { ok: true };
  }));
  app.post('/api/workspace/incidents/:id/impacts', route((req, res, clientId, actor) => {
    const body = z.object({ area: z.enum(IMPACT_AREAS), text: text(2000).min(1) }).parse(req.body);
    const result = analysis.addImpact(clientId, actor, incidentId(req), body, clock().toISOString());
    changed('incidents');
    res.status(201).json(result);
    return undefined;
  }));
  app.delete('/api/workspace/incidents/:id/impacts/:itemId', route((req, _res, clientId, actor) => {
    const result = analysis.removeImpact(clientId, actor, incidentId(req), Number(req.params.itemId), clock().toISOString());
    changed('incidents');
    return result ?? { ok: true };
  }));
  app.post('/api/workspace/incidents/:id/actions', route((req, res, clientId, actor) => {
    const body = z.object({ text: text(500).min(1), owner: text(100).nullable().default(null), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }).parse(req.body);
    const result = analysis.addAction(clientId, actor, incidentId(req), body, clock().toISOString());
    changed('incidents');
    res.status(201).json(result);
    return undefined;
  }));
  app.patch('/api/workspace/incidents/:id/actions/:itemId', route((req, _res, clientId, actor) => {
    const body = z.object({ status: z.enum(['Open', 'Done']).optional(), owner: text(100).nullable().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).strict().parse(req.body);
    const result = analysis.updateAction(clientId, actor, incidentId(req), Number(req.params.itemId), body, clock().toISOString());
    changed('incidents');
    return result ?? { ok: true };
  }));
  app.delete('/api/workspace/incidents/:id/actions/:itemId', route((req, _res, clientId, actor) => {
    const result = analysis.removeAction(clientId, actor, incidentId(req), Number(req.params.itemId), clock().toISOString());
    changed('incidents');
    return result ?? { ok: true };
  }));

  app.get('/api/workspace/incidents/:id/duplicates', route((req, _res, clientId) => {
    const incident = analysis.getIncident(clientId, incidentId(req));
    const items = analysis.suggestDuplicates(clientId, {
      title: incident.title, category: incident.category, countryCodes: incident.countries.map((c) => c.code),
      articleIds: incident.evidence.map((link) => link.articleId),
    }, incident.id);
    return { items, basis: 'Possible duplicates for review only: shared report, same country and category updated within 14 days, or a similar title. Nothing is merged automatically.' };
  }));

  /** New reports that may belong to the incident. Shown for review; nothing is linked or changed automatically. */
  app.get('/api/workspace/incidents/:id/suggestions', route((req, _res, clientId) => {
    const incident = analysis.getIncident(clientId, incidentId(req));
    const linked = new Set(incident.evidence.map((link) => link.articleId));
    const dismissed = new Set(analysis.dismissedFor(incident.id));
    const codes = incident.countries.map((country) => country.code);
    const suggestions = buildAllItems(store, clientId)
      .filter((item) => !linked.has(item.id) && !dismissed.has(item.id))
      .map((item) => {
        const reasons: string[] = [];
        const sharedCountry = item.countries.some((country) => codes.includes(country.code));
        const sameCategory = Boolean(incident.category) && (item.category === incident.category || item.categoryLabels.includes(incident.category));
        const titleScore = similarity(incident.title, item.headline);
        if (sharedCountry && sameCategory) reasons.push('Same country and category');
        if (titleScore >= 0.3) reasons.push(`Similar headline (${Math.round(titleScore * 100)}% word overlap)`);
        return { item, reasons, score: (sharedCountry && sameCategory ? 1 : 0) + titleScore };
      })
      .filter((entry) => entry.reasons.length > 0 && Date.parse(entry.item.publishedAt) >= Date.parse(incident.eventAt ?? incident.createdAt) - 2 * 86_400_000)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ item, reasons }) => ({
        articleId: item.id, headline: item.headline, url: item.url, source: item.source, publishedAt: item.publishedAt,
        retrievedAt: item.retrievedAt, severity: item.severity, reasons,
      }));
    return { items: suggestions, basis: 'Suggested by shared country and category or similar headline. Nothing is linked until you accept it, and your assessment is never changed.' };
  }));
  app.post('/api/workspace/incidents/:id/suggestions/dismiss', route((req, _res, clientId) => {
    const { articleId } = z.object({ articleId: z.string().min(1).max(2048) }).parse(req.body);
    analysis.getIncident(clientId, incidentId(req));
    analysis.dismissSuggestion(clientId, incidentId(req), articleId);
    return { ok: true };
  }));

  // ------------------------------------------------------------ countries

  app.get('/api/workspace/countries', route((_req, _res, clientId) => {
    const items = countryDirectory(store, analysis, clientId, clock().getTime());
    return { items, total: items.length, method: SCORING_METHOD, categories: COUNTRY_CATEGORIES, ratings: RATINGS };
  }));
  /** Up to three countries with identical criteria, for side-by-side comparison. Registered before the :code route. */
  app.get('/api/workspace/countries/compare', route((req, _res, clientId) => {
    const { codes } = z.object({ codes: text(60) }).parse(req.query);
    const list = [...new Set(codes.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean))];
    if (list.length < 2 || list.length > 3) throw new ValidationError('Choose two or three countries to compare.');
    const items = list.map((code) => {
      const detail = countryDetail(store, analysis, clientId, code, clock().getTime());
      if (!detail) throw new NotFoundError(`Unknown country ${code}.`);
      return detail;
    });
    return { items };
  }));
  app.get('/api/workspace/countries/:code', route((req, _res, clientId) => {
    const detail = countryDetail(store, analysis, clientId, countryCode(req), clock().getTime());
    if (!detail) throw new NotFoundError('Unknown country.');
    return detail;
  }));
  app.put('/api/workspace/countries/:code/watch', route((req, _res, clientId) => {
    const { watched } = z.object({ watched: z.boolean() }).parse(req.body);
    analysis.setCountryWatch(clientId, countryCode(req), watched, clock().toISOString());
    changed('countries');
    return { watched };
  }));
  app.post('/api/workspace/countries/:code/evidence', route((req, res, clientId, actor) => {
    const code = countryCode(req);
    const body = z.object({
      refType: z.enum(['report', 'incident']), refId: z.string().min(1).max(2048), category: z.enum(COUNTRY_CATEGORIES.map((c) => c.id) as [string, ...string[]]), note: text(500).default(''),
    }).parse(req.body);
    let label: string; let url: string | null = null; let source: string | null = null; let eventTime: string | null;
    if (body.refType === 'report') {
      const item = buildAllItems(store, clientId).find((entry) => entry.id === body.refId);
      if (!item) throw new NotFoundError('Report not found.');
      if (!item.countries.some((country) => country.code === code)) throw new ValidationError('That report does not name this country.');
      ({ headline: label, url, source } = item); eventTime = item.publishedAt;
    } else {
      const incident = analysis.getIncident(clientId, body.refId);
      if (!incident.countries.some((country) => country.code === code)) throw new ValidationError('That incident is not linked to this country.');
      label = incident.title; eventTime = incident.eventAt ?? incident.createdAt; source = 'Incident';
    }
    const result = analysis.addCountryEvidence(clientId, actor, code, { ...body, label, url, source, eventTime }, clock().toISOString());
    changed('countries');
    res.status(201).json(result);
    return undefined;
  }));
  app.delete('/api/workspace/countries/:code/evidence/:itemId', route((req, _res, clientId) => {
    const result = analysis.removeCountryEvidence(clientId, countryCode(req), Number(req.params.itemId));
    changed('countries');
    return result;
  }));
  app.post('/api/workspace/countries/:code/assessments', route((req, res, clientId, actor) => {
    const code = countryCode(req);
    const category = z.object({
      rating: z.enum([...RATINGS, 'Unassessed'] as [string, ...string[]]), rationale: text(2000).default(''),
      confidence: z.enum(CONFIDENCE_LEVELS).default('Unassessed'), evidenceIds: z.array(z.number().int()).max(50).default([]),
    });
    const body = z.object({
      summary: text(4000).default(''), confidence: z.enum(CONFIDENCE_LEVELS).default('Unassessed'),
      categories: z.record(z.enum(COUNTRY_CATEGORIES.map((c) => c.id) as [string, ...string[]]), category),
    }).parse(req.body);
    const nowIso = clock().toISOString();
    const version = analysis.saveCountryAssessment(clientId, actor, code, body as never, nowIso);
    countryAssessmentChangeAlert(analysis, clientId, code, nowIso);
    changed('countries');
    publish('alerts-updated', {});
    res.status(201).json(version);
    return undefined;
  }));
  app.get('/api/workspace/countries/:code/assessments/:version', route((req, _res, clientId) => {
    const version = analysis.getAssessmentVersion(clientId, countryCode(req), Number(req.params.version));
    if (!version) throw new NotFoundError('Version not found.');
    return version;
  }));
  app.get('/api/workspace/category-suggestion', route((req) => {
    const { categories, category } = z.object({ categories: text(300).default(''), category: text(100).default('') }).parse(req.query);
    return suggestCategory(categories.split(',').filter(Boolean), category);
  }));

  // ------------------------------------------------------------ indicators

  const geoParam = (req: Request, perCountry: boolean) => {
    const geo = String(req.query.geo ?? 'ALL').toUpperCase();
    if (geo === 'ALL') return geo;
    if (!perCountry) return 'ALL';
    if (!isKnownCountryCode(geo)) throw new ValidationError('Unknown country.');
    return geo;
  };

  app.get('/api/workspace/indicators', route((_req, _res, clientId) => {
    const ctx = context();
    const data = loadIndicatorData(ctx);
    const watched = analysis.watchedIndicators(clientId);
    const pairs = new Map<string, { id: string; geo: string }>();
    for (const def of INDICATORS) pairs.set(`${def.id}|ALL`, { id: def.id, geo: 'ALL' });
    for (const watch of watched) pairs.set(`${watch.indicatorId}|${watch.geo}`, { id: watch.indicatorId, geo: watch.geo });
    for (const code of activeGeos(data, ctx.now, 5)) {
      for (const def of INDICATORS) if (def.perCountry) pairs.set(`${def.id}|${code}`, { id: def.id, geo: code });
    }
    const items = [...pairs.values()].flatMap(({ id, geo }) => {
      const def = getDefinition(id);
      return def ? [toSummary(computeIndicator(def, geo, analysis.getIndicatorSettings(clientId, id, geo), ctx, data))] : [];
    });
    return { items, confidencePolicy: CONFIDENCE_POLICY, computedAt: ctx.now.toISOString() };
  }));
  app.get('/api/workspace/indicators/:id', route((req, _res, clientId) => {
    const def = getDefinition(String(req.params.id));
    if (!def) throw new NotFoundError('Unknown indicator.');
    const geo = geoParam(req, def.perCountry);
    const ctx = context();
    return computeIndicator(def, geo, analysis.getIndicatorSettings(clientId, def.id, geo), ctx, loadIndicatorData(ctx));
  }));
  app.put('/api/workspace/indicators/:id/settings', route((req, _res, clientId) => {
    const def = getDefinition(String(req.params.id));
    if (!def) throw new NotFoundError('Unknown indicator.');
    const geo = geoParam(req, def.perCountry);
    const patch = z.object({
      mode: z.enum(['auto', 'fixed']).optional(), warn: z.number().min(0).nullable().optional(), alert: z.number().min(0).nullable().optional(),
      minCount: z.number().int().optional(), cooldownHours: z.number().int().optional(), watched: z.boolean().optional(),
    }).strict().parse(req.body);
    const settings = analysis.saveIndicatorSettings(clientId, def.id, geo, patch, clock().toISOString());
    const ctx = context();
    const reading = computeIndicator(def, geo, settings, ctx, loadIndicatorData(ctx));
    changed('indicators');
    return reading;
  }));

  // ------------------------------------------------------------ alerts

  app.get('/api/workspace/alerts', route((_req, _res, clientId) => analysis.listAlerts(clientId)));
  app.post('/api/workspace/alerts/read', route((req, _res, clientId) => {
    const body = z.object({ ids: z.union([z.literal('all'), z.array(z.number().int()).max(200)]) }).parse(req.body);
    analysis.markAlertsRead(clientId, body.ids, clock().toISOString());
    return analysis.listAlerts(clientId);
  }));
  app.post('/api/workspace/alerts/evaluate', route((_req, _res, clientId) => {
    // Evaluates only this workspace, so a user cannot trigger work on behalf of others.
    const ctx = context();
    const { created } = runAlertEvaluation(analysis, ctx, clientId);
    if (created > 0) publish('alerts-updated', {});
    return { created, ...analysis.listAlerts(clientId) };
  }));
}
