import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { FakeOllama } from './fake-ollama';
// @ts-expect-error plain ESM tool without types
import { createGateway } from '../../tools/ollama-gateway.mjs';

const KEY = 'k'.repeat(40);

test('gateway: refuses without the key, forwards only the two model endpoints, and does not expose Ollama admin routes', async () => {
  const fake = new FakeOllama();
  fake.responder = () => '{"ok":true}';
  const upstream = await fake.start();
  const gateway = createGateway({ apiKey: KEY, ollamaUrl: upstream });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const go = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const auth = { authorization: `Bearer ${KEY}` };

  assert.equal((await go('/api/tags')).status, 401);
  assert.equal((await go('/api/tags', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await go('/api/tags', { headers: { authorization: KEY } })).status, 401, 'must be a Bearer token');
  assert.equal(fake.calls.length, 0, 'nothing reached Ollama without the key');

  assert.equal((await go('/api/tags', { headers: auth })).status, 200);
  const chat = await go('/api/chat', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:4b', messages: [] }) });
  assert.equal(chat.status, 200);
  assert.equal(((await chat.json()) as any).message.content, '{"ok":true}');

  for (const [method, path] of [['POST', '/api/pull'], ['DELETE', '/api/delete'], ['POST', '/api/copy'], ['GET', '/api/ps'], ['POST', '/api/generate'], ['GET', '/']] as const) {
    assert.equal((await go(path, { method, headers: auth })).status, 404, `${method} ${path}`);
  }
  assert.equal(fake.calls.filter((c) => c.path !== '/api/tags' && c.path !== '/api/chat').length, 0);

  const big = await go('/api/chat', { method: 'POST', headers: auth, body: 'x'.repeat(300 * 1024) });
  assert.equal(big.status, 413);

  await new Promise((resolve) => gateway.close(resolve));
  await fake.stop();
});

test('gateway: refuses to start with a weak key or a non-local Ollama address', () => {
  assert.throws(() => createGateway({ apiKey: 'short' }), /at least 24/);
  assert.throws(() => createGateway({ apiKey: KEY, ollamaUrl: 'http://203.0.113.5:11434' }), /this computer/);
});
