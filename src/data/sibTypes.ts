import type { Severity } from './feedTypes';

/**
 * Security Information Bulletins (SIBs). A bulletin is always created from a real record (an incident or a saved country
 * assessment); the record's content is copied in as an editable starting point and its evidence is kept as a snapshot.
 */

export const SIB_CLASSIFICATIONS = ['Public', 'Internal', 'Internal / Restricted', 'Confidential'] as const;
export type SibClassification = (typeof SIB_CLASSIFICATIONS)[number];
export const SIB_STATUSES = ['Draft', 'Approved'] as const;
export type SibStatus = (typeof SIB_STATUSES)[number];

export type SibSourceRef =
  | { type: 'incident'; id: string; label: string }
  | { type: 'country'; code: string; label: string; version: number }
  /** A bulletin drafted straight from selected feed reports (ids are report ids). */
  | { type: 'reports'; ids: string[]; label: string };

/** Present on bulletins drafted with AI. The label stays on the bulletin; confirmation is an explicit step before approval. */
export type SibAiMeta = {
  model: string;
  modelDigest: string | null;
  promptVersion: string;
  generatedAt: string;
  /** Ids of the records the draft was grounded on. */
  recordIds: string[];
  outputId: string;
  /** Who confirmed they reviewed the AI-assisted text, and when. Approval is blocked until this is set. */
  confirmedBy: string | null;
  confirmedAt: string | null;
};

export type SibEvidence = {
  headline: string;
  url: string | null;
  source: string | null;
  /** Publication time of the report (or the time the evidence was recorded, for items without one). */
  publishedAt: string | null;
};

/** The parts an analyst writes or edits. */
export type SibFields = {
  title: string;
  classification: SibClassification;
  severity: Severity;
  location: string;
  summary: string;
  situation: string;
  employeeImpact: string;
  operationsImpact: string;
  assets: string[];
  actions: string[];
  /** What is uncertain or unknown. Optional so bulletins saved before this field existed still load. */
  uncertainties?: string;
  /** yyyy-mm-dd; when the bulletin should next be reviewed. */
  nextReviewDate?: string | null;
};

export type SibAuditEntry = { id: number; at: string; actor: string; type: string; detail: string };

export type SibSummary = {
  id: string;
  title: string;
  classification: SibClassification;
  severity: Severity;
  status: SibStatus;
  /** Number of times this bulletin has been approved. */
  revision: number;
  source: SibSourceRef;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
};

export type SibRecord = SibSummary & SibFields & {
  evidence: SibEvidence[];
  createdBy: string;
  /** When the evidence snapshot and the starting text were taken from the source. */
  snapshotAt: string;
  ai?: SibAiMeta;
};

/** current = the source is unchanged since the snapshot; changed = it was edited after; missing = it no longer exists. */
export type SibSourceState = 'current' | 'changed' | 'missing';

export type SibDetail = SibRecord & { sourceState: SibSourceState; audit: SibAuditEntry[] };

export const EMPTY_FIELDS: SibFields = {
  title: '', classification: 'Internal / Restricted', severity: 'Unassessed', location: '', summary: '', situation: '',
  employeeImpact: '', operationsImpact: '', assets: [], actions: [],
};

/** What stops a bulletin being approved. An empty list means it can be approved. */
export function approvalBlockers(sib: Pick<SibFields, 'title' | 'severity' | 'location' | 'summary' | 'actions'> & { evidence: SibEvidence[]; ai?: SibAiMeta }): string[] {
  const blockers: string[] = [];
  if (!sib.title.trim()) blockers.push('Add a title.');
  if (sib.severity === 'Unassessed') blockers.push('Set a severity other than Unassessed.');
  if (!sib.location.trim()) blockers.push('Add a location.');
  if (!sib.summary.trim()) blockers.push('Write the executive summary.');
  if (sib.actions.filter((action) => action.trim()).length === 0) blockers.push('Add at least one recommended action (or state that none is needed).');
  if (sib.evidence.length === 0) blockers.push('The bulletin needs at least one source report.');
  if (sib.ai && !sib.ai.confirmedBy) blockers.push('This draft was written with AI. Read it, correct it, then confirm you have reviewed it.');
  return blockers;
}

/** Country assessment ratings are mapped to a pre-filled severity; the analyst can change it. */
export const COUNTRY_RATING_TO_SEVERITY: Record<string, Severity> = {
  Severe: 'Critical', High: 'High', Elevated: 'Medium', Moderate: 'Low', Low: 'Low',
};
