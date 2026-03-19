/**
 * tools/coverage.js — Test coverage map for a project.
 *
 * Scans source files and test files, then builds a mapping of which source
 * files have test companions. Does NOT run tests — this is purely static
 * analysis of file naming conventions and import relationships.
 *
 * Coverage conventions recognised:
 *   src/auth.js         → test/auth.test.js    (same name, .test. inserted)
 *   src/auth.js         → test/auth.spec.js    (.spec. variant)
 *   src/auth.js         → tests/auth.test.js   (plural tests/ dir)
 *   src/board.js        → test/board.test.js
 *
 * Usage:
 *   const map = await buildCoverageMap(targetDir);
 *   // map.covered   → [{ source, tests: [testFile] }]
 *   // map.uncovered → [sourceFile]
 *   // map.pct       → 0..100
 */

import { readFile }          from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { existsSync }        from 'node:fs';
import { findFiles }         from './search.js';

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
const TEST_DIRS   = ['test', 'tests', '__tests__', 'spec'];
const TEST_SUFFIXES = ['.test.js', '.test.mjs', '.test.ts', '.spec.js', '.spec.mjs', '.spec.ts'];

/**
 * Build a static coverage map for a project directory.
 *
 * @param {string} dir  — Project root
 * @returns {Promise<{
 *   covered:   Array<{ source: string, tests: string[] }>,
 *   uncovered: string[],
 *   total:     number,
 *   pct:       number,
 * }>}
 */
export async function buildCoverageMap(dir) {
  const allFiles = await findFiles('**/*', dir);

  const TEST_PAT = /test|spec|__tests__/i;

  // Separate source files from test files
  const sourceFiles = allFiles.filter(f =>
    SOURCE_EXTS.has(extname(f)) &&
    !TEST_PAT.test(f) &&
    !/node_modules|\.mind-server|dist/.test(f)
  );

  const testFiles = allFiles.filter(f =>
    SOURCE_EXTS.has(extname(f)) &&
    TEST_PAT.test(f) &&
    !/node_modules|\.mind-server|dist/.test(f)
  );

  // Build a lookup: base name → test files that cover it
  // e.g. 'board' → ['test/board.test.js']
  const byBase = new Map();
  for (const tf of testFiles) {
    const name = basename(tf);
    // Strip test suffix to get the base name
    const base = name
      .replace(/\.(test|spec)\.(js|mjs|cjs|ts|jsx|tsx)$/, '')
      .replace(/\.(js|mjs|cjs|ts|jsx|tsx)$/, '');
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(tf);
  }

  // Also check by reading test file imports — more accurate but slower
  const importMap = new Map(); // sourceBase → [testFile]
  for (const tf of testFiles.slice(0, 50)) { // cap for perf
    try {
      const src = await readFile(join(dir, tf), 'utf8');
      // Extract relative imports
      const imports = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
      for (const imp of imports) {
        const base = basename(imp).replace(/\.(js|mjs|cjs|ts|jsx|tsx)$/, '');
        if (!importMap.has(base)) importMap.set(base, []);
        if (!importMap.get(base).includes(tf)) importMap.get(base).push(tf);
      }
    } catch { /* skip */ }
  }

  const covered   = [];
  const uncovered = [];

  for (const sf of sourceFiles) {
    const base  = basename(sf).replace(/\.(js|mjs|cjs|ts|jsx|tsx)$/, '');
    const tests = [
      ...(byBase.get(base) ?? []),
      ...(importMap.get(base) ?? []),
    ];
    const unique = [...new Set(tests)];

    // Also look for companion test file by path pattern
    for (const testDir of TEST_DIRS) {
      for (const suffix of TEST_SUFFIXES) {
        const candidate = join(testDir, base + suffix);
        if (existsSync(join(dir, candidate)) && !unique.includes(candidate)) {
          unique.push(candidate);
        }
      }
    }

    if (unique.length > 0) {
      covered.push({ source: sf, tests: unique });
    } else {
      uncovered.push(sf);
    }
  }

  const total = covered.length + uncovered.length;
  const pct   = total > 0 ? Math.round((covered.length / total) * 100) : 0;

  return { covered, uncovered, total, pct };
}
