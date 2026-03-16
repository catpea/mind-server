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

export class Monica extends BaseAgent {
  name        = 'monica';
  description = 'Planner. Transforms user requests into structured, actionable todo posts.';
  avatar      = '📋';
  role        = 'planner';

  async think(ctx) {
    const { board } = ctx;

    // Find open posts in r/requests
    const requests = await board.getPosts('requests', { status: 'open' }).catch(() => []);
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

    for (const req of requests) {
      this.log(`planning: "${req.title}"`, ctx);

      let todoBody;
      if (ctx.ai.isAvailable()) {
        todoBody = await this.#planWithAI(req, projectFiles, ctx);
      } else {
        todoBody = this.#planWithoutAI(req);
      }

      // Create todo post
      await board.ensureSub('todo');
      const todo = await board.createPost('todo', {
        title:  req.title,
        body:   todoBody,
        author: this.name,
        type:   'todo',
        meta:   { requestId: req.id, requestAuthor: req.author },
      });

      // Mark request as planned
      await board.advanceStatus(req.id, 'planned', {
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
        meta:    { todoId: todo.id },
      });

      actions.push({ type: 'created-todo', todoId: todo.id, requestId: req.id, title: req.title });
      this.log(`created todo ${todo.id} for "${req.title}"`, ctx);
    }

    return { outcome: 'planned', count: requests.length, actions };
  }

  async #planWithAI(req, projectFiles, ctx) {
    const prompt = `You are Monica, a software development planner.

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

    const result = await ctx.ai.ask(prompt, {
      system: 'You are a concise technical planner. Write clear, actionable plans for software developers.',
    });
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
