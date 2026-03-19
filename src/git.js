/**
 * git.js — Lightweight git helpers for agents.
 *
 * All functions take a `dir` argument (the target project directory).
 * They all silently return safe defaults if the directory isn't a git repo
 * or git isn't available — agents should never crash because of missing git.
 *
 * Usage:
 *   import * as git from '../git.js';
 *   if (await git.isRepo(targetDir)) {
 *     const diff = await git.diff(targetDir);
 *     await git.stageAll(targetDir);
 *     await git.commit(targetDir, 'fix: resolve XSS in listItem()');
 *   }
 */

import { execFile }  from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join }       from 'node:path';

const execFileAsync = promisify(execFile);

async function run(dir, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, timeout: 15_000 });
  return stdout.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True if `dir` is inside a git repository. */
export async function isRepo(dir) {
  try {
    await run(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Short status summary: list of { path, state } objects.
 * state: 'modified' | 'added' | 'deleted' | 'untracked'
 *
 * Returns null if git is unavailable or the directory is not a repo.
 * Returns [] (empty array) if the repo is clean.
 * Callers should check for null before assuming a clean repo.
 */
export async function status(dir) {
  try {
    const out = await run(dir, ['status', '--porcelain']);
    return out.split('\n').filter(Boolean).map(line => {
      const code  = line.slice(0, 2).trim();
      const path  = line.slice(3).trim();
      const state = code === '??' ? 'untracked'
        : code.includes('D')     ? 'deleted'
        : code.includes('A')     ? 'added'
        : 'modified';
      return { path, state };
    });
  } catch {
    return null; // null = git unavailable or not a repo (distinct from [] = clean)
  }
}

/**
 * Return the unified diff of uncommitted changes.
 * Pass a specific `file` to limit to one path.
 *
 * Returns null if git is unavailable or errors out.
 * Returns '' (empty string) if the repo is clean / no changes.
 * Callers should check for null before assuming a clean diff.
 */
export async function diff(dir, file) {
  try {
    const args = ['diff', 'HEAD', '--'];
    if (file) args.push(file);
    return await run(dir, args);
  } catch {
    // HEAD may not exist on a brand-new repo — fall back to cached diff
    try {
      const args = ['diff', '--cached', '--'];
      if (file) args.push(file);
      return await run(dir, args);
    } catch {
      return null; // null = git unavailable (distinct from '' = clean)
    }
  }
}

/** Stage all changes (equivalent to `git add -A`). */
export async function stageAll(dir) {
  try {
    await run(dir, ['add', '-A']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a commit with the given message.
 * Stages all changes first. Returns the short commit SHA, or null on failure.
 */
export async function commit(dir, message) {
  try {
    await stageAll(dir);
    await run(dir, ['commit', '-m', message, '--allow-empty']);
    return await run(dir, ['rev-parse', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Return the last `n` commit subjects as an array of strings.
 */
export async function log(dir, n = 5) {
  try {
    const out = await run(dir, ['log', `--oneline`, `-${n}`]);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Return the name of the current branch, or null.
 */
export async function branch(dir) {
  try {
    return await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}
