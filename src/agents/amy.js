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

export class Amy extends BaseAgent {
  name        = 'amy';
  description = 'Product Manager. Validates requests, clarifies requirements, prioritises the backlog.';
  avatar      = '🗺';
  role        = 'product-manager';

  async think(ctx) {
    const { board } = ctx;

    const requests    = await board.getPosts('requests', { status: 'open' }).catch(() => []);
    const needsReview = requests.filter(p => !p.meta?.amyReviewed);
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
          meta: { ...req.meta, amyReviewed: true, amyStatus: 'needs-clarification' },
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
            amyReviewed: true,
            amyStatus:   'approved',
            priority:    assessment.priority,
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
    const result     = await ctx.ai.askJSON(
      `You are Amy, a Product Manager reviewing a feature request.

Request title: ${req.title}
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
      { system: 'You are a product manager. Be concise and decisive. Reply with JSON only.' }
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
}
