/**
 * board.js — Reddit-like discussion board built on the Store.
 *
 * Concepts:
 *
 *   Subreddit  — a named channel. Name can contain slashes (e.g. 'u/vera').
 *                Stored as collection 'subs', id = slugified name.
 *
 *   Post       — a thread in a subreddit. Has a status lifecycle:
 *                open → planned → in-progress → review → done
 *                Stored as collection 'posts'.
 *
 *   Comment    — a reply to a post. Stored as collection 'comments'.
 *
 *   DM         — private message between two agents/users.
 *                Supports threaded conversations via threadId + replyToId.
 *                - threadId: ID of the first message in a conversation thread.
 *                            All replies in the same thread share this ID.
 *                - replyToId: ID of the specific message being replied to.
 *                A DM with no replyToId starts a new thread (threadId = own id).
 *                Stored as collection 'dms'.
 *
 * All writes go through Board methods so SSE events are emitted automatically.
 *
 * Usage:
 *   const board = new Board(store, hub);
 *   const post = await board.createPost('general', { title: 'Hello', author: 'vera' });
 *   const posts = await board.getPosts('general');
 *   await board.advanceStatus(post.id, 'in-progress');
 *
 *   // Start a conversation:
 *   const dm  = await board.sendDM({ from: 'erica', to: 'rita', subject: 'Quick question', body: '...' });
 *   // Reply continues the thread:
 *   await board.replyToDM(dm.id, { from: 'rita', body: 'Yes, that looks right.' });
 *   // Read the full conversation:
 *   const thread = await board.getDMThread(dm.id);
 */

import { randomUUID } from 'node:crypto';

export const POST_STATUSES = [
  'open', 'planned', 'awaiting-approval', 'approved',
  'in-progress', 'review', 'done', 'wont-fix',
];

/**
 * Valid status transitions.
 * advanceStatus() enforces this graph — no agent can skip steps or create
 * nonsensical state changes.
 *
 * Intentionally permissive where the workflow needs it (e.g. in-progress →
 * open allows reverting an accidental pick-up) but tight enough to catch bugs.
 */
const STATUS_TRANSITIONS = {
  'open':              new Set(['planned', 'awaiting-approval', 'approved', 'in-progress', 'wont-fix']),
  'planned':           new Set(['open', 'approved', 'in-progress', 'wont-fix']),
  'awaiting-approval': new Set(['approved', 'open', 'wont-fix']),
  'approved':          new Set(['in-progress', 'planned', 'open', 'wont-fix']),
  'in-progress':       new Set(['review', 'open', 'planned', 'wont-fix']),
  'review':            new Set(['done', 'in-progress', 'open', 'wont-fix']),
  'done':              new Set(['open']),       // allow re-open
  'wont-fix':          new Set(['open']),       // allow re-open
};

export class Board {
  #store;
  #hub;
  #writeListeners = new Set();

  constructor(store, hub) {
    this.#store = store;
    this.#hub   = hub;
  }

  /**
   * Register a callback fired after any post create/update.
   * Used by the Scheduler for event-driven dispatch.
   * Returns an unsubscribe function.
   */
  onWrite(cb) {
    this.#writeListeners.add(cb);
    return () => this.#writeListeners.delete(cb);
  }

