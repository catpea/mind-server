/**
 * lauren.js — Lauren, the UX Designer.
 *
 * Role: Advocates for the user. Lauren reviews the project for accessibility,
 * usability, and user-facing quality. She doesn't write code — she writes
 * feedback that makes code better for humans.
 *
 * What she does:
 *   - Reviews HTML/JSX/templates for accessibility issues (ARIA, alt text, labels)
 *   - Checks for hardcoded English strings (i18n readiness)
 *   - Flags UX anti-patterns: missing loading states, absent error messages,
 *     unclear button labels, missing focus management
 *   - Reviews error messages for human-friendliness
 *   - Posts UX findings to r/ux
 *   - Occasionally posts design principles to r/standards
 *
 * Without AI: regex-based a11y and UX pattern checks.
 * With AI:    holistic usability review with specific improvement suggestions.
 */

import { BaseAgent }               from './base.js';
import { readFile, readdir }       from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { SUBS, META, SEVERITY }   from '../board-schema.js';

// Accessibility patterns to check
const A11Y_PATTERNS = [
  {
    regex: /<img(?![^>]*\balt\s*=)[^>]*>/gi,
    label: 'Image missing alt attribute',
    fix:   'Add `alt="descriptive text"` or `alt=""` for decorative images.',
  },
  {
    regex: /<input(?![^>]*\bid\s*=)(?![^>]*\baria-label\s*=)[^>]*>/gi,
    label: 'Input missing id/aria-label (cannot be associated with a label)',
    fix:   'Add `id="..."` and a matching `<label for="...">`, or use `aria-label="..."` directly on the input.',
  },
  {
    regex: /onclick\s*=|addEventListener\s*\(\s*['"]click['"]/g,
    label: 'Click handler on potentially non-interactive element',
    fix:   'Ensure click handlers are on `<button>` or `<a href>` elements, not `<div>` or `<span>`. Add `role` and `tabindex="0"` if a div/span must be used.',
  },
  {
    regex: /color\s*:\s*#(?:[0-9a-f]{3}|[0-9a-f]{6})\s*;/gi,
    label: 'Hardcoded colour — may fail contrast requirements',
    fix:   'Use design tokens or CSS variables instead of hardcoded colours. Verify contrast ratio meets WCAG AA (4.5:1 for text).',
  },
];

// UX anti-patterns
const UX_PATTERNS = [
  {
    regex: /\.disabled\s*=\s*true|setAttribute\s*\(\s*['"]disabled['"]/g,
    label: 'Disabled element — ensure user understands why',
    fix:   'Add a tooltip or helper text explaining why the element is disabled and what action will enable it.',
  },
  {
    regex: /alert\s*\(/g,
    label: 'alert() for user feedback — poor UX',
    fix:   'Replace `alert()` with an inline error/success message or a non-blocking toast notification.',
  },
];

export class Lauren extends BaseAgent {
  static priority = 13;
  name        = 'lauren';
  description = 'UX Designer. Accessibility review, usability patterns, human-friendly error messages, i18n readiness.';
  avatar      = '🎨';
  role        = 'ux-designer';

  async think(ctx) {
    const { targetDir } = ctx;

    const files = await this.#collectFiles(targetDir);
    return { files, targetDir };
  }

  async act(plan, ctx) {
    const { board }                = ctx;
    const { files, targetDir } = plan;
    const actions                  = [];

    await board.ensureSub(SUBS.UX);
    this.log(`reviewing ${files.length} UI files for accessibility and usability`, ctx);

    const findings = [];

    for (const f of files) {
      try {
        const content = await readFile(f.abs, 'utf8');
        findings.push(...this.#a11yCheck(f.rel, content));
        findings.push(...this.#uxCheck(f.rel, content));
      } catch { /* skip */ }
    }

    // ── AI usability review ───────────────────────────────────────────────────
    if (ctx.ai.isAvailable() && files.length > 0) {
      const f       = files[0];
      const content = await readFile(f.abs, 'utf8').catch(() => '');
      if (content.length > 50) {
        const aiFindings = await this.#aiUxReview(f.rel, content, ctx);
        findings.push(...aiFindings);
      }
    }

    // ── Post new findings ─────────────────────────────────────────────────────
    for (const finding of findings) {
      if (await this.findDuplicate(board, SUBS.UX, finding.title)) continue;
      await board.createPost(SUBS.UX, {
        title:  finding.title,
        body:   finding.body,
        author: this.name,
        type:   'quality',
        meta:   { [META.SEVERITY]: finding.severity },
      });
      this.log(finding.title, ctx);
      actions.push({ type: 'finding', title: finding.title });
    }

    if (!actions.length) this.log('UX looks solid — idle', ctx);
    return { outcome: actions.length ? 'findings-posted' : 'clean', count: actions.length, actions };
  }

  #a11yCheck(filepath, content) {
    const findings = [];
    for (const { regex, label, fix } of A11Y_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        const lineNo = (() => {
          regex.lastIndex = 0;
          const m = regex.exec(content);
          return m ? content.slice(0, m.index).split('\n').length : '?';
        })();
        findings.push({
          title:    `[A11Y] ${label} in ${filepath}:${lineNo}`,
          body:     `**Accessibility issue in \`${filepath}\` around line ${lineNo}**\n\n**Problem:** ${label}\n\n**Fix:** ${fix}`,
          severity: 'warning',
        });
      }
    }
    return findings;
  }

  #uxCheck(filepath, content) {
    const findings = [];
    for (const { regex, label, fix } of UX_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        findings.push({
          title:    `[UX] ${label} in ${filepath}`,
          body:     `**UX concern in \`${filepath}\`**\n\n**Problem:** ${label}\n\n**Fix:** ${fix}`,
          severity: 'info',
        });
      }
    }

    // Check for generic error messages
    if (/['"`]Something went wrong['"`]|['"`]An error occurred['"`]|['"`]Error['"`]/g.test(content)) {
      findings.push({
        title:    `[UX] Generic error message in ${filepath}`,
        body:     `Generic error messages like "Something went wrong" leave users helpless.\n\n**Fix:** Provide specific, actionable error messages that explain:\n1. What happened\n2. Why it happened (if safe to share)\n3. What the user can do next`,
        severity: 'info',
      });
    }

    return findings;
  }

  async #aiUxReview(filepath, content, ctx) {
    const result = await ctx.ai.askJSON(
      `You are Lauren, a UX Designer reviewing code for user experience quality.

Review this file for:
- Accessibility (missing labels, focus management, keyboard navigation)
- Usability (confusing flows, missing feedback, poor error messages)
- Inclusivity (hardcoded text that's hard to translate, assumptions about users)
- Mobile/responsive concerns

File: ${filepath}
\`\`\`
${content.slice(0, 3000)}
\`\`\`

Respond with a JSON array (may be empty, max 3 items):
[{ "title": "[UX] or [A11Y] Short title", "body": "Problem description + specific fix", "severity": "warning|info" }]`,
      { system: 'You are a UX designer advocating for users. Be empathetic and specific. Reply with JSON only.' }
    );
    return Array.isArray(result) ? result.slice(0, 3) : [];
  }

  async #collectFiles(targetDir) {
    const uiExts = new Set(['.html', '.js', '.mjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte']);
    const ignore = new Set(['.mind-server', '.git', 'node_modules', 'dist', 'test', 'tests']);
    const files  = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
        const ext = extname(e.name);
        if (!uiExts.has(ext)) continue;
        // Focus on files that likely have UI code
        if (/server|test|config|build/i.test(e.name)) continue;
        files.push({ abs: join(dir, e.name), rel: relative(targetDir, join(dir, e.name)) });
      }
    }

    await walk(targetDir);
    return files.slice(0, 10);
  }
}
