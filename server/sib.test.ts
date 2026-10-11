import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import express, { type Request, type Response } from 'express';
import { AnalysisStore } from './analysis-store';
import { registerSibRoutes, prefillFromAssessment, prefillFromIncident } from './sib-routes';
import { SibStore } from './sib-store';
import { SourceStore } from './source-store';
import { escapeHtml, sibDocument, sibFilename, sibMailto, sibToHtml, sibToText } from '../src/data/sibExport';
import { approvalBlockers, type SibRecord } from '../src/data/sibTypes';
import type { IncidentInput } from '../src/data/workspaceTypes';

process.env.NODE_ENV = 'test';

const T0 = '2026-10-10T08:00:00.000Z';
const alice = 'client-alice-00001';
const bob = 'client-bob-000001';

const incidentInput: IncidentInput = {
  title: 'Drone strike near Khartoum market', summary: 'A drone strike hit a market on 9 October.', category: 'conflict', locationText: 'Khartoum, Sudan',
  lat: null, lng: null, countryCodes: ['SD'], severity: 'High', severityRationale: 'Two reports of civilian deaths.', confidence: 'Medium', owner: 'Dana', eventAt: T0,
};
const reports = [
  { articleId: 'a1', headline: 'Drone strike kills 12', url: 'https://news.example.test/a1', source: 'BBC News', publishedAt: '2026-10-09T10:00:00.000Z' },
  { articleId: 'a2', headline: 'Second strike reported', url: 'https://news.example.test/a2', source: 'UN News', publishedAt: '2026-10-09T15:00:00.000Z' },
];

let server: Server;
let base: string;
let store: SourceStore;
let analysis: AnalysisStore;
let sibs: SibStore;
let incidentId: string;
let clockNow = new Date('2026-10-11T09:00:00.000Z');

