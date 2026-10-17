import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { askHelix } from './ask';
import { assistCountry, assistIncident } from './assist';
import { generateBriefing } from './briefing';
import { readAiConfig } from './config';
import { parseQuestion, retrieve } from './evidence';
import { explainMarket } from './explain';
import { AiBusyError, AiPrivacyError, AiService, AiUnavailableError } from './service';
import { draftSibWithAi } from './sib-draft';
import { NOW, alice, harness, id, type Harness } from './test-helpers';
import { prefillFromIncident, prefillFromReports, reportsFor } from '../sib-routes';
import { incidentEvidence } from './assist';

const ACCOUNT = 'a'.repeat(32);
const env = (extra: Record<string, string> = {}) => ({ AI_PROVIDER: 'cloudflare', AI_CLOUDFLARE_ACCOUNT_ID: ACCOUNT, AI_API_KEY: 'tok', ...extra }) as NodeJS.ProcessEnv;
const who = { clientId: alice, name: 'Ana' };

test('hosted config: builds the Cloudflare address itself, keeps private records out, and has automatic summaries off by default', () => {
  const c = readAiConfig(env());
  assert.deepEqual(c.problems, []);
  assert.equal(c.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`);
  assert.equal(c.provider, 'cloudflare');
  assert.equal(c.privateRecords, false);
  assert.equal(c.autoEnrich, 'off');
  assert.equal(c.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(readAiConfig(env({ AI_ALLOW_PRIVATE_RECORDS: '1' })).privateRecords, true, 'only an explicit opt-in');
  assert.equal(readAiConfig(env({ AI_AUTO_ENRICH: 'critical-high' })).autoEnrich, 'critical-high');
  const own = readAiConfig({ AI_BASE_URL: 'http://127.0.0.1:11434' } as NodeJS.ProcessEnv);
  assert.equal(own.privateRecords, true, 'a model on your own computer may see private records');
  assert.equal(own.provider, 'ollama');
});

test('hosted config: refuses a missing token, a bad account id, a custom address and unknown providers', () => {
  const problems = (e: NodeJS.ProcessEnv) => readAiConfig(e).problems.join(' ');
  assert.match(problems({ AI_PROVIDER: 'cloudflare', AI_API_KEY: 'tok' } as NodeJS.ProcessEnv), /AI_CLOUDFLARE_ACCOUNT_ID/);
  assert.match(problems({ AI_PROVIDER: 'cloudflare', AI_CLOUDFLARE_ACCOUNT_ID: 'short', AI_API_KEY: 'tok' } as NodeJS.ProcessEnv), /AI_CLOUDFLARE_ACCOUNT_ID/);
  assert.match(problems({ AI_PROVIDER: 'cloudflare', AI_CLOUDFLARE_ACCOUNT_ID: ACCOUNT } as NodeJS.ProcessEnv), /AI_API_KEY/);
  assert.match(problems(env({ AI_BASE_URL: 'https://evil.example/v1' })), /not used with AI_PROVIDER=cloudflare/);
  assert.match(problems({ AI_PROVIDER: 'openai' } as NodeJS.ProcessEnv), /must be "ollama" or "cloudflare"/);
  const bad = readAiConfig({ AI_PROVIDER: 'cloudflare', AI_API_KEY: 'secret-token' } as NodeJS.ProcessEnv);
  assert.equal(bad.baseUrl, null);
  assert.equal(bad.apiKey, null, 'a rejected configuration never keeps the token');
});

test('hosted service: status makes no network call; requests use OpenAI-style chat with a JSON schema and the bearer token', async () => {
  const h = await harness({ hosted: true, responder: () => '{"a":1}' });
  const status = await h.ai.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.provider, 'cloudflare');
  assert.match(status.message, /free plan/i);
  assert.equal(h.fake.calls.length, 0, 'nothing is contacted just to show status');
  const schema = z.object({ a: z.number() });
  const jsonSchema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
  const out = await h.ai.generate({ task: 't', system: 's', user: 'u', schema, jsonSchema });
  assert.deepEqual(out.value, { a: 1 });
  const call = h.fake.calls[0];
  assert.equal(call.path, '/chat/completions');
  assert.equal(call.auth, 'Bearer cf-test-token');
  assert.deepEqual(call.body.response_format, { type: 'json_schema', json_schema: jsonSchema });
  assert.equal(call.body.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(call.body.think, undefined);
  assert.equal(call.body.stream, false);
  assert.equal(h.ai.modelVersion, '@cf/meta/llama-3.3-70b-instruct-fp8-fast@cloudflare');
  const after = await h.ai.status();
  assert.equal(after.usage?.requests, 1);
  assert.equal(after.usage?.promptTokens, 100);
  assert.equal(after.paidProviderCalls, 0);
  await h.stop();
});

test('hosted service: a model that rejects JSON schema mode is asked once more for plain JSON, then remembered', async () => {
  let n = 0;
  const h = await harness({ hosted: true, responder: (call) => (call.body.response_format && n++ === 0 ? { status: 400, body: { error: 'response_format not supported' } } : '{"a":2}') });
  const schema = z.object({ a: z.number() });
  assert.equal((await h.ai.generate({ task: 't', system: 's', user: 'u', schema, jsonSchema: {} })).value.a, 2);
  assert.equal(h.fake.chatCount, 2);
  h.fake.reset();
  await h.ai.generate({ task: 't', system: 's', user: 'u', schema, jsonSchema: {} });
  assert.equal(h.fake.calls[0].body.response_format, undefined, 'no second failed attempt later');
  await h.stop();
});

test('hosted service: a rejected token and the daily free limit are reported honestly, with no charge and no other provider', async () => {
  const bad = await harness({ hosted: true, responder: () => ({ status: 401, body: { errors: [{ message: 'Authentication error' }] } }) });
  await assert.rejects(bad.ai.generate({ task: 't', system: 's', user: 'u', schema: z.object({}), jsonSchema: {} }), (e: unknown) => e instanceof AiUnavailableError && e.state === 'unreachable');
  const status = await bad.ai.status(true);
  assert.equal(status.state, 'unreachable');
  assert.match(status.message, /rejected the API token/);
  assert.deepEqual([...bad.ai.contactedHosts], [new URL(bad.baseUrl).host]);
  await bad.stop();

  const limit = await harness({ hosted: true, responder: () => ({ status: 429, body: { errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] } }) });
  await assert.rejects(limit.ai.generate({ task: 't', system: 's', user: 'u', schema: z.object({}), jsonSchema: {} }), (e: unknown) => e instanceof AiUnavailableError && e.state === 'limit_reached');
  const s = await limit.ai.status(true);
  assert.equal(s.state, 'limit_reached');
  assert.match(s.message, /00:00 UTC/);
  assert.match(s.message, /Nothing was charged/);
  limit.fake.reset();
  await assert.rejects(limit.ai.generate({ task: 't', system: 's', user: 'u', schema: z.object({}), jsonSchema: {} }), AiUnavailableError);
  assert.equal(limit.fake.chatCount, 0, 'no further requests until the allowance resets');
  limit.setNow(new Date(NOW.getTime() + 13 * 3_600_000));
  assert.equal((await limit.ai.status(true)).state, 'ready', 'after 00:00 UTC it tries again');
  await limit.stop();

  const busy = await harness({ hosted: true, responder: () => ({ status: 429, body: { error: 'slow down' } }) });
  await assert.rejects(busy.ai.generate({ task: 't', system: 's', user: 'u', schema: z.object({}), jsonSchema: {} }), AiBusyError);
  await busy.stop();
});

// ---------------------------------------------------------------- privacy gate for third-party services

function seed(h: Harness) {
  const incident = h.analysis.createIncident(alice, 'Ana', {
    title: 'Tanker strike response', summary: 'CONFIDENTIAL operator notes about route changes.', category: 'conflict', locationText: 'Red Sea', lat: 15, lng: 41,
    countryCodes: ['YE'], severity: 'High', severityRationale: 'Missile strike.', confidence: 'Medium', owner: null, eventAt: NOW.toISOString(),
  }, [], NOW.toISOString());
  h.places.create(alice, { name: 'Secret depot', kind: 'radius', lat: 15.1, lng: 41.1, radiusKm: 50, bbox: null, notes: '', alert: { enabled: false, minSeverity: 'High', categories: [] } } as never, NOW.toISOString());
  return incident;
}

test('privacy: with a third-party service, private incidents, assessments, places and assets never enter retrieval or prompts', async () => {
  const h = await harness({ hosted: true });
  const incident = seed(h);
  const r = retrieve(h.deps, alice, parseQuestion('tanker strike incident Red Sea assets exposure', NOW));
  assert.ok(r.items.length > 0, 'public reports are still used');
  assert.ok(r.items.every((i) => i.kind === 'report' || i.kind === 'indicator'));
  assert.ok(r.filters.some((line) => /left out/.test(line)));
  const answer = await askHelix(h.deps, who, { question: 'tanker strike incident Red Sea' });
  assert.ok(answer.evidence.every((e) => e.kind !== 'incident'));
  const sent = JSON.stringify(h.fake.calls.map((c) => c.body));
  assert.doesNotMatch(sent, /CONFIDENTIAL|Secret depot|Tanker strike response/);
  await assert.rejects(async () => assistIncident(h.deps, who, incident.id), AiPrivacyError);
  await assert.rejects(async () => assistCountry(h.deps, who, 'YE'), AiPrivacyError);
  const sibDeps = {
    ...h.deps, sibs: h.sibs,
    prefill: (clientId: string, input: { type: string; id?: string; ids?: string[] }) => input.type === 'incident'
      ? { prefill: prefillFromIncident(h.analysis.getIncident(clientId, input.id!)), built: incidentEvidence(h.deps, clientId, h.analysis.getIncident(clientId, input.id!)) }
      : { prefill: prefillFromReports(reportsFor(h.store, clientId, input.ids!), input.ids!), reports: reportsFor(h.store, clientId, input.ids!) },
  } as Parameters<typeof draftSibWithAi>[0];
  await assert.rejects(async () => draftSibWithAi(sibDeps, { ...who }, { type: 'incident', id: incident.id }), AiPrivacyError);
  assert.equal(h.sibs.list(alice).length, 0);
  const fromReports = await draftSibWithAi(sibDeps, { ...who }, { type: 'reports', ids: [id(1)] });
  assert.equal(fromReports.sib.status, 'Draft', 'public reports can still be drafted');
  assert.doesNotMatch(JSON.stringify(h.fake.calls.map((c) => c.body)), /CONFIDENTIAL|Secret depot/);
  await h.stop();
});

test('privacy: briefings under a third-party service skip incident updates; market explanations of incidents are refused', async () => {
  const h = await harness({ hosted: true });
  seed(h);
  h.analysis.setCountryWatch(alice, 'YE', true);
  const b = await generateBriefing(h.deps, who);
  assert.equal(b.generated, true);
  assert.doesNotMatch(JSON.stringify(h.fake.calls.map((c) => c.body)), /CONFIDENTIAL|Secret depot/);
  assert.ok(b.answer!.evidence.every((e) => e.kind !== 'incident'));
  await assert.rejects(explainMarket({ ...h.deps, market: undefined as never }, who, { eventKey: 'incident:INC-ZZZZ-1' }).catch((e: Error) => { throw e instanceof AiPrivacyError ? e : new AiPrivacyError('not found is also fine'); }), AiPrivacyError);
  await h.stop();
});

test('privacy: the owner can opt in, and a model on your own computer always may', async () => {
  const optIn = await harness({ hosted: true, env: { AI_ALLOW_PRIVATE_RECORDS: '1' } });
  seed(optIn);
  const r = retrieve(optIn.deps, alice, parseQuestion('tanker strike incident', NOW));
  assert.ok(r.items.some((i) => i.kind === 'incident'));
  await optIn.stop();
  const own = await harness();
  seed(own);
  assert.ok(retrieve(own.deps, alice, parseQuestion('tanker strike incident', NOW)).items.some((i) => i.kind === 'incident'));
  await own.stop();
  assert.ok(AiService);
});
