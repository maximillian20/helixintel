import { randomUUID } from 'node:crypto';
import { countryName, isKnownCountryCode } from '../src/data/countries';
import { SEVERITIES, type Severity } from '../src/data/feedTypes';
import {
  ASSET_KINDS,
  CONFIDENCE_LEVELS,
  COUNTRY_CATEGORIES,
  IMPACT_AREAS,
  INCIDENT_STATUSES,
  RATINGS,
  RATING_RANK,
  type AlertDto,
  type AssessmentVersion,
  type AuditEntry,
  type CategoryAssessment,
  type CategoryTrend,
  type Confidence,
  type CountryCategoryId,
  type CountryEvidence,
  type DuplicateSuggestion,
  type EvidenceLink,
  type IncidentAction,
  type IncidentAsset,
  type IncidentDetail,
  type IncidentImpact,
  type IncidentInput,
  type IncidentStatus,
  type IncidentSummary,
  type Rating,
  type Trend,
  type IndicatorSettings,
} from '../src/data/workspaceTypes';
import type { DatabaseHandle } from './source-store';

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

type Row = Record<string, unknown>;
const str = (value: unknown) => String(value ?? '');
const optStr = (value: unknown) => (value === null || value === undefined ? null : String(value));
const optNum = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const asSeverity = (value: unknown): Severity => SEVERITIES.find((item) => item === value) ?? 'Unassessed';
const asConfidence = (value: unknown): Confidence => CONFIDENCE_LEVELS.find((item) => item === value) ?? 'Unassessed';
const asStatus = (value: unknown): IncidentStatus => INCIDENT_STATUSES.find((item) => item === value) ?? 'New';

function tokens(text: string) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 3));
}
export function similarity(a: string, b: string) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

const emptyCategories = (): Record<CountryCategoryId, CategoryAssessment> => Object.fromEntries(
  COUNTRY_CATEGORIES.map((category) => [category.id, { rating: 'Unassessed', rationale: '', confidence: 'Unassessed', evidenceIds: [] }]),
) as unknown as Record<CountryCategoryId, CategoryAssessment>;

export type IncidentFilters = {
  q?: string;
  country?: string;
  severity?: string;
  status?: string;
  owner?: string;
  from?: string;
  to?: string;
};

export type ReportSnapshot = { articleId: string; headline: string; url: string; source: string; publishedAt: string };

