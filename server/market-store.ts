import type { DatabaseHandle } from './source-store';
import type { Bar } from './market-providers';
import type { AssetFreshness, Granularity, LinkExplanation, LinkStatus, MarketAlertSettings } from '../src/data/marketTypes';

type Row = Record<string, unknown>;
const str = (v: unknown) => String(v ?? '');
const optStr = (v: unknown) => (v === null || v === undefined ? null : String(v));

export type StoredBar = Bar;
export type FetchState = {
  assetId: string; granularity: Granularity; lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  errorKind: string | null; failCount: number; nextRunAt: string | null; needsFull: boolean;
};
export type StoredLink = {
  eventKey: string; assetId: string; status: LinkStatus; origin: 'suggested' | 'user'; ruleId: string | null;
  explanation: LinkExplanation | null; updatedAt: string; updatedBy: string;
};
export type Snapshot = {
  eventKey: string; clientId: string; type: 'report' | 'incident'; anchorId: string; title: string; anchorAt: string; snapshotAt: string;
  categories: string[]; countries: string[]; severity: string; links: Array<{ assetId: string; ruleId: string; relevance: string }>;
};

export const DEFAULT_ALERT_SETTINGS: MarketAlertSettings = { linkAlerts: false, moveAlerts: false, movePct: 5, moveWindow: '24h', cooldownHours: 24 };