  #notifyWrite(event, data) {
    for (const cb of this.#writeListeners) {
      try { cb(event, data); } catch { /* listener errors must not crash the board */ }
    }
  }

  // ── Subreddits ─────────────────────────────────────────────────────────────

  /**
   * Normalize a subreddit name to a safe filesystem storage ID.
   * Encodes slashes as '%2F' (hex percent-encoding) — collision-free unlike '__'.
   * 'u/my__test' and 'u__my/test' previously both mapped to 'u__my__test'.
   */
  subId(name) {
    return name.replace(/\//g, '%2F');
  }

  /** Reverse of subId. */
  subName(id) {
    return id.replace(/%2F/g, '/');
  }

  async ensureSub(name) {
    const id = this.subId(name);
    const existing = await this.#store.get('subs', id);
    if (existing) return existing;
    const sub = await this.#store.put('subs', {
      id,
      name,
      createdAt: new Date().toISOString(),
    });
    this.#hub.broadcast('sub:created', sub);
    return sub;
  }

  async getSub(name) {
    return this.#store.get('subs', this.subId(name));
  }

  async listSubs() {
    const all = await this.#store.all('subs');
    // Restore real name for display
    return all.map(s => ({ ...s, name: this.subName(s.id) }));
  }

  // ── Posts ──────────────────────────────────────────────────────────────────

  async createPost(subName, { title, body = '', author, type = 'discussion', meta = {} } = {}) {
    await this.ensureSub(subName);
    const post = await this.#store.put('posts', {
      id:     randomUUID(),
      sub:    subName,
      title,
      body,
      author,
      type,   // 'discussion' | 'todo' | 'quality' | 'announcement'
      status: 'open',
      meta,
    });
    this.#hub.broadcast('post:created', post);
    this.#notifyWrite('post:created', post);
    return post;
  }

  async getPost(id) {
    return this.#store.get('posts', id);
  }

  async updatePost(id, patch) {
    const existing = await this.#store.get('posts', id);
    if (!existing) throw new Error(`Post not found: ${id}`);

    // Enforce the state machine whenever a status change is requested,
    // even via the raw updatePost() path (e.g. direct API PATCH calls).
    if (patch.status !== undefined && patch.status !== existing.status) {
      if (!POST_STATUSES.includes(patch.status)) {
        throw new Error(`Invalid status: "${patch.status}". Valid: ${POST_STATUSES.join(', ')}`);
      }
      const allowed = STATUS_TRANSITIONS[existing.status];
      if (allowed && !allowed.has(patch.status)) {
        throw new Error(
          `Invalid transition: "${existing.status}" → "${patch.status}". ` +
          `Allowed from "${existing.status}": ${[...allowed].join(', ')}`,
        );
      }
    }

    const updated = await this.#store.put('posts', { ...existing, ...patch, id });
    this.#hub.broadcast('post:updated', updated);
    this.#notifyWrite('post:updated', updated);
    return updated;
  }

  async advanceStatus(id, newStatus, { author, comment } = {}) {
    if (!POST_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status: "${newStatus}". Valid: ${POST_STATUSES.join(', ')}`);
    }
    const current = await this.getPost(id);
    if (!current) throw new Error(`Post not found: ${id}`);

    const allowed = STATUS_TRANSITIONS[current.status];
    if (allowed && !allowed.has(newStatus)) {
      throw new Error(
        `Invalid transition: "${current.status}" → "${newStatus}". ` +
        `Allowed from "${current.status}": ${[...allowed].join(', ')}`,
      );
    }

    const post = await this.updatePost(id, { status: newStatus });
    if (comment) {
      await this.addComment(id, { author, body: comment });
    }
    return post;
  }

  async getPosts(subName, { status, type, author, limit = 100, offset = 0 } = {}) {
    const all = await this.#store.all('posts');
    let posts = all.filter(p => p.sub === subName);
    if (status) posts = posts.filter(p => p.status === status);
    if (type)   posts = posts.filter(p => p.type === type);
    if (author) posts = posts.filter(p => p.author === author);
    // Sort: open/planned first, then by createdAt desc
    posts.sort((a, b) => {
      const ai = POST_STATUSES.indexOf(a.status);
      const bi = POST_STATUSES.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    return posts.slice(offset, offset + limit);
  }

  async getAllPosts({ status, type, limit = 500 } = {}) {
    const all = await this.#store.all('posts');
    let posts = all;
    if (status) posts = posts.filter(p => p.status === status);
    if (type)   posts = posts.filter(p => p.type === type);
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return posts.slice(0, limit);
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async addComment(postId, { author, body, meta = {} } = {}) {
    const comment = await this.#store.put('comments', {
      id:     randomUUID(),
      postId,
      author,
      body,
      meta,
    });
    this.#hub.broadcast('comment:created', comment);
    return comment;
  }

  async getComments(postId) {
    const all = await this.#store.all('comments');
    return all
      .filter(c => c.postId === postId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  // ── DMs ───────────────────────────────────────────────────────────────────

  /**
   * Send a DM. Optionally reply to an existing message.
   *
   * @param {object} opts
   * @param {string}  opts.from
   * @param {string}  opts.to
   * @param {string}  [opts.subject]
   * @param {string}  opts.body
   * @param {object}  [opts.meta]
   * @param {string}  [opts.replyToId]  — ID of the message being replied to.
   *                                      Sets threadId automatically.
   */
  async sendDM({ from, to, subject = '', body, meta = {}, replyToId } = {}) {
    const id = randomUUID();

    // Compute threadId: inherit from parent, or start a new thread
    let threadId = id;
    if (replyToId) {
      const parent = await this.#store.get('dms', replyToId);
      threadId = parent?.threadId ?? replyToId;
    }

    const dm = await this.#store.put('dms', {
      id,
      from,
      to,
      subject,
      body,
      read:      false,
      threadId,
      replyToId: replyToId ?? null,
      meta,
    });
    this.#hub.broadcast('dm:sent', dm);
    this.#notifyWrite('dm:sent', dm);
    return dm;
  }

  /**
   * Reply to an existing DM, continuing its thread.
   * The reply goes back to the original sender.
   */
  async replyToDM(dmId, { from, body, meta = {} } = {}) {
    const original = await this.#store.get('dms', dmId);
    if (!original) throw new Error(`DM not found: ${dmId}`);
    const subject = original.subject.startsWith('Re: ')
      ? original.subject
      : `Re: ${original.subject}`;
    return this.sendDM({
      from,
      to:        original.from,
      subject,
      body,
      replyToId: dmId,
      meta:      { ...meta, isReply: true },
    });
  }

  /**
   * Get all DMs in a conversation thread (sorted oldest → newest).
   * Pass any message ID from the thread — it will find all siblings.
   */
  async getDMThread(dmId) {
    const dm = await this.#store.get('dms', dmId);
    if (!dm) return [];
    const threadId = dm.threadId ?? dmId;
    const all = await this.#store.all('dms');
    return all
      .filter(d => (d.threadId ?? d.id) === threadId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async getDMs({ to, from, unreadOnly = false } = {}) {
    const all = await this.#store.all('dms');
    let dms = all;
    if (to)   dms = dms.filter(d => d.to === to);
    if (from) dms = dms.filter(d => d.from === from);
    if (unreadOnly) dms = dms.filter(d => !d.read);
    return dms.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async markDMRead(id) {
    const dm = await this.#store.get('dms', id);
    if (!dm) throw new Error(`DM not found: ${id}`);
    return this.#store.put('dms', { ...dm, read: true });
  }

  // ── Board summary ─────────────────────────────────────────────────────────

  /**
   * High-level board summary — used by agents for situational awareness.
   * Returns counts by status + recent activity.
   */
  async summary() {
    const posts    = await this.getAllPosts({ limit: 1000 });
    const subs     = await this.listSubs();
    const counts   = {};
    for (const s of POST_STATUSES) counts[s] = 0;
    for (const p of posts) counts[p.status] = (counts[p.status] ?? 0) + 1;

    const recent = posts
      .filter(p => p.status !== 'done' && p.status !== 'wont-fix')
      .slice(0, 10)
      .map(p => ({ id: p.id, sub: p.sub, title: p.title, status: p.status, author: p.author }));

    return {
      postCount:  posts.length,
      subCount:   subs.length,
      byStatus:   counts,
      recent,
    };
  }

  /**
   * Front page: top open/in-progress posts across all subs, formatted as markdown.
   */
  async frontPage() {
    const posts = await this.getAllPosts({ limit: 20 });
    const active = posts.filter(p => p.status !== 'done' && p.status !== 'wont-fix');
    if (!active.length) return '*(no active posts)*';

    const lines = ['# Front Page\n'];
    for (const p of active) {
      const badge = `[${p.status}]`;
      lines.push(`- **${badge}** r/${p.sub} — ${p.title} *(${p.author})*`);
    }
    return lines.join('\n');
  }
}
