/**
 * mallory.js — Mallory, the pentester.
 *
 * Role: Adversarial security tester. Where Bobby hunts code patterns,
 * Mallory thinks like an attacker: she tests authentication, authorization,
 * session handling, secrets management, dependencies, and attack surface.
 *
 * She thinks in threat models:
 *   "What would I do as an attacker? What is the blast radius?"
 *
 * Checks Mallory runs:
 *   - OWASP Top 10 structural review
 *   - Secrets / credentials in source code (hardcoded keys, passwords)
 *   - Dependency audit (reads package.json, flags known-vulnerable patterns)
 *   - Auth/authz review (missing authentication guards)
 *   - HTTP security headers (missing CORS, CSP, HSTS)
 *   - Information disclosure (stack traces, verbose errors in prod)
 *   - Rate limiting and DoS surface
 *
 * All findings go to r/security as posts with threat level: critical/high/medium/low.
 */

import { BaseAgent }               from './base.js';
import { readFile, readdir }       from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join, extname, relative } from 'node:path';
import { SUBS, META }              from '../board-schema.js';

// Patterns that suggest hardcoded secrets
const SECRET_PATTERNS = [
  { regex: /(['"`])(?:sk|pk|api|secret|password|token|key)[-_]?[a-z0-9]{20,}\1/gi, label: 'Hardcoded API key or secret' },
  { regex: /password\s*[:=]\s*['"`][^'"`]{6,}/gi,                                   label: 'Hardcoded password' },
  { regex: /-----BEGIN\s+(?:RSA|EC|OPENSSH|PGP)\s+PRIVATE/g,                        label: 'Private key in source' },
  { regex: /mongodb(?:\+srv)?:\/\/[^@]+:[^@]+@/g,                                   label: 'Database credentials in URI' },
];

export class Mallory extends BaseAgent {
  static priority = 10;
  name        = 'mallory';
  description = 'Pentester. Adversarial security review: secrets, auth, OWASP Top 10, attack surface analysis.';
  avatar      = '🏴‍☠️';
  role        = 'pentester';

  async think(ctx) {
    const { targetDir } = ctx;

    const files = await this.#collectFiles(targetDir);
    return { files, targetDir };
  }

  async act(plan, ctx) {
    const { board }          = ctx;
    const { files, targetDir } = plan;
    const actions            = [];

    await board.ensureSub(SUBS.SECURITY);
    this.log('starting adversarial security review', ctx);

    const findings = [];

    // ── Secret scanning ──────────────────────────────────────────────────────
    for (const f of files.source) {
      try {
        const content = await readFile(f.abs, 'utf8');
        findings.push(...this.#scanSecrets(f.rel, content));
      } catch { /* skip */ }
    }

    // ── Package.json dependency review ───────────────────────────────────────
    const pkgPath = join(targetDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg   = JSON.parse(await readFile(pkgPath, 'utf8'));
        const depFindings = this.#reviewDependencies(pkg);
        findings.push(...depFindings);
      } catch { /* skip */ }
    }

    // ── HTTP server review ───────────────────────────────────────────────────
    for (const f of files.server) {
      try {
        const content = await readFile(f.abs, 'utf8');
        findings.push(...this.#reviewServer(f.rel, content));
      } catch { /* skip */ }
    }

    // ── AI threat model ──────────────────────────────────────────────────────
    if (ctx.ai.isAvailable() && files.source.length > 0) {
      const sample = files.source.slice(0, 2);
      for (const f of sample) {
        const content = await readFile(f.abs, 'utf8').catch(() => '');
        if (content.length < 50) continue;
        const aiFindings = await this.#threatModel(f.rel, content, ctx);
        findings.push(...aiFindings);
      }
    }

    // ── Post new findings ────────────────────────────────────────────────────
    for (const finding of findings) {
      if (await this.findDuplicate(board, SUBS.SECURITY, finding.title)) continue;
      await board.createPost(SUBS.SECURITY, {
        title:  finding.title,
        body:   finding.body,
        author: this.name,
        type:   'quality',
        meta:   { [META.SEVERITY]: finding.severity, [META.THREAT_LEVEL]: finding.threatLevel },
      });
      this.log(`[${finding.threatLevel}] ${finding.title}`, ctx);
      actions.push({ type: 'finding', title: finding.title, level: finding.threatLevel });
    }

    if (!actions.length) this.log('no new security issues found', ctx);
    return { outcome: actions.length ? 'findings-posted' : 'clean', count: actions.length, actions };
  }

  #scanSecrets(filepath, content) {
    const findings = [];
    for (const { regex, label } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        const lineNo = (() => {
          regex.lastIndex = 0;
          const m = regex.exec(content);
          return m ? content.slice(0, m.index).split('\n').length : '?';
        })();
        findings.push({
          title:       `[SECRET] ${label} in ${filepath}`,
          body:        `A hardcoded secret was found at \`${filepath}:${lineNo}\`.\n\n**Threat:** Any developer with repo access has these credentials. If the repo is public, the secret is compromised.\n\n**Fix:** Move to environment variables. Add the file pattern to \`.gitignore\`. Rotate the exposed credentials immediately.`,
          severity:    'error',
          threatLevel: 'critical',
        });
      }
    }
    return findings;
  }

  #reviewDependencies(pkg) {
    const findings = [];
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Flag absence of lockfile awareness
    if (!pkg.engines?.node) {
      findings.push({
        title:       '[DEP] No Node.js engine constraint in package.json',
        body:        'Specifying `engines.node` prevents accidental deployment on incompatible Node versions.\n\n**Fix:** Add `"engines": { "node": ">=18.0.0" }` to package.json.',
        severity:    'info',
        threatLevel: 'low',
      });
    }

    // Check for known-risky patterns (not exact CVE lookup — just hygiene)
    if (deps['serialize-javascript'] === undefined && deps['node-serialize']) {
      findings.push({
        title:       '[DEP] node-serialize is known vulnerable (RCE via deserialization)',
        body:        '`node-serialize` has a known Remote Code Execution vulnerability (CVE-2017-5941).\n\n**Fix:** Remove it immediately. Use JSON.parse() for safe data or a maintained alternative.',
        severity:    'error',
        threatLevel: 'critical',
      });
    }

    return findings;
  }

  #reviewServer(filepath, content) {
    const findings = [];

    if (!content.includes('helmet') && !content.includes('Content-Security-Policy') && content.includes('createServer')) {
      findings.push({
        title:       `[HEADERS] Missing HTTP security headers in ${filepath}`,
        body:        'No security headers detected (CSP, HSTS, X-Frame-Options, etc.).\n\n**Fix:** Add security headers. For Node.js HTTP: set them in your response handler. For Express: use `helmet`.',
        severity:    'warning',
        threatLevel: 'medium',
      });
    }

    if (content.match(/err\.stack|error\.stack/) && !content.match(/NODE_ENV.*production/)) {
      findings.push({
        title:       `[DISCLOSURE] Stack trace exposure in ${filepath}`,
        body:        'Stack traces may be sent to clients. This reveals internal structure to attackers.\n\n**Fix:** Only log stack traces server-side. Return generic error messages to clients in production.',
        severity:    'warning',
        threatLevel: 'medium',
      });
    }

    return findings;
  }

  async #threatModel(filepath, content, ctx) {
    const result = await ctx.ai.askJSON(
      `You are Mallory, an adversarial penetration tester.
Think like an attacker. Analyse this file for security weaknesses beyond simple injection:
authentication gaps, authorization flaws, session issues, information disclosure,
insecure defaults, missing input validation, business logic vulnerabilities.

File: ${filepath}
\`\`\`
${content.slice(0, 3000)}
\`\`\`

Respond with a JSON array (may be empty):
[{ "title": "Short issue title", "body": "Threat description + attack scenario + fix", "severity": "error|warning", "threatLevel": "critical|high|medium|low" }]`,
      { system: 'You are an adversarial security tester. Think like an attacker. Reply with JSON only.' }
    );
    return Array.isArray(result) ? result.slice(0, 4) : [];
  }

  async #collectFiles(targetDir) {
    const sourceExts = new Set(['.js', '.mjs', '.ts', '.py']);
    const ignore     = new Set(['.mind-server', '.git', 'node_modules', 'dist']);
    const source     = [];
    const server     = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
        if (!sourceExts.has(extname(e.name))) continue;
        const f = { abs: join(dir, e.name), rel: relative(targetDir, join(dir, e.name)) };
        source.push(f);
        if (/server|app|index|main/i.test(e.name)) server.push(f);
      }
    }

    await walk(targetDir);
    return { source: source.slice(0, 15), server: server.slice(0, 5) };
  }
}
