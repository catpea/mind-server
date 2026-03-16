/**
 * angela.js — Angela, the Security Engineer.
 *
 * Role: Defensive security posture. Where Mallory attacks and Bobby hunts
 * injections, Angela builds the defences: security policies, dependency
 * health, incident response readiness, and secure defaults.
 *
 * What she does:
 *   - Audits dependencies for known vulnerabilities (npm audit patterns)
 *   - Reviews authentication implementation for missing controls
 *   - Checks cryptography usage (weak algos, improper randomness)
 *   - Validates input sanitisation at API boundaries
 *   - Posts security policy recommendations to r/security
 *   - DMs Kimberly when she finds critical unaddressed findings
 *
 * Without AI: rule-based checks on crypto, auth, input patterns.
 * With AI:    comprehensive security architecture review.
 */

import { BaseAgent }               from './base.js';
import { readFile, readdir }       from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join, extname, relative } from 'node:path';

// Cryptographic anti-patterns
const CRYPTO_PATTERNS = [
  { regex: /createCipher(?!iv)\s*\(/g,                      label: 'Deprecated createCipher() — use createCipheriv()' },
  { regex: /md5|sha1(?!\s*\d)/gi,                           label: 'Weak hash algorithm (MD5/SHA-1) — use SHA-256+' },
  { regex: /Math\.random\s*\(\)/g,                          label: 'Math.random() for security — use crypto.randomBytes()' },
  { regex: /AES-?128-?ECB|DES(?:-CBC)?/gi,                  label: 'Weak cipher mode — use AES-256-GCM' },
];

export class Angela extends BaseAgent {
  name        = 'angela';
  description = 'Security Engineer. Defensive posture: auth controls, crypto hygiene, input validation, dependency health.';
  avatar      = '🛡';
  role        = 'security-engineer';

  async think(ctx) {
    const { targetDir, board } = ctx;

    const files    = await this.#collectFiles(targetDir);
    const existing = (await board.getPosts('security').catch(() => []))
      .filter(p => p.status !== 'done' && p.author === this.name)
      .map(p => p.title);

    // Read package.json for dependency analysis
    let pkg = null;
    const pkgPath = join(targetDir, 'package.json');
    if (existsSync(pkgPath)) {
      try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); } catch { /* skip */ }
    }

    return { files, existing, pkg, targetDir };
  }

  async act(plan, ctx) {
    const { board }                    = ctx;
    const { files, existing, pkg, targetDir } = plan;
    const actions                      = [];

    await board.ensureSub('security');
    this.log('running defensive security review', ctx);

    const findings = [];

    // ── Cryptography review ───────────────────────────────────────────────────
    for (const f of files.source) {
      try {
        const content = await readFile(f.abs, 'utf8');
        findings.push(...this.#cryptoReview(f.rel, content));
        findings.push(...this.#authReview(f.rel, content));
        findings.push(...this.#inputValidation(f.rel, content));
      } catch { /* skip */ }
    }

    // ── Dependency hygiene ────────────────────────────────────────────────────
    if (pkg) findings.push(...this.#depHygiene(pkg));

    // ── Security policy check ─────────────────────────────────────────────────
    findings.push(...this.#policyCheck(targetDir));

    // ── AI security architecture review ──────────────────────────────────────
    if (ctx.ai.isAvailable() && files.source.length > 0) {
      const sample = files.auth.length > 0 ? files.auth : files.source.slice(0, 2);
      for (const f of sample.slice(0, 2)) {
        const content = await readFile(f.abs, 'utf8').catch(() => '');
        if (content.length < 50) continue;
        const aiFindings = await this.#aiSecurityReview(f.rel, content, ctx);
        findings.push(...aiFindings);
      }
    }

    // ── Post new findings ─────────────────────────────────────────────────────
    const seen = new Set(existing);
    for (const finding of findings) {
      if (seen.has(finding.title)) continue;
      seen.add(finding.title);
      await board.createPost('security', {
        title:  finding.title,
        body:   finding.body,
        author: this.name,
        type:   'quality',
        meta:   { severity: finding.severity, threatLevel: finding.threatLevel },
      });
      this.log(`[${finding.threatLevel}] ${finding.title}`, ctx);
      actions.push({ type: 'finding', title: finding.title, level: finding.threatLevel });
    }

    // ── DM Kimberly on critical findings ─────────────────────────────────────
    const critical = actions.filter(a => a.level === 'critical');
    if (critical.length > 0) {
      await ctx.board.createPost('u/kimberly', {
        title:  `🛡 Angela: ${critical.length} critical security finding(s) need attention`,
        body:   critical.map(a => `- ${a.title}`).join('\n'),
        author: this.name,
        type:   'dm',
      }).catch(() => {});
    }

    if (!actions.length) this.log('security posture looks healthy — idle', ctx);
    return { outcome: actions.length ? 'findings-posted' : 'clean', count: actions.length, actions };
  }

  #cryptoReview(filepath, content) {
    const findings = [];
    for (const { regex, label } of CRYPTO_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        findings.push({
          title:       `[CRYPTO] ${label} in ${filepath}`,
          body:        `Insecure cryptography detected in \`${filepath}\`.\n\n**Issue:** ${label}\n\n**Fix:** Use modern, secure defaults: AES-256-GCM for encryption, SHA-256+ for hashing, \`crypto.randomBytes()\` for random values.`,
          severity:    'warning',
          threatLevel: 'high',
        });
      }
    }
    return findings;
  }

  #authReview(filepath, content) {
    const findings = [];

    // JWT without verification
    if (content.includes('jwt') || content.includes('jsonwebtoken')) {
      if (content.includes('verify') === false && content.includes('decode')) {
        findings.push({
          title:       `[AUTH] JWT decoded without verification in ${filepath}`,
          body:        `\`jwt.decode()\` skips signature verification — any token will be accepted, including forged ones.\n\n**Fix:** Always use \`jwt.verify(token, secret)\` instead of \`jwt.decode()\`.`,
          severity:    'error',
          threatLevel: 'critical',
        });
      }
    }

    // Session without secure flags
    if (/session\s*\(\s*\{/.test(content) && !content.includes('secure: true') && !content.includes('httpOnly: true')) {
      findings.push({
        title:       `[AUTH] Session cookies missing secure flags in ${filepath}`,
        body:        `Session middleware configured without \`secure\` and \`httpOnly\` flags. Cookies can be read by JavaScript or sent over HTTP.\n\n**Fix:**\n\`\`\`js\napp.use(session({ cookie: { secure: true, httpOnly: true, sameSite: 'strict' } }))\n\`\`\``,
        severity:    'warning',
        threatLevel: 'high',
      });
    }

    return findings;
  }

  #inputValidation(filepath, content) {
    const findings = [];

    // JSON.parse without try/catch on request body
    if (/JSON\.parse\s*\(req\.body\)/.test(content)) {
      findings.push({
        title:       `[INPUT] Unguarded JSON.parse of request body in ${filepath}`,
        body:        `\`JSON.parse(req.body)\` without a try/catch will crash the server on malformed input.\n\n**Fix:** Wrap in try/catch or use a body-parser middleware that handles errors gracefully.`,
        severity:    'warning',
        threatLevel: 'medium',
      });
    }

    return findings;
  }

  #depHygiene(pkg) {
    const findings = [];
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Check for known-problematic packages
    const risky = {
      'node-serialize': 'RCE via unsafe deserialization (CVE-2017-5941)',
      'serialize-javascript': 'XSS via unsafe serialization in older versions',
      'lodash': 'Prototype pollution in versions < 4.17.21',
      'minimist': 'Prototype pollution in versions < 1.2.6',
    };

    for (const [dep, risk] of Object.entries(risky)) {
      if (deps[dep] !== undefined) {
        findings.push({
          title:       `[DEP] Review ${dep} — ${risk}`,
          body:        `\`${dep}\` has known security issues: ${risk}.\n\n**Fix:** Ensure you are on the latest patched version, or replace with a maintained alternative. Run \`npm audit\` for CVE details.`,
          severity:    'warning',
          threatLevel: 'medium',
        });
      }
    }

    return findings;
  }

  #policyCheck(targetDir) {
    const findings = [];

    if (!existsSync(join(targetDir, 'SECURITY.md')) &&
        !existsSync(join(targetDir, '.github', 'SECURITY.md'))) {
      findings.push({
        title:       '[POLICY] No SECURITY.md — missing vulnerability disclosure policy',
        body:        'There is no `SECURITY.md` file. Security researchers and users need to know how to report vulnerabilities responsibly.\n\n**Fix:** Create `SECURITY.md` with:\n- How to report a vulnerability (email, private issue)\n- Expected response time\n- Which versions are supported',
        severity:    'info',
        threatLevel: 'low',
      });
    }

    return findings;
  }

  async #aiSecurityReview(filepath, content, ctx) {
    const result = await ctx.ai.askJSON(
      `You are Angela, a defensive security engineer reviewing code for security architecture issues.

Focus on: authentication gaps, missing authorisation checks, insecure defaults, broken access control, unsafe cryptography, input validation gaps.

File: ${filepath}
\`\`\`
${content.slice(0, 3000)}
\`\`\`

Respond with a JSON array (may be empty):
[{ "title": "[SEC] Short issue title", "body": "Description + attack scenario + fix", "severity": "error|warning|info", "threatLevel": "critical|high|medium|low" }]`,
      { system: 'You are a security engineer doing a defensive review. Be concise. Reply with JSON only.' }
    );
    return Array.isArray(result) ? result.slice(0, 3) : [];
  }

  async #collectFiles(targetDir) {
    const sourceExts = new Set(['.js', '.mjs', '.ts']);
    const ignore     = new Set(['.mind-server', '.git', 'node_modules', 'dist']);
    const source     = [];
    const auth       = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
        if (!sourceExts.has(extname(e.name))) continue;
        const f = { abs: join(dir, e.name), rel: relative(targetDir, join(dir, e.name)) };
        source.push(f);
        if (/auth|session|login|token|jwt|passport/i.test(e.name)) auth.push(f);
      }
    }

    await walk(targetDir);
    return { source: source.slice(0, 15), auth: auth.slice(0, 5) };
  }
}