async function call(method: string, path: string, client: string | null, body?: unknown, analyst?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (client) headers['x-client-id'] = client;
  if (analyst) headers['x-analyst-name'] = analyst;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  store = new SourceStore(':memory:');
  analysis = new AnalysisStore(store.handle);
  sibs = new SibStore(store.handle);
  const created = analysis.createIncident(alice, 'Ana', incidentInput, reports, T0);
  incidentId = created.id;
  analysis.addImpact(alice, 'Ana', incidentId, { area: 'Operational', text: 'Port access limited.' }, T0);
  analysis.addImpact(alice, 'Ana', incidentId, { area: 'Human rights', text: 'Civilian casualties reported.' }, T0);
  analysis.addAsset(alice, 'Ana', incidentId, { kind: 'Supplier', name: 'Nile Logistics', notes: 'Main depot', countryCode: 'SD' }, T0);
  analysis.addAction(alice, 'Ana', incidentId, { text: 'Confirm staff safety', owner: 'Dana', dueDate: '2026-10-20' }, T0);
  const app = express();
  app.use(express.json());
  const requireClientId = (req: Request, res: Response) => {
    const id = req.header('x-client-id');
    if (!id) { res.status(400).json({ error: 'Missing client id.' }); return null; }
    return id;
  };
  registerSibRoutes({ app, analysis, sibs, requireClientId, publish: () => undefined, now: () => clockNow });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

test('prefill from an incident copies only what the incident records', () => {
  const prefill = prefillFromIncident(analysis.getIncident(alice, incidentId));
  assert.equal(prefill.fields.title, incidentInput.title);
  assert.equal(prefill.fields.severity, 'High');
  assert.equal(prefill.fields.location, 'Khartoum, Sudan');
  assert.equal(prefill.fields.summary, incidentInput.summary);
  assert.match(prefill.fields.situation, /UN News, 09 Oct 2026: Second strike reported/);
  assert.match(prefill.fields.situation, /Severity rationale: Two reports of civilian deaths\./);
  assert.match(prefill.fields.situation, /Human rights: Civilian casualties reported\./);
  assert.equal(prefill.fields.operationsImpact, 'Port access limited.');
  assert.equal(prefill.fields.employeeImpact, '', 'employee impact is not recorded by incidents, so it stays empty');
  assert.deepEqual(prefill.fields.assets, ['Supplier: Nile Logistics (Main depot)']);
  assert.deepEqual(prefill.fields.actions, ['Confirm staff safety (owner: Dana) (due 2026-10-20)']);
  assert.equal(prefill.evidence.length, 2);
  assert.equal(prefill.evidence[0].url?.startsWith('https://'), true);
  assert.equal(prefill.fields.classification, 'Internal / Restricted');
});

test('prefill from an assessment maps the highest rating, lists only rated categories and copies evidence', () => {
  analysis.addCountryEvidence(alice, 'Ana', 'SD', { refType: 'report', refId: 'a1', category: 'security', note: '', label: 'Drone strike kills 12', url: 'https://news.example.test/a1', source: 'BBC News', eventTime: '2026-10-09T10:00:00.000Z' }, T0);
  const evidence = analysis.listCountryEvidence(alice, 'SD');
  const version = analysis.saveCountryAssessment(alice, 'Ana', 'SD', {
    summary: 'Security is deteriorating.', confidence: 'Medium',
    categories: {
      security: { rating: 'Severe', rationale: 'Attacks on markets.', confidence: 'High', evidenceIds: [evidence[0].id] },
      travel: { rating: 'Elevated', rationale: 'Airport closed.', confidence: 'Medium', evidenceIds: [evidence[0].id] },
    },
  }, T0);
  const prefill = prefillFromAssessment('SD', version);
  assert.equal(prefill.fields.severity, 'Critical');
  assert.equal(prefill.fields.location, 'Sudan');
  assert.match(prefill.fields.title, /^Sudan/);
  assert.match(prefill.fields.situation, /Security: Severe \(High confidence\)\. Attacks on markets\./);
  assert.match(prefill.fields.situation, /Travel: Elevated/);
  assert.doesNotMatch(prefill.fields.situation, /Infrastructure/);
  assert.equal(prefill.evidence.length, 1);
  assert.equal(prefill.source.type === 'country' && prefill.source.version, 1);
});

test('http: bulletins need a client id, a valid id and a known source; other browsers cannot see them', async () => {
  assert.equal((await call('GET', '/api/workspace/sibs', null)).status, 400);
  assert.equal((await call('POST', '/api/workspace/sibs', alice, { source: { type: 'incident', id: 'INC-NOPE0' } })).status, 404);
  assert.equal((await call('POST', '/api/workspace/sibs', alice, { source: { type: 'country', code: 'ZZ' } })).status, 404);
  assert.equal((await call('POST', '/api/workspace/sibs', alice, { source: { type: 'country', code: 'FR' } })).status, 404, 'a country without a saved assessment has nothing to start from');
  assert.equal((await call('POST', '/api/workspace/sibs', alice, {})).status, 400);
  assert.equal((await call('GET', '/api/workspace/sibs/not-an-id', alice)).status, 404);
  // Another browser's incident cannot be used as a source.
  assert.equal((await call('POST', '/api/workspace/sibs', bob, { source: { type: 'incident', id: incidentId } })).status, 404);
});

test('http: draft, edit, approval rules, locking, reopening and audit trail', async () => {
  const created = await call('POST', '/api/workspace/sibs', alice, { source: { type: 'incident', id: incidentId } }, 'Ana Analyst');
  assert.equal(created.status, 201);
  const id = created.body.id as string;
  assert.match(id, /^SIB-[A-Z0-9]{6}$/);
  assert.equal(created.body.status, 'Draft');
  assert.equal(created.body.sourceState, 'current');
  assert.equal(created.body.source.label, `Incident ${incidentId}`);
  assert.equal(created.body.evidence.length, 2);

  assert.equal((await call('GET', `/api/workspace/sibs/${id}`, bob)).status, 404, 'private to the creating browser');
  assert.equal((await call('GET', '/api/workspace/sibs', bob)).body.total, 0);
  assert.equal((await call('GET', '/api/workspace/sibs', alice)).body.total, 1);

  // Approval needs real content and a named approver.
  await call('PATCH', `/api/workspace/sibs/${id}`, alice, { actions: [], summary: '' });
  const blocked = await call('POST', `/api/workspace/sibs/${id}/approve`, alice, {}, 'Ana Analyst');
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /executive summary/);
  assert.match(blocked.body.error, /recommended action/);
  await call('PATCH', `/api/workspace/sibs/${id}`, alice, { summary: 'Strikes on markets continue.', actions: [' Confirm staff safety ', '', 'Review travel to Khartoum'] }, 'Ana Analyst');
  const unnamed = await call('POST', `/api/workspace/sibs/${id}/approve`, alice, {});
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.error, /analyst name/);

  assert.equal((await call('PATCH', `/api/workspace/sibs/${id}`, alice, { severity: 'Extreme' })).status, 400);
  assert.equal((await call('PATCH', `/api/workspace/sibs/${id}`, alice, { status: 'Approved' })).status, 400, 'status cannot be set by editing');
  assert.equal((await call('PATCH', `/api/workspace/sibs/${id}`, alice, { severity: 'Unassessed' })).status, 200);
  assert.match((await call('POST', `/api/workspace/sibs/${id}/approve`, alice, {}, 'Ana Analyst')).body.error, /severity/);
  await call('PATCH', `/api/workspace/sibs/${id}`, alice, { severity: 'High' });

  const approved = await call('POST', `/api/workspace/sibs/${id}/approve`, alice, {}, 'Ana Analyst');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'Approved');
  assert.equal(approved.body.revision, 1);
  assert.equal(approved.body.approvedBy, 'Ana Analyst');
  assert.deepEqual(approved.body.actions, ['Confirm staff safety', 'Review travel to Khartoum'], 'actions are trimmed and blanks dropped');

  // Locked while approved.
  assert.equal((await call('PATCH', `/api/workspace/sibs/${id}`, alice, { title: 'Changed' })).status, 400);
  assert.equal((await call('DELETE', `/api/workspace/sibs/${id}`, alice)).status, 400);
  assert.equal((await call('POST', `/api/workspace/sibs/${id}/approve`, alice, {}, 'Ana Analyst')).status, 400);
  assert.equal((await call('POST', `/api/workspace/sibs/${id}/refresh-sources`, alice, {})).status, 400);

  const reopened = await call('POST', `/api/workspace/sibs/${id}/reopen`, alice, {}, 'Dana Reviewer');
  assert.equal(reopened.body.status, 'Draft');
  assert.equal(reopened.body.approvedBy, null);
  assert.equal(reopened.body.approvedAt, null);
  assert.equal(reopened.body.revision, 1, 'the revision count survives reopening');
  await call('PATCH', `/api/workspace/sibs/${id}`, alice, { title: 'Khartoum market strikes' }, 'Dana Reviewer');
  const second = await call('POST', `/api/workspace/sibs/${id}/approve`, alice, {}, 'Dana Reviewer');
  assert.equal(second.body.revision, 2);
  assert.equal(second.body.approvedBy, 'Dana Reviewer');

  const types = second.body.audit.map((entry: any) => entry.type);
  for (const expected of ['created', 'edited', 'approved', 'reopened']) assert.ok(types.includes(expected), `${expected} in ${types.join(',')}`);
  assert.ok(second.body.audit.every((entry: any) => entry.actor && entry.at));
  assert.ok(second.body.audit.some((entry: any) => entry.actor === 'Dana Reviewer' && entry.type === 'reopened'));

  const list = await call('GET', '/api/workspace/sibs', alice);
  const row = list.body.items.find((entry: any) => entry.id === id);
  assert.equal(row.status, 'Approved');
  assert.equal('summary' in row, false, 'list rows are summaries');
});

