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
import { readFile, readdir }       from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join, extname, relative } from 'node:path';

export class Heather extends BaseAgent {
  name        = 'heather';
  description = 'Tech Lead. Reviews architecture, sets technical standards, flags anti-patterns.';
  avatar      = '🏗';
  role        = 'tech-lead';

  async think(ctx) {
    const { board } = ctx;

    // Posts in review waiting for arch signoff
    const inReview = await board.getPosts('todo', { status: 'review' }).catch(() => []);
    const notReviewed = inReview.filter(p => !p.meta?.heatherReviewed);

    // Standards not yet posted
    const existing = (await board.getPosts('standards').catch(() => [])).map(p => p.title);

    return { notReviewed, existingStandards: existing };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { notReviewed, existingStandards } = plan;
    const actions = [];

    await board.ensureSub('standards');

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
      }
    }

    // Post foundational standards if board is fresh
    if (existingStandards.length < 3 && ctx.ai.isAvailable()) {
      const standards = await this.#generateStandards(targetDir, ctx);
      for (const s of standards) {
        if (existingStandards.includes(s.title)) continue;
        await board.createPost('standards', {
          title:  s.title,
          body:   s.body,
          author: this.name,
          type:   'announcement',
        });
        actions.push({ type: 'standard-posted', title: s.title });
        this.log(`posted standard: ${s.title}`, ctx);
      }
    }

    if (!actions.length) this.log('architecture looks aligned — idle', ctx);
    return { outcome: actions.length ? 'reviewed' : 'idle', actions };
  }

  async #archReview(post, targetDir, ctx) {
    const filesWritten = post.meta?.filesWritten ?? [];
    const fileContext  = [];
    for (const f of filesWritten.slice(0, 3)) {
      const abs = join(targetDir, f);
      if (existsSync(abs)) {
        const content = await readFile(abs, 'utf8').catch(() => '');
        if (content) fileContext.push(`### ${f}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
      }
    }

    return ctx.ai.ask(
      `You are Heather, a Tech Lead reviewing code for architectural quality.

Task: ${post.title}
Plan: ${post.body?.slice(0, 1000) ?? ''}

${fileContext.join('\n\n') || '(no files available)'}

Review for:
- Does it follow separation of concerns?
- Are there hidden dependencies or tight coupling?
- Is naming consistent with the rest of the project?
- Are there simpler approaches?
- Any technical debt introduced?

Be specific and constructive. 3-5 bullet points max. Start with "🏗 Heather:"`,
      { system: 'You are a senior tech lead doing an architectural code review. Be specific and practical.' }
    );
  }

  #quickReview(post) {
    return `🏗 Heather: Quick architecture check for "${post.title}"\n\n- Review file structure and naming conventions manually.\n- Ensure no circular dependencies have been introduced.\n- Verify the implementation matches the acceptance criteria.\n\n*(AI review not available — set ANTHROPIC_API_KEY or configure a local model for detailed analysis.)*`;
  }

  async #generateStandards(targetDir, ctx) {
    // Read project structure for context
    const pkgPath = join(targetDir, 'package.json');
    let pkgInfo   = '';
    if (existsSync(pkgPath)) {
      const pkg = await readFile(pkgPath, 'utf8').catch(() => '{}');
      pkgInfo   = pkg.slice(0, 500);
    }

    const result = await ctx.ai.askJSON(
      `You are Heather, a Tech Lead for this project.

package.json: ${pkgInfo}

Generate 3 brief architectural standards appropriate for this project.
Each standard should be clear, actionable, and prevent common mistakes.

Respond with JSON array:
[{ "title": "Standard title", "body": "Markdown explanation with examples (max 300 chars)" }]`,
      { system: 'You are a tech lead setting architectural standards. Be concise and practical. Reply with JSON only.' }
    );
    return Array.isArray(result) ? result.slice(0, 3) : [];
  }
}
