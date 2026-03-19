/**
 * monica.js — Monica, the planner.
 *
 * Role: Turns user requests into structured, actionable todo posts.
 *
 * What she does each cycle:
 *   1. Reads r/requests for open posts (user feature requests / bug reports)
 *   2. For each unprocessed request, creates a structured post in r/todo:
 *      - Clear title
 *      - Acceptance criteria (numbered list)
 *      - Files likely to need changes (best guess)
 *      - Complexity estimate: S/M/L
 *   3. Marks the original request as 'planned'
 *   4. DMs Erica with the new todo post ID
 *
 * When AI not available:
 *   Copies the request as-is into r/todo with a note that it needs refinement.
 */

import { BaseAgent } from './base.js';
import { readdir }   from 'node:fs/promises';
import { join }      from 'node:path';
import { homedir }   from 'node:os';
import { SUBS, STATUS, META, AMY_STATUS } from '../board-schema.js';
import { PERSONAS }  from './personas.js';
import { Knowledge } from '../knowledge.js';

export class Monica extends BaseAgent {
  static priority = 3;
  name        = 'monica';
  description = 'Planner. Transforms user requests into structured, actionable todo posts.';
  avatar      = '📋';
  role        = 'planner';

  #kb = new Knowledge(homedir());

  async think(ctx) {
    const { board } = ctx;

    // Only plan requests Amy has approved (or all open ones if Amy hasn't run yet)
    const all      = await board.getPosts(SUBS.REQUESTS, { status: STATUS.OPEN }).catch(() => []);
    const requests = all.filter(p =>
      p.meta?.[META.AMY_STATUS] === AMY_STATUS.APPROVED ||
      (!p.meta?.[META.AMY_REVIEWED] && !p.meta?.[META.AMY_STATUS])   // Amy hasn't run yet — plan anyway
    );
    return { requests };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { requests }         = plan;
    const actions              = [];

    if (!requests.length) {
      this.log('no open requests — idle', ctx);
      return { outcome: 'idle', actions };
    }

    this.log(`processing ${requests.length} request(s)`, ctx);

    // Project file tree (top-level only — for context)
    const projectFiles = await this.#listProjectFiles(targetDir);

    // Incorporate any clarification Amy sent since last cycle
    const amyReplies = await this.getConversationReplies(board);
    const clarifications = new Map(); // requestId → amy's answer
    for (const r of amyReplies) {
      if (r.from === 'amy' && r.meta?.requestId) {
        clarifications.set(r.meta.requestId, r.body);
        await board.markDMRead(r.id);
      }
    }

    for (const req of requests) {
      this.log(`planning: "${req.title}"`, ctx);

      // If the request body is very short/vague, ask Amy for clarification first
      const isVague = (req.body ?? '').trim().length < 30;
      const waitingForAmy = await this.pendingQuestion(board, `Clarify request: ${req.title}`);
      const amyClarification = clarifications.get(req.id);

      if (isVague && !waitingForAmy && !amyClarification && ctx.ai.isAvailable()) {
        await this.consultPeer(board, {
          to:      'amy',
          subject: `Clarify request: ${req.title}`,
          body:    `I need to plan this request but the description is quite brief.\n\n**Request:** "${req.title}"\n**Body:** ${req.body || '(empty)'}\n\nCan you provide:\n1. What problem this solves for the user\n2. Any acceptance criteria you had in mind\n3. Anything I should watch out for when planning this`,
          meta:    { requestId: req.id },
        });
        this.log(`asked Amy to clarify "${req.title}" — skipping for now`, ctx);
        await this.writeScratchpad('monica', `Waiting for Amy's clarification on: "${req.title}" (requestId: ${req.id})\nAsked: ${new Date().toISOString()}`);
        actions.push({ type: 'consulted-peer', peer: 'amy', requestId: req.id });
        continue;
      }

      if (waitingForAmy) {
        this.log(`still waiting for Amy's clarification on "${req.title}"`, ctx);
        continue;
      }

      let todoBody;
      if (ctx.ai.isAvailable()) {
        todoBody = await this.#planWithAI(req, projectFiles, ctx, amyClarification);
      } else {
        todoBody = this.#planWithoutAI(req);
      }

      // Synchronous design check — Heather reviews the plan before it becomes a todo
      try {
        const designReview = await ctx.call('heather', 'reviewDesign', { plan: todoBody, title: req.title });
        if (!designReview.ok) {
          await board.addComment(req.id, {
            author: this.name,
            body:   `📋 Monica: Heather flagged design concerns before planning:\n\n${designReview.comment}\n\nRefining the plan...`,
          });
          // Prepend Heather's feedback to the plan body
          todoBody = `## Heather's Design Notes\n${designReview.comment}\n\n${todoBody}`;
        }
      } catch { /* ctx.call fails if heather not loaded — non-blocking */ }

      // Create todo post — gate controls whether it needs human approval first
      const gated     = ctx.gated ?? true;
      const initStatus = gated ? STATUS.AWAITING_APPROVAL : STATUS.OPEN;
      await board.ensureSub(SUBS.TODO);
      const todo = await board.createPost(SUBS.TODO, {
        title:  req.title,
        body:   todoBody,
        author: this.name,
        type:   'todo',
        status: initStatus,
        meta:   { [META.REQUEST_ID]: req.id, [META.REQUEST_AUTHOR]: req.author },
      });

      // Mark request as planned
      await board.advanceStatus(req.id, STATUS.PLANNED, {
        author:  this.name,
        comment: `Planned as todo: ${todo.id}`,
      });

      // DM Erica
      await board.ensureSub('u/erica');
      await board.sendDM({
        from:    this.name,
        to:      'erica',
        subject: `New todo: ${req.title}`,
        body:    `I've planned this for you. Todo post ID: ${todo.id}\n\n${todoBody}`,
        meta:    { [META.TODO_ID]: todo.id },
      });

      actions.push({ type: 'created-todo', todoId: todo.id, requestId: req.id, title: req.title });
      this.log(`created todo ${todo.id} for "${req.title}"`, ctx);
    }

    return { outcome: 'planned', count: requests.length, actions };
  }

