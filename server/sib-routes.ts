import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError, type AnalysisStore } from './analysis-store';
import { buildAllItems } from './feed-service';
import type { SourceStore } from './source-store';
import { SIB_ID_PATTERN, type SibStore } from './sib-store';
import { countryName, isKnownCountryCode } from '../src/data/countries';
import { SEVERITIES, SEVERITY_RANK, type FeedItemDto } from '../src/data/feedTypes';
import {
  COUNTRY_RATING_TO_SEVERITY, EMPTY_FIELDS, SIB_CLASSIFICATIONS,
  type SibDetail, type SibEvidence, type SibFields, type SibRecord, type SibSourceRef, type SibSourceState,
} from '../src/data/sibTypes';
import { COUNTRY_CATEGORIES, RATING_RANK, type AssessmentVersion, type IncidentDetail } from '../src/data/workspaceTypes';

type Deps = {
  app: Express;
  /** Needed for bulletins drafted from selected reports. */
  store?: SourceStore;
  analysis: AnalysisStore;
  sibs: SibStore;
  requireClientId: (req: Request, res: Response) => string | null;
  publish: (event: string, payload: unknown) => void;
  now?: () => Date;
};

type Prefill = { fields: SibFields; source: SibSourceRef; evidence: SibEvidence[] };

const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'date not recorded' : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Starting text for a bulletin from an incident. Only what the incident records is copied; the employee impact stays empty
 * for the analyst because incidents do not record it.
 */
export function prefillFromIncident(incident: IncidentDetail): Prefill {
  const operational = incident.impacts.filter((impact) => impact.area === 'Operational' || impact.area === 'Business').map((impact) => impact.text);
  const other = incident.impacts.filter((impact) => impact.area === 'Human rights' || impact.area === 'Other').map((impact) => `${impact.area}: ${impact.text}`);
  const reports = incident.evidence.slice(0, 8).map((link) => `- ${link.source}, ${day(link.publishedAt)}: ${link.headline}`);
  const situation = [
    reports.length > 0 ? `Reporting linked to this incident (newest first):\n${reports.join('\n')}` : '',
    incident.severityRationale.trim() ? `Severity rationale: ${incident.severityRationale.trim()}` : '',
    other.length > 0 ? `Other recorded impacts:\n${other.map((line) => `- ${line}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    fields: {
      ...EMPTY_FIELDS,
      title: incident.title,
      severity: incident.severity,
      location: incident.locationText || incident.countries.map((country) => country.name).join(', '),
      summary: incident.summary,
      situation,
      operationsImpact: operational.join('\n'),
      assets: incident.assets.map((asset) => `${asset.kind}: ${asset.name}${asset.notes ? ` (${asset.notes})` : ''}`),
      actions: incident.actions.filter((action) => action.status === 'Open').map((action) => `${action.text}${action.owner ? ` (owner: ${action.owner})` : ''}${action.dueDate ? ` (due ${action.dueDate})` : ''}`),
    },
    source: { type: 'incident', id: incident.id, label: `Incident ${incident.id}` },
    evidence: incident.evidence.map((link) => ({ headline: link.headline, url: link.url || null, source: link.source || null, publishedAt: link.publishedAt || null })),
  };
}

/** Starting text for a bulletin drafted from selected feed reports. Only what the reports state is copied. */
export function prefillFromReports(items: FeedItemDto[], ids: string[]): Prefill {
  const first = items[0];
  const top = [...items].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
  const countryNames = [...new Set(items.flatMap((item) => item.countries.filter((c) => c.code !== 'GLOBAL' && c.code !== 'UNKNOWN').map((c) => c.name)))];
  const lines = items.slice(0, 8).map((item) => `- ${item.source}, ${day(item.publishedAt)}: ${item.headline}`);
  return {
    fields: {
      ...EMPTY_FIELDS,
      title: `${first.headline}${items.length > 1 ? ` (and ${items.length - 1} more)` : ''}`.slice(0, 200),
      severity: top.severity,
      location: countryNames.join(', '),
      summary: first.summary.slice(0, 4000),
      situation: `Reports selected for this bulletin (newest first):\n${lines.join('\n')}`,
    },
    source: { type: 'reports', ids, label: `${items.length} selected report${items.length === 1 ? '' : 's'}` },
    evidence: items.map((item) => ({ headline: item.headline, url: item.url || null, source: item.source || null, publishedAt: item.publishedAt })),
  };
}

