import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { AiAuditEntry, AiSettingsDto, AiStatusDto } from '../../src/data/aiTypes';
import { isKnownCountryCode } from '../../src/data/countries';
import { NotFoundError, ValidationError } from '../analysis-store';
import type { MarketStore } from '../market-store';
import { prefillFromAssessment, prefillFromIncident, prefillFromReports, reportsFor } from '../sib-routes';
import type { SibStore } from '../sib-store';
import type { SourceStore } from '../source-store';
import { assistCountry, assistIncident, countryEvidence, incidentEvidence } from './assist';
import { askHelix, scopeSchema } from './ask';
import { generateBriefing } from './briefing';
import type { AiDeps } from './common';
import { enrichReport, enrichmentsFor } from './enrich';
import { explainIndicator, explainMarket } from './explain';
import { parseMapQuery } from './mapquery';
import { relatedToIncident, relatedToReport } from './related';
import { draftSibWithAi, type SibDraftInput } from './sib-draft';
import { AiBusyError, AiCancelledError, AiOutputError, AiPrivacyError, AiTimeoutError, AiUnavailableError } from './service';

type Deps = Omit<AiDeps, 'now'> & {
  app: Express;
  store: SourceStore;
  market: MarketStore;
  sibs: SibStore;
  requireClientId: (req: Request, res: Response) => string | null;
  publish: (event: string, payload: unknown) => void;
  now?: () => Date;
};

const PER_CLIENT_INFLIGHT = 2;
const WINDOW_MS = 10 * 60_000;
const WINDOW_LIMIT = 30;

