/**
 * server.js — HTTP server for mind-server.
 *
 * Manages a project via its .mind-server/ directory.
 * All state (board data, agent memory) lives inside the target project.
 *
 * Route table:
 *   GET    /                         — index + project info
 *   GET    /openapi.json             — OpenAPI 3.1 spec
 *   GET    /scheduler/status         — scheduler observability
 *   GET    /events                   — SSE stream
 *   GET    /summary                  — board summary
 *   GET    /instructions             — markdown context for agents
 *   GET    /agents                   — list agents
 *   GET    /agents/:name             — agent info + recent memory
 *   POST   /agents/:name/run         — trigger one agent cycle
 *   DELETE /agents/:name/memory      — clear agent memory
 *   GET    /dm                       — list DMs (?to= ?from= ?unreadOnly=)
 *   POST   /dm                       — send DM { from, to, subject, body }
 *   POST   /dm/:id/read              — mark DM read
 *   POST   /dm/:id/reply             — reply to a DM thread
 *   GET    /dm/:id/thread            — full thread for a DM
 *   GET    /u/:name                  — user profile (posts + DMs)
 *   GET    /r                        — list subreddits
 *   GET    /r/:sub                   — list posts (?status= ?type= ?author= ?limit=)
 *   POST   /r/:sub                   — create post { title, body, author, type, meta }
 *   GET    /r/:sub/:id               — get post + comments
 *   PATCH  /r/:sub/:id               — update post { status, body, meta, … }
 *   POST   /r/:sub/:id/comment       — add comment { author, body }
 *
 * CORS: enabled for all origins.
 * No external dependencies — Node.js built-ins only.
 */

import { createServer }  from 'node:http';
import { resolve, join } from 'node:path';
import { mkdir }         from 'node:fs/promises';

import { Router }        from './router.js';
import { Store }         from './store.js';
import { SseHub }        from './sse.js';
import { Board }         from './board.js';
import { buildSpec }     from './openapi.js';
import { createAgents }  from './agents/index.js';
import { initBoard }     from './template.js';
import { Config }        from './config.js';
import { createAI }      from './agents/ai.js';
import { logBuffer }     from './log-buffer.js';

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create the HTTP server bound to a target project directory.
 *
 * @param {object} opts
 * @param {string} opts.targetDir  — absolute path to the project directory
 * @param {number} [opts.port]     — port for spec generation (default 3002)
 * @param {boolean}[opts.gated]    — require human approval before Erica implements
 * @returns {{ server, store, hub, board, agents, setScheduler }}
 */
