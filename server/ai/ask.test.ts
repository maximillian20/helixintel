import assert from 'node:assert/strict';
import test from 'node:test';
import { askHelix } from './ask';
import { evidenceIn, taskOf, userOf, wellBehaved, type FakeCall } from './fake-ollama';
import { AiService, AiUnavailableError } from './service';
import { NOW, alice, bob, harness, id } from './test-helpers';

const who = (clientId: string, name = 'Analyst') => ({ clientId, name });
const claimJson = (claims: unknown[]) => JSON.stringify({ claims, gaps: [], follow_ups: [] });

test('ask: answers carry cited evidence, basis labels, dates and depth, and the model sees only filtered records', async () => {
  const h = await harness();
  const answer = await askHelix(h.deps, who(alice), { question: 'What happened to the tanker in the Red Sea in the last 24 hours?' });
  assert.ok(answer.claims.length >= 2);
  const refs = new Set(answer.evidence.map((e) => e.ref));
  for (const claim of answer.claims) {
    if (claim.basis !== 'unknown') assert.ok(claim.refs.length > 0 && claim.refs.every((r) => refs.has(r)), 'every claim cites real evidence');
  }
  for (const e of answer.evidence) {
    assert.ok(e.url === null || e.url.startsWith('https://news.example.test/'), 'URLs come from records only');
    assert.ok(e.depth && 'publishedAt' in e);
  }
  assert.ok(answer.claims.some((c) => c.basis === 'interpretation'));
  assert.equal(answer.meta.model, 'qwen3:4b');
  assert.ok(answer.meta.modelDigest);
  assert.ok(answer.filters.some((f) => /last 1 day/.test(f)));
  assert.equal(answer.freshness.newestReportAt !== null, true);
  assert.deepEqual(answer.evidence.map((e) => e.id).filter((i) => i === id(8)), [], 'the 30-day-old report is outside the window');
  assert.equal((await h.ai.status()).paidProviderCalls, 0);
  await h.stop();
});

test('ask: corroborated needs independent publishers; syndicated copies and same-publisher follow-ups do not count', async () => {
  const h = await harness({
    responder: (call) => {
      const items = evidenceIn(call);
      const titles: Record<number, string> = { 1: 'Houthi missile strike hits tanker', 2: 'Tanker attacked off Yemen', 3: 'Red Sea tanker attack: crew', 4: 'Houthi missile strike hits tanker' };
      const find = (n: number) => items.filter((i) => i.title.startsWith(titles[n])).map((i) => i.ref)[n === 4 ? 1 : 0];
      return claimJson([
        { text: 'A tanker was struck in the Red Sea.', kind: 'fact', evidence: [find(1), find(4), find(3)].filter(Boolean) },
        { text: 'Naval forces rescued the crew.', kind: 'fact', evidence: [find(1), find(2)].filter(Boolean) },
      ]);
    },
  });
  const answer = await askHelix(h.deps, who(alice), { question: 'tanker attack Red Sea' });
  const [copies, independent] = answer.claims;
  assert.equal(copies.independentSources, 1);
  assert.equal(copies.basis, 'reported', 'one publisher, its follow-up and a syndicated copy are still one source');
  assert.equal(independent.independentSources, 2);
  assert.equal(independent.basis, 'corroborated');
  await h.stop();
});

test('ask: fabricated citations, numbers, links and uncited facts are removed', async () => {
  const h = await harness({
    responder: (call) => {
      const first = evidenceIn(call)[0].ref;
      return claimJson([
        { text: 'Cited properly.', kind: 'fact', evidence: [first] },
        { text: 'Cites a record that does not exist.', kind: 'fact', evidence: ['E99'] },
        { text: 'No citation at all.', kind: 'fact', evidence: [] },
        { text: '47 sailors died in the attack.', kind: 'fact', evidence: [first] },
        { text: 'More at https://evil.example/report and www.evil.test.', kind: 'fact', evidence: [first] },
      ]);
    },
  });
  const answer = await askHelix(h.deps, who(alice), { question: 'tanker attack Red Sea' });
  const texts = answer.claims.map((c) => c.text);
  assert.ok(texts.includes('Cited properly.'));
  assert.ok(!texts.some((t) => /does not exist|No citation|47 sailors/.test(t)));
  assert.equal(answer.removedClaims, 3);
  assert.ok(!JSON.stringify(answer).includes('evil.example'));
  assert.ok(!JSON.stringify(answer).includes('evil.test'));
  await h.stop();
});

test('ask: injection text in a report is wrapped as data, flagged, and cannot change the app or close the evidence block', async () => {
  const h = await harness({
    responder: (call) => {
      const user = userOf(call);
      const nonce = /<<<EVIDENCE E1 ([0-9a-f]+)>>>/.exec(user)![1];
      assert.notEqual(nonce, 'abc123');
      const injected = evidenceIn(call).find((i) => i.block.includes('instruction-like'));
      assert.ok(injected, 'the injection article was retrieved and flagged');
      assert.doesNotMatch(injected!.block, /<<<END E1 abc123>>>/, 'the forged delimiter was defused');
      assert.equal((user.match(new RegExp(`<<<END E\\d+ ${nonce}>>>`, 'g')) ?? []).length, evidenceIn(call).length, 'only the real closing markers remain');
      return wellBehaved(call);
    },
  });
  const before = JSON.stringify([...h.store.getUserStates(alice)]);
  const answer = await askHelix(h.deps, who(alice), { question: 'port operations resume after storm' });
  assert.ok(answer.evidence.some((e) => e.flagged), 'flag is shown to the analyst');
  assert.equal(JSON.stringify([...h.store.getUserStates(alice)]), before, 'nothing was marked reviewed or changed');
  assert.deepEqual(h.sibs.list(alice), [], 'no bulletin was created or approved');
  await h.stop();
});

