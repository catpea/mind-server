/**
 * heather.js — Heather, the Tech Lead.
 *
 * Role: Shapes architecture, technical standards, and implementation quality.
 * She reviews Erica's code for architectural alignment, posts tech standards
 * to r/standards, and weighs in on design decisions before they harden.
 *
 * What she does:
 *   - Reviews r/todo items in 'review' status for architectural concerns
 *   - Posts architectural standards and patterns to r/standards
 *   - Flags anti-patterns: God objects, circular deps, inconsistent naming
 *   - Ensures new code follows the patterns already established in the project
 *
 * Without AI: flags common structural anti-patterns via regex.
 * With AI:    performs architecture review and suggests design improvements.
 */

import { BaseAgent }               from './base.js';
import { readFile, writeFile }     from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join }                    from 'node:path';
import { homedir }                 from 'node:os';
import { SUBS, STATUS, META }      from '../board-schema.js';
import { PERSONAS }                from './personas.js';
import * as git                    from '../git.js';
import { Knowledge }               from '../knowledge.js';

export class Heather extends BaseAgent {
  static priority = 6;
  name        = 'heather';
  description = 'Tech Lead. Reviews architecture, sets technical standards, flags anti-patterns.';
  avatar      = '🏗';
  role        = 'tech-lead';

  #kb = new Knowledge(homedir());

  skills = {
    reviewDesign: async ({ plan, title }, ctx) => {
      if (!ctx.ai?.isAvailable()) return { ok: true, comment: 'AI unavailable — proceed' };
      const comment = await ctx.ai.fast.ask(
        `Quick design review:\nTitle: ${title}\nPlan: ${(plan ?? '').slice(0, 800)}\n\nFlag any architectural concerns (2-3 bullets max). If it looks fine, say "LGTM".`,
        { system: 'You are a tech lead doing a quick design review.' }
      );
      const ok = !/(concern|issue|problem|wrong|bad|avoid|don't|shouldn't)/i.test(comment ?? '');
      return { ok, comment: comment ?? 'No concerns.' };
    },
  };

  async think(ctx) {
    const { board, targetDir } = ctx;

    // Posts in review waiting for arch signoff
    const inReview = await board.getPosts(SUBS.TODO, { status: STATUS.REVIEW }).catch(() => []);
    const notReviewed = inReview.filter(p => !p.meta?.heatherReviewed);

    // Standards not yet posted
    const existing = (await board.getPosts(SUBS.STANDARDS).catch(() => [])).map(p => p.title);

    // Read recent git log to understand what changed
    const recentCommits = await git.log(targetDir, 5);

    return { notReviewed, existingStandards: existing, recentCommits };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { notReviewed, existingStandards, recentCommits } = plan;
    const actions = [];

    await board.ensureSub(SUBS.STANDARDS);

    // Architecture review of in-review todos
    for (const post of notReviewed.slice(0, 2)) {
      const review = ctx.ai.isAvailable()
        ? await this.#archReview(post, targetDir, ctx)
        : this.#quickReview(post);

      if (review) {
        await board.addComment(post.id, { author: this.name, body: review });
        await board.updatePost(post.id, { meta: { ...post.meta, heatherReviewed: true } });
        this.log(`reviewed "${post.title}"`, ctx);
        actions.push({ type: 'arch-review', postId: post.id });

        // After each review, update context.md with architecture notes from the diff
        if (ctx.ai.isAvailable()) {
          await this.#updateContextMd(post, targetDir, ctx);
        }
      }
    }

    // Post foundational standards if board is fresh
    if (existingStandards.length < 3 && ctx.ai.isAvailable()) {
      const standards = await this.#generateStandards(targetDir, ctx);
      for (const s of standards) {
        if (existingStandards.includes(s.title)) continue;
        await board.createPost(SUBS.STANDARDS, {
          title:  s.title,
          body:   s.body,
          author: this.name,
          type:   'announcement',
        });
        actions.push({ type: 'standard-posted', title: s.title });
        this.log(`posted standard: ${s.title}`, ctx);
      }
    }

    // Dependency graph analysis — flag circular deps and God modules
    if (ctx.ai.isAvailable() && notReviewed.length === 0) {
      const depFindings = await this.#analyzeDepGraph(ctx);
      for (const f of depFindings) {
        if (await this.findDuplicate(board, SUBS.STANDARDS, f.title)) continue;
        await board.createPost(SUBS.STANDARDS, {
          title:  f.title,
          body:   f.body,
          author: this.name,
          type:   'quality',
        });
        actions.push({ type: 'dep-finding', title: f.title });
        this.log(`dep graph: ${f.title}`, ctx);
      }

      // Idle cycle — curate patterns Erica has written
      if (ctx.ai.isAvailable()) {
        await this.#curatePatterns(ctx);
      }
    }

    if (!actions.length) this.log('architecture looks aligned — idle', ctx);
    return { outcome: actions.length ? 'reviewed' : 'idle', actions };
  }

