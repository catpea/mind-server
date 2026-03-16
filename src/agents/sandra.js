/**
 * sandra.js — Sandra, the QA scanner.
 *
 * Role: Scans the project for quality issues and posts findings.
 *
 * What she does each cycle:
 *   1. Reads the project's package.json (if present) to understand structure
 *   2. Checks for common quality signals: missing tests, no README, etc.
 *   3. If npm test script exists, notes it (doesn't run it — that's for CI)
 *   4. Asks Claude to review a sample of source files for code quality
 *   5. Posts findings to r/quality — one post per distinct issue
 *   6. Marks issues as 'done' if she can't find the problem on re-scan
 *
 * When AI not available:
 *   Does structural checks only (package.json fields, file presence, etc.)
 */

import { BaseAgent }                    from './base.js';
import { readFile, readdir, stat }      from 'node:fs/promises';
import { existsSync }                   from 'node:fs';
import { join, extname, relative }      from 'node:path';

export class Sandra extends BaseAgent {
  name        = 'sandra';
  description = 'QA scanner. Finds quality issues in the project and posts findings.';
  avatar      = '🔬';
  role        = 'qa';

  async think(ctx) {
    const { targetDir, board } = ctx;

    // Gather project structure
    const structure = await this.#scanStructure(targetDir);

    // Existing quality posts (to avoid duplicates)
    const existing = await board.getAllPosts({ type: 'quality' }).catch(() => []);
    const openTitles = new Set(existing.filter(p => p.status !== 'done').map(p => p.title));

    return { structure, openTitles };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { structure, openTitles } = plan;
    const actions = [];

    this.log(`scanning ${targetDir}`, ctx);

    const findings = [];

    // ── Structural checks (no AI needed) ───────────────────────────────────

    if (!structure.hasPackageJson) {
      findings.push({ title: 'Missing package.json', body: 'No package.json found. Run `npm init` to initialise the project.', severity: 'warning' });
    } else {
      const pkg = structure.packageJson;
      if (!pkg.description) findings.push({ title: 'package.json missing description', body: 'Add a `description` field to package.json.', severity: 'info' });
      if (!pkg.scripts?.test) findings.push({ title: 'No test script in package.json', body: 'Add a `test` script (e.g. `node --test test/*.test.js`) so the team can run tests.', severity: 'warning' });
      if (!pkg.license) findings.push({ title: 'package.json missing license', body: 'Add a `license` field (e.g. `"MIT"`).', severity: 'info' });
    }

    if (!structure.hasReadme) {
      findings.push({ title: 'Missing README.md', body: 'No README found. Add one describing the project purpose, setup, and usage.', severity: 'warning' });
    }

    if (!structure.hasTests) {
      findings.push({ title: 'No test files found', body: 'No test files detected (looked for test/, tests/, *.test.js). Add tests to verify correctness.', severity: 'warning' });
    }

    // ── AI-powered code review (sample of source files) ────────────────────

    if (ctx.ai.isAvailable() && structure.sourceFiles.length > 0) {
      const sample = structure.sourceFiles.slice(0, 3); // review up to 3 files
      for (const filepath of sample) {
        try {
          const content = await readFile(join(targetDir, filepath), 'utf8');
          if (content.length < 50) continue; // skip trivial files
          const issues = await this.#reviewFile(filepath, content, ctx);
          findings.push(...issues);
        } catch { /* skip unreadable files */ }
      }
    }

    // ── Post new findings ───────────────────────────────────────────────────

    await board.ensureSub('quality');
    let posted = 0;

    for (const finding of findings) {
      if (openTitles.has(finding.title)) continue; // already open
      await board.createPost('quality', {
        title:  finding.title,
        body:   finding.body,
        author: this.name,
        type:   'quality',
        meta:   { severity: finding.severity ?? 'info' },
      });
      this.log(`posted: ${finding.title}`, ctx);
      actions.push({ type: 'posted-finding', title: finding.title });
      posted++;
    }

    if (!posted) this.log('no new issues found', ctx);

    await this.remember('scan', {
      targetDir,
      files:       structure.sourceFiles.length,
      findingsNew: posted,
    });

    return { outcome: posted > 0 ? 'findings-posted' : 'clean', count: posted, actions };
  }

  async #scanStructure(targetDir) {
    const ignore = new Set(['.mind-server', '.git', 'node_modules', 'dist', '.cache', 'coverage']);

    const pkgPath = join(targetDir, 'package.json');
    let packageJson = null;
    if (existsSync(pkgPath)) {
      try { packageJson = JSON.parse(await readFile(pkgPath, 'utf8')); } catch { /* skip */ }
    }

    // Walk top 2 levels
    const sourceExts = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx', '.py']);
    const testPattern = /test|spec/i;
    const sourceFiles = [];
    let   hasTests    = false;
    let   hasReadme   = false;

    async function walk(dir, depth = 0) {
      if (depth > 2) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        const rel = relative(targetDir, join(dir, e.name));
        if (e.isDirectory()) {
          if (testPattern.test(e.name)) hasTests = true;
          await walk(join(dir, e.name), depth + 1);
        } else {
          if (/readme/i.test(e.name)) hasReadme = true;
          if (testPattern.test(e.name) && sourceExts.has(extname(e.name))) hasTests = true;
          if (sourceExts.has(extname(e.name)) && !testPattern.test(e.name)) sourceFiles.push(rel);
        }
      }
    }

    await walk(targetDir);

    return {
      hasPackageJson: !!packageJson,
      packageJson,
      hasReadme,
      hasTests,
      sourceFiles: sourceFiles.slice(0, 20), // cap for performance
    };
  }

  async #reviewFile(filepath, content, ctx) {
    const prompt = `You are Sandra, a code quality scanner reviewing a source file.

File: ${filepath}
Content:
\`\`\`
${content.slice(0, 3000)}
\`\`\`

List any genuine quality issues (bugs, missing error handling, security concerns, anti-patterns).
Ignore style preferences. Only report real problems.

Respond with JSON array (may be empty):
[
  { "title": "Short issue title", "body": "Explanation of the issue and how to fix it.", "severity": "info|warning|error" },
  ...
]`;

    const issues = await ctx.ai.askJSON(prompt, {
      system: 'You are a senior code reviewer. Only report real bugs and problems, not style issues. Reply with JSON only.',
    });
    return Array.isArray(issues) ? issues.slice(0, 3) : []; // cap to 3 per file
  }
}