  async #planWithAI(req, projectFiles, ctx, amyClarification) {
    const contextSection = ctx.projectContext
      ? `\n## Project Context\n${ctx.projectContext}\n`
      : '';
    const clarificationSection = amyClarification
      ? `\n## PM Clarification (from Amy)\n${amyClarification}\n`
      : '';

    // Query knowledge base for relevant past patterns
    let knowledgeSection = '';
    try {
      const query   = `${req.title} ${(req.body ?? '')}`;
      const results = await this.#kb.search(query);
      if (results.length) {
        const patterns = results
          .map(r => `- ${r.title}: ${r.body}`)
          .join('\n')
          .slice(0, 1500);
        knowledgeSection = `\n## Relevant Past Patterns\n${patterns}\n`;
      }
    } catch { /* advisory only */ }

    const prompt = `You are Monica, a software development planner.
${contextSection}${clarificationSection}${knowledgeSection}
A user has submitted this request:
Title: ${req.title}
Body: ${req.body || '(no body)'}

Project files available:
${projectFiles.slice(0, 30).join('\n')}

Write a structured todo plan with these sections:
## Goal
One sentence describing what needs to be done.

## Acceptance Criteria
Numbered list of specific, testable outcomes.

## Files Likely Affected
List of files that probably need to change (best guess from file tree).

## Complexity
One of: S (< 1 hour), M (half day), L (full day or more)

## Notes
Any warnings, dependencies, or things Erica should know.`;

    const result = await ctx.ai.full.ask(prompt, { system: PERSONAS.monica });
    return result ?? this.#planWithoutAI(req);
  }

  #planWithoutAI(req) {
    return `## Goal
${req.body || req.title}

## Acceptance Criteria
1. Implementation matches the request description.
2. Existing tests still pass.
3. New functionality has test coverage.

## Files Likely Affected
*(AI not available — review codebase manually)*

## Complexity
M

## Notes
This plan was generated without AI. Review and refine before implementing.`;
  }

  async #listProjectFiles(targetDir) {
    const ignore = new Set(['.mind-server', '.git', 'node_modules', 'dist', '.cache']);
    try {
      const entries = await readdir(targetDir, { withFileTypes: true });
      const files   = [];
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        files.push(e.isDirectory() ? `${e.name}/` : e.name);
      }
      return files;
    } catch {
      return [];
    }
  }
}
