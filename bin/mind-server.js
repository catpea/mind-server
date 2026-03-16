#!/usr/bin/env node
/**
 * mind-server — development board server with bundled AI agents.
 *
 * First run — creates .mind-server/ and saves config:
 *   mind-server /home/meow/AI/my-project --port 3002 --ai-provider local --ai-base-url http://localhost:11434/v1
 *
 * Second run — just point at the project (reads saved config):
 *   mind-server /home/meow/AI/my-project
 *
 * Re-port — overwrite the saved port:
 *   mind-server /home/meow/AI/my-project --port 3003
 *
 * AI secrets always come from environment variables:
 *   ANTHROPIC_API_KEY=sk-...  mind-server .   (provider: anthropic)
 *   OPENAI_API_KEY=sk-...     mind-server .   (provider: openai)
 *   mind-server .                             (provider: local — no key needed)
 *
 * Multiple projects = multiple server instances on different ports:
 *   mind-server ~/projects/alpha --port 3002
 *   mind-server ~/projects/beta  --port 3003
 */

import { createMindServer } from '../src/server.js';
import { Config }           from '../src/config.js';
import { resolve, join }    from 'node:path';
import { mkdir }            from 'node:fs/promises';

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
  --ai-provider <p>    AI provider: anthropic | openai | local  (saved)
  --ai-model <m>       Model name  (saved)
  --ai-base-url <url>  Base URL for local/openai-compat AI  (saved)
  --help               Show this help

AI Secrets (environment variables — never stored):
  ANTHROPIC_API_KEY    Required for provider: anthropic
  OPENAI_API_KEY       Required for provider: openai
  (local provider needs no key)

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

// Load existing config, then apply CLI overrides
const config = await Config.load(mindDir);
const port   = parseInt(process.env.PORT ?? argMap.port ?? config.get('port'), 10);

// Merge CLI AI overrides into config
const aiOverrides = {};
if (argMap['ai-provider'])  aiOverrides.provider = argMap['ai-provider'];
if (argMap['ai-model'])     aiOverrides.model     = argMap['ai-model'];
if (argMap['ai-base-url'])  aiOverrides.baseUrl   = argMap['ai-base-url'];
if (Object.keys(aiOverrides).length) await config.merge({ ai: aiOverrides });
if (port !== config.get('port'))      await config.set('port', port);

const aiCfg = config.getAI();

// ── Start ─────────────────────────────────────────────────────────────────────

const aiStatus = () => {
  if (aiCfg.provider === 'anthropic') return process.env.ANTHROPIC_API_KEY ? '✅ Anthropic (Claude)' : '⚠  Anthropic — set ANTHROPIC_API_KEY';
  if (aiCfg.provider === 'openai')    return process.env.OPENAI_API_KEY    ? '✅ OpenAI'            : '⚠  OpenAI — set OPENAI_API_KEY';
  if (aiCfg.provider === 'local')     return `✅ Local AI at ${aiCfg.baseUrl}`;
  return '⚠  unknown provider';
};

console.log(`\n🧠 Mind Server`);
console.log(`   Target:   ${targetDir}`);
console.log(`   Port:     ${port}`);
console.log(`   AI:       ${aiStatus()}`);
console.log(`   Model:    ${aiCfg.model}`);
console.log(`   Config:   ${mindDir}/config.json\n`);

const { server } = await createMindServer({ targetDir, port });

server.listen(port, () => {
  console.log(`✅ Listening at http://localhost:${port}`);
  console.log(`   Board:        http://localhost:${port}/r`);
  console.log(`   Agents:       http://localhost:${port}/agents`);
  console.log(`   Instructions: http://localhost:${port}/instructions`);
  console.log(`   OpenAPI:      http://localhost:${port}/openapi.json`);
  console.log(`\n   Press Ctrl+C to stop.\n`);
});

process.on('SIGINT',  () => { process.stdout.write('\n'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
