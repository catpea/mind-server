/**
 * agent.test.js — Tests for the BaseAgent framework.
 *
 * Tests: postSafe(), recallWhere(), readonly board proxy, memory rotation.
 * Uses a concrete subclass (TestAgent) to access protected BaseAgent behaviour.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { Board } from '../src/board.js';
import { BaseAgent } from '../src/agents/base.js';

const DATA_DIR = '/tmp/mind-server-test-agent';

const hub = { broadcast: () => {} };

let store, board;

// Minimal concrete agent for testing
class TestAgent extends BaseAgent {
  static priority = 99;
  name        = 'testagent';
  description = 'Test agent';
  avatar      = '🧪';
  role        = 'test';
  readonly    = false;
}

class ReadonlyTestAgent extends BaseAgent {
  static priority = 99;
  name        = 'ro-agent';
  description = 'Read-only test agent';
  avatar      = '👁';
  role        = 'test';
  readonly    = true;  // explicitly opt into readonly protection
}

let agent;
let roAgent;

before(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  store  = new Store(DATA_DIR);
  board  = new Board(store, hub);
  agent  = new TestAgent();
  agent.init({ targetDir: DATA_DIR });
  roAgent = new ReadonlyTestAgent();
  roAgent.init({ targetDir: DATA_DIR });
});

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

// ── postSafe() ────────────────────────────────────────────────────────────────

test('postSafe creates post and returns isDuplicate=false', async () => {
  await board.ensureSub('tests');
  const { post, isDuplicate } = await agent.postSafe(board, 'tests', {
    title:  'New Finding',
    body:   'Details here',
    author: 'testagent',
    type:   'quality',
  });
  assert.equal(isDuplicate, false);
  assert.equal(post.title, 'New Finding');
  assert.ok(post.id);
});

test('postSafe detects a duplicate and returns isDuplicate=true', async () => {
  const { post: original } = await agent.postSafe(board, 'tests', {
    title:  'Duplicate Finding',
    author: 'testagent',
  });
  assert.ok(original.id);

  // Second call with same title → should deduplicate
  const { post: dupe, isDuplicate } = await agent.postSafe(board, 'tests', {
    title:  'Duplicate Finding',
    author: 'testagent',
  });
  assert.equal(isDuplicate, true);
  assert.equal(dupe.id, original.id, 'should return the existing post');
});

test('postSafe auto-creates the sub if absent', async () => {
  const { post, isDuplicate } = await agent.postSafe(board, 'brand-new-sub', {
    title:  'First Post',
    author: 'testagent',
  });
  assert.equal(isDuplicate, false);
  const sub = await board.getSub('brand-new-sub');
  assert.ok(sub, 'sub should have been created');
  assert.ok(post.id);
});

// ── recallWhere() ─────────────────────────────────────────────────────────────

test('recallWhere returns entries of the requested type only', async () => {
  await agent.remember('alpha', { val: 1 });
  await agent.remember('beta',  { val: 2 });
  await agent.remember('alpha', { val: 3 });

  const alphas = await agent.recallWhere('alpha');
  assert.ok(alphas.every(e => e.type === 'alpha'));
  assert.equal(alphas.length >= 2, true);
});

test('recallWhere returns entries in reverse-chronological order (newest first)', async () => {
  await agent.remember('ordered', { seq: 1 });
  await agent.remember('ordered', { seq: 2 });
  await agent.remember('ordered', { seq: 3 });

  const entries = await agent.recallWhere('ordered');
  // newest first → seq values should be descending
  assert.equal(entries[0].content.seq > entries[entries.length - 1].content.seq, true);
});

test('recallWhere applies predicate filter', async () => {
  await agent.remember('metric', { score: 10 });
  await agent.remember('metric', { score: 90 });
  await agent.remember('metric', { score: 50 });

  const high = await agent.recallWhere('metric', e => e.content.score > 70);
  assert.ok(high.length >= 1);
  assert.ok(high.every(e => e.content.score > 70));
});

test('recallWhere returns empty array when no match', async () => {
  const none = await agent.recallWhere('nonexistent-type');
  assert.deepEqual(none, []);
});

// ── Readonly proxy ─────────────────────────────────────────────────────────────

test('readonly agent: write methods are blocked and return null', async () => {
  // Use the readonly agent's run() which will wrap board in the readonly proxy.
  // We exercise this indirectly by getting the proxied board from a run() call.
  // More directly: subclass run() and inspect the proxied board.

  // Construct the proxied board the same way BaseAgent does (via run)
  // We'll check that calling createPost on the proxy returns null without throwing.
  let proxyResult = undefined;

  class ProbeAgent extends BaseAgent {
    static priority = 99;
    name        = 'probe';
    description = 'Probe agent';
    avatar      = '🔬';
    readonly    = true;

    async think()         { return {}; }
    async act(_, ctx) {
      // ctx.board is the proxied readonly board
      proxyResult = await ctx.board.createPost('noop', { title: 'blocked', author: 'probe' });
      return { outcome: 'done', actions: [] };
    }
  }

  const probe = new ProbeAgent();
  probe.init({ targetDir: DATA_DIR });

  const ctx = {
    board,
    hub,
    targetDir: DATA_DIR,
    ai: { isAvailable: () => false },
  };

  await probe.run(ctx);

  assert.equal(proxyResult, null, 'readonly proxy should return null for write methods');
});

test('readonly proxy does not throw when write method is called', async () => {
  // This is already implicitly tested above but let's be explicit
  class SilentProbe extends BaseAgent {
    static priority = 99;
    name        = 'silentprobe';
    description = 'Silent probe';
    avatar      = '🔕';
    readonly    = true;

    async think()         { return {}; }
    async act(_, ctx) {
      // Should NOT throw — just return null
      await ctx.board.sendDM({ from: 'a', to: 'b', body: 'blocked' });
      await ctx.board.advanceStatus('fake-id', 'done');
      return { outcome: 'done', actions: [] };
    }
  }

  const probe = new SilentProbe();
  probe.init({ targetDir: DATA_DIR });

  const ctx = {
    board,
    hub,
    targetDir: DATA_DIR,
    ai: { isAvailable: () => false },
  };

  await assert.doesNotReject(() => probe.run(ctx));
});

// ── Memory rotation ────────────────────────────────────────────────────────────

test('memory rotation: oldest entry is dropped when cap is exceeded', async () => {
  const rotAgent = new TestAgent();
  rotAgent.name = 'rot-agent';
  rotAgent.init({ targetDir: DATA_DIR });

  // Write 1001 entries — cap is 1000
  for (let i = 0; i < 1001; i++) {
    await rotAgent.remember('seq', { i });
  }

  const all = await rotAgent.allMemory();
  assert.equal(all.length, 1000, 'should cap at 1000 entries');

  // The oldest entry (i=0) should be gone; newest (i=1000) should be present
  assert.equal(all[0].content.i, 1, 'oldest entry (i=0) should have been dropped');
  assert.equal(all[all.length - 1].content.i, 1000, 'newest entry should be present');
});