  async #archReview(post, targetDir, ctx) {
    const filesWritten = post.meta?.[META.FILES_WRITTEN] ?? [];
    const fileContext  = [];
    for (const f of filesWritten.slice(0, 3)) {
      const abs = join(targetDir, f);
      if (existsSync(abs)) {
        const content = await readFile(abs, 'utf8').catch(() => '');
        if (content) fileContext.push(`### ${f}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
      }
    }

    return ctx.ai.full.ask(
      `Task: ${post.title}
Plan: ${post.body?.slice(0, 1000) ?? ''}

${fileContext.join('\n\n') || '(no files available)'}

Review for:
- Does it follow separation of concerns?
- Are there hidden dependencies or tight coupling?
- Is naming consistent with the rest of the project?
- Are there simpler approaches?
- Any technical debt introduced?

Be specific and constructive. 3-5 bullet points max. Start with "🏗 Heather:"`,
      { system: PERSONAS.heather }
    );
  }

  #quickReview(post) {
    return `🏗 Heather: Quick architecture check for "${post.title}"\n\n- Review file structure and naming conventions manually.\n- Ensure no circular dependencies have been introduced.\n- Verify the implementation matches the acceptance criteria.\n\n*(AI review not available — set ANTHROPIC_API_KEY or configure a local model for detailed analysis.)*`;
  }

  async #generateStandards(targetDir, ctx) {
    const pkgPath = join(targetDir, 'package.json');
    let pkgInfo   = '';
    if (existsSync(pkgPath)) {
      const pkg = await readFile(pkgPath, 'utf8').catch(() => '{}');
      pkgInfo   = pkg.slice(0, 500);
    }

    const result = await ctx.ai.full.askJSON(
      `package.json: ${pkgInfo}

Generate 3 brief architectural standards appropriate for this project.
Each standard should be clear, actionable, and prevent common mistakes.

Respond with JSON array:
[{ "title": "Standard title", "body": "Markdown explanation with examples (max 300 chars)" }]`,
      { system: PERSONAS.heather }
    );
    return Array.isArray(result) ? result.slice(0, 3) : [];
  }

  /**
   * Read the git diff of files written by this review cycle and extract
   * architecture insights. Append a dated block to .mind-server/context.md.
   * Caps context.md at ~4000 tokens by summarising older blocks if needed.
   */
  async #updateContextMd(post, targetDir, ctx) {
    const contextPath = join(targetDir, '.mind-server', 'context.md');
    const filesWritten = post.meta?.[META.FILES_WRITTEN] ?? [];
    if (!filesWritten.length) return;

    // Read diffs for changed files
    const diffs = [];
    for (const f of filesWritten.slice(0, 3)) {
      const d = await git.diff(targetDir, f);
      if (d) diffs.push(`### ${f}\n\`\`\`diff\n${d.slice(0, 1500)}\n\`\`\``);
    }
    if (!diffs.length) return;

    const update = await ctx.ai.full.ask(
      `Review these file changes and extract a brief architecture update.

${diffs.join('\n\n')}

Extract (in markdown, 150 words max):
- New exports or APIs added
- Removed or renamed exports
- New dependencies introduced
- Changed file purposes or responsibilities
- Any patterns established or broken

Be specific. Mention file names and symbol names.`,
      { system: PERSONAS.heather }
    );

    if (!update) return;

    const date    = new Date().toISOString().slice(0, 10);
    const block   = `\n## [${date}] ${post.title}\n${update.trim()}\n`;

    const existing = existsSync(contextPath)
      ? await readFile(contextPath, 'utf8').catch(() => '')
      : '';

    // Cap at ~4000 tokens (~16000 chars). Summarise oldest blocks if over limit.
    const CHAR_LIMIT = 16_000;
    let updated = existing + block;

    if (updated.length > CHAR_LIMIT && ctx.ai.isAvailable()) {
      const sections  = updated.split(/\n(?=## )/);
      const keep      = sections.slice(-5).join('\n');   // keep last 5 sections verbatim
      const toSummary = sections.slice(0, -5).join('\n');

      if (toSummary.length > 500) {
        const summary = await ctx.ai.fast.ask(
          `Summarise these architecture notes concisely (200 words max). Preserve file names, symbol names, and key decisions:\n\n${toSummary.slice(0, 8000)}`,
          { system: 'You summarise architecture notes. Be terse. Preserve names and decisions.' }
        );
        updated = `## [summary] Architecture history\n${summary ?? toSummary.slice(0, 500)}\n\n${keep}`;
      }
    }

    // Hard safety cap: if the file is still over the limit after summarisation
    // (e.g. AI was unavailable, or the last 5 sections alone exceed the limit),
    // truncate from the front so we always keep the most recent context.
    if (updated.length > CHAR_LIMIT) {
      const cutAt = updated.indexOf('\n## ', updated.length - CHAR_LIMIT);
      updated = cutAt !== -1 ? updated.slice(cutAt + 1) : updated.slice(-CHAR_LIMIT);
    }

    await writeFile(contextPath, updated, 'utf8');
    // Invalidate the context cache (base.js uses module-level cache)
    this.log(`updated context.md with architecture notes for "${post.title}"`, ctx);
  }

  async #curatePatterns(ctx) {
    const { targetDir } = ctx;
    try {
      const patterns = await this.#kb.byProject(targetDir, 20);
      if (!patterns.length) return;

      const review = await ctx.ai.fast.askJSON(
        `Review these patterns from Erica. Identify any that should be promoted (are genuinely reusable, well-described) vs demoted (too specific, unclear). Return JSON: [{"id":"...","title":"...","verdict":"promote"|"demote"|"keep","reason":"..."}]

Patterns:
${JSON.stringify(patterns.map(p => ({ id: p.id, title: p.title, body: p.body?.slice(0, 200) })), null, 2)}`,
        { system: PERSONAS.heather }
      );

      if (!Array.isArray(review)) return;

      let promotions = 0;
      for (const item of review) {
        if (item.verdict !== 'promote' || promotions >= 2) continue;
        const original = patterns.find(p => p.id === item.id);
        if (!original) continue;
        await this.#kb.write({
          projectDir: targetDir,
          agentName:  this.name,
          type:       'decision',
          title:      `[Promoted] ${item.title}`,
          body:       `${original.body ?? ''}\n\nHeather's note: ${item.reason ?? ''}`.trim(),
          tags:       ['promoted', 'decision'],
        });
        promotions++;
        this.log(`promoted pattern: "${item.title}"`, ctx);
      }
    } catch { /* curate is advisory — never block */ }
  }

  async #analyzeDepGraph(ctx) {
    const graph    = await ctx.tools.buildGraph();
    const findings = [];

    const cycles = ctx.tools.findCycles(graph);
    if (cycles.length > 0) {
      const cycleList = cycles.slice(0, 3).map(c => c.join(' → ')).join('\n- ');
      findings.push({
        title: `[ARCH] Circular dependencies detected (${cycles.length})`,
        body:  `Circular import chains were found:\n\n- ${cycleList}\n\nCircular dependencies make modules harder to test and refactor. Break cycles by extracting shared code into a new module that neither chain imports.`,
      });
    }

    const gods = ctx.tools.findGodModules(graph, 6);
    for (const { file, importedBy } of gods.slice(0, 2)) {
      findings.push({
        title: `[ARCH] God module: ${file} (${importedBy} importers)`,
        body:  `\`${file}\` is imported by ${importedBy} files. High in-degree signals a God module — a file doing too much. Consider splitting into smaller, focused modules with clear responsibilities.`,
      });
    }

    return findings;
  }
}
