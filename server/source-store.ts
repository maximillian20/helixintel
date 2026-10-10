import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SyncStatus = 'healthy' | 'stale' | 'unavailable' | 'not_checked';

export type SourceDefinition = {
  id: string;
  name: string;
  url: string;
  format: string;
  coverage: string;
  cadence: string;
  attribution: string;
  termsUrl: string;
};

export type NormalizedArticle = {
  sourceRecordId: string;
  canonicalUrl: string;
  headline: string;
  summary: string;
  publishedAt: string;
  sourceModifiedAt: string | null;
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

export type StoredArticle = NormalizedArticle & {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  lastCheckedAt: string;
  verificationStatus: 'publisher_provided';
  attribution: string;
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
    `);
    this.addColumnIfMissing('source_records', 'source_name', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('source_records', 'source_url', "TEXT NOT NULL DEFAULT ''");
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
    const insertChange = this.database.prepare(`
      INSERT INTO source_changes (source_id, record_id, headline, changed_at, fields_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    let newCount = 0;
    let updatedCount = 0;

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

    return { status, consecutiveFailures: failures };
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
