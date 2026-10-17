import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { MarketStore } from '../market-store';
import { registerSibRoutes } from '../sib-routes';
import { wellBehaved } from './fake-ollama';
import { registerAiRoutes } from './routes';
import { NOW, alice, bob, harness, id, type Harness } from './test-helpers';

async function appFor(h: Harness) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  const market = new MarketStore(h.store.handle);
  const requireClientId = (req: express.Request, res: express.Response) => {
    const value = req.header('x-client-id');
    if (!value || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) { res.status(400).json({ error: 'A valid X-Client-Id header is required.' }); return null; }
    return value;
  };
  registerAiRoutes({ ...h.deps, app, market, sibs: h.sibs, requireClientId, publish: () => undefined, now: () => NOW } as never);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, client: string | null, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...(client ? { 'x-client-id': client } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  return { call, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

test('routes: every AI endpoint needs a client id; status never reveals the key or full endpoint', async () => {
  const h = await harness({ env: { AI_API_KEY: 'sekrit-key' } });
  const api = await appFor(h);
  assert.equal((await api.call('GET', '/api/ai/status', null)).status, 400);
  assert.equal((await api.call('POST', '/api/ai/ask', null, { question: 'x' })).status, 400);
  const status = await api.call('GET', '/api/ai/status', alice);
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'ready');
  assert.equal(status.body.paidProviderCalls, 0);
  assert.doesNotMatch(JSON.stringify(status.body), /sekrit-key/);
  await api.close(); await h.stop();
});

test('routes: ask validates input, returns a cited answer, and keeps it private to the asking browser', async () => {
  const h = await harness();
  const api = await appFor(h);
  assert.equal((await api.call('POST', '/api/ai/ask', alice, { question: '' })).status, 400);
  assert.equal((await api.call('POST', '/api/ai/ask', alice, { question: 'x', extra: 1 })).status, 400);
  const ok = await api.call('POST', '/api/ai/ask', alice, { question: 'tanker attack Red Sea' }, { 'x-analyst-name': 'Ana <script>' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.claims.length > 0 && ok.body.evidence.length > 0);
  assert.equal(ok.body.status, 'active');

  assert.equal((await api.call('GET', `/api/ai/outputs/${ok.body.id}`, alice)).status, 200);
  assert.equal((await api.call('GET', `/api/ai/outputs/${ok.body.id}`, bob)).status, 404, 'another browser cannot open it');
  assert.deepEqual((await api.call('GET', '/api/ai/outputs', bob)).body.items, []);
  assert.equal((await api.call('POST', `/api/ai/outputs/${ok.body.id}/dismiss`, bob, { dismissed: true })).status, 404);
  assert.equal((await api.call('POST', `/api/ai/outputs/${ok.body.id}/dismiss`, alice, { dismissed: true })).status, 200);
  assert.equal((await api.call('GET', '/api/ai/outputs', alice)).body.items.length, 0, 'dismissed results leave the history');
  assert.equal((await api.call('GET', '/api/ai/outputs?includeDismissed=true', alice)).body.items.length, 1, 'but are not deleted');

  const audit = (await api.call('GET', '/api/ai/audit', alice)).body.items;
  assert.ok(audit.some((entry: any) => entry.action === 'ask' && entry.actor === 'Ana script'), 'the analyst name is sanitised and recorded');
  assert.deepEqual((await api.call('GET', '/api/ai/audit', bob)).body.items, []);
  await api.close(); await h.stop();
});

test('routes: with no model connected the AI endpoints answer 503 "AI setup required" while the rest keeps working', async () => {
  const h = await harness({ connected: false });
  const api = await appFor(h);
  const status = await api.call('GET', '/api/ai/status', alice);
  assert.equal(status.body.state, 'setup_required');
  assert.ok(status.body.steps.length > 0);
  const ask = await api.call('POST', '/api/ai/ask', alice, { question: 'tanker attack Red Sea' });
  assert.equal(ask.status, 503);
  assert.equal(ask.body.aiState, 'setup_required');
  assert.match(ask.body.error, /AI setup required/);
  // deterministic features still work without a model
  const related = await api.call('GET', `/api/ai/related?articleId=${encodeURIComponent(id(1))}`, alice);
  assert.equal(related.status, 200);
  assert.ok(related.body.items.length > 0);
  const map = await api.call('POST', '/api/ai/map/query', alice, { text: 'high severity maritime reports last 7 days' });
  assert.equal(map.status, 200);
  assert.equal(map.body.filters.severity, 'High');
  await api.close(); await h.stop();
});

test('routes: the per-browser AI switch stops generation and is respected immediately', async () => {
  const h = await harness();
  const api = await appFor(h);
  assert.equal((await api.call('PUT', '/api/ai/settings', alice, { enabled: false })).status, 200);
  const off = await api.call('POST', '/api/ai/ask', alice, { question: 'tanker attack Red Sea' });
  assert.equal(off.status, 403);
  assert.equal(h.fake.chatCount, 0);
  assert.equal((await api.call('GET', '/api/ai/status', alice)).body.userEnabled, false);
  assert.equal((await api.call('POST', '/api/ai/ask', bob, { question: 'tanker attack Red Sea' })).status, 200, 'other browsers are unaffected');
  assert.equal((await api.call('PUT', '/api/ai/settings', alice, { enabled: true, briefing: { schedule: 'daily', hourUtc: 25 } })).status, 400);
  assert.equal((await api.call('PUT', '/api/ai/settings', alice, { enabled: true, briefing: { schedule: 'daily', hourUtc: 6 } })).status, 200);
  assert.equal((await api.call('GET', '/api/ai/settings', alice)).body.briefing.schedule, 'daily');
  await api.close(); await h.stop();
});

test('routes: server switch AI_ENABLED=0 disables everything', async () => {
  const h = await harness({ env: { AI_ENABLED: '0' } });
  const api = await appFor(h);
  assert.equal((await api.call('GET', '/api/ai/status', alice)).body.state, 'disabled');
  assert.equal((await api.call('POST', '/api/ai/ask', alice, { question: 'tanker attack Red Sea' })).status, 503);
  assert.equal(h.fake.calls.length, 0, 'the model host is never contacted');
  await api.close(); await h.stop();
});

test('routes: a model that returns garbage yields a clear 502, not a made-up answer', async () => {
  const h = await harness({ responder: () => 'I am not JSON' });
  const api = await appFor(h);
  const bad = await api.call('POST', '/api/ai/ask', alice, { question: 'tanker attack Red Sea' });
  assert.equal(bad.status, 502);
  assert.equal((await api.call('GET', '/api/ai/outputs', alice)).body.items.length, 0);
  await api.close(); await h.stop();
});

test('routes: per-browser request limits protect the single model', async () => {
  const h = await harness({ responder: (call) => ({ delayMs: 400, content: wellBehaved(call) }) });
  const api = await appFor(h);
  const first = api.call('POST', '/api/ai/ask', alice, { question: 'tanker attack Red Sea', refresh: true });
  const second = api.call('POST', '/api/ai/ask', alice, { question: 'Dutch police Rotterdam', refresh: true });
  const third = await api.call('POST', '/api/ai/ask', alice, { question: 'Amsterdam protesters', refresh: true });
  assert.equal(third.status, 429, 'a third simultaneous request is refused');
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(h.fake.maxConcurrent, 1);
  await api.close(); await h.stop();
});

test('routes: enrichment endpoints; related and incident assist are scoped to the caller', async () => {
  const h = await harness();
  const api = await appFor(h);
  const view = await api.call('POST', '/api/ai/enrich', alice, { articleId: id(1) });
  assert.equal(view.status, 200);
  const many = await api.call('GET', `/api/ai/enrichment?ids=${encodeURIComponent(id(1))}`, bob);
  assert.ok(many.body.items[id(1)] ?? many.body[id(1)], 'public enrichment is shared');
  assert.equal((await api.call('POST', '/api/ai/enrich', alice, { articleId: 'nope' })).status, 404);
  assert.equal((await api.call('POST', '/api/ai/incidents/INC-ZZZZ-1/assist', bob, {})).status, 404);
  await api.close(); await h.stop();
});

test('routes: drafting a bulletin returns a Draft id; approval still needs the explicit confirmation step', async () => {
  const h = await harness();
  const api = await appFor(h);
  const drafted = await api.call('POST', '/api/ai/sibs', alice, { source: { type: 'reports', ids: [id(1), id(2)] } }, { 'x-analyst-name': 'Ana' });
  assert.equal(drafted.status, 201);
  const sib = h.sibs.get(alice, drafted.body.sibId)!;
  assert.equal(sib.status, 'Draft');
  assert.equal(sib.ai!.confirmedBy, null);
  assert.equal(h.sibs.get(bob, drafted.body.sibId), null);
  assert.throws(() => h.sibs.approve(alice, 'Ana', sib.id, NOW.toISOString()));
  assert.equal((await api.call('POST', '/api/ai/sibs', alice, { source: { type: 'reports', ids: [] } })).status, 400);
  await api.close(); await h.stop();
});

test('routes: map query endpoint refuses anything outside the filter vocabulary', async () => {
  const h = await harness({ responder: () => JSON.stringify({ severity: 'High', category: 'conflict', country: '', review: 'All', last_days: 3, keywords: ['drop table'] }) });
  const api = await appFor(h);
  const r = await api.call('POST', '/api/ai/map/query', alice, { text: 'zorblax; DROP TABLE reports' });
  assert.equal(r.status, 200);
  assert.ok(['All', 'Critical', 'High', 'Medium', 'Low', 'Unassessed'].includes(r.body.filters.severity));
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('drop table;'));
  await api.close(); await h.stop();
});

test('the SIB route module still loads alongside the AI routes', () => {
  assert.equal(typeof registerSibRoutes, 'function');
});
