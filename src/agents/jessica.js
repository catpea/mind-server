/**
 * jessica.js — Jessica, the Business Analyst.
 *
 * Role: Bridges the gap between user intent and engineering output.
 * Jessica reads what was requested, compares it to what was built,
 * and asks: "Does this actually solve the problem?"
 *
 * What she does:
 *   - Reads completed r/todo items and checks if acceptance criteria were met
 *   - Posts "done — but did we solve the problem?" notes when something feels off
 *   - Looks for requirements that contradict each other
 *   - Ensures features are traceable back to a request
 *   - Identifies work that was done but never requested (scope creep)
 *   - Posts weekly product health report to r/general
 *
 * Without AI: checks that done todos have a linked request and comments.
 * With AI:    reads the request + implementation and evaluates outcome alignment.
 */

import { BaseAgent } from './base.js';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class Jessica extends BaseAgent {
  name        = 'jessica';
  description = 'Business Analyst. Validates that completed work solves the original problem. Outcome alignment, scope, and traceability.';
  avatar      = '📊';
  role        = 'business-analyst';

  async think(ctx) {
    const { board } = ctx;

    // Recently completed work
    const doneTodos = (await board.getPosts('todo', { status: 'done' }).catch(() => []))
      .filter(p => !p.meta?.jessicaReviewed);

    // All requests for cross-reference
    const requests = await board.getAllPosts({ type: 'request' }).catch(() => []);

    // Orphaned todos — implemented without a corresponding request
    const requestTitles = new Set(requests.map(r => r.title.toLowerCase()));
    const orphaned = doneTodos.filter(t => {
      const linked = t.meta?.requestId || t.meta?.linkedRequest;
      return !linked && !requestTitles.has(t.title.toLowerCase());
    });

    // Open requests that have been open > 2 weeks with no todo
    const now         = Date.now();
    const stalledReqs = requests
      .filter(r => r.status === 'open')
      .filter(r => (now - new Date(r.createdAt).getTime()) > 2 * ONE_WEEK_MS)
      .filter(r => !r.meta?.amyStatus || r.meta.amyStatus !== 'needs-clarification');

    return { doneTodos, orphaned, stalledReqs, requests };
  }

  async act(plan, ctx) {
    const { board }                              = ctx;
    const { doneTodos, orphaned, stalledReqs, requests } = plan;
    const actions                                = [];

    // ── Review completed work ─────────────────────────────────────────────────
    for (const todo of doneTodos.slice(0, 3)) {
      const review = ctx.ai.isAvailable()
        ? await this.#reviewWithAI(todo, requests, ctx)
        : this.#reviewWithoutAI(todo, requests);

      await board.addComment(todo.id, {
        author: this.name,
        body:   review.comment,
      });
      await board.updatePost(todo.id, {
        meta: { ...todo.meta, jessicaReviewed: true, outcomeScore: review.score },
      });
      this.log(`reviewed outcome of "${todo.title}" (score: ${review.score})`, ctx);
      actions.push({ type: 'outcome-review', postId: todo.id, score: review.score });
    }

    // ── Flag orphaned work ────────────────────────────────────────────────────
    for (const todo of orphaned.slice(0, 2)) {
      const alreadyFlagged = (await board.getComments(todo.id))
        .some(c => c.author === this.name && c.body.includes('traceability'));
      if (alreadyFlagged) continue;

      await board.addComment(todo.id, {
        author: this.name,
        body:   `📊 Jessica: This work doesn't appear to be linked to an open request. **Traceability concern** — was this in scope? If it solves a real user need, please create a matching request in r/requests so we have a record of *why* this was built.`,
      });
      actions.push({ type: 'orphan-flagged', postId: todo.id });
      this.log(`flagged orphaned work: "${todo.title}"`, ctx);
    }

    // ── Escalate stalled requests ─────────────────────────────────────────────
    for (const req of stalledReqs.slice(0, 2)) {
      const alreadyFlagged = (await board.getComments(req.id))
        .some(c => c.author === this.name);
      if (alreadyFlagged) continue;

      const ageWeeks = Math.round((Date.now() - new Date(req.createdAt).getTime()) / ONE_WEEK_MS);
      await board.addComment(req.id, {
        author: this.name,
        body:   `📊 Jessica: This request has been open for **${ageWeeks} weeks** without being picked up for planning. Is this still a priority? If so, comment here to signal urgency. If not, consider closing it to keep the backlog clean.`,
      });
      actions.push({ type: 'stalled-request-flagged', postId: req.id });
      this.log(`flagged stalled request: "${req.title}"`, ctx);
    }

    // ── Weekly product health report ──────────────────────────────────────────
    const lastReport = (await this.recall(5)).find(m => m.type === 'product-report');
    const daysSince  = lastReport
      ? (Date.now() - new Date(lastReport.timestamp)) / 86_400_000
      : Infinity;

    if (daysSince > 6) {
      await this.#postProductReport(board, doneTodos, stalledReqs, ctx);
      await this.remember('product-report', { date: new Date().toISOString() });
      actions.push({ type: 'report-posted' });
    }

    if (!actions.length) this.log('outcomes look aligned — idle', ctx);
    return { outcome: actions.length ? 'reviewed' : 'idle', count: actions.length, actions };
  }

  async #reviewWithAI(todo, requests, ctx) {
    const relatedRequest = requests.find(r =>
      r.id === todo.meta?.requestId ||
      todo.title.toLowerCase().includes(r.title.toLowerCase().slice(0, 20))
    );

    const result = await ctx.ai.askJSON(
      `You are Jessica, a Business Analyst. Review whether this completed work actually solves the original need.

Completed work:
Title: ${todo.title}
Plan: ${todo.body?.slice(0, 500) ?? '(none)'}
${relatedRequest ? `\nOriginal request:\n${relatedRequest.title}\n${relatedRequest.body?.slice(0, 300)}` : '\nNo linked request found.'}

Evaluate:
1. Does the implementation seem to match the request?
2. Is there a clear business outcome?
3. Anything likely missing or misunderstood?

Score 1-5: 5 = excellent outcome alignment, 1 = unclear or misaligned.

Respond with JSON:
{ "score": 1-5, "comment": "📊 Jessica: [your outcome review comment — be constructive, max 3 sentences]" }`,
      { system: 'You are a business analyst. Focus on user outcomes, not code quality. Reply with JSON only.' }
    );
    return result ?? this.#reviewWithoutAI(todo, requests);
  }

  #reviewWithoutAI(todo, requests) {
    const linked = requests.find(r => r.id === todo.meta?.requestId);
    const score  = linked ? 3 : 2;
    const comment = linked
      ? `📊 Jessica: This is linked to request "${linked.title}". Marking as reviewed. *(AI unavailable for outcome analysis.)*`
      : `📊 Jessica: No linked request found for this work item. Please add a \`requestId\` to the post metadata for traceability. *(AI unavailable for outcome analysis.)*`;
    return { score, comment };
  }

  async #postProductReport(board, doneTodos, stalledReqs, ctx) {
    const reportBody = ctx.ai.isAvailable()
      ? await ctx.ai.ask(
          `You are Jessica, a Business Analyst. Write a brief weekly product health report.

Recently completed: ${doneTodos.map(t => t.title).slice(0, 5).join(', ') || 'none'}
Stalled requests (>2 weeks open): ${stalledReqs.map(r => r.title).slice(0, 3).join(', ') || 'none'}

Write a 2-paragraph product health update: what got done, and what concerns you have about backlog health. Be honest but constructive.`,
          { system: 'You are a product-focused business analyst. Write for a human team audience.' }
        )
      : `**Completed this week:** ${doneTodos.length} items\n**Stalled requests:** ${stalledReqs.length} open requests over 2 weeks old`;

    await board.createPost('general', {
      title:  `📊 Weekly Product Health — ${new Date().toLocaleDateString()}`,
      body:   reportBody ?? '',
      author: this.name,
      type:   'announcement',
    });
    this.log('posted weekly product health report', ctx);
  }
}
