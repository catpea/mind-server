/**
 * server.js — HTTP server for mind-server.
 *
 * Manages a project via its .mind-server/ directory.
 * All state (board data, agent memory) lives inside the target project.
 *
 * Route table:
 *   GET  /                         — index + project info
 *   GET  /r                        — list subreddits
 *   GET  /r/:sub                   — list posts (?status= ?type= ?author= ?limit=)
 *   POST /r/:sub                   — create post { title, body, author, type, meta }
 *   GET  /r/:sub/:id               — get post + comments
 *   PATCH /r/:sub/:id              — update post { status, body, meta, … }
 *   POST /r/:sub/:id/comment       — add comment { author, body }
 *   GET  /u/:name                  — user profile (posts + DMs)
 *   GET  /dm                       — list DMs (?to= ?from= ?unreadOnly=)
 *   POST /dm                       — send DM { from, to, subject, body }
 *   POST /dm/:id/read              — mark DM read
 *   GET  /agents                   — list agents
 *   GET  /agents/:name             — agent info + recent memory
 *   POST /agents/:name/run         — trigger one agent cycle
 *   DELETE /agents/:name/memory    — clear agent memory
 *   GET  /events                   — SSE stream
 *   GET  /summary                  — board summary
 *   GET  /instructions             — markdown context for agents
 *   GET  /openapi.json             — OpenAPI 3.1 spec
 *
 * CORS: enabled for all origins (agents call from anywhere).
 * No external dependencies — Node.js built-ins only.
 */

import { createServer }  from 'node:http';
import { resolve, join } from 'node:path';
import { mkdir }         from 'node:fs/promises';

