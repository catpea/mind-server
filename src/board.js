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
 *                Stored as collection 'dms'.
 *
 *   Vote       — upvote/downvote on a post. Stored as collection 'votes'.
 *
 * All writes go through Board methods so SSE events are emitted automatically.
 *
 * Usage:
 *   const board = new Board(store, hub);
 *   const post = await board.createPost('general', { title: 'Hello', author: 'vera' });
 *   const posts = await board.getPosts('general');
 *   await board.advanceStatus(post.id, 'in-progress');
 */

import { randomUUID } from 'node:crypto';

export const POST_STATUSES = ['open', 'planned', 'in-progress', 'review', 'done'];

export class Board {
  #store;
  #hub;

  constructor(store, hub) {
    this.#store = store;
    this.#hub   = hub;
  }

  // ── Subreddits ─────────────────────────────────────────────────────────────

  /** Normalize a subreddit name to a safe storage ID (slashes → '__'). */
  subId(name) {
    return name.replace(/\//g, '__');
  }

  /** Reverse of subId. */
  subName(id) {
    return id.replace(/__/g, '/');
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
      id:      randomUUID(),
      sub:     subName,
      title,
      body,
      author,
      type,    // 'discussion' | 'todo' | 'quality' | 'announcement'
      status:  'open',
      votes:   0,
      meta,
    });
    this.#hub.broadcast('post:created', post);
    return post;
  }

  async getPost(id) {
    return this.#store.get('posts', id);
  }

  async updatePost(id, patch) {
    const existing = await this.#store.get('posts', id);
    if (!existing) throw new Error(`Post not found: ${id}`);
    const updated = await this.#store.put('posts', { ...existing, ...patch, id });
    this.#hub.broadcast('post:updated', updated);
    return updated;
  }

  async advanceStatus(id, newStatus, { author, comment } = {}) {
    if (!POST_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}. Valid: ${POST_STATUSES.join(', ')}`);
    }
    const post = await this.updatePost(id, { status: newStatus });
    if (comment) {
      await this.addComment(id, { author, body: comment });
    }
    return post;
  }

  async getPosts(subName, { status, type, author, limit = 100 } = {}) {
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
    return posts.slice(0, limit);
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

  async sendDM({ from, to, subject = '', body, meta = {} } = {}) {
    const dm = await this.#store.put('dms', {
      id:   randomUUID(),
      from,
      to,
      subject,
      body,
      read: false,
      meta,
    });
    this.#hub.broadcast('dm:sent', dm);
    return dm;
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
      .filter(p => p.status !== 'done')
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
    const active = posts.filter(p => p.status !== 'done');
    if (!active.length) return '*(no active posts)*';

    const lines = ['# Front Page\n'];
    for (const p of active) {
      const badge = `[${p.status}]`;
      lines.push(`- **${badge}** r/${p.sub} — ${p.title} *(${p.author})*`);
    }
    return lines.join('\n');
  }
}
