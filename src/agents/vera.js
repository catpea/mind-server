/**
 * vera.js — Vera, the dispatcher.
 *
 * Role: Reads the board and coordinates the other agents.
 * She doesn't write code or plan features — she makes sure work flows.
 *
 * What she does each cycle:
 *   1. Reads board summary (open/planned/in-progress/review counts)
 *   2. Reads recent agent activity from SSE log / board comments
 *   3. Decides which agent should act next
 *   4. Creates a dispatch post in r/dispatch (or DMs the agent)
 *   5. When AI available: uses Claude to reason about board state
 *      When AI not available: applies simple heuristic rules
 *
 * Heuristic (no AI):
 *   - open requests with no todo → Monica
 *   - todos in planned/open state → Erica
 *   - todos in review state → Rita
 *   - no quality scan recently → Sandra
 *   - otherwise → idle
 */

import { BaseAgent } from './base.js';

export class Vera extends BaseAgent {
  name        = 'vera';
  description = 'Dispatcher and orchestrator. Reads the board and coordinates the team.';
  avatar      = '🦉';
  role        = 'dispatcher';

  async think(ctx) {
    const { board } = ctx;
    const summary   = await board.summary();
    const recent    = await this.recall(10);

    // Count actionable states
    const open       = summary.byStatus.open        ?? 0;
    const planned    = summary.byStatus.planned      ?? 0;
    const inProgress = summary.byStatus['in-progress'] ?? 0;
    const review     = summary.byStatus.review       ?? 0;
    const done       = summary.byStatus.done         ?? 0;

    // Get request posts (unplanned user requests)
    const requestPosts = await board.getPosts('requests').catch(() => []);
    const unplanned    = requestPosts.filter(p => p.status === 'open');

    // Get todo posts
    const todoPosts = await board.getPosts('todo').catch(() => []);
    const needsWork = todoPosts.filter(p => ['open', 'planned'].includes(p.status));
    const inReview  = todoPosts.filter(p => p.status === 'review');

    // When was Sandra last active?
    const lastScan = recent.find(m => m.content?.dispatch === 'sandra');
    const hoursSinceScan = lastScan
      ? (Date.now() - new Date(lastScan.timestamp)) / 3_600_000
      : Infinity;

    let dispatch = null;
    let reason   = '';

    if (ctx.ai.isAvailable()) {
      // Let Claude decide
      const recentStr = recent.map(m => `${m.timestamp}: ${m.type} ${JSON.stringify(m.content)}`).join('\n');
      const prompt = `You are Vera, the dispatcher for a software development team of AI agents.

Board state:
- Unplanned requests (needs Monica): ${unplanned.length}
- Todo items needing implementation (needs Erica): ${needsWork.length}
- Items in review (needs Rita): ${inReview.length}
- Hours since last quality scan: ${hoursSinceScan.toFixed(1)}

Your recent actions:
${recentStr || '(none)'}

Agents available: monica (planner), erica (implementer), rita (reviewer), sandra (QA scanner)

Respond with JSON: { "dispatch": "<agentName or null>", "reason": "<one sentence>" }
Dispatch null if all is idle or you dispatched this agent recently.`;

      const result = await ctx.ai.askJSON(prompt, { system: 'You coordinate a software development team. Reply with only JSON.' });
      if (result) {
        dispatch = result.dispatch;
        reason   = result.reason;
      }
    }

    // Heuristic fallback
    if (!dispatch) {
      if (unplanned.length > 0)       { dispatch = 'monica';  reason = `${unplanned.length} unplanned request(s)`; }
      else if (needsWork.length > 0)  { dispatch = 'erica';   reason = `${needsWork.length} todo(s) need implementation`; }
      else if (inReview.length > 0)   { dispatch = 'rita';    reason = `${inReview.length} item(s) in review`; }
      else if (hoursSinceScan > 2)    { dispatch = 'sandra';  reason = `no quality scan in ${hoursSinceScan.toFixed(0)}h`; }
    }

    return { dispatch, reason, summary };
  }

  async act(plan, ctx) {
    const { board } = ctx;
    const actions   = [];

    if (!plan.dispatch) {
      this.log('board is clear — nothing to dispatch', ctx);
      return { outcome: 'idle', actions };
    }

    this.log(`dispatching ${plan.dispatch} — ${plan.reason}`, ctx);

    // Post a dispatch notice so humans can see what's happening
    await board.ensureSub('dispatch');
    const post = await board.createPost('dispatch', {
      title:  `Dispatch: ${plan.dispatch}`,
      body:   plan.reason,
      author: this.name,
      type:   'announcement',
    });

    // DM the agent
    await board.sendDM({
      from:    this.name,
      to:      plan.dispatch,
      subject: 'Run request',
      body:    plan.reason,
      meta:    { dispatchPostId: post.id },
    });

    await this.remember('dispatch', { dispatch: plan.dispatch, reason: plan.reason });
    actions.push({ type: 'dispatch', agent: plan.dispatch, reason: plan.reason });

    return { outcome: 'dispatched', dispatch: plan.dispatch, actions };
  }
}
