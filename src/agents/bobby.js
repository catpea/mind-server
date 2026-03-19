/**
 * bobby.js — Bobby, the code injection specialist.
 *
 * Role: Hunts injection vulnerabilities in source code. Bobby specialises in
 * finding places where user input reaches dangerous sinks: shell commands,
 * SQL queries, HTML rendering, eval(), path traversal, and prototype pollution.
 *
 * She is adversarial-but-constructive: she finds the holes and posts them
 * with precise file/line references and concrete remediation steps.
 *
 * Vulnerability classes Bobby covers:
 *   - Command injection  (exec/spawn with user input)
 *   - SQL injection      (string-built queries)
 *   - XSS               (innerHTML/document.write with user data)
 *   - Path traversal     (fs operations with user-supplied paths)
 *   - Prototype pollution (merge/assign of untrusted objects)
 *   - eval / Function()  (dynamic code execution)
 *   - SSRF              (fetch/http with user-controlled URL)
 *
 * Without AI: pattern-matches source code against known dangerous patterns.
 * With AI:    does deeper taint analysis to find subtle injection paths.
 */

import { BaseAgent }               from './base.js';
import { readFile }                from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join }                    from 'node:path';
import { homedir }                 from 'node:os';
import { SUBS, META }              from '../board-schema.js';
import { PERSONAS }                from './personas.js';
import { Knowledge }               from '../knowledge.js';

// ── Dangerous pattern catalogue ────────────────────────────────────────────────

