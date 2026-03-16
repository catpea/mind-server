/**
 * agents/index.js — Agent registry.
 *
 * Creates and manages the bundled agent crew. Each agent is a singleton
 * scoped to the running server instance.
 *
 * Usage:
 *   import { createAgents } from './agents/index.js';
 *   const agents = createAgents({ targetDir });
 *
 *   // Run one agent:
 *   const result = await agents.run('vera', ctx);
 *
 *   // Run all agents in sequence (Vera goes first):
 *   const results = await agents.runAll(ctx);
 *
 *   // Get agent list:
 *   const list = agents.list();
 */

import { Vera }         from './vera.js';
import { Monica }       from './monica.js';
import { Erica }        from './erica.js';
import { Rita }         from './rita.js';
import { Sandra }       from './sandra.js';
import { Alice }        from './alice.js';
import { Bobby }        from './bobby.js';
import { Mallory }      from './mallory.js';
import { Heather }      from './heather.js';
import { Amy }          from './amy.js';
import { Kimberly }     from './kimberly.js';
import { Danielle }     from './danielle.js';
import { Angela }       from './angela.js';
import { Lauren }       from './lauren.js';
import { Jessica }      from './jessica.js';
import { createAI }     from './ai.js';

// Agent run order matters:
//   1. Amy     — validate requests before Monica plans them
//   2. Vera    — dispatch work based on board state
//   3. Monica  — plan approved requests into todos
//   4. Erica   — implement planned todos
//   5. Rita    — review implemented work
//   6. Heather — architecture review of reviewed work
//   7. Sandra  — QA scanning
//   8. Alice   — write and run tests
//   9. Bobby   — injection vulnerability scanning
//  10. Mallory — adversarial pentesting
//  11. Angela  — defensive security engineering
//  12. Danielle — DevOps/operational readiness
//  13. Lauren  — UX and accessibility review
//  14. Jessica — outcome alignment and business analysis
//  15. Kimberly — engineering management (standups, blockers) — goes last
const AGENT_CLASSES = [
  Amy, Vera, Monica, Erica, Rita, Heather, Sandra,
  Alice, Bobby, Mallory, Angela, Danielle, Lauren, Jessica, Kimberly,
];

export function createAgents({ targetDir, ai }) {
  // Use provided ai instance or create a default (picks up env vars)
  const aiInstance = ai ?? createAI();

  // Instantiate and initialise each agent
  const byName = new Map();
  for (const AgentClass of AGENT_CLASSES) {
    const agent = new AgentClass();
    agent.init({ targetDir });
    byName.set(agent.name, agent);
  }

  /** Build the context object passed to think/act. */
  function buildCtx({ board, hub }) {
    return { board, targetDir, hub, ai: aiInstance };
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
      const ctx = buildCtx({ board, hub });
      return agent.run(ctx);
    },

    /**
     * Run all agents in sequence.
     * Vera dispatches first; others run in order.
     * Returns array of { name, result }.
     */
    async runAll({ board, hub }) {
      const ctx     = buildCtx({ board, hub });
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
