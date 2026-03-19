/**
 * tools/shell.js — Run a shell command in a given directory.
 *
 * Returns a consistent result object regardless of exit code so callers
 * don't need to catch. Errors (spawn failures, timeouts) set ok=false and
 * populate stderr — they do NOT throw.
 *
 * Usage:
 *   const result = await shell('npm test', { cwd: targetDir, timeout: 30_000 });
 *   if (!result.ok) console.error(result.stderr);
 *
 * Result shape:
 *   { ok: boolean, stdout: string, stderr: string, code: number|null }
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 30_000; // 30 s
const MAX_OUTPUT      = 50_000; // 50 KB per stream — prevent memory explosion

/**
 * Run a shell command.
 *
 * @param {string}  cmd              — Shell command string (passed to /bin/sh -c)
 * @param {object}  [opts]
 * @param {string}  [opts.cwd]       — Working directory (default: process.cwd())
 * @param {number}  [opts.timeout]   — Timeout in ms (default: 30 000)
 * @param {object}  [opts.env]       — Additional env vars merged with process.env
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null }>}
 */
export async function shell(cmd, { cwd, timeout = DEFAULT_TIMEOUT, env } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd:   cwd ?? process.cwd(),
      env:   env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', chunk => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });

    const done = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
    };

    child.on('close', code => done(code === 0, code));
    child.on('error', err => {
      stderr += err.message;
      done(false, null);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\n[shell] timed out after ${timeout}ms`;
      done(false, null);
    }, timeout);
  });
}
