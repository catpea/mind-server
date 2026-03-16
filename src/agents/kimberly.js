/**
 * kimberly.js — Kimberly, the Engineering Manager.
 *
 * Role: Removes blockers, tracks delivery, and protects the team from chaos.
 * Kimberly doesn't write code — she creates the conditions for others to work.
 *
 * What she does:
 *   - Reads the board for stuck work (in-progress > 24h without a comment)
 *   - Posts a daily standup summary to r/general
 *   - Identifies agents with large queues and asks Vera to redistribute
 *   - Flags posts that have been open too long without progress
 *   - Escalates security findings that nobody has addressed
 *
 * She is the human-facing layer of the agent team — her posts are
 * written for human readers, not other agents.
 */

import { BaseAgent } from './base.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class Kimberly extends BaseAgent {
  name        = 'kimberly';
  description = 'Engineering Manager. Removes blockers, tracks delivery, posts daily standups.';
  avatar      = '👔';
  role        = 'engineering-manager';

  async think(ctx) {
    const { board } = ctx;

    const allPosts = await board.getAllPosts({ limit: 200 }).catch(() => []);
    const now      = Date.now();

    const stalled = allPosts.filter(p => {
      if (!['open', 'planned', 'in-progress'].includes(p.status)) return false;
      const age = now - new Date(p.updatedAt ?? p.createdAt).getTime();
      return age > ONE_DAY_MS;
    });

    const summary = await board.summary();

    const securityOpen = (await board.getPosts('security', { status: 'open' }).catch(() => []))
      .filter(p => p.meta?.severity === 'error' || p.meta?.threatLevel === 'critical');

    return { stalled, summary, securityOpen };
  }

  async act(plan, ctx) {
    const { board }                      = ctx;
    const { stalled, summary, securityOpen } = plan;
    const actions                        = [];

    // ── Daily standup ────────────────────────────────────────────────────────
    const lastStandup = (await this.recall(5)).find(m => m.type === 'standup');
    const hoursSince  = lastStandup
      ? (Date.now() - new Date(lastStandup.timestamp)) / 3_600_000
      : Infinity;

    if (hoursSince > 20) {
      const standup = await this.#buildStandup(summary, stalled, securityOpen, ctx);
      await board.createPost('general', {
        title:  `📋 Daily Standup — ${new Date().toLocaleDateString()}`,
        body:   standup,
        author: this.name,
        type:   'announcement',
      });
      await this.remember('standup', { date: new Date().toISOString() });
      actions.push({ type: 'standup-posted' });
      this.log('posted daily standup', ctx);
    }

    // ── Flag stalled work ────────────────────────────────────────────────────
    for (const post of stalled.slice(0, 3)) {
      const ageH = Math.round((Date.now() - new Date(post.updatedAt ?? post.createdAt)) / 3_600_000);
      const existing = (await board.getComments(post.id))
        .some(c => c.author === this.name && c.body.includes('stalled'));
      if (existing) continue;

      await board.addComment(post.id, {
        author: this.name,
        body:   `👔 Kimberly: This item has been in **${post.status}** for ${ageH}h without activity. Is there a blocker? If so, post it in r/general and I'll help remove it.`,
      });
      actions.push({ type: 'blocker-flagged', postId: post.id });
    }

    // ── Escalate unaddressed critical security ───────────────────────────────
    for (const sec of securityOpen.slice(0, 2)) {
      const ageH = Math.round((Date.now() - new Date(sec.createdAt)) / 3_600_000);
      if (ageH < 2) continue;
      const hasKimberlyComment = (await board.getComments(sec.id))
        .some(c => c.author === this.name);
      if (hasKimberlyComment) continue;

      await board.addComment(sec.id, {
        author: this.name,
        body:   `👔 Kimberly escalation: This is a **${sec.meta?.threatLevel ?? 'high'}-priority** security finding that has been open for ${ageH}h. Angela and the team should address this before new features ship.`,
      });
      actions.push({ type: 'security-escalated', postId: sec.id });
    }

    if (!actions.length) this.log('team is healthy — idle', ctx);
    return { outcome: actions.length ? 'managed' : 'idle', actions };
  }

  async #buildStandup(summary, stalled, securityOpen, ctx) {
    const byStatus = summary.byStatus;
    const base = [
      '## Yesterday / Today / Blockers\n',
      `**Board Health**`,
      `| Status | Count |`,
      `|--------|-------|`,
      ...Object.entries(byStatus).map(([k, v]) => `| ${k} | ${v} |`),
      '',
      `**Stalled items:** ${stalled.length}`,
      `**Open security findings:** ${securityOpen.length}`,
    ].join('\n');

    if (ctx.ai.isAvailable() && stalled.length > 0) {
      const insight = await ctx.ai.ask(
        `You are Kimberly, an engineering manager. Write a one-paragraph standup summary.
Board: ${JSON.stringify(byStatus)}
Stalled items: ${stalled.map(p => p.title).slice(0, 5).join(', ')}
Security open: ${securityOpen.length}
Be brief, actionable, and encouraging.`,
        { system: 'You are a supportive engineering manager. One paragraph, plain text, no markdown headers.' }
      );
      return base + '\n\n' + (insight ?? '');
    }

    return base;
  }
}
