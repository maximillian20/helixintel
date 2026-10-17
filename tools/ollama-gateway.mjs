#!/usr/bin/env node
/**
 * Helix Ollama gateway. Run this on the computer that runs Ollama. It is the only thing you expose to the internet
 * (through a Cloudflare named tunnel); Ollama itself stays on 127.0.0.1 and is never exposed.
 *
 *   AI_API_KEY=<long random secret> node tools/ollama-gateway.mjs
 *
 * - Requires `Authorization: Bearer <AI_API_KEY>` on every request (constant-time comparison).
 * - Forwards ONLY GET /api/tags and POST /api/chat. Everything else is 404 (no pulling, deleting or copying models).
 * - Caps request size, and does not log prompts or answers.
 * - No dependencies. Node 22 or newer.
 *
 * Optional: GATEWAY_PORT (default 8787), OLLAMA_URL (default http://127.0.0.1:11434), GATEWAY_HOST (default 127.0.0.1),
 * GATEWAY_MAX_BODY_KB (default 256).
 */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

export function createGateway(options = {}) {
  const key = options.apiKey ?? process.env.AI_API_KEY ?? '';
  const upstream = new URL(options.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434');
  const maxBody = Number(options.maxBodyKb ?? process.env.GATEWAY_MAX_BODY_KB ?? 256) * 1024;
  if (key.length < 24) throw new Error('AI_API_KEY must be set and at least 24 characters long. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  if (!['127.0.0.1', 'localhost', '::1'].includes(upstream.hostname)) throw new Error('OLLAMA_URL must point at this computer (127.0.0.1).');
  const digest = (value) => createHash('sha256').update(value).digest();
  const expected = digest(key);

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(digest(given), expected)) return send(res, 401, { error: 'unauthorized' });

    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    if (route !== 'GET /api/tags' && route !== 'POST /api/chat') return send(res, 404, { error: 'not found' });

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) return send(res, 413, { error: 'request too large' });
      chunks.push(chunk);
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const response = await fetch(new URL(req.url, upstream), {
        method: req.method, signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      const text = await response.text();
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      res.end(text);
    } catch (error) {
      if (!res.writableEnded) send(res, 502, { error: error?.name === 'AbortError' ? 'client went away' : 'Ollama is not reachable on this computer' });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  const server = createGateway();
  server.listen(port, host, () => console.log(`Helix Ollama gateway listening on http://${host}:${port} (forwarding to Ollama on this computer). Point your tunnel at this address.`));
}