export async function createMindServer({ targetDir, port = 3002, gated = true } = {}) {
  targetDir = resolve(targetDir ?? process.cwd());

  // Scheduler reference — injected after server creation via setScheduler()
  let scheduler = null;

  // Create .mind-server directory structure
  const mindDir = join(targetDir, '.mind-server');
  const dataDir = join(mindDir, 'data');
  await mkdir(dataDir, { recursive: true });

  // Load config (persists port + AI settings; secrets stay in env vars)
  const config = await Config.load(mindDir);
  if (port !== config.get('port')) await config.set('port', port);

  const aiCfg  = config.getAI();
  const ai     = createAI(aiCfg);
  const store  = new Store(dataDir);
  const hub    = new SseHub();
  const board  = new Board(store, hub);
  const agents = await createAgents({ targetDir, ai, gated });
  const spec   = buildSpec(port);

  // Bootstrap default board content for fresh projects
  await initBoard(board, targetDir);

  // ── Helper: AI availability for the /agents list ───────────────────────────

  function aiAvailable() {
    if (aiCfg.provider === 'local')      return true;
    if (aiCfg.provider === 'anthropic')  return Boolean(process.env.ANTHROPIC_API_KEY);
    if (aiCfg.provider === 'openai')     return Boolean(process.env.OPENAI_API_KEY);
    return false;
  }

  // ── Router ─────────────────────────────────────────────────────────────────

  const router = new Router();

  // ── Index ──────────────────────────────────────────────────────────────────

  router.get('/', (req, res) => {
    res.json({
      name:      'mind-server',
      version:   '1.0.0',
      targetDir,
      gated,
      agents:    agents.list().map(a => a.name),
      links: {
        board:        '/r',
        instructions: '/instructions',
        spec:         '/openapi.json',
        events:       '/events',
        summary:      '/summary',
        scheduler:    '/scheduler/status',
        health:       '/health',
        metrics:      '/metrics',
        logs:         '/logs',
      },
    });
  });

  router.get('/openapi.json', (req, res) => res.json(spec));

  // ── Scheduler status ───────────────────────────────────────────────────────

  router.get('/scheduler/status', (req, res) => {
    if (!scheduler) {
      return res.json({ running: false, stopped: true, reason: 'scheduler not started (run with --auto)' });
    }
    res.json(scheduler.status());
  });

  // ── SSE ────────────────────────────────────────────────────────────────────
  // SSE needs the raw res — handled before the router augments it.

  router.get('/events', (req, res) => {
    const CORS = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    hub.connect(req, res, CORS);
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  router.get('/summary', async (req, res) => {
    res.json(await board.summary());
  });

  // ── Logs ───────────────────────────────────────────────────────────────────

  router.get('/logs', (req, res) => {
    const n      = req.int('n', 100);
    const agent  = req.str('agent');
    const runId  = req.str('runId');
    res.json(logBuffer.get(n, { agent: agent || undefined, runId: runId || undefined }));
  });

  // ── Health ─────────────────────────────────────────────────────────────────

  router.get('/health', async (req, res) => {
    const summary    = await board.summary();
    const aiOk       = aiAvailable();
    const schedStatus = scheduler ? scheduler.status() : null;
    res.json({
      ok:        true,
      timestamp: new Date().toISOString(),
      ai:        { available: aiOk, provider: aiCfg.provider, model: aiCfg.model },
      board:     { posts: summary.postCount, subs: summary.subCount, byStatus: summary.byStatus },
      scheduler: schedStatus ?? { running: false, stopped: true },
      sseClients: hub.size,
    });
  });

  // ── Metrics (Prometheus text format) ───────────────────────────────────────

  router.get('/metrics', async (req, res) => {
    const summary   = await board.summary();
    const schedStat = scheduler ? scheduler.status() : {};
    const lines = [
      '# HELP mindserver_posts_total Total board posts',
      '# TYPE mindserver_posts_total gauge',
      `mindserver_posts_total ${summary.postCount}`,
      '',
      '# HELP mindserver_posts_by_status Posts by status',
      '# TYPE mindserver_posts_by_status gauge',
      ...Object.entries(summary.byStatus).map(([s, n]) => `mindserver_posts_by_status{status="${s}"} ${n}`),
      '',
      '# HELP mindserver_sse_clients Connected SSE clients',
      '# TYPE mindserver_sse_clients gauge',
      `mindserver_sse_clients ${hub.size}`,
      '',
      '# HELP mindserver_scheduler_running Whether scheduler is running',
      '# TYPE mindserver_scheduler_running gauge',
      `mindserver_scheduler_running ${schedStat.running ? 1 : 0}`,
      '',
      '# HELP mindserver_scheduler_last_cycle_ms Duration of last scheduler cycle',
      '# TYPE mindserver_scheduler_last_cycle_ms gauge',
      `mindserver_scheduler_last_cycle_ms ${schedStat.lastCycleMs ?? 0}`,
    ];
    res.text(lines.join('\n'));
  });

  // ── Scheduler config hot-patch ─────────────────────────────────────────────

  router.patch('/scheduler/config', async (req, res) => {
    if (!scheduler) return res.badRequest('scheduler not running (start with --auto)');
    const body = await req.body();
    const { cycleMs, scanMs } = body;
    if (cycleMs || scanMs) {
      scheduler.stop();
      scheduler.start({ cycleMs: cycleMs ?? 30_000, scanMs: scanMs ?? 300_000 });
      res.json({ ok: true, cycleMs: cycleMs ?? 30_000, scanMs: scanMs ?? 300_000 });
    } else {
      res.badRequest('provide cycleMs and/or scanMs');
    }
  });

  // ── Instructions ───────────────────────────────────────────────────────────

  router.get('/instructions', async (req, res) => {
    const summary   = await board.summary();
    const front     = await board.frontPage();
    const agentList = agents.list().map(a => `- **${a.avatar} ${a.name}** — ${a.description}`).join('\n');
    const aiStatus  = process.env.ANTHROPIC_API_KEY
      ? 'yes (ANTHROPIC_API_KEY set)'
      : 'no — set ANTHROPIC_API_KEY to enable AI agents';

    const md = [
      '# Mind Server — Board Instructions',
      '',
      `Project: \`${targetDir}\``,
      `AI available: ${aiStatus}`,
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

    res.text(md);
  });

  // ── Agents ─────────────────────────────────────────────────────────────────

  router.get('/agents', (req, res) => {
    const aiOk = aiAvailable();
    res.json(agents.list().map(a => ({ ...a, aiAvailable: aiOk })));
  });

  router.post('/agents/:name/run', async (req, res) => {
    const { name } = req.params;
    if (!agents.get(name)) return res.notFound(`Agent not found: ${name}`);
    res.json(await agents.run(name, { board, hub }));
  });

  router.delete('/agents/:name/memory', async (req, res) => {
    const { name } = req.params;
    if (!agents.get(name)) return res.notFound(`Agent not found: ${name}`);
    await agents.clearMemory(name);
    res.json({ ok: true });
  });

  router.get('/agents/:name', async (req, res) => {
    const { name } = req.params;
    const agent = agents.get(name);
    if (!agent) return res.notFound(`Agent not found: ${name}`);
    const memory = await agents.memory(name, { limit: req.int('limit', 100) });
    res.json({ ...agent.toJSON(), memory });
  });

  // ── DMs ────────────────────────────────────────────────────────────────────

  router.get('/dm', async (req, res) => {
    res.json(await board.getDMs({
      to:         req.str('to')  || undefined,
      from:       req.str('from') || undefined,
      unreadOnly: req.bool('unreadOnly'),
    }));
  });

  router.post('/dm', async (req, res) => {
    const body = await req.body();
    if (!body.from || !body.to || !body.body) return res.badRequest('from, to, body required');
    res.created(await board.sendDM(body));
  });

  router.post('/dm/:id/read', async (req, res) => {
    res.json(await board.markDMRead(req.params.id));
  });

  router.post('/dm/:id/reply', async (req, res) => {
    const body = await req.body();
    if (!body.from || !body.body) return res.badRequest('from and body required');
    res.created(await board.replyToDM(req.params.id, body));
  });

  router.get('/dm/:id/thread', async (req, res) => {
    res.json(await board.getDMThread(req.params.id));
  });

  // ── User profile ───────────────────────────────────────────────────────────

  router.get('/u/:name', async (req, res) => {
    const { name } = req.params;
    res.json({
      name,
      sub:   await board.getSub(`u/${name}`),
      posts: await board.getPosts(`u/${name}`).catch(() => []),
      inbox: await board.getDMs({ to: name }),
      sent:  await board.getDMs({ from: name }),
    });
  });

  // ── Subreddits ─────────────────────────────────────────────────────────────

  router.get('/r', async (req, res) => {
    res.json(await board.listSubs());
  });

  // ── Posts ──────────────────────────────────────────────────────────────────

  router.get('/r/:sub', async (req, res) => {
    res.json(await board.getPosts(req.params.sub, {
      status: req.str('status') || undefined,
      type:   req.str('type')   || undefined,
      author: req.str('author') || undefined,
      limit:  req.int('limit', 100),
      offset: req.int('offset', 0),
    }));
  });

  router.post('/r/:sub', async (req, res) => {
    const body = await req.body();
    if (!body.title || !body.author) return res.badRequest('title and author required');
    if (typeof body.title !== 'string' || body.title.length > 500)
      return res.badRequest('title must be a string ≤ 500 characters');
    if (typeof body.author !== 'string' || body.author.length > 100)
      return res.badRequest('author must be a string ≤ 100 characters');
    if (body.body != null && (typeof body.body !== 'string' || body.body.length > 100_000))
      return res.badRequest('body must be a string ≤ 100 000 characters');
    res.created(await board.createPost(req.params.sub, body));
  });

  // ── Single post ────────────────────────────────────────────────────────────

  router.get('/r/:sub/:id', async (req, res) => {
    const post = await board.getPost(req.params.id);
    if (!post) return res.notFound(`Post not found: ${req.params.id}`);
    res.json({ ...post, comments: await board.getComments(req.params.id) });
  });

  router.patch('/r/:sub/:id', async (req, res) => {
    const body = await req.body();
    res.json(await board.updatePost(req.params.id, body));
  });

  // ── Comments ───────────────────────────────────────────────────────────────

  router.post('/r/:sub/:id/comment', async (req, res) => {
    const body = await req.body();
    if (!body.author || !body.body) return res.badRequest('author and body required');
    if (typeof body.body !== 'string' || body.body.length > 100_000)
      return res.badRequest('body must be a string ≤ 100 000 characters');
    res.created(await board.addComment(req.params.id, body));
  });

  // ── HTTP server ────────────────────────────────────────────────────────────

  const server = createServer(router.handler());

  return {
    server,
    store,
    hub,
    board,
    agents,
    /** Inject the Scheduler so GET /scheduler/status can report its state. */
    setScheduler(sched) { scheduler = sched; },
  };
}
