#!/usr/bin/env node
/**
 * mind-server-agent — interactive CLI for a bundled agent.
 *
 * Connects to a running mind-server and lets you interact as a named agent.
 * The agent's memory lives on the server (in <targetDir>/.mind-server/agents/<name>/).
 *
 * Usage:
 *   mind-server-agent <name> [--server http://localhost:3002]
 *
 * Examples:
 *   mind-server-agent vera
 *   mind-server-agent erica --server http://localhost:3003
 *
 * Commands at the prompt:
 *   status              — board summary + your unread DMs
 *   board               — front page (full instructions)
 *   run                 — trigger one agent cycle on the server
 *   loop [interval]     — continuous mode: auto-run every N minutes (default 5m)
 *   post <sub> <title>  — create a post
 *   dm <to> <message>   — send a DM
 *   read <postId>       — show a post + comments
 *   comment <postId>    — add a comment
 *   memory [n]          — show your last N memory entries (default 20)
 *   agents              — list all agents and their status
 *   help                — list commands
 *   exit / quit         — exit
 */

import * as rl from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!args.length || args[0] === '--help' || args[0] === '-h') {
  console.log(`
mind-server-agent v1.0.0

Usage:
  mind-server-agent <name> [--server <url>]

Arguments:
  <name>            Agent name: vera, monica, erica, rita, sandra
                    (or any custom name for human/observer mode)

Options:
  --server <url>    mind-server URL (default: http://localhost:3002, env: MIND_SERVER)
  --help            Show this help
`);
  process.exit(0);
}

const argMap    = {};
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

const agentName = positional[0];
const serverUrl = (process.env.MIND_SERVER ?? argMap.server ?? 'http://localhost:3002').replace(/\/$/, '');

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(`${serverUrl}${path}`, opts);
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, body: text }; }
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
      throw new Error(`Cannot reach mind-server at ${serverUrl}\nIs it running? Start it with: mind-server <project-dir>`);
    }
    throw err;
  }
}

const GET   = p      => api('GET',    p).then(r => r.body);
const POST  = (p, b) => api('POST',   p, b).then(r => r.body);
const PATCH = (p, b) => api('PATCH',  p, b).then(r => r.body);
const DEL   = p      => api('DELETE', p).then(r => r.body);

// ── Formatting ────────────────────────────────────────────────────────────────

const STATUS_ICONS = { open: '🔵', planned: '🟡', 'in-progress': '🟠', review: '🟣', done: '✅' };

function badge(s) { return `${STATUS_ICONS[s] ?? '⚪'} ${s}`; }

function formatPost(post) {
  const lines = [
    `ID:      ${post.id}`,
    `Sub:     r/${post.sub}`,
    `Author:  ${post.author}`,
    `Status:  ${badge(post.status)}`,
    `Created: ${post.createdAt}`,
    '',
  ];
  if (post.body) lines.push(post.body, '');
  if (post.comments?.length) {
    lines.push(`── Comments (${post.comments.length}) ──`);
    for (const c of post.comments) {
      lines.push(`  [${c.author}] ${c.body}`);
    }
  }
  return lines.join('\n');
}

function hr(char = '─', n = 50) { return char.repeat(n); }

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const [summary, inbox] = await Promise.all([
    GET('/summary'),
    GET(`/dm?to=${agentName}&unreadOnly=true`).catch(() => []),
  ]);

  console.log(`\n${hr()}`);
  console.log(`📊 Board — ${serverUrl}`);
  console.log(hr());
  for (const [k, v] of Object.entries(summary.byStatus)) {
    console.log(`  ${badge(k).padEnd(22)} ${v}`);
  }
  console.log(`  ${'total posts'.padEnd(21)} ${summary.postCount}`);
  console.log(`  ${'subreddits'.padEnd(21)} ${summary.subCount}`);

  if (inbox.length) {
    console.log(`\n📬 Unread DMs (${inbox.length}):`);
    for (const dm of inbox) {
      console.log(`  From ${dm.from}: ${(dm.subject || dm.body).slice(0, 80)}`);
    }
  } else {
    console.log('\n📭 No unread DMs');
  }
  console.log('');
}

async function cmdBoard() {
  const res  = await fetch(`${serverUrl}/instructions`);
  const text = await res.text();
  console.log('\n' + text + '\n');
}

async function cmdAgents() {
  const agents = await GET('/agents');
  console.log(`\n🤖 Agents (${agents.length})\n${hr()}`);
  for (const a of agents) {
    const ai = a.aiAvailable ? '✅ AI' : '⚠ no AI';
    console.log(`  ${a.avatar} ${a.name.padEnd(10)} ${a.description.slice(0, 55)} [${ai}]`);
  }
  console.log('');
}

async function cmdRun() {
  console.log(`\n🔄 Triggering ${agentName} cycle...`);
  const result = await POST(`/agents/${agentName}/run`);
  console.log(`\n  Outcome:  ${result.outcome}`);
  if (result.actions?.length) {
    console.log(`  Actions:`);
    for (const a of result.actions) console.log(`    - ${JSON.stringify(a)}`);
  }
  if (result.error) console.log(`  Error: ${result.error}`);
  if (result.durationMs) console.log(`  Time: ${result.durationMs}ms`);
  console.log('');
}