import { Store }         from './store.js';
import { SseHub }        from './sse.js';
import { Board }         from './board.js';
import { buildSpec }     from './openapi.js';
import { createAgents }  from './agents/index.js';
import { initBoard }     from './template.js';
import { Config }        from './config.js';
import { createAI }      from './agents/ai.js';

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) reject(new Error('Payload too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  return Object.fromEntries(new URL(url, 'http://x').searchParams.entries());
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, data, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(data, null, 2) : String(data);
  res.writeHead(status, { 'Content-Type': type, ...CORS });
  res.end(body);
}

const json = (res, status, data) => send(res, status, data);
const text = (res, status, str)  => send(res, status, str, 'text/plain; charset=utf-8');
const e404 = (res, msg = 'Not found')   => json(res, 404, { error: msg });
const e400 = (res, msg)                  => json(res, 400, { error: msg });
const e500 = (res, err)                  => json(res, 500, { error: String(err?.message ?? err) });

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create the HTTP server bound to a target project directory.
 *
 * @param {object} opts
 * @param {string} opts.targetDir  — absolute path to the project directory
 * @param {number} [opts.port]     — port for spec generation (default 3002)
 * @returns {{ server, store, hub, board, agents }}
 */
export async function createMindServer({ targetDir, port = 3002 } = {}) {
  targetDir = resolve(targetDir ?? process.cwd());

  // Create .mind-server directory structure
  const mindDir = join(targetDir, '.mind-server');
  const dataDir = join(mindDir, 'data');
  await mkdir(dataDir, { recursive: true });

  // Load config (persists port + AI settings; secrets stay in env vars)
  const config = await Config.load(mindDir);
  // Update config if port explicitly provided
  if (port !== config.get('port')) await config.set('port', port);

  const ai     = createAI(config.getAI());
  const store  = new Store(dataDir);
  const hub    = new SseHub();
  const board  = new Board(store, hub);
  const agents = createAgents({ targetDir, ai });
  const spec   = buildSpec(port);

  // Bootstrap default board content for fresh projects
  await initBoard(board, targetDir);

  // ── Request handler ────────────────────────────────────────────────────────

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    const method   = req.method;
    const url      = req.url ?? '/';
    const normPath = url.split('?')[0].replace(/\/+$/, '') || '/';
    const query    = parseQuery(url);

    try {

      // ── Index ──────────────────────────────────────────────────────────────
      if (normPath === '/' && method === 'GET') {
        return json(res, 200, {
          name:      'mind-server',
          version:   '1.0.0',
          targetDir,
          agents:    agents.list().map(a => a.name),
          links:     { board: '/r', instructions: '/instructions', spec: '/openapi.json', events: '/events', summary: '/summary' },
        });
      }

      if (normPath === '/openapi.json' && method === 'GET') {
        return json(res, 200, spec);
      }

      // ── SSE ────────────────────────────────────────────────────────────────
      if (normPath === '/events' && method === 'GET') {
        hub.connect(req, res);
        return;
      }

      // ── Summary ────────────────────────────────────────────────────────────
      if (normPath === '/summary' && method === 'GET') {
        return json(res, 200, await board.summary());
      }

      // ── Instructions (markdown) ────────────────────────────────────────────
      if (normPath === '/instructions' && method === 'GET') {
        const summary = await board.summary();
        const front   = await board.frontPage();
        const agentList = agents.list().map(a => `- **${a.avatar} ${a.name}** — ${a.description}`).join('\n');
        const md = [
          '# Mind Server — Board Instructions',
          '',
          `Project: \`${targetDir}\``,
          `AI available: ${process.env.ANTHROPIC_API_KEY ? 'yes (ANTHROPIC_API_KEY set)' : 'no — set ANTHROPIC_API_KEY to enable AI agents'}`,
          '',
          '## Board Summary',
          `- Posts: ${summary.postCount} | Subreddits: ${summary.subCount}`,
          '- By status: ' + Object.entries(summary.byStatus).map(([k, v]) => `${k}: ${v}`).join(', '),
          '',
          front,
          '',
          '## Agent Team',
          agentList,
          '',
          '## Post Status Lifecycle',
          '`open` → `planned` → `in-progress` → `review` → `done`',
          '',
          '## Key Endpoints',
          '- `POST /r/requests`          — submit a feature request or bug report',
          '- `GET  /r/todo`              — see implementation queue',
          '- `PATCH /r/:sub/:id`         — advance post status',
          '- `POST /agents/vera/run`     — trigger Vera (orchestrator)',
          '- `POST /agents/:name/run`    — trigger any agent',
          '- `GET  /agents`              — list all agents',
          '- `GET  /openapi.json`        — full API spec',
          '- `GET  /events`              — real-time SSE stream',
        ].join('\n');
        return text(res, 200, md);
      }

      // ── Agents ─────────────────────────────────────────────────────────────

      if (normPath === '/agents' && method === 'GET') {
        const list = agents.list();
        // Attach AI availability
        const withAI = list.map(a => ({ ...a, aiAvailable: !!process.env.ANTHROPIC_API_KEY }));
        return json(res, 200, withAI);
      }

      const agentRunM = normPath.match(/^\/agents\/([^/]+)\/run$/);
      if (agentRunM && method === 'POST') {
        const name = agentRunM[1];
        if (!agents.get(name)) return e404(res, `Agent not found: ${name}`);
        const result = await agents.run(name, { board, hub });
        return json(res, 200, result);
      }

      const agentMemoryDelM = normPath.match(/^\/agents\/([^/]+)\/memory$/);
      if (agentMemoryDelM && method === 'DELETE') {
        const name = agentMemoryDelM[1];
        if (!agents.get(name)) return e404(res, `Agent not found: ${name}`);
        await agents.clearMemory(name);
        return json(res, 200, { ok: true });
      }

      const agentDetailM = normPath.match(/^\/agents\/([^/]+)$/);
      if (agentDetailM && method === 'GET') {
        const name  = agentDetailM[1];
        const agent = agents.get(name);
        if (!agent) return e404(res, `Agent not found: ${name}`);
        const memory = await agents.memory(name, { limit: parseInt(query.limit ?? '100') });
        return json(res, 200, { ...agent.toJSON(), memory });
      }

      // ── DMs ────────────────────────────────────────────────────────────────

      if (normPath === '/dm' && method === 'GET') {
        return json(res, 200, await board.getDMs({
          to:         query.to,
          from:       query.from,
          unreadOnly: query.unreadOnly === 'true',
        }));
      }

      if (normPath === '/dm' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.from || !body.to || !body.body) return e400(res, 'from, to, body required');
        return json(res, 201, await board.sendDM(body));
      }

      const dmReadM = normPath.match(/^\/dm\/([^/]+)\/read$/);
      if (dmReadM && method === 'POST') {
        return json(res, 200, await board.markDMRead(dmReadM[1]));
      }

      // ── User profile ───────────────────────────────────────────────────────

      const userM = normPath.match(/^\/u\/([^/]+)$/);
      if (userM && method === 'GET') {
        const name = userM[1];
        return json(res, 200, {
          name,
          sub:   await board.getSub(`u/${name}`),
          posts: await board.getPosts(`u/${name}`).catch(() => []),
          inbox: await board.getDMs({ to: name }),
          sent:  await board.getDMs({ from: name }),
        });
      }

      // ── Subreddits ─────────────────────────────────────────────────────────

      if (normPath === '/r' && method === 'GET') {
        return json(res, 200, await board.listSubs());
      }

      // ── Posts ──────────────────────────────────────────────────────────────

      const subM = normPath.match(/^\/r\/([^/]+)$/);
      if (subM) {
        const subName = decodeURIComponent(subM[1]);

        if (method === 'GET') {
          return json(res, 200, await board.getPosts(subName, {
            status: query.status,
            type:   query.type,
            author: query.author,
            limit:  query.limit ? parseInt(query.limit) : 100,
          }));
        }

        if (method === 'POST') {
          const body = await parseBody(req);
          if (!body.title || !body.author) return e400(res, 'title and author required');
          return json(res, 201, await board.createPost(subName, body));
        }
      }

      // ── Single post ────────────────────────────────────────────────────────

      const postM = normPath.match(/^\/r\/([^/]+)\/([^/]+)$/);
      if (postM) {
        const [, , postId] = postM;

        if (method === 'GET') {
          const post = await board.getPost(postId);
          if (!post) return e404(res, `Post not found: ${postId}`);
          return json(res, 200, { ...post, comments: await board.getComments(postId) });
        }

        if (method === 'PATCH') {
          const body = await parseBody(req);
          return json(res, 200, await board.updatePost(postId, body));
        }
      }

      // ── Comments ───────────────────────────────────────────────────────────

      const commentM = normPath.match(/^\/r\/([^/]+)\/([^/]+)\/comment$/);
      if (commentM && method === 'POST') {
        const [, , postId] = commentM;
        const body = await parseBody(req);
        if (!body.author || !body.body) return e400(res, 'author and body required');
        return json(res, 201, await board.addComment(postId, body));
      }

      e404(res);

    } catch (err) {
      console.error('[mind-server] error:', err);
      e500(res, err);
    }
  });

  return { server, store, hub, board, agents };
}
