import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseHandle } from '../source-store';
import type { AiAnswerDto, AiAuditEntry, AiOutputSummary, AiSettingsDto, EnrichmentDto } from '../../src/data/aiTypes';

type Row = Record<string, unknown>;

export const sha = (...parts: unknown[]) => createHash('sha256').update(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('\u0001')).digest('hex').slice(0, 24);

export const DEFAULT_SETTINGS: AiSettingsDto = { enabled: true, briefing: { schedule: 'off', hourUtc: 7, lastGeneratedAt: null, lastRunAt: null } };

/**
 * Storage for AI results. Two kinds of data live here and they are isolated differently:
 *  - enrichment is derived from public feed records only, so it is shared (it contains nothing about any user);
 *  - everything else is derived from a person's own workspace and is keyed by client id in every query.
 */
export class AiStore {
  constructor(private readonly db: DatabaseHandle) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_enrichment (
        article_id TEXT NOT NULL, content_hash TEXT NOT NULL, prompt_version TEXT NOT NULL, model_version TEXT NOT NULL,
        json TEXT NOT NULL, generated_at TEXT NOT NULL,
        PRIMARY KEY (article_id, content_hash, prompt_version, model_version)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_enrichment_article ON ai_enrichment (article_id, generated_at);
      CREATE TABLE IF NOT EXISTS ai_enrichment_dismissed (client_id TEXT NOT NULL, article_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (client_id, article_id));
      CREATE TABLE IF NOT EXISTS ai_outputs (
        client_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, cache_key TEXT NOT NULL, json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', generated_at TEXT NOT NULL, actor TEXT NOT NULL,
        PRIMARY KEY (client_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_outputs_key ON ai_outputs (client_id, cache_key);
      CREATE TABLE IF NOT EXISTS ai_settings (client_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_related_dismissed (client_id TEXT NOT NULL, subject TEXT NOT NULL, target TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (client_id, subject, target));
      CREATE TABLE IF NOT EXISTS ai_briefing_seen (client_id TEXT NOT NULL, ref TEXT NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (client_id, ref));
      CREATE TABLE IF NOT EXISTS ai_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_audit ON ai_audit (client_id, id);
    `);
  }

  // ------------------------------------------------------------ enrichment (shared, public data only)

  getEnrichment(articleId: string, contentHash: string, promptVersion: string, modelVersion: string): EnrichmentDto | null {
    const row = this.db.prepare('SELECT json FROM ai_enrichment WHERE article_id = ? AND content_hash = ? AND prompt_version = ? AND model_version = ?').get(articleId, contentHash, promptVersion, modelVersion) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as EnrichmentDto) : null;
  }

  /** Most recent enrichment of any version, so an outdated one can still be shown with a warning. */
  latestEnrichment(articleId: string): { enrichment: EnrichmentDto; contentHash: string; promptVersion: string } | null {
    const row = this.db.prepare('SELECT json, content_hash, prompt_version FROM ai_enrichment WHERE article_id = ? ORDER BY generated_at DESC LIMIT 1').get(articleId) as Row | undefined;
    return row ? { enrichment: JSON.parse(String(row.json)) as EnrichmentDto, contentHash: String(row.content_hash), promptVersion: String(row.prompt_version) } : null;
  }

  saveEnrichment(articleId: string, contentHash: string, promptVersion: string, modelVersion: string, value: EnrichmentDto, now: string) {
    this.db.prepare('INSERT OR REPLACE INTO ai_enrichment (article_id, content_hash, prompt_version, model_version, json, generated_at) VALUES (?, ?, ?, ?, ?, ?)').run(articleId, contentHash, promptVersion, modelVersion, JSON.stringify(value), now);
  }

  dismissEnrichment(clientId: string, articleId: string, now: string) {
    this.db.prepare('INSERT OR REPLACE INTO ai_enrichment_dismissed (client_id, article_id, at) VALUES (?, ?, ?)').run(clientId, articleId, now);
  }

  restoreEnrichment(clientId: string, articleId: string) {
    this.db.prepare('DELETE FROM ai_enrichment_dismissed WHERE client_id = ? AND article_id = ?').run(clientId, articleId);
  }

  dismissedEnrichments(clientId: string): Set<string> {
    return new Set((this.db.prepare('SELECT article_id FROM ai_enrichment_dismissed WHERE client_id = ?').all(clientId) as Row[]).map((row) => String(row.article_id)));
  }

  /** Removes enrichment for reports that no longer exist and keeps only the newest few versions of the rest. */
  prune() {
    this.db.exec(`
      DELETE FROM ai_enrichment WHERE article_id NOT IN (SELECT id FROM source_records);
      DELETE FROM ai_enrichment WHERE rowid IN (
        SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY generated_at DESC) AS n FROM ai_enrichment) WHERE n > 3
      );
    `);
  }

  // ------------------------------------------------------------ per-client outputs (cache + history)

  /** Cached output for exactly this input, prompt and model. The client id is part of the lookup, so nothing crosses workspaces. */
  findCached(clientId: string, kind: string, cacheKey: string): AiAnswerDto | null {
    const row = this.db.prepare("SELECT json, status FROM ai_outputs WHERE client_id = ? AND kind = ? AND cache_key = ? AND status = 'active' ORDER BY generated_at DESC LIMIT 1").get(clientId, kind, cacheKey) as Row | undefined;
    return row ? { ...(JSON.parse(String(row.json)) as AiAnswerDto), cached: true } : null;
  }

  saveOutput(clientId: string, actor: string, cacheKey: string, answer: Omit<AiAnswerDto, 'id' | 'status' | 'cached'>): AiAnswerDto {
    const id = `AI-${randomBytes(5).toString('hex').toUpperCase()}`;
    const full: AiAnswerDto = { ...answer, id, status: 'active', cached: false };
    this.db.prepare('INSERT INTO ai_outputs (client_id, id, kind, cache_key, json, status, generated_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(clientId, id, answer.kind, cacheKey, JSON.stringify(full), 'active', answer.meta.generatedAt, actor);
    return full;
  }

  getOutput(clientId: string, id: string): AiAnswerDto | null {
    const row = this.db.prepare('SELECT json, status FROM ai_outputs WHERE client_id = ? AND id = ?').get(clientId, id) as Row | undefined;
    return row ? { ...(JSON.parse(String(row.json)) as AiAnswerDto), status: String(row.status) as AiAnswerDto['status'] } : null;
  }

  listOutputs(clientId: string, limit = 50, includeDismissed = false): AiOutputSummary[] {
    const rows = this.db.prepare(`SELECT json, status FROM ai_outputs WHERE client_id = ? ${includeDismissed ? '' : "AND status = 'active'"} ORDER BY generated_at DESC LIMIT ?`).all(clientId, limit) as Row[];
    return rows.map((row) => {
      const answer = JSON.parse(String(row.json)) as AiAnswerDto;
      return { id: answer.id, kind: answer.kind, title: answer.title, question: answer.question, status: String(row.status) as AiAnswerDto['status'], generatedAt: answer.meta.generatedAt, model: answer.meta.model };
    });
  }

  setOutputStatus(clientId: string, id: string, status: 'active' | 'dismissed'): boolean {
    return this.db.prepare('UPDATE ai_outputs SET status = ? WHERE client_id = ? AND id = ?').run(status, clientId, id).changes > 0;
  }

  latestOutput(clientId: string, kind: string): AiAnswerDto | null {
    const row = this.db.prepare('SELECT json FROM ai_outputs WHERE client_id = ? AND kind = ? ORDER BY generated_at DESC LIMIT 1').get(clientId, kind) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as AiAnswerDto) : null;
  }

  // ------------------------------------------------------------ settings

  getSettings(clientId: string): AiSettingsDto {
    const row = this.db.prepare('SELECT json FROM ai_settings WHERE client_id = ?').get(clientId) as Row | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    const saved = JSON.parse(String(row.json)) as Partial<AiSettingsDto>;
    return { enabled: saved.enabled ?? true, briefing: { ...DEFAULT_SETTINGS.briefing, ...(saved.briefing ?? {}) } };
  }

  saveSettings(clientId: string, settings: AiSettingsDto, now: string) {
    this.db.prepare('INSERT INTO ai_settings (client_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(clientId, JSON.stringify(settings), now);
  }

  clientsWithBriefings(): string[] {
    return (this.db.prepare('SELECT client_id, json FROM ai_settings').all() as Row[])
      .filter((row) => (JSON.parse(String(row.json)) as AiSettingsDto).briefing?.schedule && (JSON.parse(String(row.json)) as AiSettingsDto).briefing.schedule !== 'off')
      .map((row) => String(row.client_id));
  }

  // ------------------------------------------------------------ related-event dismissals

  dismissRelated(clientId: string, subject: string, target: string, now: string) {
    this.db.prepare('INSERT OR REPLACE INTO ai_related_dismissed (client_id, subject, target, at) VALUES (?, ?, ?, ?)').run(clientId, subject, target, now);
  }

  dismissedRelated(clientId: string, subject: string): Set<string> {
    return new Set((this.db.prepare('SELECT target FROM ai_related_dismissed WHERE client_id = ? AND subject = ?').all(clientId, subject) as Row[]).map((row) => String(row.target)));
  }

  // ------------------------------------------------------------ briefing memory (what the last briefing already said)

  briefingSeen(clientId: string): Map<string, string> {
    return new Map((this.db.prepare('SELECT ref, fingerprint FROM ai_briefing_seen WHERE client_id = ?').all(clientId) as Row[]).map((row) => [String(row.ref), String(row.fingerprint)]));
  }

  markBriefingSeen(clientId: string, entries: Array<{ ref: string; fingerprint: string }>, now: string) {
    const statement = this.db.prepare('INSERT OR REPLACE INTO ai_briefing_seen (client_id, ref, fingerprint, at) VALUES (?, ?, ?, ?)');
    for (const entry of entries) statement.run(clientId, entry.ref, entry.fingerprint, now);
    this.db.prepare("DELETE FROM ai_briefing_seen WHERE client_id = ? AND at < datetime(?, '-60 days')").run(clientId, now);
  }

  // ------------------------------------------------------------ audit

  audit(clientId: string, actor: string, action: string, subject: string, detail: string, now: string) {
    this.db.prepare('INSERT INTO ai_audit (client_id, at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?, ?)').run(clientId, now, actor, action, subject.slice(0, 200), detail.slice(0, 500));
  }

  auditFor(clientId: string, limit = 100): AiAuditEntry[] {
    return (this.db.prepare('SELECT * FROM ai_audit WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, limit) as Row[])
      .map((row) => ({ id: Number(row.id), at: String(row.at), actor: String(row.actor), action: String(row.action), subject: String(row.subject), detail: String(row.detail) }));
  }
}