test('ask: nothing matches -> an honest "unknown" answer and no model call', async () => {
  const h = await harness();
  const answer = await askHelix(h.deps, who(alice), { question: 'volcano eruption in Iceland today' });
  assert.equal(h.fake.chatCount, 0);
  assert.equal(answer.claims[0].basis, 'unknown');
  assert.equal(answer.evidence.length, 0);
  assert.match(answer.claims[0].text, /nothing to base an answer on/);
  await h.stop();
});

test('ask: stale and headline-only evidence is flagged in the notes and on the claim', async () => {
  const h = await harness({
    responder: (call) => {
      const all = evidenceIn(call);
      const e = all.find((i) => i.title.startsWith('Officials meet')) ?? all[0];
      return claimJson([{ text: 'Officials met.', kind: 'fact', evidence: [e.ref] }]);
    },
  });
  const answer = await askHelix(h.deps, who(alice), { question: 'officials meet over regional trade' });
  assert.equal(answer.claims[0].headlineOnly, true);
  assert.match(answer.notes.join(' '), /headline/i);

  h.setNow(new Date(NOW.getTime() + 60 * 86_400_000));
  const old = await askHelix(h.deps, who(alice), { question: 'anything about Chile earthquake' });
  assert.ok(old.evidence.some((e) => e.stale) || old.notes.length > 0);
  await h.stop();
});

test('ask: contradictory accounts can be shown as a conflict and only when two records are cited', async () => {
  const h = await harness({
    responder: (call) => {
      const [a, b] = evidenceIn(call).map((i) => i.ref);
      return claimJson([
        { text: 'Accounts differ on the crew.', kind: 'conflict', evidence: [a, b] },
        { text: 'One-sided conflict.', kind: 'conflict', evidence: [a] },
      ]);
    },
  });
  const answer = await askHelix(h.deps, who(alice), { question: 'tanker attack Red Sea' });
  assert.equal(answer.claims.length, 1);
  assert.equal(answer.claims[0].basis, 'conflict');
  await h.stop();
});

test('ask: cache hit makes no model call; changed evidence, a refresh or another person misses the cache', async () => {
  const h = await harness();
  const q = { question: 'tanker attack Red Sea' };
  const first = await askHelix(h.deps, who(alice), q);
  assert.equal(h.fake.chatCount, 1);
  const again = await askHelix(h.deps, who(alice), q);
  assert.equal(again.cached, true);
  assert.equal(again.id, first.id);
  assert.equal(h.fake.chatCount, 1, 'served from cache');
  assert.equal(h.ai.counters.cacheHits, 1);

  await askHelix(h.deps, who(alice), { ...q, refresh: true });
  assert.equal(h.fake.chatCount, 2, 'refresh regenerates');

  const other = await askHelix(h.deps, who(bob), q);
  assert.notEqual(other.id, first.id);
  assert.equal(h.fake.chatCount, 3, 'caches are per person');
  assert.equal(h.aiStore.getOutput(bob, first.id), null, "one person's saved answer is not readable by another");

  // new evidence -> new fingerprint -> miss
  h.store.updateUserState(alice, id(2), { reviewStatus: 'Reviewed' }, NOW.toISOString());
  h.fake.reset();
  await askHelix(h.deps, who(alice), { question: 'tanker attack Red Sea unreviewed' });
  assert.equal(h.fake.chatCount, 1);
  await h.stop();
});

test('ask: a different model version does not reuse the cache', async () => {
  const h = await harness();
  const q = { question: 'tanker attack Red Sea' };
  await askHelix(h.deps, who(alice), q);
  h.fake.tags = [{ name: 'qwen3:4b', digest: 'sha256:ffffffffffff' }];
  const upgraded = new AiService(h.ai.config, fetch, () => NOW);
  await askHelix({ ...h.deps, ai: upgraded }, who(alice), q);
  assert.equal(h.fake.chatCount, 2, 'a new model digest means a new answer');
  await h.stop();
});

test('ask: when the model is unreachable the call fails with an availability error and nothing is invented', async () => {
  const h = await harness({ connected: false });
  await assert.rejects(askHelix(h.deps, who(alice), { question: 'tanker attack Red Sea' }), (error: unknown) => error instanceof AiUnavailableError && error.state === 'setup_required');
  assert.equal(h.aiStore.listOutputs(alice).length, 0, 'no result was saved');
  await h.stop();
});

test('ask: audit entries record who asked, what and which records were used', async () => {
  const h = await harness();
  await askHelix(h.deps, who(alice, 'Ana Analyst'), { question: 'tanker attack Red Sea' });
  const audit = h.aiStore.auditFor(alice);
  assert.equal(audit[0].actor, 'Ana Analyst');
  assert.equal(audit[0].action, 'ask');
  assert.match(audit[0].detail, /news\.example\.test|test-a:/);
  assert.match(audit[0].detail, /qwen3:4b/);
  assert.deepEqual(h.aiStore.auditFor(bob), []);
  await h.stop();
});

test('ask: the task prompt for each call is identified correctly by the harness', async () => {
  const h = await harness({ responder: (call: FakeCall) => { assert.equal(taskOf(call), 'ask'); return wellBehaved(call); } });
  await askHelix(h.deps, who(alice), { question: 'tanker attack Red Sea' });
  await h.stop();
});
