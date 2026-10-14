import type { Express, Request, Response } from 'express';
import { countryName } from '../src/data/countries';
import type { ConnectionEdge, ConnectionNode, ConnectionsResponse } from '../src/data/connectionTypes';
import { RATING_RANK, type Rating } from '../src/data/workspaceTypes';
import type { AnalysisStore } from './analysis-store';
import type { SibStore } from './sib-store';

type Deps = {
  app: Express;
  analysis: AnalysisStore;
  sibs: SibStore;
  requireClientId: (req: Request, res: Response) => string | null;
};

/**
 * The links between this browser's own records. Every edge comes from a field that is already saved:
 * an incident's countries, and the incident or country a bulletin was created from. Nothing is inferred.
 * Countries appear only when something links to them or they are watched or assessed.
 */
export function buildConnections(analysis: AnalysisStore, sibs: SibStore, clientId: string): ConnectionsResponse {
  const nodes = new Map<string, ConnectionNode>();
  const edges: ConnectionEdge[] = [];
  const addEdge = (edge: ConnectionEdge) => { if (nodes.has(edge.from) && nodes.has(edge.to)) edges.push(edge); };
  const countryNode = (code: string) => {
    const id = `country:${code}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: 'country', label: countryName(code), detail: '', severity: null, openId: code });
    return id;
  };

  const watched = new Set(analysis.getWatchedCountries(clientId));
  const latest = analysis.latestAssessments(clientId);
  for (const code of watched) countryNode(code);
  for (const code of latest.keys()) countryNode(code);

  const incidents = analysis.listIncidents(clientId);
  for (const incident of incidents) {
    const id = `incident:${incident.id}`;
    nodes.set(id, { id, type: 'incident', label: incident.title, detail: `${incident.status}${incident.openActions ? `, ${incident.openActions} open action${incident.openActions === 1 ? '' : 's'}` : ''}`, severity: incident.severity, openId: incident.id });
  }
  for (const incident of incidents) {
    for (const country of incident.countries) addEdge({ from: `incident:${incident.id}`, to: countryNode(country.code), kind: 'affects' });
  }

  for (const sib of sibs.list(clientId)) {
    const id = `sib:${sib.id}`;
    nodes.set(id, { id, type: 'sib', label: sib.title || 'Untitled bulletin', detail: sib.status, severity: sib.severity, openId: sib.id });
    if (sib.source.type === 'incident') addEdge({ from: id, to: `incident:${sib.source.id}`, kind: 'based-on' });
    else addEdge({ from: id, to: countryNode(sib.source.code), kind: 'based-on' });
  }

  for (const [id, node] of nodes) {
    if (node.type !== 'country') continue;
    const code = id.slice('country:'.length);
    const version = latest.get(code);
    let highest: Rating | null = null;
    if (version) for (const entry of Object.values(version.categories)) {
      if (entry.rating !== 'Unassessed' && (highest === null || RATING_RANK[entry.rating as Rating] > RATING_RANK[highest])) highest = entry.rating as Rating;
    }
    node.detail = [watched.has(code) ? 'Watched' : '', highest ? `Highest rating: ${highest}` : ''].filter(Boolean).join(', ') || 'Linked';
  }
  return { nodes: [...nodes.values()], edges };
}

export function registerConnectionsRoutes({ app, analysis, sibs, requireClientId }: Deps) {
  app.get('/api/workspace/connections', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    try {
      res.set('Cache-Control', 'no-store');
      res.json(buildConnections(analysis, sibs, clientId));
    } catch (error) {
      console.error('Connections request failed', error);
      res.status(500).json({ error: 'The request could not be completed.' });
    }
  });
}