test('http: drafts can be deleted; a no-op edit is not logged', async () => {
  const id = (await call('POST', '/api/workspace/sibs', alice, { source: { type: 'incident', id: incidentId } })).body.id as string;
  const before = (await call('GET', `/api/workspace/sibs/${id}`, alice)).body.audit.length;
  await call('PATCH', `/api/workspace/sibs/${id}`, alice, { title: incidentInput.title });
  assert.equal((await call('GET', `/api/workspace/sibs/${id}`, alice)).body.audit.length, before);
  assert.equal((await call('DELETE', `/api/workspace/sibs/${id}`, alice)).status, 200);
  assert.equal((await call('GET', `/api/workspace/sibs/${id}`, alice)).status, 404);
});

test('http: a changed source is flagged and its reports can be replaced without touching the text', async () => {
  const id = (await call('POST', '/api/workspace/sibs', alice, { source: { type: 'incident', id: incidentId } })).body.id as string;
  await call('PATCH', `/api/workspace/sibs/${id}`, alice, { summary: 'My own summary.' });
  // The incident gains a report after the bulletin was drafted (the routes' clock is 09:00 until the refresh below).
  analysis.linkReports(alice, 'Ana', incidentId, [{ articleId: 'a3', headline: 'Third report', url: 'https://news.example.test/a3', source: 'Reuters', publishedAt: '2026-10-11T07:00:00.000Z' }], '2026-10-11T10:00:00.000Z');
  const flagged = (await call('GET', `/api/workspace/sibs/${id}`, alice)).body;
  assert.equal(flagged.sourceState, 'changed');
  assert.equal(flagged.evidence.length, 2);
  clockNow = new Date('2026-10-11T10:30:00.000Z');
  const refreshed = await call('POST', `/api/workspace/sibs/${id}/refresh-sources`, alice, {}, 'Ana Analyst');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.evidence.length, 3);
  assert.equal(refreshed.body.summary, 'My own summary.', 'the analyst text is never overwritten');
  assert.equal(refreshed.body.sourceState, 'current');
  assert.ok(refreshed.body.audit.some((entry: any) => entry.type === 'sources-refreshed'));
});