export class MarketStore {
  constructor(private readonly db: DatabaseHandle) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_bars (
        asset_id TEXT NOT NULL, granularity TEXT NOT NULL, t TEXT NOT NULL, close_at INTEGER NOT NULL,
        o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, raw_close REAL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, granularity, t)
      );
      CREATE INDEX IF NOT EXISTS market_bars_close_idx ON market_bars(asset_id, granularity, close_at);
      CREATE TABLE IF NOT EXISTS market_fetch_state (
        asset_id TEXT NOT NULL, granularity TEXT NOT NULL, last_attempt_at TEXT, last_success_at TEXT, last_error TEXT,
        error_kind TEXT, fail_count INTEGER NOT NULL DEFAULT 0, next_run_at TEXT, needs_full INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (asset_id, granularity)
      );
      CREATE TABLE IF NOT EXISTS market_watch (
        client_id TEXT NOT NULL, asset_id TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (client_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS market_links (
        client_id TEXT NOT NULL, event_key TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
        rule_id TEXT, explanation_json TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        PRIMARY KEY (client_id, event_key, asset_id)
      );
      CREATE TABLE IF NOT EXISTS market_snapshots (
        event_key TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, anchor_id TEXT NOT NULL, title TEXT NOT NULL,
        anchor_at TEXT NOT NULL, snapshot_at TEXT NOT NULL, categories_json TEXT NOT NULL, countries_json TEXT NOT NULL,
        severity TEXT NOT NULL, links_json TEXT NOT NULL, PRIMARY KEY (event_key, client_id)
      );
      CREATE TABLE IF NOT EXISTS market_alert_settings (client_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_alert_state (
        client_id TEXT NOT NULL, key TEXT NOT NULL, last_alert_at TEXT NOT NULL, PRIMARY KEY (client_id, key)
      );
    `);
  }

  // ------------------------------------------------------------ bars
  upsertBars(assetId: string, granularity: Granularity, bars: Bar[], fetchedAt: string) {
    this.db.transaction(() => this.writeBars(assetId, granularity, bars, fetchedAt))();
  }

  private writeBars(assetId: string, granularity: Granularity, bars: Bar[], fetchedAt: string) {
    const stmt = this.db.prepare(`
      INSERT INTO market_bars (asset_id, granularity, t, close_at, o, h, l, c, raw_close, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (asset_id, granularity, t) DO UPDATE SET close_at = excluded.close_at, o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, raw_close = excluded.raw_close, fetched_at = excluded.fetched_at
    `);
    for (const b of bars) stmt.run(assetId, granularity, b.t, b.closeAt, b.o, b.h, b.l, b.c, b.rawClose, fetchedAt);
  }

  replaceBars(assetId: string, granularity: Granularity, bars: Bar[], fetchedAt: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM market_bars WHERE asset_id = ? AND granularity = ?').run(assetId, granularity);
      this.writeBars(assetId, granularity, bars, fetchedAt);
    })();
  }

  getBars(assetId: string, granularity: Granularity, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER): Bar[] {
    const rows = this.db.prepare('SELECT * FROM market_bars WHERE asset_id = ? AND granularity = ? AND close_at >= ? AND close_at <= ? ORDER BY close_at').all(assetId, granularity, fromMs, toMs) as Row[];
    return rows.map(toBar);
  }

  lastBar(assetId: string, granularity: Granularity): Bar | null {
    const row = this.db.prepare('SELECT * FROM market_bars WHERE asset_id = ? AND granularity = ? ORDER BY close_at DESC LIMIT 1').get(assetId, granularity) as Row | undefined;
    return row ? toBar(row) : null;
  }

  barByT(assetId: string, granularity: Granularity, t: string): Bar | null {
    const row = this.db.prepare('SELECT * FROM market_bars WHERE asset_id = ? AND granularity = ? AND t = ?').get(assetId, granularity, t) as Row | undefined;
    return row ? toBar(row) : null;
  }

  barCount(assetId: string, granularity: Granularity) {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM market_bars WHERE asset_id = ? AND granularity = ?').get(assetId, granularity) as Row).n);
  }

  // ------------------------------------------------------------ fetch state
  getState(assetId: string, granularity: Granularity): FetchState | null {
    const r = this.db.prepare('SELECT * FROM market_fetch_state WHERE asset_id = ? AND granularity = ?').get(assetId, granularity) as Row | undefined;
    return r ? {
      assetId, granularity, lastAttemptAt: optStr(r.last_attempt_at), lastSuccessAt: optStr(r.last_success_at), lastError: optStr(r.last_error),
      errorKind: optStr(r.error_kind), failCount: Number(r.fail_count), nextRunAt: optStr(r.next_run_at), needsFull: Number(r.needs_full) === 1,
    } : null;
  }

  saveState(s: FetchState) {
    this.db.prepare(`
      INSERT INTO market_fetch_state (asset_id, granularity, last_attempt_at, last_success_at, last_error, error_kind, fail_count, next_run_at, needs_full)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (asset_id, granularity) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
        last_error = excluded.last_error, error_kind = excluded.error_kind, fail_count = excluded.fail_count, next_run_at = excluded.next_run_at, needs_full = excluded.needs_full
    `).run(s.assetId, s.granularity, s.lastAttemptAt, s.lastSuccessAt, s.lastError, s.errorKind, s.failCount, s.nextRunAt, s.needsFull ? 1 : 0);
  }

  // ------------------------------------------------------------ watchlist
  watch(clientId: string, assetId: string, now: string) {
    return this.db.prepare('INSERT OR IGNORE INTO market_watch (client_id, asset_id, added_at) VALUES (?, ?, ?)').run(clientId, assetId, now).changes > 0;
  }
  unwatch(clientId: string, assetId: string) {
    return this.db.prepare('DELETE FROM market_watch WHERE client_id = ? AND asset_id = ?').run(clientId, assetId).changes > 0;
  }
  watched(clientId: string): string[] {
    return (this.db.prepare('SELECT asset_id FROM market_watch WHERE client_id = ? ORDER BY added_at, asset_id').all(clientId) as Row[]).map((r) => str(r.asset_id));
  }
  allWatchedAssetIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT asset_id FROM market_watch').all() as Row[]).map((r) => str(r.asset_id));
  }
  watchersOf(assetId: string): string[] {
    return (this.db.prepare('SELECT client_id FROM market_watch WHERE asset_id = ?').all(assetId) as Row[]).map((r) => str(r.client_id));
  }
  clientsWithWatch(): string[] {
    return (this.db.prepare('SELECT DISTINCT client_id FROM market_watch').all() as Row[]).map((r) => str(r.client_id));
  }

  // ------------------------------------------------------------ links
  setLink(clientId: string, link: Omit<StoredLink, 'updatedAt'> & { updatedAt: string }) {
    this.db.prepare(`
      INSERT INTO market_links (client_id, event_key, asset_id, status, origin, rule_id, explanation_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id, event_key, asset_id) DO UPDATE SET status = excluded.status, origin = excluded.origin, rule_id = excluded.rule_id,
        explanation_json = excluded.explanation_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(clientId, link.eventKey, link.assetId, link.status, link.origin, link.ruleId, link.explanation ? JSON.stringify(link.explanation) : null, link.updatedAt, link.updatedBy);
  }
  deleteLink(clientId: string, eventKey: string, assetId: string) {
    return this.db.prepare('DELETE FROM market_links WHERE client_id = ? AND event_key = ? AND asset_id = ?').run(clientId, eventKey, assetId).changes > 0;
  }
  linksFor(clientId: string, eventKeys: string[]): StoredLink[] {
    if (eventKeys.length === 0) return [];
    const marks = eventKeys.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM market_links WHERE client_id = ? AND event_key IN (${marks})`).all(clientId, ...eventKeys) as Row[]).map(toLink);
  }
  linksForAsset(clientId: string, assetId: string): StoredLink[] {
    return (this.db.prepare('SELECT * FROM market_links WHERE client_id = ? AND asset_id = ?').all(clientId, assetId) as Row[]).map(toLink);
  }
  confirmedAssetIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT asset_id FROM market_links WHERE status = 'confirmed'").all() as Row[]).map((r) => str(r.asset_id));
  }

  // ------------------------------------------------------------ snapshots (point-in-time classification)
  insertSnapshot(s: Snapshot) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO market_snapshots (event_key, client_id, type, anchor_id, title, anchor_at, snapshot_at, categories_json, countries_json, severity, links_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.eventKey, s.clientId, s.type, s.anchorId, s.title, s.anchorAt, s.snapshotAt, JSON.stringify(s.categories), JSON.stringify(s.countries), s.severity, JSON.stringify(s.links)).changes > 0;
  }
  snapshots(clientId: string): Snapshot[] {
    return (this.db.prepare("SELECT * FROM market_snapshots WHERE client_id IN ('', ?) ORDER BY anchor_at").all(clientId) as Row[]).map((r) => ({
      eventKey: str(r.event_key), clientId: str(r.client_id), type: r.type === 'incident' ? 'incident' : 'report', anchorId: str(r.anchor_id), title: str(r.title),
      anchorAt: str(r.anchor_at), snapshotAt: str(r.snapshot_at), categories: JSON.parse(str(r.categories_json)), countries: JSON.parse(str(r.countries_json)),
      severity: str(r.severity), links: JSON.parse(str(r.links_json)),
    }));
  }
  snapshotKeys(clientId: string): Set<string> {
    return new Set((this.db.prepare("SELECT event_key FROM market_snapshots WHERE client_id IN ('', ?)").all(clientId) as Row[]).map((r) => str(r.event_key)));
  }

  // ------------------------------------------------------------ alert settings and state
  getAlertSettings(clientId: string): MarketAlertSettings {
    const r = this.db.prepare('SELECT json FROM market_alert_settings WHERE client_id = ?').get(clientId) as Row | undefined;
    return r ? { ...DEFAULT_ALERT_SETTINGS, ...JSON.parse(str(r.json)) } : { ...DEFAULT_ALERT_SETTINGS };
  }
  saveAlertSettings(clientId: string, settings: MarketAlertSettings, now: string) {
    this.db.prepare(`INSERT INTO market_alert_settings (client_id, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (client_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(clientId, JSON.stringify(settings), now);
  }
  alertedAt(clientId: string, key: string): string | null {
    return optStr((this.db.prepare('SELECT last_alert_at FROM market_alert_state WHERE client_id = ? AND key = ?').get(clientId, key) as Row | undefined)?.last_alert_at);
  }
  markAlerted(clientId: string, key: string, at: string) {
    this.db.prepare(`INSERT INTO market_alert_state (client_id, key, last_alert_at) VALUES (?, ?, ?)
      ON CONFLICT (client_id, key) DO UPDATE SET last_alert_at = excluded.last_alert_at`).run(clientId, key, at);
  }
}

const toBar = (r: Row): Bar => ({ t: str(r.t), closeAt: Number(r.close_at), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), rawClose: r.raw_close === null ? null : Number(r.raw_close) });
const toLink = (r: Row): StoredLink => ({
  eventKey: str(r.event_key), assetId: str(r.asset_id), status: str(r.status) as LinkStatus, origin: r.origin === 'user' ? 'user' : 'suggested', ruleId: optStr(r.rule_id),
  explanation: r.explanation_json ? JSON.parse(str(r.explanation_json)) : null, updatedAt: str(r.updated_at), updatedBy: str(r.updated_by),
});

export type { AssetFreshness };