function actorOf(req: Request, clientId: string) {
  const name = (req.header('x-analyst-name') ?? '').replace(/[^\p{L}\p{N} .'_-]/gu, '').trim().slice(0, 60);
  return { clientId, name: name || `Browser ${clientId.slice(0, 6)}`, named: Boolean(name) };
}

export function registerAiRoutes(deps: Deps) {
  const { app, ai, aiStore, requireClientId, publish } = deps;
  const clock = () => deps.now?.() ?? new Date();
  const base = (): AiDeps => ({ ...deps, now: clock() });
  const inflight = new Map<string, number>();
  const recent = new Map<string, number[]>();

  const statusFor = async (clientId: string, force = false): Promise<AiStatusDto> => {
    const status = await ai.status(force);
    const userEnabled = aiStore.getSettings(clientId).enabled;
    if (!userEnabled && status.state === 'ready') return { ...status, userEnabled, message: 'AI features are switched off for this browser. You can switch them on in the AI settings.' };
    return { ...status, userEnabled };
  };

  /** Generative routes: permission, switch-off, fairness limits, cancellation when the browser goes away, and honest errors. */
  const generative = (handler: (req: Request, res: Response, who: ReturnType<typeof actorOf>, signal: AbortSignal) => Promise<unknown>) => async (req: Request, res: Response) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    res.set('Cache-Control', 'no-store');
    const who = actorOf(req, clientId);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const now = Date.now();
    const times = (recent.get(clientId) ?? []).filter((t) => now - t < WINDOW_MS);
    let counted = false;
    try {
      if (!ai.config.enabled) throw new AiUnavailableError('disabled', 'AI features are switched off on this server.');
      if (!aiStore.getSettings(clientId).enabled) { res.status(403).json({ error: 'AI features are switched off for this browser. Switch them on in the AI settings.', aiState: 'disabled' }); return; }
      if (times.length >= WINDOW_LIMIT) { res.status(429).json({ error: 'That is a lot of AI requests in a short time. Wait a few minutes.' }); return; }
      if ((inflight.get(clientId) ?? 0) >= PER_CLIENT_INFLIGHT) { res.status(429).json({ error: 'You already have AI requests running. Wait for them to finish or cancel one.' }); return; }
      recent.set(clientId, [...times, now]);
      inflight.set(clientId, (inflight.get(clientId) ?? 0) + 1);
      counted = true;
      const result = await handler(req, res, who, controller.signal);
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      if (error instanceof AiUnavailableError) res.status(503).json({ error: error.message, aiState: error.state });
      else if (error instanceof AiPrivacyError) res.status(409).json({ error: error.message, aiState: 'privacy' });
      else if (error instanceof AiBusyError) res.status(429).json({ error: error.message });
      else if (error instanceof AiTimeoutError) res.status(504).json({ error: error.message });
      else if (error instanceof AiOutputError) res.status(502).json({ error: error.message });
      else if (error instanceof AiCancelledError) res.status(499).end();
      else if (error instanceof NotFoundError) res.status(404).json({ error: error.message });
      else if (error instanceof ValidationError) res.status(400).json({ error: error.message });
      else if (error instanceof z.ZodError) res.status(400).json({ error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      else { console.error('AI request failed', error); res.status(500).json({ error: 'The request could not be completed.' }); }
    } finally {
      if (counted) inflight.set(clientId, Math.max(0, (inflight.get(clientId) ?? 1) - 1));
    }
  };

  /** Plain routes (no model call): same client-id check and error mapping. */
  const plain = (handler: (req: Request, res: Response, who: ReturnType<typeof actorOf>) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    res.set('Cache-Control', 'no-store');
    try {
      const result = await handler(req, res, actorOf(req, clientId));
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError) res.status(404).json({ error: error.message });
      else if (error instanceof ValidationError) res.status(400).json({ error: error.message });
      else if (error instanceof z.ZodError) res.status(400).json({ error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      else { console.error('AI request failed', error); res.status(500).json({ error: 'The request could not be completed.' }); }
    }
  };

  // ------------------------------------------------------------ status and settings

  app.get('/api/ai/status', plain(async (req, _res, who) => statusFor(who.clientId, req.query.refresh === 'true')));

  app.get('/api/ai/settings', plain((_req, _res, who) => aiStore.getSettings(who.clientId)));
  app.put('/api/ai/settings', plain((req, _res, who) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      briefing: z.object({ schedule: z.enum(['off', 'daily', 'weekly']), hourUtc: z.number().int().min(0).max(23) }).partial().optional(),
    }).strict().parse(req.body);
    const current = aiStore.getSettings(who.clientId);
    const next: AiSettingsDto = { enabled: body.enabled ?? current.enabled, briefing: { ...current.briefing, ...(body.briefing ?? {}) } };
    aiStore.saveSettings(who.clientId, next, clock().toISOString());
    aiStore.audit(who.clientId, who.name, 'settings', 'AI settings', `AI ${next.enabled ? 'on' : 'off'}; scheduled briefing ${next.briefing.schedule}${next.briefing.schedule === 'off' ? '' : ` at ${String(next.briefing.hourUtc).padStart(2, '0')}:00 UTC`}.`, clock().toISOString());
    return next;
  }));

  // ------------------------------------------------------------ ask, summaries, related

  app.post('/api/ai/ask', generative(async (req, _res, who, signal) => {
    const body = z.object({ question: z.string().trim().min(3).max(400), scope: scopeSchema.optional(), refresh: z.boolean().optional() }).strict().parse(req.body);
    if (body.scope?.country && !isKnownCountryCode(body.scope.country.toUpperCase())) throw new ValidationError('Unknown country.');
    const scope = body.scope ? { ...body.scope, country: body.scope.country?.toUpperCase() } : undefined;
    return askHelix(base(), who, { question: body.question, scope, refresh: body.refresh }, signal);
  }));

  app.post('/api/ai/enrich', generative(async (req, _res, who, signal) => {
    const body = z.object({ articleId: z.string().min(1).max(2048), force: z.boolean().optional() }).strict().parse(req.body);
    return enrichReport(base(), who, body.articleId, { force: body.force, signal });
  }));
  app.get('/api/ai/enrichment', plain((req, _res, who) => {
    const { ids } = z.object({ ids: z.string().max(8000) }).parse(req.query);
    return { items: enrichmentsFor(base(), who.clientId, ids.split(',').filter(Boolean)) };
  }));
  app.post('/api/ai/enrichment/dismiss', plain((req, _res, who) => {
    const body = z.object({ articleId: z.string().min(1).max(2048), dismissed: z.boolean() }).strict().parse(req.body);
    if (body.dismissed) aiStore.dismissEnrichment(who.clientId, body.articleId, clock().toISOString());
    else aiStore.restoreEnrichment(who.clientId, body.articleId);
    aiStore.audit(who.clientId, who.name, body.dismissed ? 'dismiss-summary' : 'restore-summary', body.articleId, 'AI summary hidden for this browser only.', clock().toISOString());
    return { ok: true };
  }));

  app.get('/api/ai/related', plain((req, _res, who) => {
    const q = z.object({ articleId: z.string().max(2048).optional(), incidentId: z.string().regex(/^INC-[A-Z0-9-]{4,16}$/).optional() }).parse(req.query);
    if (q.incidentId) return { items: relatedToIncident(base(), who.clientId, q.incidentId), basis: 'Matched by country, time, event type, shared names and wording. Nothing is linked until you accept it.' };
    if (q.articleId) return { items: relatedToReport(base(), who.clientId, q.articleId), basis: 'Matched by country, time, event type, shared names and wording. Nothing is merged or linked until you do it.' };
    throw new ValidationError('Provide articleId or incidentId.');
  }));
  app.post('/api/ai/related/dismiss', plain((req, _res, who) => {
    const body = z.object({ subject: z.string().max(2100), target: z.string().max(2100) }).strict().parse(req.body);
    aiStore.dismissRelated(who.clientId, body.subject, body.target, clock().toISOString());
    aiStore.audit(who.clientId, who.name, 'dismiss-related', body.subject, `Dismissed ${body.target}.`, clock().toISOString());
    return { ok: true };
  }));

  // ------------------------------------------------------------ assessments, bulletins, briefings

  app.post('/api/ai/incidents/:id/assist', generative(async (req, _res, who, signal) => {
    const id = z.string().regex(/^INC-[A-Z0-9-]{4,16}$/).parse(req.params.id);
    const { refresh } = z.object({ refresh: z.boolean().optional() }).strict().parse(req.body ?? {});
    return assistIncident(base(), who, id, { refresh, signal });
  }));
  app.post('/api/ai/countries/:code/assist', generative(async (req, _res, who, signal) => {
    const code = String(req.params.code ?? '').toUpperCase();
    if (!isKnownCountryCode(code)) throw new NotFoundError('Unknown country.');
    const { refresh } = z.object({ refresh: z.boolean().optional() }).strict().parse(req.body ?? {});
    return assistCountry(base(), who, code, { refresh, signal });
  }));

  app.post('/api/ai/sibs', generative(async (req, res, who, signal) => {
    const body = z.object({
      source: z.discriminatedUnion('type', [
        z.object({ type: z.literal('incident'), id: z.string().regex(/^INC-[A-Z0-9-]{4,16}$/) }),
        z.object({ type: z.literal('country'), code: z.string().max(8) }),
        z.object({ type: z.literal('reports'), ids: z.array(z.string().min(1).max(2048)).min(1).max(8) }),
      ]),
    }).strict().parse(req.body);
    const input: SibDraftInput = body.source.type === 'country' ? { type: 'country', code: body.source.code.toUpperCase() } : body.source;
    if (input.type === 'country' && !isKnownCountryCode(input.code)) throw new NotFoundError('Unknown country.');
    const d = base();
    const { sib, output } = await draftSibWithAi({
      ...d, sibs: deps.sibs,
      prefill: (clientId, source) => {
        if (source.type === 'incident') {
          const detail = deps.analysis.getIncident(clientId, source.id);
          return { prefill: prefillFromIncident(detail), built: incidentEvidence(d, clientId, detail) };
        }
        if (source.type === 'country') {
          const latest = deps.analysis.latestAssessments(clientId).get(source.code);
          if (!latest) throw new NotFoundError('There is no saved assessment for that country. Save one in Country Assessments first.');
          return { prefill: prefillFromAssessment(source.code, latest), built: countryEvidence(d, clientId, source.code) };
        }
        const items = reportsFor(deps.store, clientId, source.ids);
        return { prefill: prefillFromReports(items, source.ids), reports: items };
      },
    }, who, input, signal);
    publish('workspace-updated', { kind: 'sibs' });
    res.status(201).json({ sibId: sib.id, outputId: output.id, status: sib.status, message: 'A draft bulletin was created. It is not approved and has not been sent.' });
    return undefined;
  }));

  app.post('/api/ai/briefing', generative(async (_req, _res, who, signal) => {
    const result = await generateBriefing(base(), who, { signal });
    if (result.generated) publish('workspace-updated', { kind: 'ai' });
    return { generated: result.generated, message: result.message, reviewCount: result.reviewCount, answer: result.answer };
  }));

  // ------------------------------------------------------------ analysis helpers

  app.post('/api/ai/indicators/explain', generative(async (req, _res, who, signal) => {
    const body = z.object({ indicatorId: z.string().max(60), geo: z.string().max(8).default('ALL'), refresh: z.boolean().optional() }).strict().parse(req.body);
    const geo = body.geo.toUpperCase();
    if (geo !== 'ALL' && !isKnownCountryCode(geo)) throw new ValidationError('Unknown country.');
    return explainIndicator(base(), who, { indicatorId: body.indicatorId, geo }, { refresh: body.refresh, signal });
  }));
  app.post('/api/ai/market/explain', generative(async (req, _res, who, signal) => {
    const body = z.object({ eventKey: z.string().min(3).max(120), assetId: z.string().max(60).optional(), refresh: z.boolean().optional() }).strict().parse(req.body);
    return explainMarket({ ...base(), market: deps.market }, who, { eventKey: body.eventKey, assetId: body.assetId }, { refresh: body.refresh, signal });
  }));
  app.post('/api/ai/map/query', plain(async (req, res, who) => {
    const { text } = z.object({ text: z.string().trim().min(2).max(240) }).strict().parse(req.body);
    const settings = aiStore.getSettings(who.clientId);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const result = await parseMapQuery(ai.config.enabled && settings.enabled ? ai : null, text, clock(), controller.signal);
    aiStore.audit(who.clientId, who.name, 'map-query', text.slice(0, 120), `${result.method}: ${result.understood.length} filters understood.`, clock().toISOString());
    return result;
  }));

  // ------------------------------------------------------------ history and audit

  app.get('/api/ai/outputs', plain((req, _res, who) => {
    const q = z.object({ includeDismissed: z.enum(['true', 'false']).default('false'), limit: z.coerce.number().int().min(1).max(100).default(40) }).parse(req.query);
    return { items: aiStore.listOutputs(who.clientId, q.limit, q.includeDismissed === 'true') };
  }));
  app.get('/api/ai/outputs/:id', plain((req, _res, who) => {
    const id = z.string().regex(/^AI-[A-F0-9]{10}$/).parse(req.params.id);
    const output = aiStore.getOutput(who.clientId, id);
    if (!output) throw new NotFoundError('That AI result does not exist.');
    return output;
  }));
  app.post('/api/ai/outputs/:id/dismiss', plain((req, _res, who) => {
    const id = z.string().regex(/^AI-[A-F0-9]{10}$/).parse(req.params.id);
    const { dismissed } = z.object({ dismissed: z.boolean() }).strict().parse(req.body);
    if (!aiStore.setOutputStatus(who.clientId, id, dismissed ? 'dismissed' : 'active')) throw new NotFoundError('That AI result does not exist.');
    aiStore.audit(who.clientId, who.name, dismissed ? 'dismiss-result' : 'restore-result', id, 'Result hidden from your history; it was not deleted.', clock().toISOString());
    return { ok: true };
  }));
  app.get('/api/ai/audit', plain((_req, _res, who): { items: AiAuditEntry[] } => ({ items: aiStore.auditFor(who.clientId, 100) })));
}
