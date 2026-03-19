/**
 * tools/search.js — Code search built on ripgrep (rg).
 *
 * Falls back gracefully if rg is not installed — returns empty results.
 *
 * Three entry points:
 *   search(pattern, dir, opts)   — line-level grep; returns [{ file, line, text }]
 *   findRefs(symbol, dir)        — usages of a symbol across the codebase
 *   findFiles(glob, dir)         — list files matching a glob pattern
 *
 * Usage:
 *   const refs = await findRefs('createPost', targetDir);
 *   const tests = await findFiles('**\/*.test.js', targetDir);
 */

import { shell } from './shell.js';

const IGNORE_DIRS = ['node_modules', '.git', '.mind-server', 'dist'];
const DEFAULT_EXTS = ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'md', 'py'];

/**
 * Escape a value for safe embedding in a POSIX shell command string.
 * Wraps in single quotes and escapes any embedded single quotes.
 * Prevents shell injection when passing user-controlled or AI-generated strings.
 */
function shellEscape(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * Run ripgrep and parse JSON output into a flat result array.
 * @param {string[]} args  — rg arguments (excluding --json which is always added)
 * @param {string}   dir   — working directory for the search
 * @returns {Promise<Array<{ file: string, line: number, text: string }>>}
 */
async function rg(args, dir) {
  const ignoreFlags = IGNORE_DIRS.flatMap(d => ['--glob', shellEscape(`!${d}`)]);
  // Escape every non-flag argument to prevent shell injection from
  // AI-generated patterns or user-supplied search terms.
  const safeArgs = args.map(a => /^-/.test(a) ? a : shellEscape(a));
  const cmd = ['rg', '--json', ...ignoreFlags, ...safeArgs].join(' ');

  const result = await shell(cmd, { cwd: dir, timeout: 15_000 });

  // rg exits 1 when there are no matches — that's not an error
  if (!result.ok && result.code !== 1) return [];

  const matches = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'match') {
        const { path, lines, line_number } = obj.data;
        matches.push({
          file: path.text,
          line: line_number,
          text: lines.text.trimEnd(),
        });
      }
    } catch { /* skip malformed lines */ }
  }

  return matches;
}

/**
 * Search for a pattern across source files.
 *
 * @param {string}   pattern         — Regex pattern (ripgrep syntax)
 * @param {string}   dir             — Directory to search
 * @param {object}   [opts]
 * @param {string[]} [opts.exts]     — File extensions to include (without dot)
 * @param {number}   [opts.limit]    — Max results (default: 100)
 * @returns {Promise<Array<{ file: string, line: number, text: string }>>}
 */
export async function search(pattern, dir, { exts = DEFAULT_EXTS, limit = 100 } = {}) {
  const extFlag = exts.length ? ['--type-add', `custom:*.{${exts.join(',')}}`, '--type', 'custom'] : [];
  const results = await rg([...extFlag, '--', pattern], dir);
  return results.slice(0, limit);
}

/**
 * Find all usages of a symbol (function, class, variable) across the codebase.
 * Uses word-boundary matching to avoid partial matches.
 *
 * @param {string} symbol  — Identifier to search for
 * @param {string} dir     — Directory to search
 * @returns {Promise<Array<{ file: string, line: number, text: string }>>}
 */
export async function findRefs(symbol, dir) {
  // --fixed-strings: treat symbol as a literal (no regex interpretation)
  // --word-regexp:   match only on word boundaries
  // This avoids building a shell-interpolated regex from potentially
  // untrusted input, and handles symbols containing regex special chars.
  const results = await rg(['--fixed-strings', '--word-regexp', '--', symbol], dir);
  return results.slice(0, 200);
}

/**
 * Find files matching a glob pattern.
 *
 * @param {string} glob   — Glob pattern (e.g. '**\/*.test.js')
 * @param {string} dir    — Directory to search
 * @returns {Promise<string[]>}  — Relative file paths
 */
export async function findFiles(glob, dir) {
  const ignoreFlags = IGNORE_DIRS.flatMap(d => ['--glob', shellEscape(`!${d}`)]);
  const cmd = ['rg', '--files', ...ignoreFlags, '--glob', shellEscape(glob)].join(' ');

  const result = await shell(cmd, { cwd: dir, timeout: 15_000 });

  if (!result.ok && result.code !== 1) return [];
  return result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}
