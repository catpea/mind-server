/**
 * e2e.test.js — End-to-end agent cycle test.
 *
 * Pipeline: POST request → Monica plans → Erica implements → Rita reviews → done
 *
 * Runs entirely in a temp directory with a mock AI (no Anthropic API key needed).
 * Amy is skipped — Monica handles unreviewed requests directly.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Store }  from '../src/store.js';
import { Board }  from '../src/board.js';
import { Monica } from '../src/agents/monica.js';
import { Erica }  from '../src/agents/erica.js';
import { Rita }   from '../src/agents/rita.js';
import { SUBS, STATUS, META } from '../src/board-schema.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TMP_DIR = mkdtempSync('/tmp/mind-e2e-');

const hub = { broadcast: () => {} };

let store, board;
let monica, erica, rita;

/**
 * Build a mock AI that returns sensible fixed responses based on prompt content.
 * This lets us test the full pipeline without an API key.
 */
function makeMockAI() {
  const fastAsk = async () => 'Looks good.';

  const fastAskJSON = async () => ({
    needsClarification: false,
    questions: [],
    priority: 'medium',
    rationale: 'Auto-approved by test mock.',
    ok: true,
    comment: 'LGTM',
  });

  const fullAsk = async (prompt) => {
    // Monica's planning prompt — return a markdown plan
    if (prompt.includes('Write a structured todo plan') || prompt.includes('You are Monica')) {
      return [
        '## Goal',
        'Add a greeting function.',
        '',
        '## Acceptance Criteria',
        '1. Function returns a greeting string.',
        '2. Existing tests still pass.',
        '',
        '## Files Likely Affected',
        'src/greet.js',
        '',
        '## Complexity',
        'S',
        '',
        '## Notes',
        'None.',
      ].join('\n');
    }
    return 'Looks good.';
  };

  const fullAskJSON = async (prompt) => {
    // Erica's implementation prompt
    if (prompt.includes('You are Erica') || prompt.includes('Implement the following task')) {
      return {
        summary: 'Added greet.js with greeting function.',
        files: { 'src/greet.js': '// greet\nexport function greet(name) { return `Hello, ${name}!`; }\n' },
        notes: '',
      };
    }
    // Rita's review prompt
    if (prompt.includes('Review this implementation')) {
      return { approved: true, comment: '✅ Implementation looks correct.' };
    }
    // Heather's quick design review (called by Monica via ctx.call)
    if (prompt.includes('Quick design review') || prompt.includes('design review')) {
      return { ok: true, comment: 'LGTM' };
    }
    return {};
  };

  return {
    isAvailable: () => true,
    ask:     fullAsk,
    askJSON: fullAskJSON,
    fast: { isAvailable: () => true, ask: fastAsk, askJSON: fastAskJSON },
    full: { isAvailable: () => true, ask: fullAsk, askJSON: fullAskJSON },
  };
}

/** Build a ctx object for running agents. */
function makeCtx(opts = {}) {
  const ai = makeMockAI();

  // Minimal tools — shell is real, others are no-ops (or simple stubs)
  const tools = {
    shell:            async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    search:           async () => [],
    findRefs:         async () => [],
    findFiles:        async () => [],
    fetch:            async () => ({ ok: false, status: 0, text: '' }),
    buildGraph:       async () => ({ nodes: [], edges: [] }),
    findDependencies: () => [],
    findDependents:   () => [],
    findCycles:       () => [],
    findGodModules:   () => [],
    buildCoverageMap: async () => ({ covered: [], uncovered: [], total: 0, pct: 0 }),
  };

  // ctx.call — needed by Monica (calls Heather's reviewDesign skill)
  const call = async (_name, method) => {
    if (method === 'reviewDesign') return { ok: true, comment: 'LGTM' };
    return null;
  };

  return {
    board,
    targetDir: TMP_DIR,
    hub,
    ai,
    gated:          false,  // Erica can pick up 'open'/'planned' todos without approval gate
    projectContext: '',
    tools,
    call,
    ...opts,
  };
}

before(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(join(TMP_DIR, 'src'), { recursive: true });

  store  = new Store(join(TMP_DIR, '.mind-server', 'board'));
  board  = new Board(store, hub);

  monica = new Monica();   monica.init({ targetDir: TMP_DIR });
  erica  = new Erica();    erica.init({ targetDir: TMP_DIR });
  rita   = new Rita();     rita.init({ targetDir: TMP_DIR });
});

after(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ── End-to-end pipeline ────────────────────────────────────────────────────────

test('e2e: request → Monica plans → todo created in r/todo', async () => {
  // Seed a request post
  await board.ensureSub(SUBS.REQUESTS);
  const request = await board.createPost(SUBS.REQUESTS, {
    title:  'Add a greet function',
    body:   'Add a function that returns a greeting string.',
    author: 'human',
    status: STATUS.OPEN,
  });
  assert.ok(request.id, 'request post should be created');

  // Run Monica
  const result = await monica.run(makeCtx());
  assert.equal(result.outcome, 'planned');

  // Todo should now exist in r/todo
  await board.ensureSub(SUBS.TODO);
  const todos = await board.getPosts(SUBS.TODO);
  assert.equal(todos.length >= 1, true, 'at least one todo should be created');

  const todo = todos.find(t => t.title === 'Add a greet function');
  assert.ok(todo, 'todo should match the request title');
  assert.equal(todo.status, STATUS.OPEN, 'ungated todo starts as open');
});

test('e2e: Erica implements the open todo', async () => {
  const todos  = await board.getPosts(SUBS.TODO);
  const before = todos.find(t => t.title === 'Add a greet function');
  assert.ok(before, 'todo must exist for Erica to pick up');

  const result = await erica.run(makeCtx());

  // Erica should have implemented it
  assert.equal(result.outcome, 'implemented', `expected implemented, got: ${result.outcome}`);
  assert.ok(result.filesWritten?.length > 0, 'Erica should have written files');
});

test('e2e: Rita reviews and approves → todo is done', async () => {
  // Check todo is in review after Erica's run
  const todos  = await board.getPosts(SUBS.TODO);
  const inReview = todos.find(t => t.title === 'Add a greet function' && t.status === STATUS.REVIEW);
  assert.ok(inReview, 'todo should be in review after Erica implements it');

  // Run Rita
  const result = await rita.run(makeCtx());
  assert.equal(result.outcome, 'approved');

  // Todo should be done
  const after = await board.getPosts(SUBS.TODO);
  const done  = after.find(t => t.title === 'Add a greet function');
  assert.ok(done, 'todo should still exist');
  assert.equal(done.status, STATUS.DONE, `expected done, got: ${done.status}`);
});
