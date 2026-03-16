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
import { readFile, readdir }       from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

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
  name        = 'bobby';
  description = 'Injection specialist. Hunts command, SQL, XSS, path-traversal, and eval vulnerabilities in source code.';
  avatar      = '💉';
  role        = 'security-injection';

  async think(ctx) {
    const { targetDir, board } = ctx;

    const sourceFiles = await this.#collectSourceFiles(targetDir);
    const existing    = (await board.getPosts('security', { type: 'quality' }).catch(() => []))
      .filter(p => p.status !== 'done' && p.author === this.name)
      .map(p => p.title);

    return { sourceFiles, existing };
  }

  async act(plan, ctx) {
    const { board }             = ctx;
    const { sourceFiles, existing } = plan;
    const actions               = [];

    await board.ensureSub('security');
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

    // Deduplicate by title
    const seen = new Set(existing);
    for (const f of findings) {
      if (seen.has(f.title)) continue;
      seen.add(f.title);
      await board.createPost('security', {
        title:  f.title,
        body:   f.body,
        author: this.name,
        type:   'quality',
        meta:   { severity: f.severity, vulnClass: f.id },
      });
      this.log(`found: ${f.title}`, ctx);
      actions.push({ type: 'vuln-posted', title: f.title, severity: f.severity });
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
      `You are Bobby, a code injection specialist.
Analyse this file for injection vulnerabilities — command injection, SQL injection, XSS, path traversal, eval, SSRF, prototype pollution.
Only report real, exploitable issues. Skip false positives.

File: ${filepath}
\`\`\`
${content.slice(0, 3000)}
\`\`\`

Respond with a JSON array (may be empty):
[{ "title": "Short issue title", "body": "Explanation + remediation steps", "severity": "error|warning", "id": "VULN-CLASS" }]`,
      { system: 'You are a security engineer. Report only real vulnerabilities. Reply with JSON only.' }
    );
    return Array.isArray(result) ? result.slice(0, 5) : [];
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

  async #collectSourceFiles(targetDir) {
    const exts   = new Set(['.js', '.mjs', '.ts', '.py', '.php', '.rb']);
    const ignore = new Set(['.mind-server', '.git', 'node_modules', 'dist', 'test', 'tests']);
    const files  = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
        if (exts.has(extname(e.name))) {
          files.push({ abs: join(dir, e.name), rel: relative(targetDir, join(dir, e.name)) });
        }
      }
    }

    await walk(targetDir);
    return files.slice(0, 20); // cap for performance
  }
}
