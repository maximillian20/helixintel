import Database from 'better-sqlite3';

export type DatabaseHandle = InstanceType<typeof Database>;
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainText } from './text';

export type SyncStatus = 'healthy' | 'stale' | 'unavailable' | 'not_checked' | 'setup_required';

export type SourceDefinition = {
  id: string;
  name: string;
  url: string;
  format: string;
  coverage: string;
  cadence: string;
  attribution: string;
  termsUrl: string;
  /** Which connector fetches this source. Defaults to the generic RSS reader. */
  connector?: 'rss' | 'gdacs' | 'gdelt' | 'cisa-kev' | 'reliefweb' | 'eia' | 'acled';
  kind?: 'news' | 'hazard' | 'humanitarian' | 'cyber' | 'energy';
  /** How often the source is checked. Defaults to the global polling interval. */
  intervalMs?: number;
  /** Present when the source needs a free credential that is configured on the server. */
  credential?: { envVars: string[]; instructions: string; signupUrl: string };
};

/** Source-provided structure that the headline and summary alone cannot give. */
export type ArticleEnrichment = {
  category?: string;
  /** Countries affected by the event, from source metadata. Omit when the source gives none. */
  countryCodes?: string[];
  /** True when the item applies worldwide rather than to a place (e.g. a software vulnerability). */
  global?: boolean;
  location?: { lat: number; lng: number; label: string };
  severity?: { value: 'Critical' | 'High' | 'Medium' | 'Low'; reason: string; method: 'source' | 'rules' };
};

export type NormalizedArticle = {
  sourceRecordId: string;
  canonicalUrl: string;
  headline: string;
  summary: string;
  publishedAt: string;
  sourceModifiedAt: string | null;
  enrichment?: ArticleEnrichment;
};