/** Starting text for a bulletin from a saved country assessment. */
export function prefillFromAssessment(code: string, version: AssessmentVersion): Prefill {
  const name = countryName(code);
  const rated = COUNTRY_CATEGORIES.map((category) => ({ category, entry: version.categories[category.id] })).filter(({ entry }) => entry && entry.rating !== 'Unassessed');
  const top = rated.reduce<string | null>((best, { entry }) => (best === null || RATING_RANK[entry.rating as keyof typeof RATING_RANK] > RATING_RANK[best as keyof typeof RATING_RANK] ? entry.rating : best), null);
  const situation = rated.map(({ category, entry }) => `${category.label}: ${entry.rating} (${entry.confidence} confidence)${entry.rationale.trim() ? `. ${entry.rationale.trim()}` : ''}`).join('\n');
  return {
    fields: {
      ...EMPTY_FIELDS,
      title: `${name}: security assessment update`,
      severity: top ? COUNTRY_RATING_TO_SEVERITY[top] ?? 'Unassessed' : 'Unassessed',
      location: name,
      summary: version.summary,
      situation,
    },
    source: { type: 'country', code, version: version.version, label: `${name} assessment, version ${version.version}` },
    evidence: version.evidence.map((item) => ({ headline: item.label, url: item.url, source: item.source, publishedAt: item.eventTime })),
  };
}

const fieldSchema = {
  title: z.string().max(200), classification: z.enum(SIB_CLASSIFICATIONS), severity: z.enum(SEVERITIES), location: z.string().max(200),
  summary: z.string().max(4000), situation: z.string().max(8000), employeeImpact: z.string().max(4000), operationsImpact: z.string().max(4000),
  assets: z.array(z.string().max(300)).max(30), actions: z.array(z.string().max(500)).max(30),
  uncertainties: z.string().max(3000), nextReviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
};

