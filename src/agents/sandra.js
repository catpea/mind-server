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
import { readFile }                     from 'node:fs/promises';
import { existsSync }                   from 'node:fs';
import { join }                         from 'node:path';
import { SUBS, META, SEVERITY }         from '../board-schema.js';
import { PERSONAS }                     from './personas.js';

export class Sandra extends BaseAgent {
  static priority = 7;
  name        = 'sandra';
  description = 'QA scanner. Finds quality issues in the project and posts findings.';
  avatar      = '🔬';
  role        = 'qa';

  async think(ctx) {
    const { targetDir } = ctx;

    // Gather project structure (uses search tool for intelligent file sampling)
    const structure = await this.#scanStructure(ctx);

    // Test coverage map
    const coverage = await ctx.tools.buildCoverageMap().catch(() => null);

    // Read linter report from bin/linter.js if present (application-magic specific rules)
    const linterFindings = await this.#readLinterReport(targetDir);

    return { structure, coverage, linterFindings };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { structure, coverage, linterFindings } = plan;
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

    // ── npm audit — security vulnerabilities in dependencies ───────────────
    const pkgPath = join(targetDir, 'package.json');
    if (existsSync(pkgPath)) {
      const auditResult = await ctx.tools.shell('npm audit --json', { timeout: 30_000 });
      if (auditResult.stdout) {
        try {
          const audit = JSON.parse(auditResult.stdout);
          const vulnCount = audit.metadata?.vulnerabilities;
          if (vulnCount) {
            const high   = (vulnCount.high ?? 0) + (vulnCount.critical ?? 0);
            const total  = Object.values(vulnCount).reduce((s, n) => s + (n ?? 0), 0);
            if (total > 0) {
              findings.push({
                title:    `npm audit: ${total} vulnerabilit${total === 1 ? 'y' : 'ies'} (${high} high/critical)`,
                body:     `\`npm audit\` found ${total} vulnerabilities:\n\`\`\`\n${JSON.stringify(vulnCount, null, 2)}\n\`\`\`\n\n**Fix:** Run \`npm audit fix\` for automatic fixes, or \`npm audit fix --force\` for breaking changes.`,
                severity: high > 0 ? SEVERITY.ERROR : SEVERITY.WARNING,
              });
            }
          }
        } catch { /* audit JSON malformed — skip */ }
      }
    }

    // ── Test coverage report ────────────────────────────────────────────────
    if (coverage && coverage.total > 0) {
      const label = `Test coverage: ${coverage.pct}% (${coverage.covered.length}/${coverage.total} files)`;
      if (coverage.pct < 50) {
        findings.push({
          title:    `[QA] Low test coverage — ${coverage.pct}%`,
          body:     `${label}\n\nUntested files (${coverage.uncovered.length} total):\n${coverage.uncovered.slice(0, 8).map(f => `- \`${f}\``).join('\n')}\n\nPrioritise testing files with complex logic or error paths.`,
          severity: SEVERITY.WARNING,
        });
      }
      this.log(label, ctx);
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

    // ── Findings from bin/linter.js report ─────────────────────────────────
    // These are application-magic-specific package hygiene rules (PKG001-006, WC001-002).
    // The report is written by: node bin/linter.js --report <targetDir>

    if (linterFindings.length > 0) {
      this.log(`merging ${linterFindings.length} findings from linter report`, ctx);
      findings.push(...linterFindings);
    }

    // ── Post new findings ───────────────────────────────────────────────────

    await board.ensureSub(SUBS.QUALITY);
    let posted = 0;

    for (const finding of findings) {
      if (await this.findDuplicate(board, SUBS.QUALITY, finding.title)) continue;
      await board.createPost(SUBS.QUALITY, {
        title:  finding.title,
        body:   finding.body,
        author: this.name,
        type:   'quality',
        meta:   { [META.SEVERITY]: finding.severity ?? SEVERITY.INFO },
      });
      this.log(`posted: ${finding.title}`, ctx);
      actions.push({ type: 'posted-finding', title: finding.title });
      posted++;
    }

    if (!posted) this.log('no new issues found', ctx);

    await this.remember('scan', {
      targetDir,
      files:       structure.sourceFiles.length,
      coveragePct: coverage?.pct ?? null,
      findingsNew: posted,
    });

    return { outcome: posted > 0 ? 'findings-posted' : 'clean', count: posted, actions };
  }

  async #scanStructure(ctx) {
    const { targetDir, tools } = ctx;

    const pkgPath = join(targetDir, 'package.json');
    let packageJson = null;
    if (existsSync(pkgPath)) {
      try { packageJson = JSON.parse(await readFile(pkgPath, 'utf8')); } catch { /* skip */ }
    }

    // Use search tool to discover files — excludes node_modules/.git automatically
    const allFiles    = await tools.findFiles('**/*');
    const testPattern = /test|spec/i;

    const hasReadme   = allFiles.some(f => /readme/i.test(f));
    const hasTests    = allFiles.some(f => testPattern.test(f) && /\.(js|mjs|ts)$/.test(f));

    // Source files: non-test JS/TS files (not from test dirs)
    const sourceFiles = allFiles
      .filter(f => /\.(js|mjs|ts|jsx|tsx|py)$/.test(f) && !testPattern.test(f))
      .slice(0, 20);

    return {
      hasPackageJson: !!packageJson,
      packageJson,
      hasReadme,
      hasTests,
      sourceFiles,
    };
  }

  async #readLinterReport(targetDir) {
    const reportPath = join(targetDir, '.mind-server', 'linter-report.json');
    if (!existsSync(reportPath)) return [];
    try {
      const raw    = await readFile(reportPath, 'utf8');
      const report = JSON.parse(raw);
      if (!Array.isArray(report.issues)) return [];

      // Convert linter issue shape → Sandra finding shape
      // Group by pkg so we don't flood r/quality with one post per micro-issue;
      // instead emit one post per (pkg, id) pair — same granularity as the browser linter.
      return report.issues.map(issue => ({
        title:    `${issue.pkg}@${issue.version} — ${issue.id}`,
        body:     [
          `**Package:** \`${issue.pkg}\` (v${issue.version})`,
          `**Rule:** ${issue.id}`,
          `**Severity:** ${issue.severity}`,
          ``,
          issue.message,
          issue.blocked ? `\n> ⚠️ Blocked by: **${issue.blocked}**` : '',
          issue.fixable ? `\n> 🔧 Auto-fixable` : '',
          ``,
          `*Reported by \`bin/linter.js\` — ${report.generated}*`,
        ].filter(l => l !== '').join('\n'),
        severity: issue.severity,
      }));
    } catch {
      return [];
    }
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

    const issues = await ctx.ai.askJSON(prompt, { system: PERSONAS.sandra });
    return Array.isArray(issues) ? issues.slice(0, 3) : []; // cap to 3 per file
  }
}
