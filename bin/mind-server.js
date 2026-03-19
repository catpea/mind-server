#!/usr/bin/env node
/**
 * mind-server — development board server with bundled AI agents.
 *
 * First run — creates .mind-server/ and saves config:
 *   mind-server /home/meow/AI/my-project --port 3002 --ai-base-url http://localhost:11434/v1
 *
 * Second run — just point at the project (reads saved config):
 *   mind-server /home/meow/AI/my-project
 *
 * Re-port — overwrite the saved port:
 *   mind-server /home/meow/AI/my-project --port 3003
 *
 * No API keys needed — runs entirely on local AI (ollama, LM Studio, llama.cpp, etc.)
 *
 * Multiple projects = multiple server instances on different ports:
 *   mind-server ~/projects/alpha --port 3002
 *   mind-server ~/projects/beta  --port 3003
 */

import { createMindServer } from '../src/server.js';
import { Scheduler }        from '../src/scheduler.js';
import { Config }           from '../src/config.js';
import { resolve, join }    from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync }       from 'node:fs';

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

if (argMap.help || argMap.h) {
  console.log(`
mind-server v1.0.0

Usage:
  mind-server [targetDir] [options]

Arguments:
  targetDir            Project directory (default: cwd, env: MIND_TARGET)
                       State stored in <targetDir>/.mind-server/

Options:
  --port <n>           HTTP port — saved to config (default: 3002, env: PORT)
  --ai-model <m>       Model name  (saved, default: llama3)
  --ai-base-url <url>  Base URL for local OpenAI-compat AI  (saved, default: http://localhost:11434/v1)
  --auto               Run agents autonomously (dispatch loop + scan loop)
  --cycle <s>          Dispatch loop interval in seconds (default: 30, with --auto)
  --scan <s>           Audit scan interval in seconds (default: 300, with --auto)
  --gate               Require human approval before Erica implements (default)
  --no-gate            Skip approval gate — Erica implements immediately
  --help               Show this help

Config is stored at: <targetDir>/.mind-server/config.json
Agent memory at:     <targetDir>/.mind-server/agents/<name>/memory.json
Board data at:       <targetDir>/.mind-server/data/

Agents: vera (dispatcher) · monica (planner) · erica (implementer)
        rita (reviewer) · sandra (QA scanner)
`);
  process.exit(0);
}

const targetDir = resolve(process.env.MIND_TARGET ?? positional[0] ?? process.cwd());
const mindDir   = join(targetDir, '.mind-server');
await mkdir(join(mindDir, 'data'), { recursive: true });

// Generate a starter context.md on first run
const contextPath = join(mindDir, 'context.md');
if (!existsSync(contextPath)) {
  await writeFile(contextPath, `# Project Context

This file is prepended to every AI agent prompt. Edit it to guide agents with
project-specific information.

## What this project does
<!-- Describe the project purpose and goals -->

## Architecture overview
<!-- Key architectural decisions and patterns -->

## Tech stack
<!-- Languages, frameworks, databases, runtime versions -->

## Conventions
<!-- Code style, naming conventions, testing approach -->

## Off-limits
<!-- What agents should NOT change or touch -->
`, 'utf8');
  console.log(`   Created:  ${contextPath} (edit to guide agents)`);
}

// Load existing config, then apply CLI overrides
const config = await Config.load(mindDir);
const port   = parseInt(process.env.PORT ?? argMap.port ?? config.get('port'), 10);

// Merge CLI AI overrides into config
const aiOverrides = {};
if (argMap['ai-model'])     aiOverrides.model   = argMap['ai-model'];
if (argMap['ai-base-url'])  aiOverrides.baseUrl = argMap['ai-base-url'];
if (Object.keys(aiOverrides).length) await config.merge({ ai: aiOverrides });
if (port !== config.get('port'))      await config.set('port', port);

const aiCfg = config.getAI();

// ── Start ─────────────────────────────────────────────────────────────────────

const aiStatus = () => `✅ Local AI at ${aiCfg.baseUrl}`;

const gated = !argMap['no-gate'];

console.log(`\n🧠 Mind Server`);
console.log(`   Target:   ${targetDir}`);
console.log(`   Port:     ${port}`);
console.log(`   AI:       ${aiStatus()}`);
console.log(`   Model:    ${aiCfg.model}`);
console.log(`   Config:   ${mindDir}/config.json`);
console.log(`   Gate:     ${gated ? 'on (--no-gate to disable)' : 'off'}\n`);

const { server, agents, board, hub, setScheduler } = await createMindServer({ targetDir, port, gated });

// Hoist sched to outer scope so graceful shutdown can access it
let sched = null;

async function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received — shutting down gracefully...`);
  if (sched) {
    sched.stop();
    console.log('[shutdown] waiting for in-flight agent run (max 10s)...');
    await sched.waitForIdle(10_000);
  }
  console.log('[shutdown] closing HTTP server...');
  server.close(() => {
    console.log('[shutdown] done.');
    process.exit(0);
  });
  // Force exit after 12s if close hangs
  setTimeout(() => { console.log('[shutdown] force exit'); process.exit(1); }, 12_000);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(port, () => {
  console.log(`✅ Listening at http://localhost:${port}`);
  console.log(`   Board:        http://localhost:${port}/r`);
  console.log(`   Agents:       http://localhost:${port}/agents`);
  console.log(`   Instructions: http://localhost:${port}/instructions`);
  console.log(`   OpenAPI:      http://localhost:${port}/openapi.json`);
  console.log(`   Health:       http://localhost:${port}/health`);
  console.log(`   Metrics:      http://localhost:${port}/metrics`);
  console.log(`   Logs:         http://localhost:${port}/logs`);

  if (argMap.auto) {
    const cycleMs = parseInt(argMap.cycle ?? '30', 10) * 1000;
    const scanMs  = parseInt(argMap.scan  ?? '300', 10) * 1000;
    sched = new Scheduler({ agents, board, hub });
    setScheduler(sched);
    sched.start({ cycleMs, scanMs });
    console.log(`   Auto mode:    dispatch every ${cycleMs / 1000}s, scan every ${scanMs / 1000}s`);
  } else {
    console.log(`   Tip:          add --auto to run agents autonomously`);
  }

  console.log(`\n   Press Ctrl+C to stop.\n`);
});
