/**
 * danielle.js — Danielle, the DevOps/SRE Engineer.
 *
 * Role: Keeps the project deployable, observable, and resilient.
 * Danielle doesn't just ship features — she makes sure they stay up.
 *
 * What she does:
 *   - Checks for CI/CD configuration (GitHub Actions, Dockerfile, etc.)
 *   - Flags missing health checks, graceful shutdown, and process management
 *   - Reviews environment variable usage (config vs secrets hygiene)
 *   - Checks for logging best practices (structured logs, log levels)
 *   - Ensures there's a way to run the project in production vs dev
 *   - Posts operational runbooks to r/ops
 *
 * Without AI: structural checks — missing files, missing scripts.
 * With AI:    operational review — deployment readiness, failure modes.
 */

import { BaseAgent }               from './base.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join, extname }          from 'node:path';
import { SUBS, META, SEVERITY }   from '../board-schema.js';

const OPS_SIGNALS = [
  { file: 'Dockerfile',              label: 'Dockerfile',          severity: 'warning' },
  { file: '.github/workflows',       label: 'GitHub Actions CI/CD', severity: 'info'    },
  { file: 'docker-compose.yml',      label: 'docker-compose',       severity: 'info'    },
  { file: 'docker-compose.yaml',     label: 'docker-compose',       severity: 'info'    },
  { file: '.env.example',            label: '.env.example',         severity: 'info'    },
  { file: 'ecosystem.config.js',     label: 'PM2 ecosystem config', severity: 'info'    },
  { file: 'ecosystem.config.cjs',    label: 'PM2 ecosystem config', severity: 'info'    },
];

export class Danielle extends BaseAgent {
  static priority = 12;
  name        = 'danielle';
  description = 'DevOps/SRE. Deployment readiness, CI/CD, observability, operational hygiene.';
  avatar      = '🚀';
  role        = 'devops-sre';

