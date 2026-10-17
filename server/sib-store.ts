import { randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError } from './analysis-store';
import type { DatabaseHandle } from './source-store';
import { approvalBlockers, type SibAiMeta, type SibAuditEntry, type SibEvidence, type SibFields, type SibRecord, type SibSourceRef, type SibSummary } from '../src/data/sibTypes';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newId = () => `SIB-${Array.from(randomBytes(6), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`;

export const SIB_ID_PATTERN = /^SIB-[A-Z0-9]{6}$/;

type Row = Record<string, unknown>;

/** Bulletins are private to the browser (client id) that created them, like incidents and assessments. */
export class SibStore {
  constructor(private readonly db: DatabaseHandle) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sibs (
        client_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (client_id, id)
      );
      CREATE TABLE IF NOT EXISTS sib_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, sib_id TEXT NOT NULL,
        at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sib_audit ON sib_audit (client_id, sib_id);
    `);
  }

  private audit(clientId: string, sibId: string, actor: string, type: string, detail: string, at: string) {
    this.db.prepare('INSERT INTO sib_audit (client_id, sib_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?, ?)').run(clientId, sibId, at, actor, type, detail);
  }

  private save(clientId: string, sib: SibRecord) {
    this.db.prepare('UPDATE sibs SET json = ?, status = ?, updated_at = ? WHERE client_id = ? AND id = ?').run(JSON.stringify(sib), sib.status, sib.updatedAt, clientId, sib.id);
  }

  get(clientId: string, id: string): SibRecord | null {
    const row = this.db.prepare('SELECT json FROM sibs WHERE client_id = ? AND id = ?').get(clientId, id) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as SibRecord) : null;
  }

  private owned(clientId: string, id: string): SibRecord {
    const sib = this.get(clientId, id);
    if (!sib) throw new NotFoundError('That bulletin does not exist.');
    return sib;
  }

  list(clientId: string): SibSummary[] {
    const rows = this.db.prepare('SELECT json FROM sibs WHERE client_id = ? ORDER BY updated_at DESC').all(clientId) as Row[];
    return rows.map((row) => {
      const { id, title, classification, severity, status, revision, source, createdAt, updatedAt, approvedAt, approvedBy } = JSON.parse(String(row.json)) as SibRecord;
      return { id, title, classification, severity, status, revision, source, createdAt, updatedAt, approvedAt, approvedBy };
    });
  }

  auditFor(clientId: string, id: string): SibAuditEntry[] {
    return (this.db.prepare('SELECT * FROM sib_audit WHERE client_id = ? AND sib_id = ? ORDER BY id DESC').all(clientId, id) as Row[])
      .map((row) => ({ id: Number(row.id), at: String(row.at), actor: String(row.actor), type: String(row.type), detail: String(row.detail) }));
  }

  create(clientId: string, actor: string, input: { fields: SibFields; source: SibSourceRef; evidence: SibEvidence[]; ai?: SibAiMeta }, now: string): SibRecord {
    let id = newId();
    while (this.get(clientId, id)) id = newId();
    const sib: SibRecord = {
      ...input.fields, id, status: 'Draft', revision: 0, source: input.source, evidence: input.evidence, createdBy: actor,
      createdAt: now, updatedAt: now, approvedAt: null, approvedBy: null, snapshotAt: now,
      ...(input.ai ? { ai: input.ai } : {}),
    };
    this.db.prepare('INSERT INTO sibs (client_id, id, json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(clientId, id, JSON.stringify(sib), sib.status, now, now);
    this.audit(clientId, id, actor, 'created', input.ai ? `Drafted with AI (${input.ai.model}) from ${input.source.label}. Not approved; ${input.ai.recordIds.length} supporting records.` : `Drafted from ${input.source.label}.`, now);
    return sib;
  }

  update(clientId: string, actor: string, id: string, patch: Partial<SibFields>, now: string): SibRecord {
    const current = this.owned(clientId, id);
    if (current.status === 'Approved') throw new ValidationError('An approved bulletin is locked. Reopen it as a draft to edit it.');
    const changed = (Object.keys(patch) as Array<keyof SibFields>).filter((key) => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(current[key]));
    if (changed.length === 0) return current;
    const next: SibRecord = { ...current, ...patch, updatedAt: now };
    this.save(clientId, next);
    this.audit(clientId, id, actor, 'edited', `Changed: ${changed.join(', ')}.`, now);
    return next;
  }

  approve(clientId: string, actor: string, id: string, now: string): SibRecord {
    const current = this.owned(clientId, id);
    if (current.status === 'Approved') throw new ValidationError('This bulletin is already approved.');
    const blockers = approvalBlockers(current);
    if (blockers.length > 0) throw new ValidationError(`Cannot approve yet. ${blockers.join(' ')}`);
    const next: SibRecord = { ...current, status: 'Approved', revision: current.revision + 1, approvedAt: now, approvedBy: actor, updatedAt: now };
    this.save(clientId, next);
    this.audit(clientId, id, actor, 'approved', `Approved as revision ${next.revision}.`, now);
    return next;
  }

  reopen(clientId: string, actor: string, id: string, now: string): SibRecord {
    const current = this.owned(clientId, id);
    if (current.status !== 'Approved') throw new ValidationError('Only an approved bulletin can be reopened.');
    const next: SibRecord = { ...current, status: 'Draft', approvedAt: null, approvedBy: null, updatedAt: now, ...(current.ai ? { ai: { ...current.ai, confirmedBy: null, confirmedAt: null } } : {}) };
    this.save(clientId, next);
    this.audit(clientId, id, actor, 'reopened', `Reopened as a draft; the approval of revision ${current.revision} by ${current.approvedBy ?? 'an unrecorded approver'} no longer applies.`, now);
    return next;
  }

  /** The explicit step that says a person has read and corrected an AI-assisted draft. Approval is blocked until it happens. */
  confirmAi(clientId: string, actor: string, id: string, now: string): SibRecord {
    const current = this.owned(clientId, id);
    if (!current.ai) throw new ValidationError('This bulletin was not drafted with AI.');
    if (current.status === 'Approved') throw new ValidationError('An approved bulletin is locked.');
    const next: SibRecord = { ...current, ai: { ...current.ai, confirmedBy: actor, confirmedAt: now }, updatedAt: now };
    this.save(clientId, next);
    this.audit(clientId, id, actor, 'ai-confirmed', 'Confirmed that the AI-assisted text was reviewed.', now);
    return next;
  }

  refreshEvidence(clientId: string, actor: string, id: string, source: SibSourceRef, evidence: SibEvidence[], now: string): SibRecord {
    const current = this.owned(clientId, id);
    if (current.status === 'Approved') throw new ValidationError('An approved bulletin is locked. Reopen it as a draft first.');
    const next: SibRecord = { ...current, source, evidence, snapshotAt: now, updatedAt: now };
    this.save(clientId, next);
    this.audit(clientId, id, actor, 'sources-refreshed', `Source list replaced with the ${evidence.length} report${evidence.length === 1 ? '' : 's'} currently attached to ${source.label}. The text was not changed.`, now);
    return next;
  }

  remove(clientId: string, id: string) {
    const current = this.owned(clientId, id);
    if (current.status === 'Approved') throw new ValidationError('An approved bulletin cannot be deleted. Reopen it first.');
    this.db.prepare('DELETE FROM sibs WHERE client_id = ? AND id = ?').run(clientId, id);
    this.db.prepare('DELETE FROM sib_audit WHERE client_id = ? AND sib_id = ?').run(clientId, id);
  }
}
