/**
 * tools/deps.js — Static import dependency graph for JS/TS projects.
 *
 * Parses `import` and `require` statements using regex (no external deps).
 * Good enough for agent reasoning — not a full AST analysis, but covers the
 * common patterns and runs in milliseconds.
 *
 * Usage:
 *   const graph = await buildGraph(targetDir);
 *   const deps  = findDependencies('src/server.js', graph);  // what it imports
 *   const users = findDependents('src/board.js', graph);     // what imports it
 *
 * Graph shape:
 *   { nodes: string[], edges: [{ from: string, to: string }][] }
 */

import { readFile }  from 'node:fs/promises';
import { join, resolve, relative, dirname, extname } from 'node:path';
import { findFiles } from './search.js';

const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);

// Module-level graph cache: dir → { graph, at }
// Shared across all callers in the same process so multiple agents
// (Monica, Erica, Heather) that call buildGraph() in the same scheduler
// cycle reuse the same result instead of rebuilding from scratch each time.
const _graphCache = new Map();
const GRAPH_TTL_MS = 60_000; // 60 s

// Match ES6 imports: import ... from '...'
const ESM_IMPORT  = /\bimport\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
// Match CommonJS: require('...')
const CJS_REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Match dynamic: import('...')
const DYN_IMPORT  = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(source) {
  const specifiers = new Set();
  for (const pattern of [ESM_IMPORT, CJS_REQUIRE, DYN_IMPORT]) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(source)) !== null) {
      specifiers.add(m[1]);
    }
  }
  return [...specifiers];
}

/**
 * Resolve a specifier relative to the importer file.
 * Returns a relative path from `rootDir`, or null for node_modules.
 */
function resolveSpecifier(specifier, importerFile, rootDir) {
  // Skip node built-ins and npm packages
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  const importerDir   = dirname(importerFile);
  const resolvedAbs   = resolve(importerDir, specifier);

  // Try with various extensions
  const candidates = [
    resolvedAbs,
    ...JS_EXTS.values().map ? [...JS_EXTS].map(ext => resolvedAbs + ext) : [],
    join(resolvedAbs, 'index.js'),
  ];

  // We don't do filesystem probing here — return the relative specifier as-is
  // (with extension normalisation for common cases)
  let rel = relative(rootDir, resolvedAbs);
  if (!extname(rel) && !rel.endsWith('/')) rel = rel; // keep as-is, may resolve at runtime

  return rel.startsWith('..') ? null : rel; // skip files outside rootDir
}

/**
 * Build a dependency graph from all JS/TS files in `dir`.
 *
 * @param {string} dir  — Root directory to analyse
 * @returns {Promise<{ nodes: string[], edges: Array<{ from: string, to: string }> }>}
 */
export async function buildGraph(dir) {
  const now    = Date.now();
  const cached = _graphCache.get(dir);
  if (cached && now - cached.at < GRAPH_TTL_MS) return cached.graph;

  const files = await findFiles('**/*.{js,mjs,cjs,ts,jsx,tsx}', dir);
  const edges = [];
  const nodes = files.filter(f => !/node_modules|\.mind-server/.test(f));

  for (const file of nodes) {
    let source;
    try { source = await readFile(join(dir, file), 'utf8'); } catch { continue; }

    const imports = extractImports(source);
    for (const specifier of imports) {
      const to = resolveSpecifier(specifier, join(dir, file), dir);
      if (to) edges.push({ from: file, to });
    }
  }

  const graph = { nodes, edges };
  _graphCache.set(dir, { graph, at: now });
  return graph;
}

/**
 * Return files that `file` directly imports.
 * @param {string} file   — Relative file path
 * @param {object} graph  — Result of buildGraph()
 * @returns {string[]}
 */
export function findDependencies(file, graph) {
  return graph.edges.filter(e => e.from === file).map(e => e.to);
}

/**
 * Return files that import `file` (reverse edges).
 * @param {string} file   — Relative file path
 * @param {object} graph  — Result of buildGraph()
 * @returns {string[]}
 */
export function findDependents(file, graph) {
  // Normalise: match by basename or full path
  return graph.edges
    .filter(e => e.to === file || e.to.endsWith('/' + file.replace(/^\.\//, '')))
    .map(e => e.from);
}

/**
 * Detect circular dependency chains in the graph.
 * Returns array of cycles, each as an array of file names.
 * @param {object} graph
 * @returns {string[][]}
 */
export function findCycles(graph) {
  const adj   = new Map();
  for (const { from, to } of graph.edges) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }

  const cycles  = [];
  const visited = new Set();
  const stack   = new Set();

  function dfs(node, path) {
    if (stack.has(node)) {
      const idx = path.indexOf(node);
      cycles.push(path.slice(idx));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const next of adj.get(node) ?? []) {
      dfs(next, [...path, node]);
    }
    stack.delete(node);
  }

  for (const node of adj.keys()) dfs(node, []);
  return cycles;
}

/**
 * Find "God modules" — files with unusually high in-degree (many importers).
 * Returns files sorted by in-degree descending.
 * @param {object} graph
 * @param {number} [threshold=5]  — Minimum in-degree to report
 * @returns {Array<{ file: string, importedBy: number }>}
 */
export function findGodModules(graph, threshold = 5) {
  const inDegree = new Map();
  for (const { to } of graph.edges) {
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  return [...inDegree.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([file, importedBy]) => ({ file, importedBy }));
}