test('http: a bulletin from a country assessment records the version it was taken from', async () => {
  const created = await call('POST', '/api/workspace/sibs', alice, { source: { type: 'country', code: 'sd' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.source.type, 'country');
  assert.equal(created.body.source.code, 'SD');
  assert.equal(created.body.source.version, 1);
  assert.equal(created.body.severity, 'Critical');
  assert.equal(created.body.sourceState, 'current');
  analysis.saveCountryAssessment(alice, 'Ana', 'SD', { summary: 'v2', confidence: 'Medium', categories: { security: { rating: 'High', rationale: 'Changed.', confidence: 'Medium', evidenceIds: [analysis.listCountryEvidence(alice, 'SD')[0].id] } } }, '2026-10-11T10:00:00.000Z');
  assert.equal((await call('GET', `/api/workspace/sibs/${created.body.id}`, alice)).body.sourceState, 'changed');
});

// ------------------------------------------------------------------ pure document and export logic

const record = (over: Partial<SibRecord> = {}): SibRecord => ({
  id: 'SIB-ABC234', title: 'Test <b>bulletin</b>', classification: 'Confidential', severity: 'High', location: 'Khartoum', summary: 'Line one.\n\nLine two & more.',
  situation: '', employeeImpact: '', operationsImpact: 'Port closed.', assets: ['Site: Depot'], actions: ['Do this', 'Do that'],
  status: 'Draft', revision: 0, source: { type: 'incident', id: 'INC-1234', label: 'Incident INC-1234' }, createdAt: T0, updatedAt: T0, approvedAt: null, approvedBy: null,
  evidence: [
    { headline: 'Report <script>alert(1)</script>', url: 'https://news.example.test/x?a=1&b=2', source: 'BBC', publishedAt: '2026-10-09T10:00:00.000Z' },
    { headline: 'Unsafe link', url: 'javascript:alert(1)', source: null, publishedAt: null },
  ],
  createdBy: 'Ana', snapshotAt: T0, ...over,
});

test('document: empty optional sections are omitted, drafts are marked, approved bulletins name the approver', () => {
  const doc = sibDocument(record(), '2026-10-11T09:00:00.000Z');
  assert.deepEqual(doc.blocks.map((block) => block.heading), ['Executive summary', 'Impact on operations', 'Affected assets and locations', 'Recommended actions', 'Sources']);
  assert.equal(doc.banner, 'CONFIDENTIAL');
  assert.match(doc.draftNotice ?? '', /not approved/);
  const approved = sibDocument(record({ status: 'Approved', revision: 2, approvedBy: 'Ana Analyst', approvedAt: '2026-10-11T08:00:00.000Z' }), '2026-10-11T09:00:00.000Z');
  assert.equal(approved.draftNotice, null);
  assert.match(approved.meta.find(([label]) => label === 'Status')![1], /Approved by Ana Analyst on 11 Oct 2026, 08:00 UTC \(revision 2\)/);
});

test('exports: HTML escapes every field and only links http(s); text and Word variants carry the same content', () => {
  const doc = sibDocument(record(), '2026-10-11T09:00:00.000Z');
  const html = sibToHtml(doc);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>bulletin/);
  assert.match(html, /Test &lt;b&gt;bulletin&lt;\/b&gt;/);
  assert.match(html, /href="https:\/\/news\.example\.test\/x\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<p>Line one\.<\/p><p>Line two &amp; more\.<\/p>/);
  assert.match(html, /DRAFT: not approved for distribution/);
  assert.match(sibToHtml(doc, { word: true }), /^<html xmlns:o=/);
  const text = sibToText(doc);
  assert.match(text, /^CONFIDENTIAL\nDRAFT/);
  assert.match(text, /1\. Do this\n2\. Do that/);
  assert.match(text, /https:\/\/news\.example\.test\/x\?a=1&b=2/);
  assert.equal(escapeHtml(`<"'&>`), '&lt;&quot;&#39;&amp;&gt;');
});

test('exports: email text is shortened with a note, and file names are safe', () => {
  const long = sibDocument(record({ situation: 'x'.repeat(5000) }), T0);
  const link = sibMailto(long);
  assert.ok(link.startsWith('mailto:?subject='));
  assert.ok(decodeURIComponent(link).includes('Shortened for email'));
  assert.ok(link.length < 4500);
  assert.equal(sibFilename({ id: 'SIB-ABC234', title: 'Test <b>bulletin</b> / Khartoum!' }, 'html'), 'SIB-ABC234-test-b-bulletin-b-khartoum.html');
  assert.equal(sibFilename({ id: 'SIB-ABC234', title: '' }, 'doc'), 'SIB-ABC234.doc');
});

test('approval blockers list everything that is missing', () => {
  assert.deepEqual(approvalBlockers({ title: '', severity: 'Unassessed', location: '', summary: '', actions: [' '], evidence: [] }), [
    'Add a title.', 'Set a severity other than Unassessed.', 'Add a location.', 'Write the executive summary.',
    'Add at least one recommended action (or state that none is needed).', 'The bulletin needs at least one source report.',
  ]);
  assert.deepEqual(approvalBlockers({ title: 't', severity: 'Low', location: 'l', summary: 's', actions: ['a'], evidence: [{ headline: 'h', url: null, source: null, publishedAt: null }] }), []);
});
