import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { Board } from '../src/board.js';

const DATA_DIR = '/tmp/mind-server-test-board';

// Minimal no-op SSE hub
const hub = { broadcast: () => {}, size: 0 };

let store, board;

before(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  store = new Store(DATA_DIR);
  board = new Board(store, hub);
});

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

test('createPost creates post with status=open', async () => {
  const post = await board.createPost('general', { title: 'Hello', author: 'vera' });
  assert.equal(post.status, 'open');
  assert.equal(post.sub, 'general');
  assert.equal(post.author, 'vera');
  assert.ok(post.id);
});

test('getPosts returns posts for a sub', async () => {
  const posts = await board.getPosts('general');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Hello');
});

test('advanceStatus changes post status', async () => {
  const posts = await board.getPosts('general');
  const updated = await board.advanceStatus(posts[0].id, 'in-progress');
  assert.equal(updated.status, 'in-progress');
});

test('advanceStatus rejects invalid status', async () => {
  const posts = await board.getPosts('general');
  await assert.rejects(() => board.advanceStatus(posts[0].id, 'invalid'), /Invalid status/);
});

test('addComment and getComments work', async () => {
  const posts = await board.getPosts('general');
  const comment = await board.addComment(posts[0].id, { author: 'erica', body: 'Great!' });
  assert.equal(comment.postId, posts[0].id);
  const comments = await board.getComments(posts[0].id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'Great!');
});

test('sendDM and getDMs work', async () => {
  const dm = await board.sendDM({ from: 'vera', to: 'erica', body: 'Hey!' });
  assert.equal(dm.from, 'vera');
  assert.equal(dm.to, 'erica');
  assert.equal(dm.read, false);

  const inbox = await board.getDMs({ to: 'erica' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].body, 'Hey!');
});

test('markDMRead marks DM as read', async () => {
  const dms = await board.getDMs({ to: 'erica' });
  const updated = await board.markDMRead(dms[0].id);
  assert.equal(updated.read, true);
});

test('getDMs unreadOnly filters correctly', async () => {
  await board.sendDM({ from: 'rita', to: 'erica', body: 'Unread!' });
  const unread = await board.getDMs({ to: 'erica', unreadOnly: true });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].from, 'rita');
});

test('ensureSub is idempotent', async () => {
  const s1 = await board.ensureSub('tech');
  const s2 = await board.ensureSub('tech');
  assert.equal(s1.id, s2.id);
});

test('u/name subs work via subId encoding', async () => {
  await board.ensureSub('u/vera');
  const sub = await board.getSub('u/vera');
  assert.ok(sub);
  // Stored ID uses %2F encoding (changed from __ in Session 1)
  assert.equal(sub.id, 'u%2Fvera');
});

test('summary returns counts by status', async () => {
  const s = await board.summary();
  assert.ok(typeof s.postCount === 'number');
  assert.ok('open' in s.byStatus);
  assert.ok('done' in s.byStatus);
  assert.ok(Array.isArray(s.recent));
});

test('listSubs restores real names', async () => {
  const subs = await board.listSubs();
  const vera = subs.find(s => s.name === 'u/vera');
  assert.ok(vera, 'u/vera sub should appear with slash');
});

// ── Status transition tests ────────────────────────────────────────────────────

test('open → planned is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-open-planned', author: 'test' });
  const updated = await board.advanceStatus(post.id, 'planned');
  assert.equal(updated.status, 'planned');
});

test('open → awaiting-approval is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-open-awaiting', author: 'test' });
  const updated = await board.advanceStatus(post.id, 'awaiting-approval');
  assert.equal(updated.status, 'awaiting-approval');
});

test('open → in-progress is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-open-ip', author: 'test' });
  const updated = await board.advanceStatus(post.id, 'in-progress');
  assert.equal(updated.status, 'in-progress');
});

test('planned → in-progress is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-pl-ip', author: 'test' });
  await board.advanceStatus(post.id, 'planned');
  const updated = await board.advanceStatus(post.id, 'in-progress');
  assert.equal(updated.status, 'in-progress');
});

test('in-progress → review is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-ip-rv', author: 'test' });
  await board.advanceStatus(post.id, 'in-progress');
  const updated = await board.advanceStatus(post.id, 'review');
  assert.equal(updated.status, 'review');
});

test('review → done is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-rv-done', author: 'test' });
  await board.advanceStatus(post.id, 'in-progress');
  await board.advanceStatus(post.id, 'review');
  const updated = await board.advanceStatus(post.id, 'done');
  assert.equal(updated.status, 'done');
});

test('done → open (re-open) is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-done-open', author: 'test' });
  await board.advanceStatus(post.id, 'in-progress');
  await board.advanceStatus(post.id, 'review');
  await board.advanceStatus(post.id, 'done');
  const updated = await board.advanceStatus(post.id, 'open');
  assert.equal(updated.status, 'open');
});

test('open → wont-fix is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-wont-fix', author: 'test' });
  const updated = await board.advanceStatus(post.id, 'wont-fix');
  assert.equal(updated.status, 'wont-fix');
});

test('wont-fix → open (re-open) is valid', async () => {
  const post = await board.createPost('transitions', { title: 'T-wf-open', author: 'test' });
  await board.advanceStatus(post.id, 'wont-fix');
  const updated = await board.advanceStatus(post.id, 'open');
  assert.equal(updated.status, 'open');
});

test('open → done is invalid (must go through review)', async () => {
  const post = await board.createPost('transitions', { title: 'T-open-done-bad', author: 'test' });
  await assert.rejects(
    () => board.advanceStatus(post.id, 'done'),
    /transition/i,
  );
});

test('review → planned is invalid', async () => {
  const post = await board.createPost('transitions', { title: 'T-rv-pl-bad', author: 'test' });
  await board.advanceStatus(post.id, 'in-progress');
  await board.advanceStatus(post.id, 'review');
  await assert.rejects(
    () => board.advanceStatus(post.id, 'planned'),
    /transition/i,
  );
});

test('done → in-progress is invalid', async () => {
  const post = await board.createPost('transitions', { title: 'T-done-ip-bad', author: 'test' });
  await board.advanceStatus(post.id, 'in-progress');
  await board.advanceStatus(post.id, 'review');
  await board.advanceStatus(post.id, 'done');
  await assert.rejects(
    () => board.advanceStatus(post.id, 'in-progress'),
    /transition/i,
  );
});

test('advanceStatus transition error message names both statuses', async () => {
  const post = await board.createPost('transitions', { title: 'T-err-msg', author: 'test' });
  let caught;
  try {
    await board.advanceStatus(post.id, 'done');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'should throw');
  // Error format: 'Invalid transition: "open" → "done". Allowed from ...'
  assert.match(caught.message, /"open"/);
  assert.match(caught.message, /"done"/);
});
