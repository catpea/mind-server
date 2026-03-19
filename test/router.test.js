/**
 * router.test.js — Unit tests for src/router.js
 *
 * Tests: path matching, param extraction, req.int/bool/str, CORS headers,
 *        OPTIONS preflight, 404 fallback, error handler → 500.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Router } from '../src/router.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let server;
let port;

/** GET / POST / etc. to the test server. */
function req(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : '';
    const hdrs    = {};
    if (bodyStr) {
      hdrs['Content-Type']   = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers: hdrs }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

before(() => new Promise((resolve, reject) => {
  const router = new Router();

  router.get('/', (_req, res) => res.json({ ok: true }));
  router.get('/r/:sub', (req, res) => res.json({ sub: req.params.sub }));
  router.get('/r/:sub/posts/:id', (req, res) => res.json(req.params));
  router.get('/typed', (req, res) => res.json({
    n:    req.int('n'),
    nDef: req.int('missing', 42),
    b:    req.bool('b'),
    s:    req.str('s'),
    sDef: req.str('missing', 'hello'),
  }));
  router.post('/echo', async (req, res) => {
    const body = await req.body();
    res.created(body);
  });
  router.get('/boom', () => { throw new Error('kaboom'); });

  server = http.createServer(router.handler());
  server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve();
  });
  server.on('error', reject);
}));

after(() => new Promise(resolve => server.close(resolve)));

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET / matches root route', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('GET /r/:sub extracts named param', async () => {
  const r = await req('GET', '/r/todo');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { sub: 'todo' });
});

test('GET /r/:sub/posts/:id extracts multiple params', async () => {
  const r = await req('GET', '/r/todo/posts/abc123');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { sub: 'todo', id: 'abc123' });
});

test('GET /unknown → 404 Not Found JSON', async () => {
  const r = await req('GET', '/no-such-route');
  assert.equal(r.status, 404);
  assert.ok(r.json?.error);
});

test('req.int coerces query param to integer', async () => {
  const r = await req('GET', '/typed?n=7&b=true&s=world');
  assert.equal(r.status, 200);
  assert.equal(r.json.n, 7);
});

test('req.int returns default when param absent', async () => {
  const r = await req('GET', '/typed');
  assert.equal(r.json.nDef, 42);
  assert.equal(r.json.n, 0);
});

test('req.bool returns true only for "true"', async () => {
  const tru = await req('GET', '/typed?b=true');
  const fls = await req('GET', '/typed?b=false');
  const abs = await req('GET', '/typed');
  assert.equal(tru.json.b, true);
  assert.equal(fls.json.b, false);
  assert.equal(abs.json.b, false);
});

test('req.str returns value or default', async () => {
  const r = await req('GET', '/typed?s=meow');
  assert.equal(r.json.s, 'meow');
  assert.equal(r.json.sDef, 'hello');
});

test('CORS headers present on GET response', async () => {
  const r = await req('GET', '/');
  assert.ok(r.headers['access-control-allow-origin']);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});

test('OPTIONS preflight → 204 + CORS headers', async () => {
  const r = await req('OPTIONS', '/r/todo');
  assert.equal(r.status, 204);
  assert.ok(r.headers['access-control-allow-methods']);
});

test('POST /echo → 201 + echoed body', async () => {
  const r = await req('POST', '/echo', { body: { msg: 'hi' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { msg: 'hi' });
});

test('handler error → 500 JSON with message', async () => {
  const r = await req('GET', '/boom');
  assert.equal(r.status, 500);
  assert.equal(r.json?.error, 'kaboom');
});

test('trailing slash is normalised', async () => {
  const r = await req('GET', '/r/general/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { sub: 'general' });
});