const PATTERNS = [
  { id: 'CMD-INJ',  label: 'Command Injection',   regex: /exec\s*\(\s*[`'"].*\$\{|execSync\s*\(\s*[`'"]/g,             severity: 'error'   },
  { id: 'EVAL',     label: 'eval() / new Function', regex: /\beval\s*\(|\bnew\s+Function\s*\(/g,                         severity: 'error'   },
  { id: 'XSS',      label: 'Potential XSS',         regex: /\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/g,      severity: 'error'   },
  { id: 'PATH-TRV', label: 'Path Traversal',         regex: /readFile[Sync]?\s*\([^)]*req\.|join\s*\([^)]*req\./g,       severity: 'warning' },
  { id: 'SQLI',     label: 'SQL Injection',          regex: /query\s*\(\s*[`'"]\s*SELECT.*\$\{|[`'"]\s*INSERT.*\$\{/g,  severity: 'error'   },
  { id: 'PROTO',    label: 'Prototype Pollution',    regex: /\[['"]__proto__['"]\]|\[['"]constructor['"]\]/g,             severity: 'error'   },
  { id: 'SSRF',     label: 'SSRF / Open Redirect',   regex: /fetch\s*\(\s*req\.|fetch\s*\(\s*[^'"]\w+[^'"]\)/g,         severity: 'warning' },
  { id: 'REDIR',    label: 'Open Redirect',          regex: /res\.redirect\s*\([^'")\s]*req\./g,                         severity: 'warning' },
];

export class Bobby extends BaseAgent {
  static priority = 9;
  name        = 'bobby';
  description = 'Injection specialist. Hunts command, SQL, XSS, path-traversal, and eval vulnerabilities in source code.';
  avatar      = '💉';
  role        = 'security-injection';

  #kb = new Knowledge(homedir());

  skills = {
    scanFile: async ({ path }, ctx) => {
      const abs     = join(ctx.targetDir, path);
      const content = await readFile(abs, 'utf8').catch(() => '');
      if (!content) return { findings: [] };
      const findings = this.#patternScan(path, content);
      return { findings };
    },
  };

  async think(ctx) {
    const sourceFiles = await this.#collectSourceFiles(ctx);

    // Read package.json for known dependencies — used for CVE lookup
    let packages = {};
    const pkgPath = join(ctx.targetDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
        packages = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      } catch { /* skip */ }
    }

    return { sourceFiles, packages };
  }

  async act(plan, ctx) {
    const { board }             = ctx;
    const { sourceFiles, packages } = plan;
    const actions               = [];

    await board.ensureSub(SUBS.SECURITY);
    this.log(`scanning ${sourceFiles.length} source files for injection patterns`, ctx);

    const findings = [];

    for (const filepath of sourceFiles) {
      try {
        const content = await readFile(filepath.abs, 'utf8');
        const fileFindings = this.#patternScan(filepath.rel, content);
        findings.push(...fileFindings);

        // AI deep-scan for subtle paths
        if (ctx.ai.isAvailable() && content.length > 100) {
          const aiFindings = await this.#aiScan(filepath.rel, content, ctx);
          findings.push(...aiFindings);
        }
      } catch { /* skip unreadable */ }
    }

    for (const f of findings) {
      if (await this.findDuplicate(board, SUBS.SECURITY, f.title)) continue;
      // Write security pattern to knowledge base before posting
      await this.#kb.write({
        projectDir: ctx.targetDir,
        agentName:  this.name,
        type:       'security',
        title:      f.title,
        body:       f.body.slice(0, 500),
        tags:       ['security', (f.id?.toLowerCase() ?? 'vuln')],
      }).catch(() => {});
      await board.createPost(SUBS.SECURITY, {
        title:  f.title,
        body:   f.body,
        author: this.name,
        type:   'quality',
        meta:   { [META.SEVERITY]: f.severity, vulnClass: f.id },
      });
      this.log(`found: ${f.title}`, ctx);
      actions.push({ type: 'vuln-posted', title: f.title, severity: f.severity });
    }

    // CVE lookup via osv.dev for known packages
    const cveFindings = await this.#lookupCVEs(packages, ctx);
    for (const f of cveFindings) {
      if (await this.findDuplicate(board, SUBS.SECURITY, f.title)) continue;
      await board.createPost(SUBS.SECURITY, {
        title:  f.title,
        body:   f.body,
        author: this.name,
        type:   'quality',
        meta:   { [META.SEVERITY]: f.severity, vulnClass: 'CVE' },
      });
      this.log(`CVE: ${f.title}`, ctx);
      actions.push({ type: 'cve-posted', title: f.title });
    }

    if (!actions.length) this.log('no new injection vulnerabilities found', ctx);

    return { outcome: actions.length ? 'findings-posted' : 'clean', count: actions.length, actions };
  }

  #patternScan(filepath, content) {
    const findings = [];
    const lines    = content.split('\n');

    for (const { id, label, regex, severity } of PATTERNS) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(content)) !== null) {
        const lineNo  = content.slice(0, m.index).split('\n').length;
        const snippet = lines[lineNo - 1]?.trim() ?? '';
        findings.push({
          id,
          title:    `[${id}] ${label} in ${filepath}:${lineNo}`,
          body:     [
            `**File:** \`${filepath}\` line ${lineNo}`,
            `**Pattern:** ${label}`,
            `**Snippet:**`,
            '```',
            snippet.slice(0, 200),
            '```',
            '',
            `**Remediation:** ${this.#remediation(id)}`,
          ].join('\n'),
          severity,
        });
        // cap matches per pattern per file
        if (findings.filter(f => f.id === id).length >= 3) break;
      }
    }

    return findings;
  }

  async #aiScan(filepath, content, ctx) {
    const result = await ctx.ai.askJSON(
      `Analyse this file for injection vulnerabilities.
File: ${filepath}
\`\`\`
${content.slice(0, 3000)}
\`\`\`

Only report real, exploitable issues with file:line references. Skip false positives.
Respond with JSON array (may be empty):
[{ "title": "Short issue title", "body": "Explanation + remediation", "severity": "error|warning", "id": "VULN-CLASS" }]`,
      { system: PERSONAS.bobby }
    );
    return Array.isArray(result) ? result.slice(0, 5) : [];
  }

  /**
   * Query osv.dev for known CVEs in project dependencies.
   * Checks up to 5 packages to stay within rate limits.
   */
  async #lookupCVEs(packages, ctx) {
    const findings = [];
    const names    = Object.keys(packages).slice(0, 5);

    for (const name of names) {
      try {
        const result = await ctx.tools.fetch('https://api.osv.dev/v1/query', {
          method: 'POST',
          json:   { package: { name, ecosystem: 'npm' } },
        });
        if (!result.ok || !result.json?.vulns?.length) continue;

        const vulns = result.json.vulns.slice(0, 3);
        for (const v of vulns) {
          const id       = v.id ?? 'CVE-?';
          const summary  = v.summary ?? 'Known vulnerability';
          const severity = v.database_specific?.severity?.toLowerCase() === 'critical' ? 'error' : 'warning';
          findings.push({
            title:    `[CVE] ${name}: ${id}`,
            body:     `**Package:** \`${name}\` (${packages[name]})\n**ID:** ${id}\n**Summary:** ${summary}\n\n**Action:** Run \`npm audit fix\` or upgrade to a patched version.`,
            severity,
          });
        }
      } catch { /* skip — network not available */ }
    }

    return findings;
  }

  #remediation(id) {
    const map = {
      'CMD-INJ':  'Never pass user input to exec(). Use execFile() with an arg array, or a library that escapes shell args.',
      'EVAL':     'Remove eval(). If dynamic code is needed, consider a safe DSL or allowlist.',
      'XSS':      'Use textContent instead of innerHTML. If HTML is required, sanitise with DOMPurify.',
      'PATH-TRV': 'Resolve and validate paths against an allowed base directory. Reject paths containing "..".',
      'SQLI':     'Use parameterised queries or a query builder. Never interpolate user input into SQL strings.',
      'PROTO':    'Validate object keys before assigning. Use Object.create(null) for untrusted data.',
      'SSRF':     'Validate and allowlist URLs. Do not let user input control the host of outgoing requests.',
      'REDIR':    'Allowlist redirect destinations. Never redirect to a user-supplied URL without validation.',
    };
    return map[id] ?? 'Review and sanitise all user input at the point of use.';
  }

  async #collectSourceFiles(ctx) {
    const { targetDir, tools } = ctx;
    const paths = await tools.findFiles('**/*.{js,mjs,ts,py,php,rb}');
    return paths
      .filter(p => !/test|spec|node_modules|dist|\.mind-server/.test(p))
      .slice(0, 20)
      .map(rel => ({ abs: join(targetDir, rel), rel }));
  }
}