export type SyncState = {
  sourceId: string;
  status: SyncStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  nextRunAt: string | null;
  etag: string | null;
  lastModified: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export type StoredArticle = Omit<NormalizedArticle, 'enrichment'> & {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  lastCheckedAt: string;
  verificationStatus: 'publisher_provided';
  attribution: string;
};

export type AssessmentRow = {
  articleId: string;
  severity: string;
  impact: number;
  scope: number;
  urgency: number;
  categories: string[];
  strongCount: number;
  deaths: number | null;
  deathsStated: boolean;
  injured: number | null;
  hedged: boolean;
  rationale: string;
  countryCodes: string[];
  /** 'source' when the provider supplied the severity, otherwise 'rules'. */
  method: 'source' | 'rules';
  classifierVersion: string;
  classifiedAt: string;
};

export type UserItemState = {
  articleId: string;
  reviewStatus: 'Reviewed' | 'Unreviewed';
  reviewedAt: string | null;
  reviewedBy: string | null;
  severityOverride: string | null;
  severityOverrideAt: string | null;
  watchlisted: boolean;
  watchlistedAt: string | null;
};

export type UserItemStatePatch = {
  reviewStatus?: 'Reviewed' | 'Unreviewed';
  reviewedBy?: string | null;
  watchlisted?: boolean;
  /** A severity string sets an override; null clears it. */
  severityOverride?: string | null;
};

export type SourceChange = {
  changeId: number;
  sourceId: string;
  recordId: string;
  headline: string;
  changedAt: string;
  fields: Array<{ field: string; previous: string; current: string }>;
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = resolve(moduleDirectory, '../data/source-store.sqlite');

export class SourceStore {
  private readonly database: Database.Database;

  constructor(databasePath = process.env.SOURCE_DB_PATH || defaultDatabasePath) {
    if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS source_records (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        source_record_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        published_at TEXT NOT NULL,
        source_modified_at TEXT,
        retrieved_at TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        attribution TEXT NOT NULL,
        UNIQUE(source_id, canonical_url)
      );
      CREATE INDEX IF NOT EXISTS source_records_published_idx ON source_records(published_at DESC);
      CREATE TABLE IF NOT EXISTS source_sync_state (
        source_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_checked_at TEXT,
        next_run_at TEXT,
        etag TEXT,
        last_modified TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS source_changes (
        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        headline TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        fields_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS source_changes_source_idx ON source_changes(source_id, changed_at DESC);
      CREATE TABLE IF NOT EXISTS source_sync_leases (
        lease_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS item_assessments (
        article_id TEXT PRIMARY KEY REFERENCES source_records(id) ON DELETE CASCADE,
        severity TEXT NOT NULL,
        impact INTEGER NOT NULL,
        scope INTEGER NOT NULL,
        urgency INTEGER NOT NULL,
        categories_json TEXT NOT NULL,
        strong_count INTEGER NOT NULL,
        deaths INTEGER,
        deaths_stated INTEGER NOT NULL DEFAULT 0,
        injured INTEGER,
        hedged INTEGER NOT NULL DEFAULT 0,
        rationale TEXT NOT NULL,
        country_codes_json TEXT NOT NULL,
        classifier_version TEXT NOT NULL,
        classified_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS item_user_state (
        client_id TEXT NOT NULL,
        article_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
        review_status TEXT NOT NULL DEFAULT 'Unreviewed',
        reviewed_at TEXT,
        reviewed_by TEXT,
        severity_override TEXT,
        severity_override_at TEXT,
        watchlisted INTEGER NOT NULL DEFAULT 0,
        watchlisted_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (client_id, article_id)
      );
      CREATE TABLE IF NOT EXISTS record_enrichment (
        article_id TEXT PRIMARY KEY REFERENCES source_records(id) ON DELETE CASCADE,
        enrichment_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_checks (
        source_id TEXT NOT NULL,
        day TEXT NOT NULL,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, day)
      );
      CREATE INDEX IF NOT EXISTS item_user_state_watch_idx ON item_user_state(client_id, watchlisted);
    `);
    this.addColumnIfMissing('source_records', 'source_name', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('source_records', 'source_url', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('item_assessments', 'method', "TEXT NOT NULL DEFAULT 'rules'");
    // One-time vocabulary migration: Moderate -> Medium, Watch -> Low (manual corrections are kept).
    this.database.exec(`
      UPDATE item_user_state SET severity_override = 'Medium' WHERE severity_override = 'Moderate';
      UPDATE item_user_state SET severity_override = 'Low' WHERE severity_override = 'Watch';
    `);
  }

  getSyncStates() {
    return this.database.prepare('SELECT * FROM source_sync_state').all().map((row) => this.mapSyncState(row));
  }

  getSyncState(sourceId: string) {
    const row = this.database.prepare('SELECT * FROM source_sync_state WHERE source_id = ?').get(sourceId);
    return row ? this.mapSyncState(row) : undefined;
  }

  getRecords(sourceId?: string) {
    const rows = sourceId
      ? this.database.prepare('SELECT * FROM source_records WHERE source_id = ? ORDER BY published_at DESC').all(sourceId)
      : this.database.prepare('SELECT * FROM source_records ORDER BY published_at DESC').all();
    return rows.map((row) => this.mapArticle(row));
  }

  getRecentChanges(sourceId: string, limit = 25): SourceChange[] {
    const rows = this.database.prepare(`
      SELECT change_id, source_id, record_id, headline, changed_at, fields_json
      FROM source_changes
      WHERE source_id = ?
      ORDER BY changed_at DESC
      LIMIT ?
    `).all(sourceId, Math.max(1, Math.min(limit, 100)));

    return rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        changeId: Number(value.change_id),
        sourceId: String(value.source_id),
        recordId: String(value.record_id),
        headline: String(value.headline),
        changedAt: String(value.changed_at),
        fields: JSON.parse(String(value.fields_json)) as SourceChange['fields'],
      };
    });
  }

  acquireSyncLease(ownerId: string, now: Date, leaseUntil: Date) {
    const result = this.database.prepare(`
      INSERT INTO source_sync_leases (lease_key, owner_id, expires_at)
      VALUES ('rss-poller', ?, ?)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        expires_at = excluded.expires_at
      WHERE source_sync_leases.expires_at <= ?
    `).run(ownerId, leaseUntil.toISOString(), now.toISOString());
    return result.changes === 1;
  }

  /** Repairs stored records saved before summaries were converted to plain text (some feeds send HTML). */
  cleanStoredText() {
    const rows = this.database.prepare("SELECT id, headline, summary FROM source_records WHERE headline LIKE '%<%' OR summary LIKE '%<%' OR summary LIKE '%&lt;%' OR summary LIKE '%&amp;%'").all() as Array<{ id: string; headline: string; summary: string }>;
    const update = this.database.prepare('UPDATE source_records SET headline = ?, summary = ? WHERE id = ?');
    for (const row of rows) update.run(plainText(row.headline).slice(0, 500) || row.headline, plainText(row.summary).slice(0, 4000), row.id);
    return rows.length;
  }

  releaseSyncLease(ownerId: string) {
    return this.database.prepare(`
      DELETE FROM source_sync_leases WHERE lease_key = 'rss-poller' AND owner_id = ?
    `).run(ownerId).changes === 1;
  }

  markNotModified(
    sourceId: string,
    checkedAt: string,
    nextRunAt: string,
    etag: string | null,
    lastModified: string | null,
  ) {
    this.database.prepare(`
      INSERT INTO source_sync_state (
        source_id, status, last_attempt_at, last_success_at, last_checked_at,
        next_run_at, etag, last_modified, consecutive_failures, last_error
      ) VALUES (?, 'healthy', ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(source_id) DO UPDATE SET
        status = 'healthy',
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_checked_at = excluded.last_checked_at,
        next_run_at = excluded.next_run_at,
        etag = COALESCE(excluded.etag, source_sync_state.etag),
        last_modified = COALESCE(excluded.last_modified, source_sync_state.last_modified),
        consecutive_failures = 0,
        last_error = NULL
    `).run(sourceId, checkedAt, checkedAt, checkedAt, nextRunAt, etag, lastModified);
    this.recordCheck(sourceId, checkedAt, true);

    this.database.prepare('UPDATE source_records SET last_checked_at = ? WHERE source_id = ?')
      .run(checkedAt, sourceId);
  }

  saveSuccessfulSync(input: {
    source: SourceDefinition;
    articles: NormalizedArticle[];
    checkedAt: string;
    nextRunAt: string;
    etag: string | null;
    lastModified: string | null;
  }) {
    const insertRecord = this.database.prepare(`
      INSERT INTO source_records (
        id, source_id, source_name, source_url, source_record_id, canonical_url, headline, summary,
        published_at, source_modified_at, retrieved_at, last_checked_at,
        verification_status, attribution
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publisher_provided', ?)
      ON CONFLICT(id) DO UPDATE SET
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        source_record_id = excluded.source_record_id,
        canonical_url = excluded.canonical_url,
        headline = excluded.headline,
        summary = excluded.summary,
        published_at = excluded.published_at,
        source_modified_at = excluded.source_modified_at,
        retrieved_at = excluded.retrieved_at,
        last_checked_at = excluded.last_checked_at,
        attribution = excluded.attribution
    `);
    const getExisting = this.database.prepare('SELECT * FROM source_records WHERE id = ?');
    const getEnrichmentJson = this.database.prepare('SELECT enrichment_json FROM record_enrichment WHERE article_id = ?');
    const upsertEnrichment = this.database.prepare(`
      INSERT INTO record_enrichment (article_id, enrichment_json) VALUES (?, ?)
      ON CONFLICT(article_id) DO UPDATE SET enrichment_json = excluded.enrichment_json
    `);
    const dropAssessment = this.database.prepare('DELETE FROM item_assessments WHERE article_id = ?');
    const insertChange = this.database.prepare(`
      INSERT INTO source_changes (source_id, record_id, headline, changed_at, fields_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    let newCount = 0;
    let updatedCount = 0;
    const changedFieldsForId = new Map<string, boolean>();

    const transaction = this.database.transaction(() => {
      for (const article of input.articles) {
        const id = `${input.source.id}:${article.canonicalUrl}`;
        const existing = getExisting.get(id) as Record<string, unknown> | undefined;
        if (!existing) newCount += 1;

        const changedFields: SourceChange['fields'] = [];
        if (existing) {
          for (const field of ['headline', 'summary', 'published_at'] as const) {
            const nextValue = field === 'published_at' ? article.publishedAt : article[field === 'headline' ? 'headline' : 'summary'];
            const previousValue = String(existing[field] ?? '');
            if (previousValue !== nextValue) {
              changedFields.push({ field, previous: previousValue, current: nextValue });
            }
          }
          if (changedFields.length > 0) {
            changedFieldsForId.set(id, true);
            updatedCount += 1;
            insertChange.run(input.source.id, id, article.headline, input.checkedAt, JSON.stringify(changedFields));
          }
        }

        insertRecord.run(
          id,
          input.source.id,
          input.source.name,
          input.source.url,
          article.sourceRecordId,
          article.canonicalUrl,
          article.headline,
          article.summary,
          article.publishedAt,
          article.sourceModifiedAt,
          input.checkedAt,
          input.checkedAt,
          input.source.attribution,
        );

        // Only new or changed content is (re)assessed: a changed headline, summary or source metadata
        // drops the stored assessment so it is recomputed once. User state is never touched here.
        const enrichmentJson = article.enrichment ? JSON.stringify(article.enrichment) : null;
        const previousEnrichment = (getEnrichmentJson.get(id) as { enrichment_json: string } | undefined)?.enrichment_json ?? null;
        if (enrichmentJson !== previousEnrichment) {
          if (enrichmentJson) upsertEnrichment.run(id, enrichmentJson);
          else this.database.prepare('DELETE FROM record_enrichment WHERE article_id = ?').run(id);
          if (existing) dropAssessment.run(id);
        }
        if (existing && changedFieldsForId.get(id)) dropAssessment.run(id);
      }

      this.database.prepare(`
        INSERT INTO source_sync_state (
          source_id, status, last_attempt_at, last_success_at, last_checked_at,
          next_run_at, etag, last_modified, consecutive_failures, last_error
        ) VALUES (?, 'healthy', ?, ?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(source_id) DO UPDATE SET
          status = 'healthy',
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          last_checked_at = excluded.last_checked_at,
          next_run_at = excluded.next_run_at,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          consecutive_failures = 0,
          last_error = NULL
      `).run(
        input.source.id,
        input.checkedAt,
        input.checkedAt,
        input.checkedAt,
        input.nextRunAt,
        input.etag,
        input.lastModified,
      );
    });

    transaction();
    this.recordCheck(input.source.id, input.checkedAt, true);
    return { newCount, updatedCount };
  }

  markFailure(sourceId: string, attemptedAt: string, nextRunAt: string, error: string) {
    const current = this.getSyncState(sourceId);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    const status = current?.lastSuccessAt ? 'stale' : 'unavailable';

    this.database.prepare(`
      INSERT INTO source_sync_state (
        source_id, status, last_attempt_at, last_success_at, last_checked_at,
        next_run_at, etag, last_modified, consecutive_failures, last_error
      ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        status = excluded.status,
        last_attempt_at = excluded.last_attempt_at,
        next_run_at = excluded.next_run_at,
        consecutive_failures = excluded.consecutive_failures,
        last_error = excluded.last_error
    `).run(sourceId, status, attemptedAt, nextRunAt, failures, error);

    this.recordCheck(sourceId, attemptedAt, false);
    return { status, consecutiveFailures: failures };
  }

  countRecords() {
    return Number((this.database.prepare('SELECT COUNT(*) AS total FROM source_records').get() as { total: number }).total);
  }

  getEnrichments(): Map<string, ArticleEnrichment> {
    const rows = this.database.prepare('SELECT article_id, enrichment_json FROM record_enrichment').all() as Array<{ article_id: string; enrichment_json: string }>;
    return new Map(rows.map((row) => [row.article_id, JSON.parse(row.enrichment_json) as ArticleEnrichment]));
  }

  getAssessments(): Map<string, AssessmentRow> {
    const rows = this.database.prepare('SELECT * FROM item_assessments').all() as Array<Record<string, unknown>>;
    return new Map(rows.map((value) => [String(value.article_id), {
      articleId: String(value.article_id),
      severity: String(value.severity),
      impact: Number(value.impact),
      scope: Number(value.scope),
      urgency: Number(value.urgency),
      categories: JSON.parse(String(value.categories_json)) as string[],
      strongCount: Number(value.strong_count),
      deaths: value.deaths === null ? null : Number(value.deaths),
      deathsStated: Number(value.deaths_stated) === 1,
      injured: value.injured === null ? null : Number(value.injured),
      hedged: Number(value.hedged) === 1,
      rationale: String(value.rationale),
      countryCodes: JSON.parse(String(value.country_codes_json)) as string[],
      method: value.method === 'source' ? 'source' : 'rules',
      classifierVersion: String(value.classifier_version),
      classifiedAt: String(value.classified_at),
    }]));
  }

  saveAssessments(rows: AssessmentRow[]) {
    const upsert = this.database.prepare(`
      INSERT INTO item_assessments (
        article_id, severity, impact, scope, urgency, categories_json, strong_count, deaths, deaths_stated,
        injured, hedged, rationale, country_codes_json, method, classifier_version, classified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(article_id) DO UPDATE SET
        severity = excluded.severity,
        impact = excluded.impact,
        scope = excluded.scope,
        urgency = excluded.urgency,
        categories_json = excluded.categories_json,
        strong_count = excluded.strong_count,
        deaths = excluded.deaths,
        deaths_stated = excluded.deaths_stated,
        injured = excluded.injured,
        hedged = excluded.hedged,
        rationale = excluded.rationale,
        country_codes_json = excluded.country_codes_json,
        method = excluded.method,
        classifier_version = excluded.classifier_version,
        classified_at = excluded.classified_at
    `);
    const run = this.database.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.articleId, row.severity, row.impact, row.scope, row.urgency, JSON.stringify(row.categories),
          row.strongCount, row.deaths, row.deathsStated ? 1 : 0, row.injured, row.hedged ? 1 : 0,
          row.rationale, JSON.stringify(row.countryCodes), row.method, row.classifierVersion, row.classifiedAt,
        );
      }
    });
    run();
  }

  getUserStates(clientId: string): Map<string, UserItemState> {
    const rows = this.database.prepare('SELECT * FROM item_user_state WHERE client_id = ?').all(clientId);
    return new Map(rows.map((row) => {
      const state = this.mapUserState(row);
      return [state.articleId, state];
    }));
  }

  /** Applies a partial change to one client's state for one article. Returns undefined if the article does not exist. */
  updateUserState(clientId: string, articleId: string, patch: UserItemStatePatch, now: string): UserItemState | undefined {
    const exists = this.database.prepare('SELECT 1 AS found FROM source_records WHERE id = ?').get(articleId);
    if (!exists) return undefined;

    const apply = this.database.transaction(() => {
      const row = this.database.prepare('SELECT * FROM item_user_state WHERE client_id = ? AND article_id = ?').get(clientId, articleId);
      const current: UserItemState = row ? this.mapUserState(row) : {
        articleId,
        reviewStatus: 'Unreviewed',
        reviewedAt: null,
        reviewedBy: null,
        severityOverride: null,
        severityOverrideAt: null,
        watchlisted: false,
        watchlistedAt: null,
      };
      const next = { ...current };

      if (patch.reviewStatus !== undefined) {
        next.reviewStatus = patch.reviewStatus;
        if (patch.reviewStatus === 'Reviewed') {
          if (current.reviewStatus !== 'Reviewed') next.reviewedAt = now;
          next.reviewedBy = patch.reviewedBy ?? current.reviewedBy;
        } else {
          next.reviewedAt = null;
          next.reviewedBy = null;
        }
      }
      if (patch.watchlisted !== undefined) {
        next.watchlisted = patch.watchlisted;
        if (patch.watchlisted) {
          if (!current.watchlisted) next.watchlistedAt = now;
        } else {
          next.watchlistedAt = null;
        }
      }
      if (patch.severityOverride !== undefined) {
        next.severityOverride = patch.severityOverride;
        next.severityOverrideAt = patch.severityOverride === null ? null : now;
      }

      this.database.prepare(`
        INSERT INTO item_user_state (
          client_id, article_id, review_status, reviewed_at, reviewed_by, severity_override,
          severity_override_at, watchlisted, watchlisted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id, article_id) DO UPDATE SET
          review_status = excluded.review_status,
          reviewed_at = excluded.reviewed_at,
          reviewed_by = excluded.reviewed_by,
          severity_override = excluded.severity_override,
          severity_override_at = excluded.severity_override_at,
          watchlisted = excluded.watchlisted,
          watchlisted_at = excluded.watchlisted_at,
          updated_at = excluded.updated_at
      `).run(
        clientId, articleId, next.reviewStatus, next.reviewedAt, next.reviewedBy, next.severityOverride,
        next.severityOverrideAt, next.watchlisted ? 1 : 0, next.watchlistedAt, now,
      );
      return next;
    });
    return apply();
  }

  /** Counts one check against its UTC day. Used to tell "no events" apart from "source was not being read". */
  private recordCheck(sourceId: string, at: string, ok: boolean) {
    this.database.prepare(`
      INSERT INTO source_checks (source_id, day, successes, failures) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, day) DO UPDATE SET
        successes = successes + excluded.successes,
        failures = failures + excluded.failures
    `).run(sourceId, at.slice(0, 10), ok ? 1 : 0, ok ? 0 : 1);
  }

  getChecks(sourceId: string): Array<{ day: string; successes: number; failures: number }> {
    return (this.database.prepare('SELECT day, successes, failures FROM source_checks WHERE source_id = ? ORDER BY day').all(sourceId) as Array<Record<string, unknown>>)
      .map((row) => ({ day: String(row.day), successes: Number(row.successes), failures: Number(row.failures) }));
  }

  /**
   * Removes records that are confirmed demo content (source "demo" with verification status "demo").
   * Real records and any user work attached to them are never matched.
   */
  purgeDemoRecords(): number {
    return this.database.prepare("DELETE FROM source_records WHERE source_id = 'demo' AND verification_status = 'demo'").run().changes;
  }

  /** Newest publication time among a source's stored records. */
  latestPublished(sourceId: string): string | null {
    const row = this.database.prepare('SELECT MAX(published_at) AS latest FROM source_records WHERE source_id = ?').get(sourceId) as { latest: string | null };
    return row.latest ?? null;
  }

  /** Shared database handle for the analysis stores (incidents, assessments, alerts). */
  get handle(): DatabaseHandle {
    return this.database;
  }

  close() {
    this.database.close();
  }

  private addColumnIfMissing(table: string, column: string, declaration: string) {
    const columns = this.database.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  private mapUserState(row: unknown): UserItemState {
    const value = row as Record<string, unknown>;
    return {
      articleId: String(value.article_id),
      reviewStatus: value.review_status === 'Reviewed' ? 'Reviewed' : 'Unreviewed',
      reviewedAt: value.reviewed_at ? String(value.reviewed_at) : null,
      reviewedBy: value.reviewed_by ? String(value.reviewed_by) : null,
      severityOverride: value.severity_override ? String(value.severity_override) : null,
      severityOverrideAt: value.severity_override_at ? String(value.severity_override_at) : null,
      watchlisted: Number(value.watchlisted) === 1,
      watchlistedAt: value.watchlisted_at ? String(value.watchlisted_at) : null,
    };
  }

  private mapSyncState(row: unknown): SyncState {
    const value = row as Record<string, unknown>;
    return {
      sourceId: String(value.source_id),
      status: String(value.status) as SyncStatus,
      lastAttemptAt: value.last_attempt_at ? String(value.last_attempt_at) : null,
      lastSuccessAt: value.last_success_at ? String(value.last_success_at) : null,
      lastCheckedAt: value.last_checked_at ? String(value.last_checked_at) : null,
      nextRunAt: value.next_run_at ? String(value.next_run_at) : null,
      etag: value.etag ? String(value.etag) : null,
      lastModified: value.last_modified ? String(value.last_modified) : null,
      consecutiveFailures: Number(value.consecutive_failures),
      lastError: value.last_error ? String(value.last_error) : null,
    };
  }

  private mapArticle(row: unknown): StoredArticle {
    const value = row as Record<string, unknown>;
    return {
      id: String(value.id),
      sourceId: String(value.source_id),
      sourceRecordId: String(value.source_record_id),
      canonicalUrl: String(value.canonical_url),
      headline: String(value.headline),
      summary: String(value.summary),
      publishedAt: String(value.published_at),
      sourceModifiedAt: value.source_modified_at ? String(value.source_modified_at) : null,
      sourceName: String(value.source_name ?? ''),
      sourceUrl: String(value.source_url ?? ''),
      retrievedAt: String(value.retrieved_at),
      lastCheckedAt: String(value.last_checked_at),
      verificationStatus: 'publisher_provided',
      attribution: String(value.attribution),
    };
  }
}
