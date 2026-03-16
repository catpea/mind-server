/**
 * rita.js — Rita, the reviewer.
 *
 * Role: Reviews Erica's implementations and approves or requests changes.
 *
 * What she does each cycle:
 *   1. Checks DMs for review requests from Erica
 *   2. Reads r/todo for posts in 'review' status
 *   3. Reads the implementation comment (Erica's diff summary)
 *   4. Reads the actual files from disk
 *   5. Asks Claude: "Is this implementation correct?"
 *   6a. If approved: advances status to 'done', DMs requester
 *   6b. If changes needed: posts change request comment, sets back to 'in-progress', DMs Erica
 *
 * When AI not available:
 *   Posts a note asking a human to review, marks as 'done' (optimistic).
 */

import { BaseAgent }               from './base.js';
import { readFile }                from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join, extname }           from 'node:path';

const READABLE_EXTS = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.css', '.py']);

export class Rita extends BaseAgent {
  name        = 'rita';
  description = 'Reviewer. Assesses implementations and approves or requests changes.';
  avatar      = '🔍';
  role        = 'reviewer';

  async think(ctx) {
    const { board } = ctx;

    const dms = await board.getDMs({ to: this.name, unreadOnly: true });
    for (const dm of dms) await board.markDMRead(dm.id);

    const inReview = await board.getPosts('todo', { status: 'review' }).catch(() => []);
    return { inReview, dms };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { inReview }         = plan;
    const actions              = [];

    if (!inReview.length) {
      this.log('nothing in review — idle', ctx);
      return { outcome: 'idle', actions };
    }

    // Review one at a time
    const post = inReview[0];
    this.log(`reviewing: "${post.title}"`, ctx);

    // Get the implementation comment (latest from erica)
    const comments = await board.getComments(post.id);
    const implComment = comments
      .filter(c => c.author === 'erica')
      .at(-1);

    // Read the files that were changed
    const filesWritten = implComment?.meta?.filesWritten ?? [];
    const fileContents = {};
    for (const filepath of filesWritten) {
      const abs = join(targetDir, filepath);
      if (existsSync(abs) && READABLE_EXTS.has(extname(filepath))) {
        try { fileContents[filepath] = await readFile(abs, 'utf8'); } catch { /* skip */ }
      }
    }

    let approved = true;
    let reviewComment = '';

    if (ctx.ai.isAvailable()) {
      const review = await this.#reviewWithAI(post, implComment?.body ?? '', fileContents, ctx);
      approved      = review?.approved ?? true;
      reviewComment = review?.comment  ?? '';
    } else {
      // Optimistic approval without AI
      reviewComment = '✅ Auto-approved (AI unavailable). A human should verify this implementation.';
      approved      = true;
    }

    if (approved) {
      await board.addComment(post.id, {
        author: this.name,
        body:   `✅ Approved\n\n${reviewComment}`,
      });
      await board.advanceStatus(post.id, 'done', {
        author:  this.name,
        comment: 'Implementation approved.',
      });

      // DM the original requester
      if (post.meta?.requestAuthor) {
        await board.sendDM({
          from:    this.name,
          to:      post.meta.requestAuthor,
          subject: `Done: ${post.title}`,
          body:    `Your request "${post.title}" has been implemented and approved.`,
          meta:    { todoId: post.id },
        });
      }

      actions.push({ type: 'approved', todoId: post.id });
      this.log(`approved "${post.title}"`, ctx);

    } else {
      await board.addComment(post.id, {
        author: this.name,
        body:   `🔄 Changes requested\n\n${reviewComment}`,
      });
      await board.advanceStatus(post.id, 'in-progress', {
        author:  this.name,
        comment: 'Sent back for revisions.',
      });

      await board.sendDM({
        from:    this.name,
        to:      'erica',
        subject: `Revision needed: ${post.title}`,
        body:    `Please revise ${post.id}:\n\n${reviewComment}`,
        meta:    { todoId: post.id },
      });

      actions.push({ type: 'requested-changes', todoId: post.id });
      this.log(`requested changes on "${post.title}"`, ctx);
    }

    return { outcome: approved ? 'approved' : 'changes-requested', actions };
  }

  async #reviewWithAI(post, implSummary, fileContents, ctx) {
    const fileContext = Object.entries(fileContents)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``)
      .join('\n\n');

    const prompt = `You are Rita, a software engineering reviewer.

## Task that was implemented
${post.title}

## Plan
${post.body ?? '(no plan)'}

## Implementation summary (from Erica)
${implSummary || '(no summary)'}

## Actual file contents after implementation
${fileContext || '(no files readable)'}

Review this implementation. Respond with JSON:
{
  "approved": true or false,
  "comment": "Your review comment — specific, actionable. If approved, say what was good. If not, say exactly what needs to change."
}`;

    return ctx.ai.askJSON(prompt, {
      system: 'You are a senior software engineer doing a code review. Be specific and fair. Reply with JSON only.',
    });
  }
}
