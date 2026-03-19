/**
 * amy.js — Amy, the Product Manager.
 *
 * Role: Makes sure the team is building the right thing. Amy reads r/requests
 * before Monica plans them, validates they have enough context, and ensures
 * acceptance criteria are testable. She prevents wasted work.
 *
 * What she does:
 *   - Reviews open requests for clarity and completeness
 *   - Asks clarifying questions via comments when a request is too vague
 *   - Prioritises the backlog (adds priority metadata to posts)
 *   - Posts a weekly product update to r/general
 *   - Flags requests that duplicate existing work
 *
 * Without AI: flags requests with very short titles and no body.
 * With AI:    evaluates each request for completeness and business value.
 */

import { BaseAgent } from './base.js';
import { SUBS, STATUS, META, AMY_STATUS } from '../board-schema.js';
import { PERSONAS } from './personas.js';

export class Amy extends BaseAgent {
  static priority = 1;
  name        = 'amy';
  description = 'Product Manager. Validates requests, clarifies requirements, prioritises the backlog.';
  avatar      = '🗺';
  role        = 'product-manager';

  async think(ctx) {
    const { board } = ctx;

    const requests    = await board.getPosts(SUBS.REQUESTS, { status: STATUS.OPEN }).catch(() => []);
    const needsReview = requests.filter(p => !p.meta?.[META.AMY_REVIEWED]);
    const todos       = await board.getAllPosts({ type: 'todo' }).catch(() => []);

    return { needsReview, todos };
  }

  async act(plan, ctx) {
    const { board }          = ctx;
    const { needsReview, todos } = plan;
    const actions            = [];

    for (const req of needsReview.slice(0, 3)) {
      this.log(`reviewing request: "${req.title}"`, ctx);

      const assessment = ctx.ai.isAvailable()
        ? await this.#assessWithAI(req, todos, ctx)
        : this.#assessWithoutAI(req);

      if (assessment.needsClarification) {
        // Comment asking for more detail, block planning
        await board.addComment(req.id, {
          author: this.name,
          body:   `🗺 Amy needs more information before this can be planned:\n\n${assessment.questions.map(q => `- ${q}`).join('\n')}`,
        });
        await board.updatePost(req.id, {
          meta: { ...req.meta, [META.AMY_REVIEWED]: true, [META.AMY_STATUS]: AMY_STATUS.NEEDS_CLARIFICATION },
        });
        actions.push({ type: 'clarification-requested', postId: req.id });
        this.log(`requested clarification on "${req.title}"`, ctx);

      } else {
        // Approve for planning — add priority and estimated complexity
        await board.addComment(req.id, {
          author: this.name,
          body:   `🗺 Amy: Ready for planning.\n\n**Priority:** ${assessment.priority}\n**Why:** ${assessment.rationale}`,
        });
        await board.updatePost(req.id, {
          meta: {
            ...req.meta,
            [META.AMY_REVIEWED]: true,
            [META.AMY_STATUS]:   AMY_STATUS.APPROVED,
            priority:            assessment.priority,
          },
        });
        actions.push({ type: 'approved', postId: req.id, priority: assessment.priority });
        this.log(`approved "${req.title}" (${assessment.priority})`, ctx);
      }
    }

    if (!actions.length) this.log('backlog is clear — idle', ctx);
    return { outcome: actions.length ? 'reviewed' : 'idle', count: actions.length, actions };
  }

  async #assessWithAI(req, todos, ctx) {
    const todoTitles = todos.map(t => t.title).join(', ');
    const result     = await ctx.ai.fast.askJSON(
      `Request title: ${req.title}
Request body: ${req.body || '(none)'}
Existing work: ${todoTitles.slice(0, 400) || '(none)'}

Assess this request:
1. Is it clear enough to plan? (specific, testable outcome?)
2. Does it duplicate existing work?
3. What priority: high / medium / low?

Respond with JSON:
{
  "needsClarification": true/false,
  "questions": ["question1", "question2"],
  "priority": "high|medium|low",
  "rationale": "One sentence explanation"
}`,
      { system: PERSONAS.amy }
    );
    return result ?? this.#assessWithoutAI(req);
  }

  #assessWithoutAI(req) {
    const isTooVague = !req.body || req.body.trim().length < 20;
    return {
      needsClarification: isTooVague,
      questions:          isTooVague ? ['What is the expected outcome?', 'Who is the user and what problem does this solve?'] : [],
      priority:           'medium',
      rationale:          'Auto-assessed (AI unavailable).',
    };
  }

  /**
   * Amy answers Monica's clarification requests from a PM perspective.
   * She enriches vague requests with goals, acceptance criteria, and context.
   */
  async answerQuestion(dm, ctx) {
    if (!ctx.ai?.isAvailable()) {
      return `AI not available — proceed with what information you have. Flag any missing requirements as questions in the todo plan.`;
    }
    const contextNote = ctx.projectContext
      ? `\n\n## Project Context\n${ctx.projectContext}`
      : '';
    const prompt = `You are Amy, the product manager.
Monica (the planner) needs clarification before she can write a proper implementation plan.${contextNote}

## Monica's question
${dm.body}

Provide:
1. **User goal** — What does the user actually want to achieve?
2. **Acceptance criteria** — 2-4 specific, testable outcomes
3. **Out of scope** — What should NOT be built as part of this
4. **Priority level** — high / medium / low and why

Be concise. Monica will use this to write the implementation plan.`;
    return ctx.ai.ask(prompt, {
      system: 'You are a product manager providing requirements clarification. Be concise and specific.',
    });
  }
}
