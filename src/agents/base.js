/**
 * base.js — BaseAgent class.
 *
 * All agents extend this. Provides:
 *   - Memory: append-only JSON log at .mind-server/agents/<name>/memory.json
 *   - run(ctx): template method — calls think() → act() → remember()
 *   - Logging: agent.log(msg) → broadcasts SSE event + console
 *
 * Agent interface:
 *   class MyAgent extends BaseAgent {
 *     name        = 'myagent';
 *     description = 'What I do in one sentence.';
 *     avatar      = '🛠';
 *
 *     async think(ctx) { return { ... }; }   // assess state, return a plan
 *     async act(plan, ctx) { return { outcome, actions }; } // execute plan
 *   }
 *
 * Context object (ctx) passed to think/act:
 *   ctx.board      — Board instance (read/write posts, comments, DMs)
 *   ctx.targetDir  — absolute path to the target project directory
 *   ctx.hub        — SseHub (broadcast real-time events to clients)
 *   ctx.ai         — { ask, askJSON, isAvailable } from ai.js
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync }                 from 'node:fs';
import { join }                       from 'node:path';

export class BaseAgent {
  // Override these in subclasses:
  name        = 'agent';
  description = 'Base agent.';
  avatar      = '🤖';
  role        = 'general';

  #memoryFile;
  #memory = null; // lazy-loaded

  init({ targetDir }) {
    this.targetDir  = targetDir;
    this.#memoryFile = join(targetDir, '.mind-server', 'agents', this.name, 'memory.json');
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  async #ensureMemory() {
    if (this.#memory !== null) return;
    await mkdir(join(this.targetDir, '.mind-server', 'agents', this.name), { recursive: true });
    if (existsSync(this.#memoryFile)) {
      try {
        this.#memory = JSON.parse(await readFile(this.#memoryFile, 'utf8'));
      } catch {
        this.#memory = [];
      }
    } else {
      this.#memory = [];
    }
  }

  /** Append an entry to the agent's memory log. */
  async remember(type, content) {
    await this.#ensureMemory();
    this.#memory.push({ type, content, timestamp: new Date().toISOString() });
    await writeFile(this.#memoryFile, JSON.stringify(this.#memory, null, 2));
  }

  /** Return the last N memory entries. */
  async recall(n = 50) {
    await this.#ensureMemory();
    return this.#memory.slice(-n);
  }

  /** Return all memory entries. */
  async allMemory() {
    await this.#ensureMemory();
    return [...this.#memory];
  }

  /** Clear memory (destructive — ask the user first). */
  async clearMemory() {
    this.#memory = [];
    await writeFile(this.#memoryFile, '[]');
  }

  // ── Logging ──────────────────────────────────────────────────────────────

  /**
   * Log a message: prints to console and broadcasts an SSE event.
   * Call within think/act with access to ctx.
   */
  log(msg, ctx) {
    const line = `[${this.avatar} ${this.name}] ${msg}`;
    console.log(line);
    ctx?.hub?.broadcast('agent:log', { agent: this.name, message: msg, timestamp: new Date().toISOString() });
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  /**
   * Template method — override think() and act() in subclasses.
   * Returns { outcome, actions[], durationMs }
   */
  async run(ctx) {
    const start = Date.now();
    this.log('running...', ctx);

    let plan, result;
    try {
      plan   = await this.think(ctx);
      result = await this.act(plan, ctx);
    } catch (err) {
      this.log(`error: ${err.message}`, ctx);
      await this.remember('error', { message: err.message, stack: err.stack });
      return { outcome: 'error', error: err.message, durationMs: Date.now() - start };
    }

    const durationMs = Date.now() - start;
    await this.remember('run', {
      outcome:    result.outcome,
      actions:    result.actions ?? [],
      planSummary: plan?.summary ?? null,
      durationMs,
    });

    this.log(`done — ${result.outcome} (${durationMs}ms)`, ctx);
    ctx?.hub?.broadcast('agent:done', {
      agent:    this.name,
      outcome:  result.outcome,
      actions:  result.actions ?? [],
      durationMs,
    });

    return { ...result, durationMs };
  }

  /** Override: assess the board state and return a plan object. */
  async think(ctx) { return { summary: 'idle' }; }

  /** Override: execute the plan and return { outcome, actions[] }. */
  async act(plan, ctx) { return { outcome: 'idle', actions: [] }; }

  // ── Self-description ──────────────────────────────────────────────────────

  toJSON() {
    return {
      name:        this.name,
      description: this.description,
      avatar:      this.avatar,
      role:        this.role,
    };
  }
}
