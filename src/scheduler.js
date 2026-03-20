/**
 * scheduler.js — autonomous agent loop for mind-server.
 *
 * Three overlapping loops:
 *
 *   Dispatch loop  (event-driven + fallback poll, default 30s)
 *     → Wakes immediately when the board changes (post:created / post:updated / dm:sent).
 *     → Runs Vera, then immediately runs whoever she dispatches (one agent or several in parallel).
 *     → Repeats until Vera says idle. A 30s polling heartbeat catches anything missed.
 *
 *   Scan loop  (slow, default 5 min)
 *     → Runs the audit crew in parallel: Sandra, Bobby, Mallory, Angela, Danielle, Lauren.
 *     → Agents that find nothing return in milliseconds.
 *     → Runs concurrently with the dispatch loop — scan agents are read-only.
 *
 *   Daily loop  (every 20h)
 *     → Runs Kimberly, who posts a standup to r/general.
 *
 * Circuit breaker:
 *   Each agent tracks consecutive failures. After FAILURE_THRESHOLD failures the
 *   agent is paused for COOLDOWN_MS. Paused agents are skipped in #run().
 *   A per-agent timeout of AGENT_TIMEOUT_MS prevents a hung agent from
 *   deadlocking the scheduler's lock flags.
 */

const SCAN_AGENTS       = ['sandra', 'bobby', 'mallory', 'angela', 'danielle', 'lauren'];
const DAILY_MS          = 20 * 60 * 60 * 1000; // 20h
const AGENT_TIMEOUT_MS  = 60_000;              // 60s per agent — hard limit
const FAILURE_THRESHOLD = 3;                   // failures before cooldown
const COOLDOWN_MS       = 5 * 60 * 1000;       // 5 min cooldown after too many failures

import { withTimeout } from './utils.js';

export class Scheduler {
  #agents      = null;
  #board       = null;
  #hub         = null;
  // Two independent locks — dispatch and scan can now overlap since scan agents are read-only.
  #dispatchRunning = false;
  #scanRunning     = false;
  #timers      = [];
  #stopped     = false;
  #unsubWrite  = null;

  // Circuit breaker state per agent
  #failures    = new Map();  // name → consecutive failure count
  #pausedUntil = new Map();  // name → timestamp (ms) when cooldown ends

  // Observability
  #lastCycleMs   = 0;
  #lastCycleAt   = null;
  #nextScanAt    = null;

  constructor({ agents, board, hub }) {
    this.#agents = agents;
    this.#board  = board;
    this.#hub    = hub;
  }

  /**
   * Start the autonomous loops.
   * @param {object} opts
   * @param {number} [opts.cycleMs=30000]   — dispatch poll fallback interval
   * @param {number} [opts.scanMs=300000]   — audit scan interval
   */
  start({ cycleMs = 30_000, scanMs = 300_000 } = {}) {
    console.log(`[scheduler] starting — dispatch event-driven (poll fallback ${cycleMs / 1000}s), scan every ${scanMs / 1000}s`);

    // ── Event-driven dispatch: wake immediately on board writes ───────────────
    // Only gate on #dispatchRunning — a running scan should not prevent dispatch.
    this.#unsubWrite = this.#board.onWrite(() => {
      if (!this.#dispatchRunning && !this.#stopped) {
        setTimeout(() => this.#dispatchCycle(), 100);
      }
    });

    // ── Polling heartbeat (fallback for anything the event missed) ────────────
    this.#dispatchCycle();
    this.#timers.push(setInterval(() => this.#dispatchCycle(), cycleMs));

