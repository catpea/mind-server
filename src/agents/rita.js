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
import { homedir }                 from 'node:os';
import { SUBS, STATUS, META }      from '../board-schema.js';
import { PERSONAS }                from './personas.js';
import { Knowledge }               from '../knowledge.js';

const READABLE_EXTS = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.css', '.py']);

export class Rita extends BaseAgent {
  static priority = 5;
  name        = 'rita';
  description = 'Reviewer. Assesses implementations and approves or requests changes.';
  avatar      = '🔍';
  role        = 'reviewer';

  #kb = new Knowledge(homedir());

  async think(ctx) {
    const { board } = ctx;

    const dms = await board.getDMs({ to: this.name, unreadOnly: true });
    for (const dm of dms) await board.markDMRead(dm.id);

    const inReview = await board.getPosts(SUBS.TODO, { status: STATUS.REVIEW }).catch(() => []);
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
    const filesWritten = implComment?.meta?.[META.FILES_WRITTEN] ?? [];
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
      await board.advanceStatus(post.id, STATUS.DONE, {
        author:  this.name,
        comment: 'Implementation approved.',
      });

      // DM the original requester
      if (post.meta?.[META.REQUEST_AUTHOR]) {
        await board.sendDM({
          from:    this.name,
          to:      post.meta[META.REQUEST_AUTHOR],
          subject: `Done: ${post.title}`,
          body:    `Your request "${post.title}" has been implemented and approved.`,
          meta:    { [META.TODO_ID]: post.id },
        });
      }

      actions.push({ type: 'approved', todoId: post.id });
      this.log(`approved "${post.title}"`, ctx);

    } else {
      // Write anti-pattern to knowledge base
      await this.#kb.write({
        projectDir: ctx.targetDir,
        agentName:  this.name,
        type:       'anti-pattern',
        title:      `Review: ${post.title}`,
        body:       reviewComment.slice(0, 500),
        tags:       ['review', 'anti-pattern'],
      }).catch(() => {});

      await board.addComment(post.id, {
        author: this.name,
        body:   `🔄 Changes requested\n\n${reviewComment}`,
      });
      await board.advanceStatus(post.id, STATUS.IN_PROGRESS, {
        author:  this.name,
        comment: 'Sent back for revisions.',
      });

      await board.sendDM({
        from:    this.name,
        to:      'erica',
        subject: `Revision needed: ${post.title}`,
        body:    `Please revise ${post.id}:\n\n${reviewComment}`,
        meta:    { [META.TODO_ID]: post.id },
      });

      actions.push({ type: 'requested-changes', todoId: post.id });
      this.log(`requested changes on "${post.title}"`, ctx);
    }

    return { outcome: approved ? 'approved' : 'changes-requested', actions };
  }

  /**
   * Rita gives Erica pre-implementation feedback when asked.
   * She reads the todo plan and flags concerns before code is written.
   */
  async answerQuestion(dm, ctx) {
    if (!ctx.ai?.isAvailable()) {
      return `I'd like to review your plan but AI isn't available right now. Go ahead with your best judgment — I'll review the code once it's written.`;
    }
    const contextNote = ctx.projectContext
      ? `\n\n## Project Context\n${ctx.projectContext}`
      : '';
    const prompt = `Erica is about to implement a task and wants your feedback before writing code.${contextNote}

## Erica's question
${dm.body}

Give concise, actionable pre-implementation feedback:
- Flag any architectural concerns or missing edge cases
- Point out files she should look at that she may have missed
- Suggest a simpler approach if one exists
- Distinguish blocking issues from non-blocking suggestions
- If the plan looks good, say so clearly`;
    return ctx.ai.full.ask(prompt, { system: PERSONAS.rita });
  }

  async #reviewWithAI(post, implSummary, fileContents, ctx) {
    const fileContext = Object.entries(fileContents)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``)
      .join('\n\n');

    const prompt = `## Task
${post.title}

## Plan
${post.body ?? '(no plan)'}

## Implementation summary (from Erica)
${implSummary || '(no summary)'}

## Actual file contents
${fileContext || '(no files readable)'}

Review this implementation. Correctness first, performance second, style last.
Respond with JSON:
{
  "approved": true or false,
  "comment": "Specific, line-level feedback. Label each issue [blocking] or [non-blocking]. If approved, note what was done well."
}`;

    return ctx.ai.full.askJSON(prompt, { system: PERSONAS.rita });
  }
}