export class AnalysisStore {
  constructor(private readonly db: DatabaseHandle) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '', location_text TEXT NOT NULL DEFAULT '', lat REAL, lng REAL,
        country_codes_json TEXT NOT NULL DEFAULT '[]', severity TEXT NOT NULL DEFAULT 'Unassessed',
        severity_rationale TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT 'Unassessed', owner TEXT,
        status TEXT NOT NULL DEFAULT 'New', event_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        closed_at TEXT, reopened_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS incidents_client_idx ON incidents(client_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS incident_reports (
        incident_id TEXT NOT NULL, article_id TEXT NOT NULL, headline TEXT NOT NULL, url TEXT NOT NULL,
        source TEXT NOT NULL, published_at TEXT NOT NULL, linked_at TEXT NOT NULL, linked_by TEXT NOT NULL,
        PRIMARY KEY (incident_id, article_id)
      );
      CREATE TABLE IF NOT EXISTS incident_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '', country_code TEXT
      );
      CREATE TABLE IF NOT EXISTS incident_impacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, area TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, author TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incident_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, text TEXT NOT NULL, owner TEXT, due_date TEXT,
        status TEXT NOT NULL DEFAULT 'Open', completed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incident_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
        type TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incident_dismissed (
        incident_id TEXT NOT NULL, article_id TEXT NOT NULL, PRIMARY KEY (incident_id, article_id)
      );
      CREATE TABLE IF NOT EXISTS country_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, country_code TEXT NOT NULL, ref_type TEXT NOT NULL,
        ref_id TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', label TEXT NOT NULL, url TEXT,
        source TEXT, event_time TEXT, added_at TEXT NOT NULL, added_by TEXT NOT NULL,
        UNIQUE (client_id, country_code, ref_type, ref_id, category)
      );
      CREATE TABLE IF NOT EXISTS country_assessments (
        client_id TEXT NOT NULL, country_code TEXT NOT NULL, version INTEGER NOT NULL, assessed_at TEXT NOT NULL,
        assessor TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT 'Unassessed',
        categories_json TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY (client_id, country_code, version)
      );
      CREATE TABLE IF NOT EXISTS country_watch (
        client_id TEXT NOT NULL, country_code TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (client_id, country_code)
      );
      CREATE TABLE IF NOT EXISTS indicator_settings (
        client_id TEXT NOT NULL, indicator_id TEXT NOT NULL, geo TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'auto',
        warn REAL, alert REAL, min_count INTEGER NOT NULL DEFAULT 2, cooldown_hours INTEGER NOT NULL DEFAULT 24,
        watched INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (client_id, indicator_id, geo)
      );
      CREATE TABLE IF NOT EXISTS indicator_state (
        client_id TEXT NOT NULL, indicator_id TEXT NOT NULL, geo TEXT NOT NULL, last_level TEXT NOT NULL,
        last_alert_at TEXT, evaluated_at TEXT NOT NULL, PRIMARY KEY (client_id, indicator_id, geo)
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        title TEXT NOT NULL, detail TEXT NOT NULL, severity TEXT NOT NULL, link_json TEXT, created_at TEXT NOT NULL,
        read_at TEXT, UNIQUE (client_id, dedupe_key)
      );
    `);
  }

  // ---------------------------------------------------------------- incidents

  private owned(clientId: string, incidentId: string): Row {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id = ? AND client_id = ?').get(incidentId, clientId) as Row | undefined;
    if (!row) throw new NotFoundError('Incident not found.');
    return row;
  }

  private audit(incidentId: string, actor: string, type: string, detail: string, now: string) {
    this.db.prepare('INSERT INTO incident_audit (incident_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').run(incidentId, now, actor, type, detail.slice(0, 500));
  }

  private touch(incidentId: string, now: string) {
    this.db.prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(now, incidentId);
  }

  private validateInput(input: IncidentInput) {
    if (!input.title.trim()) throw new ValidationError('A title is required.');
    if (!SEVERITIES.includes(input.severity)) throw new ValidationError('Unknown severity.');
    if (input.severity !== 'Unassessed' && !input.severityRationale.trim()) {
      throw new ValidationError('A severity other than Unassessed needs a written rationale.');
    }
    for (const code of input.countryCodes) if (!isKnownCountryCode(code)) throw new ValidationError(`Unknown country code ${code}.`);
  }

  createIncident(clientId: string, actor: string, input: IncidentInput, reports: ReportSnapshot[], now = new Date().toISOString()): IncidentDetail {
    this.validateInput(input);
    const id = `INC-${randomUUID().slice(0, 8).toUpperCase()}`;
    const run = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO incidents (id, client_id, title, summary, category, location_text, lat, lng, country_codes_json, severity,
          severity_rationale, confidence, owner, status, event_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?)
      `).run(id, clientId, input.title.trim(), input.summary, input.category, input.locationText, input.lat, input.lng,
        JSON.stringify(input.countryCodes), input.severity, input.severityRationale, input.confidence, input.owner || null,
        input.eventAt, now, now);
      this.audit(id, actor, 'created', `Incident created: ${input.title.trim()}`, now);
      for (const report of reports) this.insertReport(id, actor, report, now);
    });
    run();
    return this.getIncident(clientId, id);
  }

  private insertReport(incidentId: string, actor: string, report: ReportSnapshot, now: string) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO incident_reports (incident_id, article_id, headline, url, source, published_at, linked_at, linked_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(incidentId, report.articleId, report.headline, report.url, report.source, report.publishedAt, now, actor);
    if (result.changes > 0) this.audit(incidentId, actor, 'report-linked', `Linked report: ${report.headline}`, now);
    return result.changes > 0;
  }

  /** Links reports; reports that are already linked are skipped, never duplicated. */
  linkReports(clientId: string, actor: string, incidentId: string, reports: ReportSnapshot[], now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    let linked = 0;
    let skipped = 0;
    this.db.transaction(() => {
      for (const report of reports) {
        if (this.insertReport(incidentId, actor, report, now)) linked += 1; else skipped += 1;
      }
      if (linked > 0) this.touch(incidentId, now);
    })();
    return { linked, skipped, incident: this.getIncident(clientId, incidentId) };
  }

  unlinkReport(clientId: string, actor: string, incidentId: string, articleId: string, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    const removed = this.db.prepare('DELETE FROM incident_reports WHERE incident_id = ? AND article_id = ?').run(incidentId, articleId);
    if (removed.changes === 0) throw new NotFoundError('That report is not linked to this incident.');
    this.audit(incidentId, actor, 'report-unlinked', `Unlinked report ${articleId}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  updateIncident(clientId: string, actor: string, incidentId: string, patch: Partial<IncidentInput> & { status?: IncidentStatus }, now = new Date().toISOString()) {
    const current = this.owned(clientId, incidentId);
    const next = {
      title: patch.title ?? str(current.title),
      summary: patch.summary ?? str(current.summary),
      category: patch.category ?? str(current.category),
      locationText: patch.locationText ?? str(current.location_text),
      lat: patch.lat === undefined ? optNum(current.lat) : patch.lat,
      lng: patch.lng === undefined ? optNum(current.lng) : patch.lng,
      countryCodes: patch.countryCodes ?? (JSON.parse(str(current.country_codes_json)) as string[]),
      severity: patch.severity ?? asSeverity(current.severity),
      severityRationale: patch.severityRationale ?? str(current.severity_rationale),
      confidence: patch.confidence ?? asConfidence(current.confidence),
      owner: patch.owner === undefined ? optStr(current.owner) : (patch.owner || null),
      eventAt: patch.eventAt === undefined ? optStr(current.event_at) : patch.eventAt,
      status: patch.status ?? asStatus(current.status),
    };
    if (patch.status && !INCIDENT_STATUSES.includes(patch.status)) throw new ValidationError('Unknown status.');
    this.validateInput({ ...next, owner: next.owner });

    const changes: Array<[string, string, string]> = [];
    const compare = (label: string, before: unknown, after: unknown) => {
      if (String(before ?? '') !== String(after ?? '')) changes.push([label, String(before ?? ''), String(after ?? '')]);
    };
    compare('title', current.title, next.title);
    compare('summary', current.summary, next.summary);
    compare('category', current.category, next.category);
    compare('location', current.location_text, next.locationText);
    compare('countries', JSON.parse(str(current.country_codes_json)).join(','), next.countryCodes.join(','));
    compare('severity', current.severity, next.severity);
    compare('severity rationale', current.severity_rationale, next.severityRationale);
    compare('confidence', current.confidence, next.confidence);
    compare('owner', current.owner, next.owner);
    compare('event time', current.event_at, next.eventAt);

    const previousStatus = asStatus(current.status);
    let closedAt = optStr(current.closed_at);
    let reopened = Number(current.reopened_count);
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE incidents SET title = ?, summary = ?, category = ?, location_text = ?, lat = ?, lng = ?, country_codes_json = ?,
          severity = ?, severity_rationale = ?, confidence = ?, owner = ?, event_at = ?, status = ?, closed_at = ?,
          reopened_count = ?, updated_at = ? WHERE id = ? AND client_id = ?
      `).run(next.title.trim(), next.summary, next.category, next.locationText, next.lat, next.lng, JSON.stringify(next.countryCodes),
        next.severity, next.severityRationale, next.confidence, next.owner, next.eventAt, next.status,
        next.status === 'Closed' ? (previousStatus === 'Closed' ? closedAt : now) : null,
        previousStatus === 'Closed' && next.status !== 'Closed' ? reopened + 1 : reopened, now, incidentId, clientId);
      for (const [label, before, after] of changes) this.audit(incidentId, actor, 'edited', `${label}: "${before.slice(0, 80)}" -> "${after.slice(0, 80)}"`, now);
      if (next.status !== previousStatus) {
        const reopenedNow = previousStatus === 'Closed';
        this.audit(incidentId, actor, reopenedNow ? 'reopened' : 'status-changed', `Status: ${previousStatus} -> ${next.status}`, now);
      }
    })();
    return this.getIncident(clientId, incidentId);
  }

  addAsset(clientId: string, actor: string, incidentId: string, input: { kind: string; name: string; notes: string; countryCode: string | null }, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    if (!ASSET_KINDS.includes(input.kind as never) || !input.name.trim()) throw new ValidationError('An asset needs a kind and a name.');
    if (input.countryCode && !isKnownCountryCode(input.countryCode)) throw new ValidationError('Unknown country code.');
    this.db.prepare('INSERT INTO incident_assets (incident_id, kind, name, notes, country_code) VALUES (?, ?, ?, ?, ?)').run(incidentId, input.kind, input.name.trim(), input.notes, input.countryCode || null);
    this.audit(incidentId, actor, 'asset-added', `${input.kind}: ${input.name.trim()}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  removeAsset(clientId: string, actor: string, incidentId: string, assetId: number, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    const removed = this.db.prepare('DELETE FROM incident_assets WHERE id = ? AND incident_id = ?').run(assetId, incidentId);
    if (removed.changes === 0) throw new NotFoundError('Asset not found.');
    this.audit(incidentId, actor, 'asset-removed', `Removed asset ${assetId}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  addImpact(clientId: string, actor: string, incidentId: string, input: { area: string; text: string }, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    if (!IMPACT_AREAS.includes(input.area as never) || !input.text.trim()) throw new ValidationError('An impact needs an area and text.');
    this.db.prepare('INSERT INTO incident_impacts (incident_id, area, text, created_at, author) VALUES (?, ?, ?, ?, ?)').run(incidentId, input.area, input.text.trim(), now, actor);
    this.audit(incidentId, actor, 'impact-added', `${input.area} impact: ${input.text.trim()}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  removeImpact(clientId: string, actor: string, incidentId: string, impactId: number, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    const removed = this.db.prepare('DELETE FROM incident_impacts WHERE id = ? AND incident_id = ?').run(impactId, incidentId);
    if (removed.changes === 0) throw new NotFoundError('Impact not found.');
    this.audit(incidentId, actor, 'impact-removed', `Removed impact ${impactId}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  addAction(clientId: string, actor: string, incidentId: string, input: { text: string; owner: string | null; dueDate: string | null }, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    if (!input.text.trim()) throw new ValidationError('An action needs text.');
    this.db.prepare('INSERT INTO incident_actions (incident_id, text, owner, due_date, created_at) VALUES (?, ?, ?, ?, ?)').run(incidentId, input.text.trim(), input.owner || null, input.dueDate || null, now);
    this.audit(incidentId, actor, 'action-added', `Action: ${input.text.trim()}${input.owner ? ` (owner ${input.owner})` : ''}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  updateAction(clientId: string, actor: string, incidentId: string, actionId: number, patch: { status?: 'Open' | 'Done'; owner?: string | null; dueDate?: string | null }, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    const action = this.db.prepare('SELECT * FROM incident_actions WHERE id = ? AND incident_id = ?').get(actionId, incidentId) as Row | undefined;
    if (!action) throw new NotFoundError('Action not found.');
    const status = patch.status ?? (action.status === 'Done' ? 'Done' : 'Open');
    const owner = patch.owner === undefined ? optStr(action.owner) : (patch.owner || null);
    const dueDate = patch.dueDate === undefined ? optStr(action.due_date) : (patch.dueDate || null);
    const completedAt = status === 'Done' ? (action.status === 'Done' ? optStr(action.completed_at) : now) : null;
    this.db.prepare('UPDATE incident_actions SET status = ?, owner = ?, due_date = ?, completed_at = ? WHERE id = ?').run(status, owner, dueDate, completedAt, actionId);
    const what = status !== action.status ? (status === 'Done' ? 'completed' : 'reopened') : 'edited';
    this.audit(incidentId, actor, `action-${what}`, `Action "${str(action.text).slice(0, 80)}" ${what}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  removeAction(clientId: string, actor: string, incidentId: string, actionId: number, now = new Date().toISOString()) {
    this.owned(clientId, incidentId);
    const removed = this.db.prepare('DELETE FROM incident_actions WHERE id = ? AND incident_id = ?').run(actionId, incidentId);
    if (removed.changes === 0) throw new NotFoundError('Action not found.');
    this.audit(incidentId, actor, 'action-removed', `Removed action ${actionId}`, now);
    this.touch(incidentId, now);
    return this.getIncident(clientId, incidentId);
  }

  dismissSuggestion(clientId: string, incidentId: string, articleId: string) {
    this.owned(clientId, incidentId);
    this.db.prepare('INSERT OR IGNORE INTO incident_dismissed (incident_id, article_id) VALUES (?, ?)').run(incidentId, articleId);
  }

  dismissedFor(incidentId: string) {
    return new Set((this.db.prepare('SELECT article_id FROM incident_dismissed WHERE incident_id = ?').all(incidentId) as Row[]).map((row) => str(row.article_id)));
  }

  private summaryOf(row: Row): IncidentSummary {
    const id = str(row.id);
    const counts = this.db.prepare(`
      SELECT (SELECT COUNT(*) FROM incident_reports WHERE incident_id = ?) AS reports,
             (SELECT COUNT(*) FROM incident_actions WHERE incident_id = ? AND status = 'Open') AS open_actions
    `).get(id, id) as Row;
    return {
      id,
      title: str(row.title),
      category: str(row.category),
      severity: asSeverity(row.severity),
      status: asStatus(row.status),
      owner: optStr(row.owner),
      countries: (JSON.parse(str(row.country_codes_json)) as string[]).map((code) => ({ code, name: countryName(code) })),
      eventAt: optStr(row.event_at),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      reportCount: Number(counts.reports),
      openActions: Number(counts.open_actions),
    };
  }

  listIncidents(clientId: string, filters: IncidentFilters = {}): IncidentSummary[] {
    const rows = this.db.prepare('SELECT * FROM incidents WHERE client_id = ? ORDER BY updated_at DESC').all(clientId) as Row[];
    const query = filters.q?.trim().toLowerCase();
    return rows
      .filter((row) => {
        const countries = JSON.parse(str(row.country_codes_json)) as string[];
        if (filters.country && !countries.includes(filters.country)) return false;
        if (filters.severity && row.severity !== filters.severity) return false;
        if (filters.status && row.status !== filters.status) return false;
        if (filters.owner && str(row.owner).toLowerCase() !== filters.owner.toLowerCase()) return false;
        const date = optStr(row.event_at) ?? str(row.created_at);
        if (filters.from && date.slice(0, 10) < filters.from) return false;
        if (filters.to && date.slice(0, 10) > filters.to) return false;
        if (query) {
          const hay = [row.id, row.title, row.summary, row.category, row.location_text, row.owner, ...countries.map(countryName)].join(' ').toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      })
      .map((row) => this.summaryOf(row));
  }

  getIncident(clientId: string, incidentId: string): IncidentDetail {
    const row = this.owned(clientId, incidentId);
    const liveRecord = this.db.prepare('SELECT retrieved_at FROM source_records WHERE id = ?');
    const assessment = this.db.prepare('SELECT severity FROM item_assessments WHERE article_id = ?');
    const evidence: EvidenceLink[] = (this.db.prepare('SELECT * FROM incident_reports WHERE incident_id = ? ORDER BY published_at DESC').all(incidentId) as Row[]).map((link) => {
      const live = liveRecord.get(str(link.article_id)) as Row | undefined;
      const sev = assessment.get(str(link.article_id)) as Row | undefined;
      return {
        articleId: str(link.article_id), headline: str(link.headline), url: str(link.url), source: str(link.source),
        publishedAt: str(link.published_at), retrievedAt: live ? str(live.retrieved_at) : null,
        severity: sev ? asSeverity(sev.severity) : null, linkedAt: str(link.linked_at), linkedBy: str(link.linked_by),
      };
    });
    const assets: IncidentAsset[] = (this.db.prepare('SELECT * FROM incident_assets WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[])
      .map((asset) => ({ id: Number(asset.id), kind: asset.kind as IncidentAsset['kind'], name: str(asset.name), notes: str(asset.notes), countryCode: optStr(asset.country_code) }));
    const impacts: IncidentImpact[] = (this.db.prepare('SELECT * FROM incident_impacts WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[])
      .map((impact) => ({ id: Number(impact.id), area: impact.area as IncidentImpact['area'], text: str(impact.text), createdAt: str(impact.created_at), author: str(impact.author) }));
    const actions: IncidentAction[] = (this.db.prepare('SELECT * FROM incident_actions WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[])
      .map((action) => ({ id: Number(action.id), text: str(action.text), owner: optStr(action.owner), dueDate: optStr(action.due_date), status: action.status === 'Done' ? 'Done' : 'Open', completedAt: optStr(action.completed_at), createdAt: str(action.created_at) }));
    const audit: AuditEntry[] = (this.db.prepare('SELECT * FROM incident_audit WHERE incident_id = ? ORDER BY id DESC').all(incidentId) as Row[])
      .map((entry) => ({ id: Number(entry.id), at: str(entry.at), actor: str(entry.actor), type: str(entry.type), detail: str(entry.detail) }));
    return {
      ...this.summaryOf(row),
      summary: str(row.summary),
      locationText: str(row.location_text),
      lat: optNum(row.lat),
      lng: optNum(row.lng),
      severityRationale: str(row.severity_rationale),
      confidence: asConfidence(row.confidence),
      closedAt: optStr(row.closed_at),
      reopenedCount: Number(row.reopened_count),
      evidence, assets, impacts, actions, audit,
    };
  }

  /** Existing incidents of this client that a new or edited incident might duplicate. For review only: nothing is merged. */
  suggestDuplicates(clientId: string, candidate: { title: string; category: string; countryCodes: string[]; articleIds: string[] }, excludeId?: string, now = Date.now()): DuplicateSuggestion[] {
    const suggestions: DuplicateSuggestion[] = [];
    const linkedTo = this.db.prepare('SELECT 1 FROM incident_reports WHERE incident_id = ? AND article_id = ?');
    for (const row of this.db.prepare('SELECT * FROM incidents WHERE client_id = ?').all(clientId) as Row[]) {
      if (str(row.id) === excludeId) continue;
      const reasons: string[] = [];
      if (candidate.articleIds.some((articleId) => linkedTo.get(str(row.id), articleId))) reasons.push('Shares a linked report');
      const countries = JSON.parse(str(row.country_codes_json)) as string[];
      const recent = now - Date.parse(str(row.updated_at)) <= 14 * 86_400_000;
      if (recent && candidate.category && candidate.category === row.category && countries.some((code) => candidate.countryCodes.includes(code))) {
        reasons.push('Same country and category, updated within 14 days');
      }
      if (similarity(candidate.title, str(row.title)) >= 0.5) reasons.push('Similar title');
      if (reasons.length > 0) suggestions.push({ id: str(row.id), title: str(row.title), status: asStatus(row.status), reasons });
    }
    return suggestions;
  }

  // ---------------------------------------------------------------- country assessments

  getWatchedCountries(clientId: string): string[] {
    return (this.db.prepare('SELECT country_code FROM country_watch WHERE client_id = ? ORDER BY country_code').all(clientId) as Row[]).map((row) => str(row.country_code));
  }

  watchedSince(clientId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT country_code, added_at FROM country_watch WHERE client_id = ?').all(clientId) as Row[];
    return new Map(rows.map((row) => [str(row.country_code), str(row.added_at)]));
  }

  setCountryWatch(clientId: string, code: string, watched: boolean, now = new Date().toISOString()) {
    if (!isKnownCountryCode(code)) throw new ValidationError('Unknown country code.');
    if (watched) this.db.prepare('INSERT OR IGNORE INTO country_watch (client_id, country_code, added_at) VALUES (?, ?, ?)').run(clientId, code, now);
    else this.db.prepare('DELETE FROM country_watch WHERE client_id = ? AND country_code = ?').run(clientId, code);
  }

  listCountryEvidence(clientId: string, code: string): CountryEvidence[] {
    return (this.db.prepare('SELECT * FROM country_evidence WHERE client_id = ? AND country_code = ? ORDER BY added_at DESC, id DESC').all(clientId, code) as Row[]).map((row) => ({
      id: Number(row.id), refType: row.ref_type === 'incident' ? 'incident' : 'report', refId: str(row.ref_id),
      category: row.category as CountryCategoryId, note: str(row.note), label: str(row.label), url: optStr(row.url),
      source: optStr(row.source), eventTime: optStr(row.event_time), addedAt: str(row.added_at), addedBy: str(row.added_by),
    }));
  }

  addCountryEvidence(clientId: string, actor: string, code: string, input: { refType: 'report' | 'incident'; refId: string; category: string; note: string; label: string; url: string | null; source: string | null; eventTime: string | null }, now = new Date().toISOString()) {
    if (!isKnownCountryCode(code)) throw new ValidationError('Unknown country code.');
    if (!COUNTRY_CATEGORIES.some((category) => category.id === input.category)) throw new ValidationError('Unknown category.');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO country_evidence (client_id, country_code, ref_type, ref_id, category, note, label, url, source, event_time, added_at, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientId, code, input.refType, input.refId, input.category, input.note, input.label, input.url, input.source, input.eventTime, now, actor);
    return { added: result.changes > 0, evidence: this.listCountryEvidence(clientId, code) };
  }

  removeCountryEvidence(clientId: string, code: string, evidenceId: number) {
    const removed = this.db.prepare('DELETE FROM country_evidence WHERE id = ? AND client_id = ? AND country_code = ?').run(evidenceId, clientId, code);
    if (removed.changes === 0) throw new NotFoundError('Evidence not found.');
    return this.listCountryEvidence(clientId, code);
  }

  /** Saves a new immutable version. Ratings need a rationale and evidence that belongs to this country. */
  saveCountryAssessment(clientId: string, actor: string, code: string, input: { summary: string; confidence: Confidence; categories: Partial<Record<CountryCategoryId, Partial<CategoryAssessment>>> }, now = new Date().toISOString()): AssessmentVersion {
    if (!isKnownCountryCode(code)) throw new ValidationError('Unknown country code.');
    const evidence = this.listCountryEvidence(clientId, code);
    const byId = new Map(evidence.map((item) => [item.id, item]));
    const categories = emptyCategories();
    let rated = 0;
    for (const category of COUNTRY_CATEGORIES) {
      const entry = input.categories[category.id];
      if (!entry || !entry.rating || entry.rating === 'Unassessed') continue;
      if (!RATINGS.includes(entry.rating)) throw new ValidationError(`Unknown rating for ${category.label}.`);
      const evidenceIds = [...new Set(entry.evidenceIds ?? [])];
      if (!(entry.rationale ?? '').trim()) throw new ValidationError(`${category.label}: a written rationale is required for a rating.`);
      if (evidenceIds.length === 0 || evidenceIds.some((id) => !byId.has(id))) {
        throw new ValidationError(`${category.label}: link at least one report or incident of this country as evidence.`);
      }
      categories[category.id] = { rating: entry.rating, rationale: entry.rationale!.trim(), confidence: entry.confidence ?? 'Unassessed', evidenceIds };
      rated += 1;
    }
    if (rated === 0) throw new ValidationError('Rate at least one category before saving an assessment.');
    const last = this.db.prepare('SELECT MAX(version) AS version FROM country_assessments WHERE client_id = ? AND country_code = ?').get(clientId, code) as Row;
    const version = Number(last.version ?? 0) + 1;
    const used = new Set(Object.values(categories).flatMap((category) => category.evidenceIds));
    const snapshot = evidence.filter((item) => used.has(item.id));
    this.db.prepare(`
      INSERT INTO country_assessments (client_id, country_code, version, assessed_at, assessor, summary, confidence, categories_json, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientId, code, version, now, actor, input.summary, input.confidence, JSON.stringify(categories), JSON.stringify(snapshot));
    return this.getAssessmentVersion(clientId, code, version)!;
  }

  private mapVersion(row: Row): AssessmentVersion {
    return {
      version: Number(row.version), countryCode: str(row.country_code), assessedAt: str(row.assessed_at), assessor: str(row.assessor),
      summary: str(row.summary), confidence: asConfidence(row.confidence),
      categories: { ...emptyCategories(), ...(JSON.parse(str(row.categories_json)) as Record<CountryCategoryId, CategoryAssessment>) },
      evidence: JSON.parse(str(row.evidence_json)) as CountryEvidence[],
    };
  }

  getAssessmentVersion(clientId: string, code: string, version: number): AssessmentVersion | null {
    const row = this.db.prepare('SELECT * FROM country_assessments WHERE client_id = ? AND country_code = ? AND version = ?').get(clientId, code, version) as Row | undefined;
    return row ? this.mapVersion(row) : null;
  }

  listAssessmentVersions(clientId: string, code: string): AssessmentVersion[] {
    return (this.db.prepare('SELECT * FROM country_assessments WHERE client_id = ? AND country_code = ? ORDER BY version DESC').all(clientId, code) as Row[]).map((row) => this.mapVersion(row));
  }

  latestAssessments(clientId: string): Map<string, AssessmentVersion> {
    const rows = this.db.prepare(`
      SELECT a.* FROM country_assessments a
      JOIN (SELECT country_code, MAX(version) AS version FROM country_assessments WHERE client_id = ? GROUP BY country_code) m
        ON m.country_code = a.country_code AND m.version = a.version
      WHERE a.client_id = ?
    `).all(clientId, clientId) as Row[];
    return new Map(rows.map((row) => [str(row.country_code), this.mapVersion(row)]));
  }

  // ---------------------------------------------------------------- indicator settings and alerts

  getIndicatorSettings(clientId: string, indicatorId: string, geo: string): IndicatorSettings {
    const row = this.db.prepare('SELECT * FROM indicator_settings WHERE client_id = ? AND indicator_id = ? AND geo = ?').get(clientId, indicatorId, geo) as Row | undefined;
    return {
      mode: row?.mode === 'fixed' ? 'fixed' : 'auto',
      warn: row ? optNum(row.warn) : null,
      alert: row ? optNum(row.alert) : null,
      minCount: row ? Number(row.min_count) : 2,
      cooldownHours: row ? Number(row.cooldown_hours) : 24,
      watched: row ? Number(row.watched) === 1 : false,
    };
  }

  saveIndicatorSettings(clientId: string, indicatorId: string, geo: string, patch: Partial<IndicatorSettings>, now = new Date().toISOString()): IndicatorSettings {
    const current = this.getIndicatorSettings(clientId, indicatorId, geo);
    const next = { ...current, ...patch };
    if (next.mode === 'fixed') {
      if (next.warn === null || next.alert === null || next.warn < 0 || next.alert < next.warn) {
        throw new ValidationError('Fixed thresholds need a warning value and an alert value that is at least as high.');
      }
    }
    if (!Number.isInteger(next.minCount) || next.minCount < 0 || next.minCount > 1000) throw new ValidationError('Minimum count must be a whole number from 0 to 1000.');
    if (!Number.isInteger(next.cooldownHours) || next.cooldownHours < 1 || next.cooldownHours > 24 * 30) throw new ValidationError('Cooldown must be 1 to 720 hours.');
    this.db.prepare(`
      INSERT INTO indicator_settings (client_id, indicator_id, geo, mode, warn, alert, min_count, cooldown_hours, watched, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, indicator_id, geo) DO UPDATE SET mode = excluded.mode, warn = excluded.warn, alert = excluded.alert,
        min_count = excluded.min_count, cooldown_hours = excluded.cooldown_hours, watched = excluded.watched, updated_at = excluded.updated_at
    `).run(clientId, indicatorId, geo, next.mode, next.mode === 'fixed' ? next.warn : null, next.mode === 'fixed' ? next.alert : null, next.minCount, next.cooldownHours, next.watched ? 1 : 0, now);
    return this.getIndicatorSettings(clientId, indicatorId, geo);
  }

  watchedIndicators(clientId?: string): Array<{ clientId: string; indicatorId: string; geo: string }> {
    const rows = clientId
      ? this.db.prepare('SELECT client_id, indicator_id, geo FROM indicator_settings WHERE watched = 1 AND client_id = ?').all(clientId)
      : this.db.prepare('SELECT client_id, indicator_id, geo FROM indicator_settings WHERE watched = 1').all();
    return (rows as Row[]).map((row) => ({ clientId: str(row.client_id), indicatorId: str(row.indicator_id), geo: str(row.geo) }));
  }

  clientsWithWatches(): string[] {
    const rows = this.db.prepare('SELECT client_id FROM country_watch UNION SELECT client_id FROM indicator_settings WHERE watched = 1').all() as Row[];
    return rows.map((row) => str(row.client_id));
  }

  getIndicatorState(clientId: string, indicatorId: string, geo: string) {
    const row = this.db.prepare('SELECT * FROM indicator_state WHERE client_id = ? AND indicator_id = ? AND geo = ?').get(clientId, indicatorId, geo) as Row | undefined;
    return row ? { lastLevel: str(row.last_level), lastAlertAt: optStr(row.last_alert_at) } : null;
  }

  saveIndicatorState(clientId: string, indicatorId: string, geo: string, level: string, lastAlertAt: string | null, now: string) {
    this.db.prepare(`
      INSERT INTO indicator_state (client_id, indicator_id, geo, last_level, last_alert_at, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, indicator_id, geo) DO UPDATE SET last_level = excluded.last_level, last_alert_at = excluded.last_alert_at, evaluated_at = excluded.evaluated_at
    `).run(clientId, indicatorId, geo, level, lastAlertAt, now);
  }

  createAlert(clientId: string, alert: { kind: string; dedupeKey: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical'; link: AlertDto['link'] }, now = new Date().toISOString()) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (client_id, kind, dedupe_key, title, detail, severity, link_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientId, alert.kind, alert.dedupeKey, alert.title, alert.detail, alert.severity, alert.link ? JSON.stringify(alert.link) : null, now);
    return result.changes > 0;
  }

  listAlerts(clientId: string, limit = 100): { items: AlertDto[]; unread: number } {
    const rows = this.db.prepare('SELECT * FROM alerts WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, limit) as Row[];
    const unread = this.db.prepare('SELECT COUNT(*) AS total FROM alerts WHERE client_id = ? AND read_at IS NULL').get(clientId) as Row;
    return {
      unread: Number(unread.total),
      items: rows.map((row) => ({
        id: Number(row.id), kind: str(row.kind), title: str(row.title), detail: str(row.detail),
        severity: row.severity === 'critical' ? 'critical' : row.severity === 'warning' ? 'warning' : 'info',
        link: row.link_json ? JSON.parse(str(row.link_json)) as AlertDto['link'] : null,
        createdAt: str(row.created_at), readAt: optStr(row.read_at),
      })),
    };
  }

  markAlertsRead(clientId: string, ids: number[] | 'all', now = new Date().toISOString()) {
    if (ids === 'all') this.db.prepare('UPDATE alerts SET read_at = ? WHERE client_id = ? AND read_at IS NULL').run(now, clientId);
    else for (const id of ids) this.db.prepare('UPDATE alerts SET read_at = ? WHERE client_id = ? AND id = ? AND read_at IS NULL').run(now, clientId, id);
  }
}

// ------------------------------------------------------------------ trends from real saved versions

const DAY = 86_400_000;

/** Compares the latest version with real earlier versions only. Without comparable history the trend is "Insufficient history". */
export function computeTrends(versions: AssessmentVersion[], now = Date.now()): Record<CountryCategoryId, CategoryTrend> {
  const result = {} as Record<CountryCategoryId, CategoryTrend>;
  const latest = versions[0];
  for (const category of COUNTRY_CATEGORIES) {
    const current = latest?.categories[category.id]?.rating;
    const currentRating = current && current !== 'Unassessed' ? current : null;
    const changes = ([7, 30, 90] as const).map((windowDays) => {
      const cutoff = now - windowDays * DAY;
      const earlier = currentRating
        ? versions.find((version, index) => index > 0 && Date.parse(version.assessedAt) <= cutoff && version.categories[category.id].rating !== 'Unassessed')
        : undefined;
      const from = earlier ? earlier.categories[category.id].rating as Rating : null;
      return { windowDays, from, fromDate: earlier?.assessedAt ?? null, steps: from && currentRating ? RATING_RANK[currentRating] - RATING_RANK[from] : null };
    });
    const basis = changes.find((change) => change.windowDays === 30 && change.steps !== null) ?? changes.find((change) => change.windowDays === 7 && change.steps !== null);
    const trend: Trend = !basis || basis.steps === null ? 'Insufficient history' : basis.steps > 0 ? 'Deteriorating' : basis.steps < 0 ? 'Improving' : 'Stable';
    result[category.id] = { trend, changes };
  }
  return result;
}