    // ── Scan loop (offset by half a cycle to avoid collision) ────────────────
    const scanOffset = Math.floor(cycleMs / 2);
    this.#timers.push(setTimeout(() => {
      if (this.#stopped) return;
      this.#nextScanAt = Date.now() + scanMs;
      this.#scanCycle();
      this.#timers.push(setInterval(() => {
        this.#nextScanAt = Date.now() + scanMs;
        this.#scanCycle();
      }, scanMs));
    }, scanOffset));

    // ── Daily Kimberly ────────────────────────────────────────────────────────
    this.#timers.push(setInterval(() => this.#dailyCycle(), DAILY_MS));
  }

  stop() {
    this.#stopped = true;
    this.#unsubWrite?.();
    for (const t of this.#timers) clearInterval(t), clearTimeout(t);
    this.#timers = [];
    console.log('[scheduler] stopped');
  }

  /**
   * Wait for any in-flight agent runs to complete.
   * Resolves when both dispatch and scan are idle, or when timeoutMs elapses.
   */
  waitForIdle(timeoutMs = 10_000) {
    if (!this.#dispatchRunning && !this.#scanRunning) return Promise.resolve();
    return new Promise(resolve => {
      const start = Date.now();
      const poll  = setInterval(() => {
        const idle = !this.#dispatchRunning && !this.#scanRunning;
        if (idle || Date.now() - start > timeoutMs) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });
  }

  /** Current status snapshot — used by GET /scheduler/status. */
  status() {
    const pausedAgents = [];
    const now = Date.now();
    for (const [name, until] of this.#pausedUntil) {
      if (until > now) pausedAgents.push({ name, resumesIn: Math.ceil((until - now) / 1000) });
    }
    const failures = {};
    for (const [name, count] of this.#failures) {
      if (count > 0) failures[name] = count;
    }
    return {
      // `running` stays true when either loop is active (backward-compat with
      // server.js health/metrics endpoints that check `schedStat.running`).
      running:             this.#dispatchRunning || this.#scanRunning,
      dispatchRunning:     this.#dispatchRunning,
      scanRunning:         this.#scanRunning,
      stopped:             this.#stopped,
      lastCycleMs:         this.#lastCycleMs,
      lastCycleAt:         this.#lastCycleAt,
      nextScanIn:          this.#nextScanAt ? Math.max(0, Math.ceil((this.#nextScanAt - now) / 1000)) : null,
      pausedAgents,
      consecutiveFailures: failures,
    };
  }

  // ── Dispatch loop ────────────────────────────────────────────────────────────

  async #dispatchCycle() {
    if (this.#dispatchRunning || this.#stopped) return;
    this.#dispatchRunning = true;
    const start = Date.now();
    try {
      let hops = 0;
      const maxHops = 6;
      while (hops++ < maxHops) {
        const vera = await this.#run('vera');
        if (!vera || vera.outcome === 'idle' || vera.outcome === 'nothing-to-do') break;

        // vera.dispatch may be a single agent name or an array of names.
        // Run multiple dispatched agents in parallel when Vera returns an array.
        const dispatched = vera.dispatch;
        if (!dispatched) break;

        const names = Array.isArray(dispatched) ? dispatched : [dispatched];
        if (names.length === 0) break;

        if (names.length === 1) {
          await this.#run(names[0]);
        } else {
          console.log(`[scheduler] parallel dispatch: ${names.join(', ')}`);
          await Promise.all(names.map(name => this.#run(name)));
        }
      }
    } finally {
      this.#dispatchRunning = false;
      this.#lastCycleMs    = Date.now() - start;
      this.#lastCycleAt    = new Date().toISOString();
    }
  }

  // ── Scan loop (parallel read-only agents) ────────────────────────────────────

  async #scanCycle() {
    // Scan has its own independent lock — it does not block or wait on dispatch.
    if (this.#scanRunning || this.#stopped) return;
    this.#scanRunning = true;
    try {
      await Promise.all(
        SCAN_AGENTS
          .filter(() => !this.#stopped)
          .map(name => this.#run(name))
      );
    } finally {
      this.#scanRunning = false;
    }
  }

  // ── Daily Kimberly ────────────────────────────────────────────────────────────

  async #dailyCycle() {
    if (this.#stopped) return;
    await this.#run('kimberly');
  }

  // ── Run one agent (with timeout + circuit breaker) ───────────────────────────

  async #run(name) {
    const agent = this.#agents.get(name);
    if (!agent) return null;

    // Circuit breaker: skip paused agents
    const pausedUntil = this.#pausedUntil.get(name) ?? 0;
    if (Date.now() < pausedUntil) {
      const secs = Math.ceil((pausedUntil - Date.now()) / 1000);
      console.log(`[scheduler] ${name}: paused (${secs}s remaining)`);
      return null;
    }

    try {
      // Hard per-agent timeout — prevents lock deadlock if agent hangs
      const result = await withTimeout(
        this.#agents.run(name, { board: this.#board, hub: this.#hub }),
        AGENT_TIMEOUT_MS,
        `agent:${name}`,
      );

      // Reset failure counter on success
      this.#failures.set(name, 0);

      const summary = result.outcome === 'idle' ? 'idle'
        : result.count !== undefined             ? `${result.outcome} (${result.count})`
        : result.outcome;
      console.log(`[scheduler] ${name}: ${summary}`);
      return result;

    } catch (err) {
      const failures = (this.#failures.get(name) ?? 0) + 1;
      this.#failures.set(name, failures);
      console.error(`[scheduler] ${name} failed (${failures}/${FAILURE_THRESHOLD}):`, err.message);

      if (failures >= FAILURE_THRESHOLD) {
        this.#pausedUntil.set(name, Date.now() + COOLDOWN_MS);
        console.error(`[scheduler] ${name}: circuit breaker tripped — pausing for ${COOLDOWN_MS / 60_000}min`);
      }

      return null;
    }
  }
}
