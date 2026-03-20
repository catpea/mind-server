#!/usr/bin/env node
/**
 * mind-server-mcp — MCP (Model Context Protocol) server for mind-server.
 *
 * Starts the mind-server HTTP API in-process and exposes board operations
 * as MCP tools over stdin/stdout (JSON-RPC 2.0, newline-delimited).
 *
 * Usage — add to your Claude Code MCP config (~/.claude/mcp.json):
 *   {
 *     "mcpServers": {
 *       "mind-server": {
 *         "command": "mind-server-mcp",
 *         "args": ["--target", "/path/to/project"]
 *       }
 *     }
 *   }
 *
 * The HTTP board API is also available at --port (default 3002) so the
 * web UI and MCP can run side-by-side from one process.
 */

import { createMindServer } from '../src/server.js';
import { Scheduler }        from '../src/scheduler.js';
import { Config }           from '../src/config.js';
import { resolve, join }    from 'node:path';
import { mkdir }            from 'node:fs/promises';
import { createInterface }  from 'node:readline';

// ── Parse args ────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const argMap     = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    argMap[key] = val;
  } else {
    positional.push(args[i]);
  }
}

const targetDir = resolve(process.env.MIND_TARGET ?? positional[0] ?? process.cwd());
const mindDir   = join(targetDir, '.mind-server');
await mkdir(join(mindDir, 'data'), { recursive: true });

const config = await Config.load(mindDir);
const port   = parseInt(process.env.PORT ?? argMap.port ?? config.get('port'), 10);

const aiOverrides = {};
if (argMap['ai-model'])    aiOverrides.model   = argMap['ai-model'];
if (argMap['ai-base-url']) aiOverrides.baseUrl = argMap['ai-base-url'];
if (Object.keys(aiOverrides).length) await config.merge({ ai: aiOverrides });
if (port !== config.get('port'))      await config.set('port', port);

const gated = !argMap['no-gate'];

// ── Boot mind-server in-process ───────────────────────────────────────────────

const { server, agents, board, hub, setScheduler } = await createMindServer({ targetDir, port, gated });

let sched = null;

if (argMap.auto) {
  const cycleMs = parseInt(argMap.cycle ?? '30', 10) * 1000;
  const scanMs  = parseInt(argMap.scan  ?? '300', 10) * 1000;
  sched = new Scheduler({ agents, board, hub });
  setScheduler(sched);
  sched.start({ cycleMs, scanMs });
}

server.listen(port);

// Log to stderr (stdout is reserved for MCP JSON-RPC)
console.error(`[mcp] mind-server running on http://localhost:${port}`);
console.error(`[mcp] target: ${targetDir}`);
console.error(`[mcp] MCP stdio transport active`);

// ── MCP Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'board_summary',
    description: 'Get a high-level summary of the development board: post counts by status, recent active posts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_posts',
    description: 'List posts from a subreddit. Subreddits: requests, todo, dispatch, standards, quality, security, general.',
    inputSchema: {
      type: 'object',
      properties: {
        sub:    { type: 'string', description: 'Subreddit name (e.g. requests, todo)' },
        status: { type: 'string', description: 'Filter by status: open, planned, in-progress, review, done, wont-fix' },
        limit:  { type: 'integer', description: 'Max results (default 20)', default: 20 },
      },
      required: ['sub'],
    },
  },
  {
    name: 'get_post',
    description: 'Get a single post by ID, including all comments.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Post UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_post',
    description: 'Create a new post (e.g. submit a feature request or bug report to r/requests).',
    inputSchema: {
      type: 'object',
      properties: {
        sub:    { type: 'string',  description: 'Target subreddit (e.g. requests)' },
        title:  { type: 'string',  description: 'Post title' },
        body:   { type: 'string',  description: 'Post body (markdown)' },
        author: { type: 'string',  description: 'Author name (your username)' },
        type:   { type: 'string',  description: 'Post type: discussion | todo | quality | announcement', default: 'discussion' },
      },
      required: ['sub', 'title', 'author'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an existing post.',
    inputSchema: {
      type: 'object',
      properties: {
        postId: { type: 'string', description: 'Post UUID to comment on' },
        author: { type: 'string', description: 'Author name' },
        body:   { type: 'string', description: 'Comment body (markdown)' },
      },
      required: ['postId', 'author', 'body'],
    },
  },
  {
    name: 'run_agent',
    description: 'Trigger one agent cycle by name. Returns the agent\'s outcome. Note: may take up to 60 seconds for AI-backed agents.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name: vera, amy, monica, erica, rita, heather, sandra, alice, bobby, mallory, angela, danielle, lauren, jessica, kimberly' },
      },
      required: ['name'],
    },
  },
  {
    name: 'send_dm',
    description: 'Send a direct message to an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        from:    { type: 'string', description: 'Sender name' },
        to:      { type: 'string', description: 'Recipient agent name' },
        subject: { type: 'string', description: 'Message subject' },
        body:    { type: 'string', description: 'Message body' },
      },
      required: ['from', 'to', 'body'],
    },
  },
  {
    name: 'list_dms',
    description: 'List direct messages. Filter by recipient or sender.',
    inputSchema: {
      type: 'object',
      properties: {
        to:         { type: 'string',  description: 'Filter by recipient' },
        from:       { type: 'string',  description: 'Filter by sender' },
        unreadOnly: { type: 'boolean', description: 'Only return unread messages', default: false },
      },
    },
  },
];

