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
import { SUBS, STATUS, META, AMY_STATUS } from '../board-schema.js';

export class Vera extends BaseAgent {
  static priority = 2;
  name        = 'vera';
  description = 'Dispatcher and orchestrator. Reads the board and coordinates the team.';
  avatar      = '🦉';
  role        = 'dispatcher';

  async think(ctx) {
    const { board } = ctx;
    const summary    = await board.summary();
    const recent     = await this.recall(10);
    const scratchpad = await this.readScratchpad();

    // Count actionable states
    const open       = summary.byStatus.open        ?? 0;
    const planned    = summary.byStatus.planned      ?? 0;
    const inProgress = summary.byStatus['in-progress'] ?? 0;
    const review     = summary.byStatus.review       ?? 0;
    const done       = summary.byStatus.done         ?? 0;

    // Get request posts
    const requestPosts   = await board.getPosts(SUBS.REQUESTS).catch(() => []);
    const unreviewed     = requestPosts.filter(p => p.status === STATUS.OPEN && !p.meta?.[META.AMY_REVIEWED]);
    const readyToplan    = requestPosts.filter(p => p.status === STATUS.OPEN && p.meta?.[META.AMY_STATUS] === AMY_STATUS.APPROVED);

    // Get todo posts (skip wont-fix)
    const todoPosts  = await board.getPosts(SUBS.TODO).catch(() => []);
    const needsWork  = todoPosts.filter(p => [STATUS.APPROVED, STATUS.OPEN, STATUS.PLANNED].includes(p.status));
    const inReview   = todoPosts.filter(p => p.status === STATUS.REVIEW);
    const gated      = ctx.gated ?? true;

    // Agents with pending DM questions they need to answer — conversations in flight
    const allDms      = await board.getDMs({}).catch(() => []);
    const unanswered  = allDms.filter(d => d.meta?.requiresReply && !d.read);
    // Group by recipient: { agentName → count }
    const pendingFor  = {};
    for (const dm of unanswered) pendingFor[dm.to] = (pendingFor[dm.to] ?? 0) + 1;
    const conversationAgents = Object.keys(pendingFor); // agents that have questions waiting

    // When was Sandra last active?
    const lastScan = recent.find(m => m.content?.dispatch === 'sandra');
    const hoursSinceScan = lastScan
      ? (Date.now() - new Date(lastScan.timestamp)) / 3_600_000
      : Infinity;

    let dispatch = null;
    let reason   = '';

    // Conversations in flight take highest priority — dispatch whoever has a pending question
    if (conversationAgents.length > 0) {
      dispatch = conversationAgents[0];
      const asker = unanswered.find(d => d.to === dispatch)?.from ?? 'a peer';
      reason   = `${asker} is waiting for a reply from ${dispatch} (${pendingFor[dispatch]} question(s))`;
    }

    if (!dispatch && ctx.ai.isAvailable()) {
      const recentStr = recent.map(m => `${m.timestamp}: ${m.type} ${JSON.stringify(m.content)}`).join('\n');
      const pendingStr = conversationAgents.length
        ? `\n- Active DM conversations waiting for reply: ${conversationAgents.map(a => `${a}(${pendingFor[a]})`).join(', ')}`
        : '';
      const scratchSection = scratchpad
        ? `\n## Shared Scratchpad (agent working notes)\n${scratchpad.slice(0, 1000)}\n`
        : '';

      const prompt = `You are Vera, the dispatcher for a software development team of AI agents.

Board state:
- Requests needing Amy's review: ${unreviewed.length}
- Requests approved for planning (needs Monica): ${readyToplan.length}
- Todo items needing implementation (needs Erica): ${needsWork.length}
- Items in review (needs Rita): ${inReview.length}
- Hours since last quality scan: ${hoursSinceScan.toFixed(1)}
- Approval gate active: ${gated}${pendingStr}

Your recent actions:
${recentStr || '(none)'}${scratchSection}

Agents available: amy (PM/triage), monica (planner), erica (implementer), rita (reviewer), sandra (QA scanner)

Respond with JSON: { "dispatch": "<agentName or null>", "reason": "<one sentence>" }
Dispatch null if all is idle or you dispatched this agent recently.`;

      const result = await ctx.ai.fast.askJSON(prompt, { system: 'You are Vera, an orchestrator. Pick the right agent to run next. Reply with only JSON.' });
      if (result) {
        dispatch = result.dispatch;
        reason   = result.reason;
      }
    }

    // Heuristic fallback
    if (!dispatch) {
      if (unreviewed.length > 0)      { dispatch = 'amy';    reason = `${unreviewed.length} unreviewed request(s)`; }
      else if (readyToplan.length > 0){ dispatch = 'monica'; reason = `${readyToplan.length} approved request(s) ready to plan`; }
      else if (needsWork.length > 0)  { dispatch = 'erica';  reason = `${needsWork.length} todo(s) need implementation`; }
      else if (inReview.length > 0)   { dispatch = 'rita';   reason = `${inReview.length} item(s) in review`; }
      else if (hoursSinceScan > 2)    { dispatch = 'sandra'; reason = `no quality scan in ${hoursSinceScan.toFixed(0)}h`; }
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
    await board.ensureSub(SUBS.DISPATCH);
    const post = await board.createPost(SUBS.DISPATCH, {
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
      meta:    { [META.DISPATCH_POST_ID]: post.id },
    });

    await this.remember('dispatch', { dispatch: plan.dispatch, reason: plan.reason });
    actions.push({ type: 'dispatch', agent: plan.dispatch, reason: plan.reason });

    return { outcome: 'dispatched', dispatch: plan.dispatch, actions };
  }
}
