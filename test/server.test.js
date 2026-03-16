import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createMindServer } from '../src/server.js';

const TARGET_DIR = '/tmp/mind-server-test-http-target';
const PORT       = 3097;
const BASE       = `http://localhost:${PORT}`;

let server;

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(BASE + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const GET   = p      => req('GET',   p);
const POST  = (p, b) => req('POST',  p, b);
const PATCH = (p, b) => req('PATCH', p, b);

before(async () => {
  await rm(TARGET_DIR, { recursive: true, force: true });
  const s = await createMindServer({ targetDir: TARGET_DIR, port: PORT });
  server  = s.server;
  await new Promise(resolve => server.listen(PORT, resolve));
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(TARGET_DIR, { recursive: true, force: true });
});

test('GET / returns project info', async () => {
  const r = await GET('/');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'mind-server');
  assert.ok(r.body.targetDir);
  assert.ok(Array.isArray(r.body.agents));
});

test('GET /openapi.json returns OpenAPI 3.1 spec', async () => {
  const r = await GET('/openapi.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.openapi, '3.1.0');
  assert.ok(Object.keys(r.body.paths).length > 5);
});

test('GET /summary returns status counts', async () => {
  const r = await GET('/summary');
  assert.equal(r.status, 200);
  assert.ok('byStatus' in r.body);
  assert.ok('open' in r.body.byStatus);
});

test('GET /agents lists bundled agents', async () => {
  const r = await GET('/agents');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  const names = r.body.map(a => a.name);
  assert.ok(names.includes('vera'));
  assert.ok(names.includes('erica'));
  assert.ok(names.includes('monica'));
  assert.ok(names.includes('rita'));
  assert.ok(names.includes('sandra'));
});

test('GET /agents/:name returns agent with memory', async () => {
  const r = await GET('/agents/vera');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'vera');
  assert.ok(Array.isArray(r.body.memory));
});

test('GET /agents/:name 404 for unknown agent', async () => {
  const r = await GET('/agents/nobody');
  assert.equal(r.status, 404);
});

test('board is initialised with default subreddits on first start', async () => {
  const r = await GET('/r');
  assert.equal(r.status, 200);
  const names = r.body.map(s => s.name);
  assert.ok(names.includes('general'));
  assert.ok(names.includes('requests'));
  assert.ok(names.includes('todo'));
  assert.ok(names.includes('quality'));
  assert.ok(names.includes('dispatch'));
});

test('welcome post created in r/general', async () => {
  const r = await GET('/r/general');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 1, 'should have welcome post');
});

test('POST /r/:sub creates post', async () => {
  const r = await POST('/r/requests', { title: 'Add search feature', author: 'alice', body: 'Users need to search.' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'open');
  assert.equal(r.body.author, 'alice');
});

test('GET /r/:sub lists posts', async () => {
  const r = await GET('/r/requests');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 1);
});

test('GET /r/:sub/:id returns post with comments array', async () => {
  const posts = await GET('/r/requests');
  const id    = posts.body[0].id;
  const r     = await GET(`/r/requests/${id}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.comments));
});

test('PATCH /r/:sub/:id updates post status', async () => {
  const posts = await GET('/r/requests');
  const id    = posts.body[0].id;
  const r     = await PATCH(`/r/requests/${id}`, { status: 'planned' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'planned');
});

test('POST /r/:sub/:id/comment adds a comment', async () => {
  const posts = await GET('/r/requests');
  const id    = posts.body[0].id;
  const r     = await POST(`/r/requests/${id}/comment`, { author: 'vera', body: 'On it.' });
  assert.equal(r.status, 201);
  assert.equal(r.body.postId, id);
});

test('POST /dm sends DM', async () => {
  const r = await POST('/dm', { from: 'vera', to: 'erica', body: 'Check this out.' });
  assert.equal(r.status, 201);
  assert.equal(r.body.read, false);
});

test('GET /dm?to=erica returns DMs', async () => {
  const r = await GET('/dm?to=erica');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 1);
});

test('POST /dm/:id/read marks DM read', async () => {
  const dms = await GET('/dm?to=erica');
  const id  = dms.body[0].id;
  const r   = await req('POST', `/dm/${id}/read`);
  assert.equal(r.status, 200);
  assert.equal(r.body.read, true);
});

test('GET /u/:name returns profile', async () => {
  const r = await GET('/u/vera');
  assert.equal(r.status, 200);
  assert.ok('posts' in r.body);
  assert.ok('inbox' in r.body);
  assert.ok('sent' in r.body);
});

test('POST /r/:sub returns 400 when title missing', async () => {
  const r = await POST('/r/requests', { author: 'vera' });
  assert.equal(r.status, 400);
});

test('POST /dm returns 400 when fields missing', async () => {
  const r = await POST('/dm', { from: 'vera' });
  assert.equal(r.status, 400);
});

test('GET /r/:sub unknown sub returns empty array', async () => {
  const r = await GET('/r/doesnotexist');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('CORS headers present on all responses', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('OPTIONS preflight returns 204', async () => {
  const res = await fetch(`${BASE}/r/general`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
});

test('POST /agents/:name/run triggers agent cycle', async () => {
  // Vera can run without AI (heuristic mode)
  const r = await POST('/agents/vera/run');
  assert.equal(r.status, 200);
  assert.ok('outcome' in r.body);
  assert.ok('durationMs' in r.body);
});
