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
import { logBuffer }                  from '../log-buffer.js';

// ── Scratchpad ────────────────────────────────────────────────────────────────

const SCRATCHPAD_TTL_MS = 5_000; // 5 s — short TTL, frequently updated
let _scratchCache = { path: '', text: '', at: 0 };

// ── Project context cache ─────────────────────────────────────────────────────

const CONTEXT_TTL_MS = 60_000; // 60 s — one reload per minute at most
let _ctxCache = { path: '', text: '', at: 0 };

/**
 * Load .mind-server/context.md if present; returns string or ''.
 * Results are cached for 60 seconds — callers (agents) run multiple times per
 * scheduler cycle and the file rarely changes, so repeated disk reads are waste.
 */
export async function loadProjectContext(targetDir) {
  const p   = join(targetDir, '.mind-server', 'context.md');
  const now = Date.now();
  if (_ctxCache.path === p && now - _ctxCache.at < CONTEXT_TTL_MS) {
    return _ctxCache.text;
  }
  if (!existsSync(p)) {
    _ctxCache = { path: p, text: '', at: now };
    return '';
  }
  try {
    const text = await readFile(p, 'utf8');
    _ctxCache  = { path: p, text, at: now };
    return text;
  } catch {
    return '';
  }
}

// ── Memory cap ────────────────────────────────────────────────────────────────

const MAX_MEMORY_ENTRIES = 1000;

// Board methods that mutate state — readonly agents must not call these.
const WRITE_METHODS = new Set([
  'createPost', 'updatePost', 'addComment', 'sendDM',
  'markDMRead', 'replyToDM', 'advanceStatus', 'ensureSub', 'del',
]);

export class BaseAgent {
  // Override these in subclasses:
  name        = 'agent';
  description = 'Base agent.';
  avatar      = '🤖';
  role        = 'general';

  /**
   * Determines agent activation order in the auto-discovery registry.
   * Lower = runs earlier. Override in each subclass.
   */
  static priority = 99;

  /**
   * Set readonly = true on pure observation agents that should never mutate
   * board state. All other agents default to false (writable).
   * The readonly proxy will block mutation calls and log a warning instead.
   */
  readonly = false;

  /**
   * Agents expose callable skills that peers can invoke synchronously via `ctx.call()`.
   * Subclasses populate this map: { methodName: async (args, ctx) => result }
   */
  skills = {};

