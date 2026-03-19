/**
 * router.js — Minimal Express-style HTTP router. Zero external dependencies.
 *
 * API:
 *   const router = new Router();
 *   router.get('/r/:sub',       async (req, res) => { ... });
 *   router.post('/r/:sub',      async (req, res) => { ... });
 *   router.patch('/r/:sub/:id', async (req, res) => { ... });
 *   router.delete('/agents/:name/memory', async (req, res) => { ... });
 *
 *   createServer(router.handler()).listen(port);
 *
 * ── req extensions ────────────────────────────────────────────────────────────
 *   req.params          named URL params       { sub: 'requests', id: 'abc' }
 *   req.query           URLSearchParams object (raw strings)
 *   req.int(key, def?)  query param coerced to int; returns def (default 0) if missing/NaN
 *   req.bool(key)       query param === 'true'
 *   req.str(key, def?)  query param string; returns def (default '') if missing
 *   req.body()          async — parses JSON request body (max 2 MB)
 *
 * ── res extensions ────────────────────────────────────────────────────────────
 *   res.json(data, status?)   send JSON (default 200)
 *   res.created(data)         send JSON with status 201
 *   res.text(str, status?)    send text/plain (default 200)
 *   res.notFound(msg?)        send 404 JSON
 *   res.badRequest(msg)       send 400 JSON
 *   res.serverError(err)      send 500 JSON (message only, stack never sent)
 *
 * ── CORS ─────────────────────────────────────────────────────────────────────
 *   All responses include CORS headers. OPTIONS preflights are handled automatically.
 */

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Path compiler ─────────────────────────────────────────────────────────────

/**
 * Compile an Express-style path string into a RegExp with named capture groups.
 *
 * Examples:
 *   '/r/:sub'        → /^\/r\/(?<sub>[^/]+)$/
 *   '/agents/:name/run' → /^\/agents\/(?<name>[^/]+)\/run$/
 *   '/'              → /^\/$/
 */
function compilePath(path) {
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const parameterized = escaped.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '(?<$1>[^/]+)');
  return new RegExp(`^${parameterized}$`);
}

// ── Body parser ───────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ── Send helpers ──────────────────────────────────────────────────────────────

function sendRaw(res, status, body, contentType) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': contentType, ...CORS });
  res.end(body);
}

// ── Router ────────────────────────────────────────────────────────────────────

export class Router {
  #routes = []; // { method: string, re: RegExp, handler: fn }

  // ── Route registration ───────────────────────────────────────────────────

  #on(method, path, handler) {
    this.#routes.push({ method, re: compilePath(path), handler });
    return this;
  }

  get(path, handler)    { return this.#on('GET',    path, handler); }
  post(path, handler)   { return this.#on('POST',   path, handler); }
  patch(path, handler)  { return this.#on('PATCH',  path, handler); }
  delete(path, handler) { return this.#on('DELETE', path, handler); }
  put(path, handler)    { return this.#on('PUT',    path, handler); }

  // ── Request handler (http.createServer callback) ─────────────────────────

  /**
   * Returns the function to pass to http.createServer().
   * Augments req and res with typed helpers before dispatching to routes.
   */
  handler() {
    return async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      // ── Parse URL ───────────────────────────────────────────────────────
      const url      = req.url ?? '/';
      const qIdx     = url.indexOf('?');
      const rawPath  = qIdx === -1 ? url : url.slice(0, qIdx);
      const qs       = qIdx === -1 ? '' : url.slice(qIdx + 1);

      // Normalize: decode, strip trailing slashes, default to '/'
      let path;
      try {
        path = decodeURIComponent(rawPath).replace(/\/+$/, '') || '/';
      } catch {
        path = rawPath.replace(/\/+$/, '') || '/';
      }

      const searchParams = new URLSearchParams(qs);

      // ── Augment req ─────────────────────────────────────────────────────
      req.params = {};
      req.query  = searchParams;

      /** Query param as integer. Returns `def` (default 0) if absent or NaN. */
      req.int  = (key, def = 0) => {
        const n = parseInt(searchParams.get(key) ?? '', 10);
        return Number.isFinite(n) ? n : def;
      };
      /** Query param as boolean. 'true' → true, anything else → false. */
      req.bool = (key) => searchParams.get(key) === 'true';
      /** Query param as string. Returns `def` (default '') if absent. */
      req.str  = (key, def = '') => searchParams.get(key) ?? def;
      /** Async: parse the JSON request body. Rejects on invalid JSON or >2MB. */
      req.body = () => parseBody(req);

      // ── Augment res ─────────────────────────────────────────────────────
      /**
       * Send a JSON response.
       * @param {*}      data
       * @param {number} [status=200]
       */
      res.json = (data, status = 200) =>
        sendRaw(res, status, JSON.stringify(data, null, 2), 'application/json');

      /** Send 201 Created + JSON. */
      res.created = (data) => res.json(data, 201);

      /**
       * Send a plain-text response.
       * @param {string} str
       * @param {number} [status=200]
       */
      res.text = (str, status = 200) =>
        sendRaw(res, status, String(str), 'text/plain; charset=utf-8');

      /** Send 404 Not Found + JSON. */
      res.notFound = (msg = 'Not found') => res.json({ error: msg }, 404);

      /** Send 400 Bad Request + JSON. */
      res.badRequest = (msg) => res.json({ error: msg }, 400);

      /**
       * Send 500 Internal Server Error + JSON.
       * Logs the full error to console but only sends the message to the client.
       */
      res.serverError = (err) => {
        console.error('[server] 500', err);
        const msg = err instanceof Error ? err.message : String(err);
        res.json({ error: msg }, 500);
      };

      // ── Route dispatch ──────────────────────────────────────────────────
      const method = req.method.toUpperCase();

      for (const route of this.#routes) {
        if (route.method !== method) continue;
        const match = path.match(route.re);
        if (!match) continue;

        req.params = match.groups ?? {};
        try {
          await route.handler(req, res);
        } catch (err) {
          if (!res.headersSent) res.serverError(err);
          else console.error('[server] unhandled error after headers sent:', err);
        }
        return;
      }

      res.notFound();
    };
  }
}
