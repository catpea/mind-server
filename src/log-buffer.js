/**
 * log-buffer.js — In-memory ring buffer for structured agent log entries.
 * Shared between server (exposes GET /logs) and base agent (feeds entries in).
 * Module-level singleton so both sides import the same instance.
 */

const MAX_ENTRIES = 500;

class LogBuffer {
  #entries = [];

  add(entry) {
    this.#entries.push({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
  }

  get(n = 100, filter = {}) {
    let entries = [...this.#entries].reverse(); // newest first
    if (filter.agent)  entries = entries.filter(e => e.agent  === filter.agent);
    if (filter.level)  entries = entries.filter(e => e.level  === filter.level);
    if (filter.runId)  entries = entries.filter(e => e.runId  === filter.runId);
    return entries.slice(0, n);
  }

  clear() { this.#entries = []; }
}

export const logBuffer = new LogBuffer();
