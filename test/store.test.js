import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { Store } from '../src/store.js';

const DATA_DIR = '/tmp/mind-server-test-store';
let store;

before(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  store = new Store(DATA_DIR);
});

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

test('put creates a record with rev=1', async () => {
  const r = await store.put('things', { id: 'a', name: 'Alice' });
  assert.equal(r.id, 'a');
  assert.equal(r.rev, 1);
  assert.ok(r.uid);
  assert.ok(r.createdAt);
});

test('get returns latest revision', async () => {
  const r = await store.get('things', 'a');
  assert.equal(r.name, 'Alice');
  assert.equal(r.rev, 1);
});

test('put increments revision on update', async () => {
  const r1 = await store.get('things', 'a');
  const r2 = await store.put('things', { ...r1, name: 'Alice Updated' });
  assert.equal(r2.rev, 2);
  assert.equal(r2.name, 'Alice Updated');
});

test('has returns true for existing record', async () => {
  assert.equal(await store.has('things', 'a'), true);
  assert.equal(await store.has('things', 'doesnotexist'), false);
});

test('all returns all live records', async () => {
  await store.put('things', { id: 'b', name: 'Bob' });
  const all = await store.all('things');
  assert.equal(all.length, 2);
  assert.ok(all.find(r => r.id === 'a'));
  assert.ok(all.find(r => r.id === 'b'));
});

test('del soft-deletes a record', async () => {
  await store.del('things', 'b');
  assert.equal(await store.get('things', 'b'), null);
  const all = await store.all('things');
  assert.equal(all.length, 1); // 'b' gone
});

test('revisions returns sorted history', async () => {
  const revs = await store.revisions('things', 'a');
  assert.ok(revs.length >= 2);
  assert.ok(revs[0].data.rev < revs[revs.length - 1].data.rev);
});

test('get returns null for non-existent record', async () => {
  assert.equal(await store.get('things', 'nope'), null);
});

test('all returns [] for empty collection', async () => {
  const all = await store.all('empty-collection');
  assert.deepEqual(all, []);
});
