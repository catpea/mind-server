/**
 * utils.js — Shared utility functions. Zero dependencies.
 *
 * Exports:
 *   withTimeout(promise, ms, label)                  — reject if not settled in time
 *   safeReadFile(path, defaultValue)                 — readFile that returns a default on error
 *   retryWithBackoff(fn, opts)                       — retry with exponential backoff
 */

import { readFile } from 'node:fs/promises';

// ── Timeout ───────────────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout.
 * Rejects with a descriptive Error if the promise doesn't settle in `ms` milliseconds.
 *
 * @param {Promise<T>}  promise
 * @param {number}      ms      — timeout in milliseconds
 * @param {string}      [label] — included in the error message for diagnostics
 * @returns {Promise<T>}
 *
 * @example
 *   const result = await withTimeout(longRunningOp(), 5000, 'longRunningOp');
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Safe file read ────────────────────────────────────────────────────────────

/**
 * Read a file as UTF-8, returning `defaultValue` on any error.
 * Useful in agents where a missing file is expected and should not crash.
 *
 * @param {string} path
 * @param {*}      [defaultValue='']
 * @returns {Promise<string|*>}
 *
 * @example
 *   const src = await safeReadFile('/path/to/file.js', '');
 */
export async function safeReadFile(path, defaultValue = '') {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return defaultValue;
  }
}

// ── Retry with exponential backoff ────────────────────────────────────────────

/**
 * Call `fn` and retry up to `retries` times on failure, with exponential backoff.
 *
 * Backoff schedule (baseMs = 500):
 *   attempt 1 → immediate
 *   retry  1  → 500ms
 *   retry  2  → 1000ms
 *   retry  3  → 2000ms
 *
 * An optional `shouldRetry(err)` predicate gates retries — return false to stop early
 * (e.g. don't retry 401 Unauthorized).
 *
 * @param {() => Promise<T>}  fn
 * @param {object}            [opts]
 * @param {number}            [opts.retries=3]       — max number of retries (not total attempts)
 * @param {number}            [opts.baseMs=500]       — base delay; doubles each retry
 * @param {string}            [opts.label='']        — included in log messages
 * @param {(err: Error) => boolean} [opts.shouldRetry] — return false to give up early
 * @returns {Promise<T>}
 *
 * @example
 *   const data = await retryWithBackoff(() => fetch(url).then(r => r.json()), {
 *     retries: 3,
 *     label: 'fetchData',
 *     shouldRetry: err => err.status === 429,
 *   });
 */
export async function retryWithBackoff(fn, {
  retries     = 3,
  baseMs      = 500,
  label       = '',
  shouldRetry = () => true,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === retries;
      if (isLast || !shouldRetry(err)) throw err;

      const base  = baseMs * 2 ** attempt;
      // ±25 % jitter — prevents a thundering herd when multiple agents
      // hit the same rate-limit at the same time and all retry in sync.
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      const delay  = Math.max(0, Math.round(base + jitter));
      const tag    = label ? `[${label}] ` : '';
      console.warn(`${tag}attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