  #memoryFile;
  #memory      = null; // lazy-loaded flat array (append-order)
  #memoryByType = new Map(); // type → entry[] in reverse-chron order (newest first)
  #runId        = null; // set at start of each run()

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
    this.#rebuildTypeIndex();
  }

  /**
   * Build a type → entry[] index from the flat memory array.
   * Entries are stored newest-first within each type bucket so that
   * recallWhere() can slice the head without a full scan.
   */
  #rebuildTypeIndex() {
    this.#memoryByType = new Map();
    for (let i = this.#memory.length - 1; i >= 0; i--) {
      const entry = this.#memory[i];
      const bucket = this.#memoryByType.get(entry.type);
      if (bucket) bucket.push(entry);
      else this.#memoryByType.set(entry.type, [entry]);
    }
  }

  /** Append an entry to the agent's memory log. Keeps the newest MAX_MEMORY_ENTRIES entries. */
  async remember(type, content) {
    await this.#ensureMemory();
    const entry = { type, content, timestamp: new Date().toISOString() };
    this.#memory.push(entry);
    // Rotate: drop the oldest entries once we exceed the cap
    if (this.#memory.length > MAX_MEMORY_ENTRIES) {
      this.#memory = this.#memory.slice(-MAX_MEMORY_ENTRIES);
      // Rebuild index from scratch after rotation (avoids stale references)
      this.#rebuildTypeIndex();
    } else {
      // Prepend to the type bucket (newest-first order)
      const bucket = this.#memoryByType.get(type);
      if (bucket) bucket.unshift(entry);
      else this.#memoryByType.set(type, [entry]);
    }
    await writeFile(this.#memoryFile, JSON.stringify(this.#memory, null, 2));
  }

  /** Return the last N memory entries. */
  async recall(n = 50) {
    await this.#ensureMemory();
    return this.#memory.slice(-n);
  }

  /**
   * Query memory by type and optional filter function.
   * Returns entries in reverse-chronological order (newest first).
   *
   * @param {string}   type      — memory entry type (e.g. 'dispatch', 'run', 'scan')
   * @param {Function} [filter]  — optional predicate: (entry) => boolean
   * @param {number}   [n=100]   — max entries to search
   * @returns {Promise<object[]>}
   *
   * @example
   *   // Last scan entry for this targetDir
   *   const last = await this.recallWhere('scan', e => e.content.targetDir === targetDir);
   *   // All dispatch entries for 'sandra'
   *   const sandraRuns = await this.recallWhere('dispatch', e => e.content.dispatch === 'sandra');
   */
  async recallWhere(type, filter, n = 100) {
    await this.#ensureMemory();
    // Use the type index (O(1) lookup) instead of a full array scan.
    const bucket = this.#memoryByType.get(type) ?? [];
    const entries = n < bucket.length ? bucket.slice(0, n) : bucket;
    return filter ? entries.filter(filter) : entries;
  }

  /**
   * Return the most recent memory entry of a given type, or null.
   * @param {string} type
   * @returns {Promise<object|null>}
   */
  async recallLast(type) {
    const results = await this.recallWhere(type, null, 200);
    return results[0] ?? null;
  }

  /** Return all memory entries. */
  async allMemory() {
    await this.#ensureMemory();
    return [...this.#memory];
  }

  /** Clear memory (destructive — ask the user first). */
  async clearMemory() {
    this.#memory = [];
    this.#memoryByType = new Map();
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
    logBuffer.add({ level: 'info', agent: this.name, message: msg, runId: this.#runId });
  }

  /**
   * Emit a structured progress event for this agent run.
   * SSE clients receive `agent:progress` events for live timeline rendering.
   * Also logs to console.
   */
  logProgress(msg, ctx) {
    const line = `[${this.avatar} ${this.name}] ⟶ ${msg}`;
    console.log(line);
    ctx?.hub?.broadcast('agent:progress', {
      agent:     this.name,
      message:   msg,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  /**
   * Template method — override think() and act() in subclasses.
   *
   * Before calling think/act, automatically handles incoming peer questions:
   * any DM addressed to this agent with meta.requiresReply that hasn't been
   * answered yet is passed to answerQuestion(). Subclasses override that method
   * to generate context-appropriate responses.
   *
   * Returns { outcome, actions[], durationMs }
   */
  async run(ctx) {
    const start = Date.now();
    this.#runId = Math.random().toString(36).slice(2, 10);
    this.log('running...', ctx);

    // Readonly agents receive a guarded board proxy that blocks mutation calls
    const activeCtx = this.readonly
      ? { ...ctx, board: this.#readonlyBoard(ctx.board) }
      : ctx;

    let plan, result;
    try {
      // Answer incoming peer questions before doing own work
      if (activeCtx.board) {
        const questions = await this.getUnansweredQuestions(activeCtx.board);
        for (const q of questions) {
          await this.#handleQuestion(q, activeCtx);
        }
      }

      plan   = await this.think(activeCtx);
      result = await this.act(plan, activeCtx);
    } catch (err) {
      this.log(`error: ${err.message}`, ctx);
      await this.remember('error', { message: err.message, stack: err.stack });
      return { outcome: 'error', error: err.message, durationMs: Date.now() - start };
    }

    const durationMs = Date.now() - start;
    await this.remember('run', {
      outcome:     result.outcome,
      actions:     result.actions ?? [],
      planSummary: plan?.summary ?? null,
      durationMs,
      runId:       this.#runId,
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

  // ── Readonly board proxy ──────────────────────────────────────────────────

  /**
   * Returns a Proxy of `board` that intercepts write methods and logs a warning
   * instead of executing them. Used to enforce the readonly contract on scan
   * agents that should only observe, never mutate.
   */
  #readonlyBoard(board) {
    const agentName = this.name;
    return new Proxy(board, {
      get(target, prop) {
        if (WRITE_METHODS.has(prop)) {
          return (..._args) => {
            console.warn(`[⚠ ${agentName}] readonly agent attempted board.${prop}() — blocked`);
            return Promise.resolve(null);
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
  }

  // ── DM Conversations ──────────────────────────────────────────────────────

  /**
   * Send a question DM to a peer agent.
   * The message is flagged requiresReply: true so the peer knows to answer.
   * Remembers the outgoing question so we can track whether it was answered.
   *
   * @param {Board} board
   * @param {object} opts
   * @param {string} opts.to       — agent name to ask
   * @param {string} opts.subject  — question subject line
   * @param {string} opts.body     — full question text
   * @returns {Promise<DM>}
   */
  async consultPeer(board, { to, subject, body }) {
    const dm = await board.sendDM({
      from:    this.name,
      to,
      subject,
      body,
      meta:    { requiresReply: true },
    });
    await this.remember('dm-question', { dmId: dm.id, to, subject });
    return dm;
  }

  /**
   * Get DMs addressed to me that require a reply and haven't been answered yet.
   * A question is considered answered if I've sent a reply DM to the same thread.
   *
   * @param {Board} board
   * @returns {Promise<DM[]>}
   */
  async getUnansweredQuestions(board) {
    const inbound  = await board.getDMs({ to: this.name });
    const questions = inbound.filter(d => d.meta?.requiresReply && !d.read);
    if (!questions.length) return [];

    // Find thread IDs I've already replied to
    const mySent   = await board.getDMs({ from: this.name });
    const replied  = new Set(mySent.filter(d => d.meta?.isReply).map(d => d.threadId));

    return questions.filter(q => !replied.has(q.threadId ?? q.id));
  }

  /**
   * Get unread replies to questions this agent sent (answers from peers).
   *
   * @param {Board} board
   * @returns {Promise<DM[]>}
   */
  async getConversationReplies(board) {
    const inbound = await board.getDMs({ to: this.name, unreadOnly: true });
    return inbound.filter(d => d.meta?.isReply);
  }

  /**
   * Check whether I'm still waiting for a reply to a pending question.
   * Returns the unanswered question DM, or null if all questions have replies.
   *
   * @param {Board} board
   * @param {string} [subject]  — narrow to a specific subject if provided
   * @returns {Promise<DM|null>}
   */
  async pendingQuestion(board, subject) {
    const questions = await this.getUnansweredQuestions(board);
    if (!subject) return questions[0] ?? null;
    return questions.find(q => q.subject === subject) ?? null;
  }

  /**
   * Check whether a similar open post already exists in a subreddit.
   * Normalises both titles to lowercase and checks for substring overlap.
   * Returns the matching post or null.
   */
  async findDuplicate(board, sub, title) {
    const norm     = t => t.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const needle   = norm(title);
    const existing = await board.getPosts(sub).catch(() => []);
    return existing.find(p =>
      p.status !== 'done' && p.status !== 'wont-fix' &&
      (norm(p.title).includes(needle) || needle.includes(norm(p.title)))
    ) ?? null;
  }

  // ── Private: question dispatch ────────────────────────────────────────────

  async #handleQuestion(dm, ctx) {
    this.log(`answering question from ${dm.from}: "${dm.subject}"`, ctx);
    let answer;
    try {
      answer = await this.answerQuestion(dm, ctx);
    } catch (err) {
      answer = `Sorry, I encountered an error trying to answer: ${err.message}`;
    }
    if (answer) {
      await ctx.board.replyToDM(dm.id, { from: this.name, body: answer });
      await ctx.board.markDMRead(dm.id);
      this.log(`replied to ${dm.from}`, ctx);
    }
  }

  /**
   * Override to provide domain-specific answers to peer questions.
   * Return a string reply, or null/undefined to skip (leave for next cycle).
   * Default implementation: use AI if available, otherwise decline politely.
   *
   * @param {DM}     dm   — the incoming question DM
   * @param {object} ctx  — agent context
   * @returns {Promise<string|null>}
   */
  async answerQuestion(dm, ctx) {
    if (!ctx.ai?.isAvailable()) {
      return `I'd like to help with "${dm.subject}" but I need AI to answer. Please try again once an AI provider is configured.`;
    }
    const contextNote = ctx.projectContext
      ? `\n\n## Project Context\n${ctx.projectContext}`
      : '';
    const prompt = `You are ${this.name} (${this.description}).
A peer agent named ${dm.from} is asking you a question before they act.
Help them make a good decision.${contextNote}

## Their question
Subject: ${dm.subject}
${dm.body}

Reply concisely. If you don't have enough context, say so clearly and ask a clarifying follow-up.`;
    return ctx.ai.ask(prompt, {
      system: `You are ${this.name}. Reply directly and helpfully to your colleague. Be concise.`,
    });
  }

  // ── Scratchpad ────────────────────────────────────────────────────────────

  /**
   * Read the shared scratchpad (.mind-server/scratchpad.md).
   * All agents share this file — it is the cross-cycle working memory.
   * Results are cached for 5 seconds to reduce repeated disk reads.
   * Returns the full content as a string, or '' if absent.
   */
  async readScratchpad() {
    const p   = join(this.targetDir, '.mind-server', 'scratchpad.md');
    const now = Date.now();
    if (_scratchCache.path === p && now - _scratchCache.at < SCRATCHPAD_TTL_MS) {
      return _scratchCache.text;
    }
    try {
      const text  = await readFile(p, 'utf8');
      _scratchCache = { path: p, text, at: now };
      return text;
    } catch {
      _scratchCache = { path: p, text: '', at: now };
      return '';
    }
  }

  /**
   * Write or replace a named section in the shared scratchpad.
   * Sections are delimited by `## <section>` headings. If the section already
   * exists its content is replaced; otherwise a new section is appended.
   *
   * @param {string} section  — Section heading (e.g. 'erica', 'vera', 'monica')
   * @param {string} content  — Markdown content for the section (no heading line)
   */
  async writeScratchpad(section, content) {
    const p        = join(this.targetDir, '.mind-server', 'scratchpad.md');
    const existing = await this.readScratchpad();
    const heading  = `## ${section}`;
    const block    = `${heading}\n${content.trimEnd()}`;

    let updated;
    // Replace existing section (heading up to next ## or end of file)
    const sectionRegex = new RegExp(`(^|\\n)(## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)[\\s\\S]*?(?=\\n## |$)`, 'm');
    if (sectionRegex.test(existing)) {
      updated = existing.replace(sectionRegex, (_, pre) => `${pre}${block}`);
    } else {
      updated = existing ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
    }

    await writeFile(p, updated, 'utf8');
    // Invalidate cache
    _scratchCache = { path: p, text: updated, at: Date.now() };
  }

  // ── Agent helpers ─────────────────────────────────────────────────────────

  /**
   * Create a post safely: checks for duplicates, ensures the sub exists.
   * Returns { post, isDuplicate }.
   *
   * Replaces the repetitive `ensureSub + findDuplicate + createPost` boilerplate
   * that every posting agent previously duplicated.
   *
   * @param {Board}  board
   * @param {string} sub      — subreddit name
   * @param {object} data     — { title, body, author, type, meta }
   * @returns {Promise<{ post: object, isDuplicate: boolean }>}
   */
  async postSafe(board, sub, { title, body = '', author, type = 'discussion', meta = {} } = {}) {
    const dupe = await this.findDuplicate(board, sub, title);
    if (dupe) {
      this.log(`duplicate: "${title}" already exists in r/${sub} — skipping`);
      return { post: dupe, isDuplicate: true };
    }
    await board.ensureSub(sub);
    const post = await board.createPost(sub, { title, body, author, type, meta });
    return { post, isDuplicate: false };
  }

  /**
   * Standard two-path AI handler.
   * Calls withAI(ctx) when AI is available, withoutAI(ctx) otherwise.
   * withoutAI is optional — returns null if omitted and AI is unavailable.
   *
   * Eliminates the repeated `if (ctx.ai.isAvailable()) { ... } else { ... }` pattern.
   *
   * @param {object}   ctx
   * @param {Function} withAI    — async (ctx) => result
   * @param {Function} [withoutAI] — async (ctx) => result
   * @returns {Promise<*>}
   *
   * @example
   *   const result = await this.whenAI(ctx,
   *     ctx => ctx.ai.askJSON(prompt),
   *     ()  => this.#heuristicFallback(),
   *   );
   */
  async whenAI(ctx, withAI, withoutAI = null) {
    if (ctx.ai.isAvailable()) return withAI(ctx);
    if (withoutAI) return withoutAI(ctx);
    return null;
  }

  // ── Overridable lifecycle ─────────────────────────────────────────────────

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