// ── MCP Tool handlers ─────────────────────────────────────────────────────────

async function callTool(name, args = {}) {
  switch (name) {
    case 'board_summary': {
      const s = await board.summary();
      return JSON.stringify(s, null, 2);
    }

    case 'list_posts': {
      const posts = await board.getPosts(args.sub, {
        status: args.status || undefined,
        limit:  args.limit ?? 20,
      });
      if (!posts.length) return `No posts found in r/${args.sub}${args.status ? ` with status=${args.status}` : ''}.`;
      return posts.map(p =>
        `[${p.status}] ${p.title}\n  id: ${p.id}\n  author: ${p.author}  created: ${p.createdAt?.slice(0, 10)}`
      ).join('\n\n');
    }

    case 'get_post': {
      const post = await board.getPost(args.id);
      if (!post) return `Post not found: ${args.id}`;
      const comments = await board.getComments(args.id);
      const lines = [
        `# ${post.title}`,
        `Status: ${post.status} | Author: ${post.author} | Sub: r/${post.sub}`,
        `Created: ${post.createdAt}`,
        '',
        post.body || '(no body)',
        '',
        `## Comments (${comments.length})`,
        ...comments.map(c => `**${c.author}** (${c.createdAt?.slice(0, 16)})\n${c.body}`),
      ];
      return lines.join('\n');
    }

    case 'create_post': {
      await board.ensureSub(args.sub);
      const post = await board.createPost(args.sub, {
        title:  args.title,
        body:   args.body ?? '',
        author: args.author,
        type:   args.type ?? 'discussion',
      });
      return `Created post in r/${args.sub}: ${post.title}\nid: ${post.id}`;
    }

    case 'add_comment': {
      const comment = await board.addComment(args.postId, {
        author: args.author,
        body:   args.body,
      });
      return `Comment added (id: ${comment.id})`;
    }

    case 'run_agent': {
      const agent = agents.get(args.name);
      if (!agent) return `Unknown agent: ${args.name}. Available: ${agents.list().map(a => a.name).join(', ')}`;
      const result = await agents.run(args.name, { board, hub });
      return `Agent ${args.name} completed.\nOutcome: ${result.outcome}\nActions: ${result.actions?.length ?? 0}`;
    }

    case 'send_dm': {
      const dm = await board.sendDM({
        from:    args.from,
        to:      args.to,
        subject: args.subject ?? '',
        body:    args.body,
      });
      return `DM sent (id: ${dm.id})`;
    }

    case 'list_dms': {
      const dms = await board.getDMs({
        to:         args.to || undefined,
        from:       args.from || undefined,
        unreadOnly: args.unreadOnly ?? false,
      });
      if (!dms.length) return 'No messages found.';
      return dms.map(d =>
        `[${d.read ? 'read' : 'UNREAD'}] From: ${d.from} → ${d.to}\n  Subject: ${d.subject}\n  id: ${d.id}`
      ).join('\n\n');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP JSON-RPC stdio transport ──────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications have no `id` — never send a response to them.
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities:    { tools: {} },
          serverInfo:      { name: 'mind-server', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
        // Client confirms it received our initialize response.
        // This is a notification — do not respond.
        break;

      case 'ping':
        if (!isNotification) respond(id, {});
        break;

      case 'tools/list':
        respond(id, { tools: TOOLS });
        break;

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        try {
          const text = await callTool(toolName, toolArgs);
          respond(id, { content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          respond(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
        break;
      }

      default:
        if (!isNotification) {
          respondError(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (err) {
    if (!isNotification) {
      respondError(id, -32603, `Internal error: ${err.message}`);
    }
    console.error(`[mcp] error handling ${method}:`, err.message);
  }
}

// Use readline to split stdin into lines — handles multi-chunk messages correctly.
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    console.error('[mcp] invalid JSON on stdin:', trimmed.slice(0, 100));
    return;
  }
  await handleMessage(msg);
});

rl.on('close', () => {
  console.error('[mcp] stdin closed — shutting down');
  if (sched) sched.stop();
  server.close();
  process.exit(0);
});

// Graceful shutdown
process.on('SIGINT',  () => { if (sched) sched.stop(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { if (sched) sched.stop(); server.close(); process.exit(0); });
