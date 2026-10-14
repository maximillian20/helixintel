import type { Severity } from './feedTypes';

export type ConnectionNode = {
  id: string;
  type: 'incident' | 'country' | 'sib';
  label: string;
  /** Short detail line: status, rating or watch state. */
  detail: string;
  severity: Severity | null;
  /** Record id to open in its own page. */
  openId: string;
};

export type ConnectionEdge = { from: string; to: string; kind: 'affects' | 'based-on' };

export type ConnectionsResponse = { nodes: ConnectionNode[]; edges: ConnectionEdge[] };
