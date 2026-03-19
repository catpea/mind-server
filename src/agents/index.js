/**
 * agents/index.js — Agent registry with auto-discovery.
 *
 * Scans the agents/ directory for .js files (excluding base.js, ai.js, index.js),
 * imports each one, and registers any class that extends BaseAgent.
 * Agent load order is determined by `static priority` (lower = earlier).
 *
 * Adding a new agent requires only:
 *   1. Create `src/agents/<name>.js` exporting a class that extends BaseAgent.
 *   2. Set `static priority = <n>` on the class to place it in the run order.
 *
 * No changes to this file are needed.
 *
 * Usage:
 *   import { createAgents } from './agents/index.js';
 *   const agents = createAgents({ targetDir });
 *
 *   const result = await agents.run('vera', ctx);
 *   const list   = agents.list();
 */

import { readdir }            from 'node:fs/promises';
import { fileURLToPath }      from 'node:url';
import { join, dirname }      from 'node:path';
import { BaseAgent, loadProjectContext } from './base.js';
import { createAI }           from './ai.js';
import { shell }                        from '../tools/shell.js';
import { search, findRefs, findFiles }  from '../tools/search.js';
import { fetchUrl }                     from '../tools/fetch.js';
import { buildGraph, findDependencies, findDependents, findCycles, findGodModules } from '../tools/deps.js';
import { buildCoverageMap }             from '../tools/coverage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKIP      = new Set(['base.js', 'ai.js', 'index.js']);

/**
 * Dynamically import all agent classes from the agents/ directory.
 * Returns them sorted by static priority (ascending).
 */
async function discoverAgentClasses() {
  const files  = await readdir(__dirname);
  const agentFiles = files.filter(f => f.endsWith('.js') && !SKIP.has(f));

  const classes = [];
  for (const file of agentFiles) {
    const mod = await import(join(__dirname, file));
    for (const exported of Object.values(mod)) {
      // Accept only classes that inherit from BaseAgent (not BaseAgent itself)
      if (
        typeof exported === 'function' &&
        exported !== BaseAgent &&
        exported.prototype instanceof BaseAgent
      ) {
        classes.push(exported);
      }
    }
  }

  // Sort by static priority; ties resolved by class name for stability
  classes.sort((a, b) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return classes;
}

export async function createAgents({ targetDir, ai, gated = true }) {
  // Use provided ai instance or create a default (picks up env vars)
  const aiInstance = ai ?? createAI();

  const agentClasses = await discoverAgentClasses();

  // Instantiate and initialise each agent
  const byName = new Map();
  for (const AgentClass of agentClasses) {
    const agent = new AgentClass();
    agent.init({ targetDir });
    byName.set(agent.name, agent);
  }

  /** Build the context object passed to think/act (loads project context once per run). */
  async function buildCtx({ board, hub }) {
    const projectContext = await loadProjectContext(targetDir);

    // Tool registry — thin wrappers that bind targetDir as the default cwd/dir
    const tools = {
      // Shell execution
      shell:     (cmd, opts = {}) => shell(cmd, { cwd: targetDir, ...opts }),
      // Code search (ripgrep-based)
      search:    (pattern, opts = {}) => search(pattern, targetDir, opts),
      findRefs:  (symbol) => findRefs(symbol, targetDir),
      findFiles: (glob) => findFiles(glob, targetDir),
      // HTTP fetch
      fetch:     (url, opts = {}) => fetchUrl(url, opts),
      // Dependency graph
      buildGraph:       () => buildGraph(targetDir),
      findDependencies: (file, graph) => findDependencies(file, graph),
      findDependents:   (file, graph) => findDependents(file, graph),
      findCycles:       (graph) => findCycles(graph),
      findGodModules:   (graph, threshold) => findGodModules(graph, threshold),
      // Test coverage map
      buildCoverageMap: () => buildCoverageMap(targetDir),
    };

    const ctx = { board, targetDir, hub, ai: aiInstance, gated, projectContext, tools };

    ctx.call = async (agentName, method, args) => {
      const agent = byName.get(agentName);
      if (!agent || typeof agent.skills[method] !== 'function') {
        throw new Error(`Agent ${agentName} has no skill: ${method}`);
      }
      return agent.skills[method](args, ctx);
    };

    return ctx;
  }

  return {
    /** List all agents as plain objects. */
    list() {
      return [...byName.values()].map(a => a.toJSON());
    },

    /** Get a single agent instance by name. */
    get(name) {
      return byName.get(name) ?? null;
    },

    /** Run one agent by name. Returns the result object. */
    async run(name, { board, hub }) {
      const agent = byName.get(name);
      if (!agent) throw new Error(`Unknown agent: ${name}`);
      const ctx = await buildCtx({ board, hub });
      return agent.run(ctx);
    },

    /**
     * Run all agents in sequence (priority order).
     * Returns array of { name, result }.
     */
    async runAll({ board, hub }) {
      const ctx     = await buildCtx({ board, hub });
      const results = [];
      for (const agent of byName.values()) {
        const result = await agent.run(ctx);
        results.push({ name: agent.name, result });
      }
      return results;
    },

    /** Get an agent's memory. */
    async memory(name, { limit = 100 } = {}) {
      const agent = byName.get(name);
      if (!agent) throw new Error(`Unknown agent: ${name}`);
      return agent.recall(limit);
    },

    /** Clear an agent's memory. */
    async clearMemory(name) {
      const agent = byName.get(name);
      if (!agent) throw new Error(`Unknown agent: ${name}`);
      return agent.clearMemory();
    },
  };
}