async function cmdLoop(iface, parts) {
  const arg = parts[1];
  let ms = 5 * 60_000;
  if (arg) {
    const n = parseInt(arg, 10);
    const u = arg.at(-1);
    ms = u === 's' ? n * 1000 : u === 'h' ? n * 3_600_000 : n * 60_000;
  }
  const label = ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}m`;
  console.log(`\n🔁 Loop every ${label} — Ctrl+C to stop\n`);

  await cmdRun();
  const timer = setInterval(cmdRun, ms);

  await new Promise(resolve => {
    const stop = () => { clearInterval(timer); console.log('\n⏹ Loop stopped.\n'); resolve(); };
    process.once('SIGINT', stop);
    // Re-attach Ctrl+C to stop loop rather than exiting
  });
}

async function cmdPost(iface, parts) {
  const sub = parts[1];
  if (!sub) { console.log('Usage: post <sub> <title>'); return; }
  const titleParts = parts.slice(2);
  const title = titleParts.length ? titleParts.join(' ') : await iface.question('Title: ');
  const body  = await iface.question('Body (Enter to skip): ');
  const type  = await iface.question('Type [discussion/todo/quality] (Enter = discussion): ') || 'discussion';

  const post = await POST(`/r/${encodeURIComponent(sub)}`, { title, body, author: agentName, type });
  console.log(`\n✅ Created post in r/${sub}\n  ID: ${post.id}\n  Status: ${badge(post.status)}\n`);
}

async function cmdDM(parts) {
  const to   = parts[1];
  const body = parts.slice(2).join(' ');
  if (!to || !body) { console.log('Usage: dm <to> <message>'); return; }
  const dm = await POST('/dm', { from: agentName, to, body });
  console.log(`\n✅ DM sent to ${to} (${dm.id})\n`);
}

async function cmdRead(postId) {
  if (!postId) { console.log('Usage: read <postId>'); return; }

  // Find the post across all subs
  const subs = await GET('/r');
  for (const sub of subs) {
    const posts = await GET(`/r/${encodeURIComponent(sub.name)}`);
    const match = posts.find(p => p.id === postId || p.id.startsWith(postId));
    if (match) {
      const full = await GET(`/r/${encodeURIComponent(sub.name)}/${match.id}`);
      console.log(`\n── ${full.title} ──\n${formatPost(full)}\n`);
      return;
    }
  }
  console.log(`Post not found: ${postId}`);
}

async function cmdComment(iface, parts) {
  const postId = parts[1];
  if (!postId) { console.log('Usage: comment <postId>'); return; }
  const body = await iface.question('Comment: ');
  if (!body.trim()) { console.log('Aborted.'); return; }

  const subs = await GET('/r');
  for (const sub of subs) {
    const posts = await GET(`/r/${encodeURIComponent(sub.name)}`);
    const match = posts.find(p => p.id === postId || p.id.startsWith(postId));
    if (match) {
      const comment = await POST(`/r/${encodeURIComponent(sub.name)}/${match.id}/comment`, {
        author: agentName,
        body,
      });
      console.log(`\n✅ Comment added (${comment.id})\n`);
      return;
    }
  }
  console.log(`Post not found: ${postId}`);
}

async function cmdMemory(parts) {
  const n   = parseInt(parts[1] ?? '20', 10);
  const res = await GET(`/agents/${agentName}?limit=${n}`);
  if (res.error) { console.log(`Error: ${res.error}`); return; }
  console.log(`\n🧠 ${agentName}'s memory (last ${n})\n${hr()}`);
  for (const entry of (res.memory ?? [])) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    console.log(`  ${time}  [${entry.type}] ${JSON.stringify(entry.content).slice(0, 120)}`);
  }
  console.log('');
}

function cmdHelp() {
  console.log(`
Commands:
  status              Board summary + unread DMs
  board               Full board instructions (markdown)
  agents              List all agents
  run                 Trigger one ${agentName} cycle
  loop [interval]     Continuous mode (default 5m, e.g. '2m', '30s')
  post <sub> <title>  Create a post
  dm <to> <message>   Send a DM
  read <postId>       Show a post + comments (postId prefix works)
  comment <postId>    Add a comment
  memory [n]          Show last N memory entries (default 20)
  help                Show this help
  exit / quit         Exit
`);
}

// ── Main REPL ─────────────────────────────────────────────────────────────────

async function main() {
  // Check server is reachable
  let serverInfo;
  try {
    serverInfo = await GET('/');
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }

  console.log(`\n🧠 mind-server-agent`);
  console.log(`   Agent:   ${agentName}`);
  console.log(`   Server:  ${serverUrl}`);
  console.log(`   Project: ${serverInfo.targetDir ?? '(unknown)'}`);
  console.log(`   AI:      ${process.env.ANTHROPIC_API_KEY ? '✅ enabled' : '⚠  disabled (ANTHROPIC_API_KEY not set)'}`);

  // Show board summary on start
  await cmdStatus();

  const iface = rl.createInterface({ input, output, terminal: true });
  iface.setPrompt(`${agentName}> `);
  iface.prompt();

  for await (const line of iface) {
    const trimmed = line.trim();
    if (!trimmed) { iface.prompt(); continue; }

    const parts = trimmed.split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    try {
      switch (cmd) {
        case 'status':  await cmdStatus(); break;
        case 'board':   await cmdBoard(); break;
        case 'agents':  await cmdAgents(); break;
        case 'run':     await cmdRun(); break;
        case 'loop':    await cmdLoop(iface, parts); break;
        case 'post':    await cmdPost(iface, parts); break;
        case 'dm':      await cmdDM(parts); break;
        case 'read':    await cmdRead(parts[1]); break;
        case 'comment': await cmdComment(iface, parts); break;
        case 'memory':  await cmdMemory(parts); break;
        case 'help':    cmdHelp(); break;
        case 'exit':
        case 'quit':
          console.log('Goodbye.');
          iface.close();
          process.exit(0);
          break;
        default:
          console.log(`Unknown command: ${cmd}. Type 'help'.`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }

    iface.prompt();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
