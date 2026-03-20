/**
 * vera.js — Vera, the dispatcher.
 *
 * Role: Reads the board and coordinates the other agents.
 * She doesn't write code or plan features — she makes sure work flows.
 *
 * What she does each cycle:
 *   1. Reads board summary (open/planned/in-progress/review counts)
 *   2. Reads recent agent activity from memory + scratchpad
 *   3. Decides which agent(s) should act next — may dispatch multiple in parallel
 *      when queues are independent (e.g. Amy reviewing requests + Erica implementing)
 *   4. Creates a dispatch post in r/dispatch and DMs each dispatched agent
 *   5. When AI available: uses Claude to reason about board state
 *      When AI not available: applies simple heuristic rules
 *
 * Multi-dispatch:
 *   When multiple independent queues need attention Vera may return an array of
 *   agent names. The scheduler runs them with Promise.all. Vera only dispatches
 *   agents that are genuinely independent — she never dispatches two agents that
 *   write to the same post.
 *
 * Heuristic (no AI):
 *   - open requests with no todo → Amy
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

    // When was Sandra last scanned?
    // Memory may store `dispatched: ['sandra', ...]` (new) or `dispatch: 'sandra'` (old) — handle both.
    const lastScan = recent.find(m => {
      const dispatched = m.content?.dispatched
        ?? (m.content?.dispatch ? [m.content.dispatch] : []);
      return dispatched.includes('sandra');
    });
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
      const recentStr = recent.map(m => {
        const d = m.content?.dispatched ?? (m.content?.dispatch ? [m.content.dispatch] : []);
        return `${m.timestamp}: ${m.type} dispatched=[${d.join(',')}]`;
      }).join('\n');
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

Your recent dispatches:
${recentStr || '(none)'}${scratchSection}

Agents available: amy (PM/triage), monica (planner), erica (implementer), rita (reviewer), sandra (QA scanner)

You may dispatch a SINGLE agent or MULTIPLE independent agents that can safely run in parallel.
- Safe to parallelise: amy + monica, amy + erica, monica + rita
- Do NOT parallelise: erica + rita (rita reviews erica's work), two agents on same post

Respond with JSON: { "dispatch": "<name>" | ["<name1>","<name2>"], "reason": "<one sentence>" }
Dispatch null if all is idle or you dispatched this agent recently.`;

      const result = await ctx.ai.fast.askJSON(prompt, { system: 'You are Vera, an orchestrator. Pick the right agent(s) to run next. Reply with only JSON.' });
      if (result) {
        dispatch = result.dispatch;
        reason   = result.reason;
      }
    }

    // Heuristic fallback (single dispatch — conservative when AI is unavailable)
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

    // Normalise to array — Vera may dispatch one or several agents in parallel.
    const dispatches = Array.isArray(plan.dispatch)
      ? plan.dispatch.filter(Boolean)
      : [plan.dispatch].filter(Boolean);

    if (dispatches.length === 0) {
      this.log('board is clear — nothing to dispatch', ctx);
      return { outcome: 'idle', actions };
    }

    const label = dispatches.join(', ');
    this.log(`dispatching ${label} — ${plan.reason}`, ctx);

    // Post one dispatch notice listing all dispatched agents
    await board.ensureSub(SUBS.DISPATCH);
    const post = await board.createPost(SUBS.DISPATCH, {
      title:  `Dispatch: ${label}`,
      body:   plan.reason,
      author: this.name,
      type:   'announcement',
    });

    // Send individual DMs to each dispatched agent
    for (const name of dispatches) {
      await board.sendDM({
        from:    this.name,
        to:      name,
        subject: 'Run request',
        body:    plan.reason,
        meta:    { [META.DISPATCH_POST_ID]: post.id },
      });
      actions.push({ type: 'dispatch', agent: name, reason: plan.reason });
    }

    // Store as `dispatched: string[]` — new format. Old code that looks for
    // `dispatch: 'name'` is handled in think() with a backward-compat lookup.
    await this.remember('dispatch', { dispatched: dispatches, reason: plan.reason });

    return { outcome: 'dispatched', dispatch: dispatches, actions };
  }
}