/** Reports a bulletin source refers to, newest first; throws when any no longer exists. */
export function reportsFor(store: SourceStore, clientId: string, ids: string[]): FeedItemDto[] {
  const byId = new Map(buildAllItems(store, clientId).map((item) => [item.id, item]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new NotFoundError('One or more of the selected reports no longer exist.');
  return ids.map((id) => byId.get(id)!).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function actorOf(req: Request, clientId: string) {
  const name = (req.header('x-analyst-name') ?? '').replace(/[^\p{L}\p{N} .'_-]/gu, '').trim().slice(0, 60);
  return { name: name || `Browser ${clientId.slice(0, 6)}`, named: Boolean(name) };
}

export function registerSibRoutes(deps: Deps) {
  const { app, analysis, sibs, requireClientId, publish, store } = deps;
  const clock = () => (deps.now?.() ?? new Date()).toISOString();

  const route = (handler: (req: Request, res: Response, clientId: string, actor: { name: string; named: boolean }) => unknown) => (req: Request, res: Response) => {
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
        console.error('SIB request failed', error);
        res.status(500).json({ error: 'The request could not be completed.' });
      }
    }
  };
  const sibId = (req: Request) => {
    const id = String(req.params.id ?? '');
    if (!SIB_ID_PATTERN.test(id)) throw new NotFoundError('That bulletin does not exist.');
    return id;
  };
  const changed = () => publish('workspace-updated', { kind: 'sibs' });

  function currentPrefill(clientId: string, source: SibSourceRef): Prefill {
    if (source.type === 'incident') return prefillFromIncident(analysis.getIncident(clientId, source.id));
    if (source.type === 'reports') {
      if (!store) throw new ValidationError('Bulletins from reports are not available here.');
      return prefillFromReports(reportsFor(store, clientId, source.ids), source.ids);
    }
    const latest = analysis.latestAssessments(clientId).get(source.code);
    if (!latest) throw new NotFoundError(`There is no saved assessment for ${countryName(source.code)}. Save one in Country Assessments first.`);
    return prefillFromAssessment(source.code, latest);
  }

  function sourceState(clientId: string, sib: SibRecord): SibSourceState {
    try {
      if (sib.source.type === 'incident') return analysis.getIncident(clientId, sib.source.id).updatedAt > sib.snapshotAt ? 'changed' : 'current';
      if (sib.source.type === 'reports') {
        if (!store) return 'current';
        reportsFor(store, clientId, sib.source.ids);
        return 'current';
      }
      const latest = analysis.latestAssessments(clientId).get(sib.source.code);
      if (!latest) return 'missing';
      return latest.version > sib.source.version ? 'changed' : 'current';
    } catch (error) {
      if (error instanceof NotFoundError) return 'missing';
      throw error;
    }
  }

  const detail = (clientId: string, sib: SibRecord): SibDetail => ({ ...sib, sourceState: sourceState(clientId, sib), audit: sibs.auditFor(clientId, sib.id) });

  app.get('/api/workspace/sibs', route((_req, _res, clientId) => {
    const items = sibs.list(clientId);
    return { items, total: items.length };
  }));

  app.post('/api/workspace/sibs', route((req, res, clientId, actor) => {
    const body = z.object({
      source: z.discriminatedUnion('type', [
        z.object({ type: z.literal('incident'), id: z.string().regex(/^INC-[A-Z0-9-]{4,16}$/) }),
        z.object({ type: z.literal('country'), code: z.string().max(8) }),
        z.object({ type: z.literal('reports'), ids: z.array(z.string().min(1).max(2048)).min(1).max(8) }),
      ]),
    }).parse(req.body);
    if (body.source.type === 'country' && !isKnownCountryCode(body.source.code.toUpperCase())) throw new NotFoundError('Unknown country.');
    const ref: SibSourceRef = body.source.type === 'incident'
      ? { type: 'incident', id: body.source.id, label: '' }
      : body.source.type === 'reports'
        ? { type: 'reports', ids: body.source.ids, label: '' }
        : { type: 'country', code: body.source.code.toUpperCase(), label: '', version: 0 };
    const prefill = currentPrefill(clientId, ref);
    const created = sibs.create(clientId, actor.name, prefill, clock());
    changed();
    res.status(201).json(detail(clientId, created));
    return undefined;
  }));

  app.get('/api/workspace/sibs/:id', route((req, _res, clientId) => {
    const sib = sibs.get(clientId, sibId(req));
    if (!sib) throw new NotFoundError('That bulletin does not exist.');
    return detail(clientId, sib);
  }));

  app.patch('/api/workspace/sibs/:id', route((req, _res, clientId, actor) => {
    const patch = z.object(fieldSchema).partial().strict().parse(req.body) as Partial<SibFields>;
    if (patch.actions) patch.actions = patch.actions.map((entry) => entry.trim()).filter(Boolean);
    if (patch.assets) patch.assets = patch.assets.map((entry) => entry.trim()).filter(Boolean);
    const updated = sibs.update(clientId, actor.name, sibId(req), patch, clock());
    changed();
    return detail(clientId, updated);
  }));

  app.post('/api/workspace/sibs/:id/approve', route((req, _res, clientId, actor) => {
    // There are no user accounts: the approver is the analyst name set in this browser. Without one the approval would be anonymous.
    if (!actor.named) throw new ValidationError('Set your analyst name (the circle at the top right) before approving, so the approval records who gave it.');
    const approved = sibs.approve(clientId, actor.name, sibId(req), clock());
    changed();
    return detail(clientId, approved);
  }));

  app.post('/api/workspace/sibs/:id/confirm-ai', route((req, _res, clientId, actor) => {
    if (!actor.named) throw new ValidationError('Set your analyst name (the circle at the top right) before confirming, so the confirmation records who gave it.');
    const confirmed = sibs.confirmAi(clientId, actor.name, sibId(req), clock());
    changed();
    return detail(clientId, confirmed);
  }));

  app.post('/api/workspace/sibs/:id/reopen', route((req, _res, clientId, actor) => {
    const reopened = sibs.reopen(clientId, actor.name, sibId(req), clock());
    changed();
    return detail(clientId, reopened);
  }));

  app.post('/api/workspace/sibs/:id/refresh-sources', route((req, _res, clientId, actor) => {
    const id = sibId(req);
    const sib = sibs.get(clientId, id);
    if (!sib) throw new NotFoundError('That bulletin does not exist.');
    const prefill = currentPrefill(clientId, sib.source);
    const updated = sibs.refreshEvidence(clientId, actor.name, id, prefill.source, prefill.evidence, clock());
    changed();
    return detail(clientId, updated);
  }));

  app.delete('/api/workspace/sibs/:id', route((req, _res, clientId) => {
    sibs.remove(clientId, sibId(req));
    changed();
    return { ok: true };
  }));
}
