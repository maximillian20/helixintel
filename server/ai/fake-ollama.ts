import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Ollama used by the tests and by `npm run ai:eval` plumbing checks. It speaks the same two endpoints
 * (/api/tags and /api/chat), records every request, and answers with whatever the test scripts. It is NOT a language model:
 * results from it prove the app's checks and wiring, never answer quality.
 */

export type FakeCall = { path: string; method: string; auth: string | undefined; body: any };
export type FakeReply =
  | string
  | { status: number; body?: unknown }
  | { hang: true }
  | { delayMs: number; content: string };
export type Responder = (call: FakeCall, index: number) => FakeReply;

export class FakeOllama {
  readonly calls: FakeCall[] = [];
  chatCount = 0;
  maxConcurrent = 0;
  private active = 0;
  private server: Server | null = null;
  tags: Array<{ name: string; digest: string }> = [{ name: 'qwen3:4b', digest: 'sha256:abcdef1234567890' }];
  /** When set, requests without `Authorization: Bearer <key>` get 401, like the real gateway. */
  requireKey: string | null = null;
  responder: Responder = () => '{}';
  /** 0 picks a free port. */
  port = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server?.closeAllConnections?.();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset() {
    this.calls.length = 0;
    this.chatCount = 0;
    this.maxConcurrent = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const call: FakeCall = { path: req.url ?? '', method: req.method ?? '', auth: req.headers.authorization, body: text ? JSON.parse(text) : null };
    this.calls.push(call);
    if (this.requireKey && call.auth !== `Bearer ${this.requireKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (call.path === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: this.tags }));
      return;
    }
    if (call.path === '/api/chat' || call.path === '/chat/completions') {
      const openAi = call.path === '/chat/completions';
      const index = this.chatCount;
      this.chatCount += 1;
      this.active += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
      try {
        const reply = this.responder(call, index);
        if (typeof reply === 'string') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openAi ? { choices: [{ message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 20 } } : { message: { role: 'assistant', content: reply }, done: true }));
        } else if ('hang' in reply) {
          await new Promise<void>((resolve) => { res.on('close', resolve); });
        } else if ('delayMs' in reply) {
          await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
          if (!res.writableEnded) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openAi ? { choices: [{ message: { role: 'assistant', content: reply.content } }] } : { message: { role: 'assistant', content: reply.content }, done: true }));
        } else {
          res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body ?? { error: 'fake error' }));
        }
      } finally {
        this.active -= 1;
      }
      return;
    }
    res.writeHead(404).end();
  }
}

/** Evidence blocks the app put in a prompt: ref, title and the full block text. */
export function evidenceIn(call: FakeCall): Array<{ ref: string; title: string; block: string; type: string }> {
  const user: string = (call.body?.messages ?? []).filter((m: { role: string }) => m.role === 'user')[0]?.content ?? '';
  const blocks = [...user.matchAll(/<<<EVIDENCE (E\d+) ([0-9a-f]+)>>>\n([\s\S]*?)\n<<<END \1 \2>>>/g)];
  return blocks.map((m) => ({
    ref: m[1], block: m[3],
    title: /TITLE: (.*)/.exec(m[3])?.[1] ?? '',
    type: /type=(\w+)/.exec(m[3])?.[1] ?? '',
  }));
}

export const systemOf = (call: FakeCall): string => (call.body?.messages ?? []).find((m: { role: string }) => m.role === 'system')?.content ?? '';
export const userOf = (call: FakeCall): string => (call.body?.messages ?? []).find((m: { role: string }) => m.role === 'user')?.content ?? '';

/** Which task a request is for, from the task text in the system prompt. */
export function taskOf(call: FakeCall): string {
  const system = systemOf(call);
  if (/Answer the QUESTION/.test(system)) return 'ask';
  if (/Summarise the single report/.test(system)) return 'enrich';
  if (/assess one incident/.test(system)) return 'incident';
  if (/review one country assessment/.test(system)) return 'country';
  if (/Security Information Bulletin/.test(system)) return 'sib';
  if (/personal briefing/.test(system)) return 'briefing';
  if (/threat indicator/.test(system)) return 'indicator';
  if (/market assets/.test(system)) return 'market';
  if (/Convert the request into map filters/.test(system)) return 'map';
  return 'unknown';
}

const claim = (text: string, kind: string, evidence: string[]) => ({ text, kind, evidence });

/** A well-behaved scripted "model": cites real evidence ids and invents nothing. Tests override parts of this to misbehave. */
export function wellBehaved(call: FakeCall): string {
  const items = evidenceIn(call);
  const reports = items.filter((i) => i.type === 'report');
  switch (taskOf(call)) {
    case 'ask':
      return JSON.stringify({
        claims: items.slice(0, 4).map((i) => claim(`${i.title}.`, 'fact', [i.ref])).concat([claim('The reports may be linked to the same event.', 'interpretation', items.slice(0, 2).map((i) => i.ref))]),
        gaps: ['No article text is available beyond headlines and short summaries.'], follow_ups: ['What did the operator say?'],
      });
    case 'enrich': {
      const title = items[0]?.title || (items[0]?.block.split('\n').find((line) => line.trim() && !/^WARNING/.test(line)) ?? 'Report');
      return JSON.stringify({ language: 'en', summary: `${title}.`, key_facts: [], category: 'other', countries: [], organisations: [], event_date: null, suggested_severity: 'Unassessed', severity_rationale: 'Too little detail to judge.' });
    }
    case 'incident': case 'country':
      return JSON.stringify({
        what_happened: [claim(`${items[0]?.title ?? 'The record'} is the starting point.`, 'fact', items.slice(0, 1).map((i) => i.ref))],
        what_changed: [claim(`${items[0]?.title ?? 'The record'} is the starting point.`, 'fact', items.slice(0, 1).map((i) => i.ref))],
        supporting_evidence: reports.slice(0, 2).map((i) => claim(`${i.title}.`, 'fact', [i.ref])),
        conflicting_accounts: [], operational_impact: [claim('Shipping routes could be disrupted.', 'interpretation', items.slice(0, 1).map((i) => i.ref))],
        possible_exposure: [], proposed_updates: [claim('Consider reviewing the severity once more reports arrive.', 'interpretation', items.slice(0, 1).map((i) => i.ref))],
        gaps: ['No casualty figures are given.'], follow_ups: ['Which assets use this route?'],
      });
    case 'sib': {
      const first = reports[0] ?? items[0];
      return JSON.stringify({
        summary: `${first?.title ?? 'An event'} was reported [${first?.ref ?? 'E1'}].`, situation: `Reporting continues [${(reports[1] ?? first)?.ref ?? 'E1'}].`,
        employee_impact: 'No employee impact can be assessed from the available evidence.', operations_impact: 'Shipping on the route could be delayed.',
        actions: ['Monitor the linked sources.', 'Check whether any shipments use the route.'], uncertainties: 'Details of the damage are not reported.', review_in_days: 3,
      });
    }
    case 'briefing':
      return JSON.stringify({
        key_developments: items.slice(0, 2).map((i) => claim(`${i.title}.`, 'fact', [i.ref])), material_changes: [], incident_updates: [], indicator_movements: [], gaps: [], follow_ups: [],
      });
    case 'indicator':
      return JSON.stringify({ explanation: [claim('The indicator counts reports and shows the level given.', 'fact', items.slice(0, 1).map((i) => i.ref))], caveats: [claim('Reporting volume is not the same as events.', 'interpretation', [])], questions_to_ask: [], gaps: [], follow_ups: [] });
    case 'market':
      return JSON.stringify({ exposure_pathways: [claim('Shipping disruption could matter to freight-exposed firms.', 'interpretation', items.slice(0, 1).map((i) => i.ref))], alternative_explanations: [claim('A broad market move on the same day could explain it.', 'interpretation', [])], limitations: [claim('Few comparable events exist.', 'unknown', [])], gaps: [], follow_ups: [] });
    case 'map':
      return JSON.stringify({ severity: 'All', category: '', country: '', review: 'All', last_days: 0, keywords: [] });
    default:
      return '{}';
  }
}