  async think(ctx) {
    const { targetDir } = ctx;

    // What infrastructure files exist?
    const infraFound = [];
    const infraMissing = [];
    for (const sig of OPS_SIGNALS) {
      const abs = join(targetDir, sig.file);
      if (existsSync(abs)) {
        infraFound.push(sig);
      } else {
        infraMissing.push(sig);
      }
    }

    // Read package.json for scripts
    let pkg = null;
    const pkgPath = join(targetDir, 'package.json');
    if (existsSync(pkgPath)) {
      try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); } catch { /* skip */ }
    }

    // Scan source files for env/logging patterns
    const sourceFiles = await this.#collectFiles(targetDir);

    return { infraFound, infraMissing, pkg, sourceFiles, targetDir };
  }

  async act(plan, ctx) {
    const { board }                                             = ctx;
    const { infraFound, infraMissing, pkg, sourceFiles, targetDir } = plan;
    const actions                                              = [];

    await board.ensureSub(SUBS.OPS);
    this.log('checking deployment readiness', ctx);

    const findings = [];

    // ── Missing scripts in package.json ──────────────────────────────────────
    if (pkg) {
      const scripts = pkg.scripts ?? {};
      if (!scripts.start) {
        findings.push({
          title:    '[OPS] No "start" script in package.json',
          body:     'Production deployments need `npm start`. Without it, process managers (PM2, Heroku, Railway) cannot start the app.\n\n**Fix:** Add `"start": "node server.js"` (or your entry point) to `scripts` in package.json.',
          severity: 'warning',
        });
      }
      if (!scripts.test) {
        findings.push({
          title:    '[OPS] No "test" script in package.json',
          body:     'CI pipelines need `npm test` to gate deployments on test results.\n\n**Fix:** Add `"test": "node --test test/*.test.js"` or equivalent.',
          severity: 'info',
        });
      }
    }

    // ── Missing Dockerfile ────────────────────────────────────────────────────
    if (infraMissing.some(f => f.file === 'Dockerfile') && infraMissing.some(f => f.file === 'docker-compose.yml')) {
      findings.push({
        title:    '[OPS] No container configuration found',
        body:     'No Dockerfile or docker-compose.yml detected. Containerising the app makes deployment portable and reproducible.\n\n**Fix:** Create a minimal Dockerfile:\n```\nFROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n```',
        severity: 'info',
      });
    }

    // ── Missing .env.example ─────────────────────────────────────────────────
    if (infraMissing.some(f => f.file === '.env.example')) {
      findings.push({
        title:    '[OPS] No .env.example file',
        body:     'New developers and CI environments need a list of required environment variables.\n\n**Fix:** Create `.env.example` with all required env var names (no values for secrets):\n```\nPORT=3001\nANTHROPIC_API_KEY=\nNODE_ENV=production\n```',
        severity: 'info',
      });
    }

    // ── Source file reviews ───────────────────────────────────────────────────
    for (const f of sourceFiles.slice(0, 3)) {
      try {
        const content = await readFile(f.abs, 'utf8');
        findings.push(...this.#reviewFile(f.rel, content));
      } catch { /* skip */ }
    }

    // ── Start check: does the project actually start? ─────────────────────────
    if (pkg?.scripts?.start) {
      const startResult = await this.#checkProjectStarts(ctx);
      if (startResult) findings.push(startResult);
    }

    // ── AI operational review ─────────────────────────────────────────────────
    if (ctx.ai.isAvailable() && pkg) {
      const aiFindings = await this.#aiOpsReview(pkg, infraFound, infraMissing, sourceFiles, ctx);
      findings.push(...aiFindings);
    }

    // ── Post new findings ─────────────────────────────────────────────────────
    for (const f of findings) {
      if (await this.findDuplicate(board, SUBS.OPS, f.title)) continue;
      await board.createPost(SUBS.OPS, {
        title:  f.title,
        body:   f.body,
        author: this.name,
        type:   'quality',
        meta:   { [META.SEVERITY]: f.severity },
      });
      this.log(`[ops] ${f.title}`, ctx);
      actions.push({ type: 'finding', title: f.title });
    }

    if (!actions.length) this.log('deployment posture looks healthy — idle', ctx);
    return { outcome: actions.length ? 'findings-posted' : 'clean', count: actions.length, actions };
  }

  #reviewFile(filepath, content) {
    const findings = [];

    // Check for process signal handling (graceful shutdown)
    const hasServer = /createServer|listen\s*\(/.test(content);
    const hasSigterm = /SIGTERM|SIGINT/.test(content);
    if (hasServer && !hasSigterm) {
      findings.push({
        title:    `[OPS] No graceful shutdown in ${filepath}`,
        body:     `The server in \`${filepath}\` does not handle SIGTERM/SIGINT. Process managers send SIGTERM before killing a process — without a handler, in-flight requests are dropped.\n\n**Fix:**\n\`\`\`js\nprocess.on('SIGTERM', () => { server.close(() => process.exit(0)); });\n\`\`\``,
        severity: 'warning',
      });
    }

    // Check for hard-coded ports
    if (/listen\s*\(\s*\d{4,5}[^,)]/.test(content)) {
      findings.push({
        title:    `[OPS] Hard-coded port in ${filepath}`,
        body:     `Port number is hard-coded. Deployment environments (Heroku, Railway, containers) assign ports via \`PORT\` env var.\n\n**Fix:** \`server.listen(process.env.PORT ?? 3001)\``,
        severity: 'info',
      });
    }

    return findings;
  }

  async #aiOpsReview(pkg, infraFound, infraMissing, sourceFiles, ctx) {
    const result = await ctx.ai.askJSON(
      `You are Danielle, a DevOps/SRE engineer reviewing a project for production readiness.

package.json scripts: ${JSON.stringify(pkg.scripts ?? {})}
Infrastructure found: ${infraFound.map(f => f.label).join(', ') || 'none'}
Infrastructure missing: ${infraMissing.map(f => f.label).join(', ') || 'none'}
Source files: ${sourceFiles.map(f => f.rel).join(', ')}

Review for production readiness concerns:
- Observability (logging, health checks)
- Resilience (retry, timeout, circuit breaker)
- Secrets management
- Deployment automation gaps

Respond with a JSON array (may be empty):
[{ "title": "[OPS] Short issue title", "body": "Description + fix", "severity": "warning|info" }]`,
      { system: 'You are a senior SRE. Focus on operational risk. Reply with JSON only.' }
    );
    return Array.isArray(result) ? result.slice(0, 3) : [];
  }

  /**
   * Try to start the project with a 5-second timeout. If it crashes immediately
   * (exit code non-zero before timeout), report it as an ops finding.
   * If it's still running at timeout, that's healthy — kill and report OK.
   */
  async #checkProjectStarts(ctx) {
    const result = await ctx.tools.shell('npm start', { timeout: 5_000 });

    // If the process exited (not a timeout kill) with non-zero code — it crashed
    if (!result.ok && result.code !== null) {
      return {
        title:    '[OPS] Project fails to start',
        body:     `\`npm start\` exited with code ${result.code} within 5 seconds.\n\n\`\`\`\n${(result.stderr || result.stdout).slice(0, 1000)}\n\`\`\`\n\n**Fix:** Investigate the startup error above.`,
        severity: 'error',
      };
    }
    // Timeout (code === null, process killed) means it ran — good
    return null;
  }

  async #collectFiles(targetDir) {
    const exts   = new Set(['.js', '.mjs', '.ts']);
    const ignore = new Set(['.mind-server', '.git', 'node_modules', 'dist', 'test', 'tests']);
    const files  = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
        if (exts.has(extname(e.name))) {
          files.push({ abs: join(dir, e.name), rel: e.name });
        }
      }
    }

    await walk(targetDir);
    return files.slice(0, 10);
  }
}
