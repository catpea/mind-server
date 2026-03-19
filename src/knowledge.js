/**
 * knowledge.js — Cross-project persistent knowledge base.
 *
 * Stores patterns, decisions, and lessons learned across all projects in
 * ~/.mind-server/knowledge/ as NDJSON files (one per project directory).
 *
 * Entry format: { id, projectDir, agentName, type, title, body, tags[], createdAt }
 *
 * Types:
 *   'pattern'      — a reusable code/design pattern Erica solved
 *   'security'     — a security rule Bobby discovered or enforced
 *   'anti-pattern' — a mistake Rita keeps seeing
 *   'decision'     — an architectural decision Heather made
 *   'lesson'       — anything else worth remembering
 *
 * Usage:
 *   const kb = new Knowledge(os.homedir());
 *   await kb.write({ projectDir, agentName: 'erica', type: 'pattern', title, body, tags });
 *   const results = await kb.search('express auth middleware', ['security']);
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync }                           from 'node:fs';
import { join }                                 from 'node:path';
import { randomUUID }                           from 'node:crypto';

export class Knowledge {
  #dir;

  constructor(homeDir) {
    this.#dir = join(homeDir, '.mind-server', 'knowledge');
  }

  /** Return the NDJSON file path for a given projectDir. */
  #filePath(projectDir) {
    return join(this.#dir, `${encodeURIComponent(projectDir)}.ndjson`);
  }

  /** Read all entries from a single NDJSON file. Returns []. */
  async #readFile(filePath) {
    if (!existsSync(filePath)) return [];
    try {
      const text = await readFile(filePath, 'utf8');
      return text
        .split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Read all entries across all project files. */
  async #readAll() {
    let files = [];
    try {
      files = (await readdir(this.#dir)).filter(f => f.endsWith('.ndjson'));
    } catch {
      return [];
    }
    const all = [];
    for (const f of files) {
      const entries = await this.#readFile(join(this.#dir, f));
      all.push(...entries);
    }
    return all;
  }

  /**
   * Append an entry to the knowledge base.
   * Generates id and createdAt automatically if absent.
   *
   * @param {object} entry
   * @param {string} entry.projectDir
   * @param {string} entry.agentName
   * @param {string} entry.type
   * @param {string} entry.title
   * @param {string} entry.body
   * @param {string[]} [entry.tags]
   */
  async write(entry) {
    await mkdir(this.#dir, { recursive: true });
    const record = {
      id:         entry.id        ?? randomUUID(),
      projectDir: entry.projectDir,
      agentName:  entry.agentName,
      type:       entry.type,
      title:      entry.title,
      body:       entry.body,
      tags:       entry.tags      ?? [],
      createdAt:  entry.createdAt ?? new Date().toISOString(),
    };
    const line = JSON.stringify(record) + '\n';
    await writeFile(this.#filePath(entry.projectDir), line, { flag: 'a', encoding: 'utf8' });
    return record;
  }

  /**
   * Search ALL project files for entries relevant to the query.
   * Scoring: +1 per query word found in title/body, +2 per matching tag.
   * Returns top-n sorted by score descending.
   *
   * @param {string}   query
   * @param {string[]} [tags=[]]  — extra tag filters (matching bumps score)
   * @param {number}   [n=20]
   * @returns {Promise<object[]>}
   */
  async search(query, tags = [], n = 20) {
    const words   = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all     = await this.#readAll();

    const scored = all.map(entry => {
      let score = 0;
      const haystack = `${entry.title ?? ''} ${entry.body ?? ''}`.toLowerCase();
      for (const word of words) {
        if (haystack.includes(word)) score += 1;
      }
      const entryTags = (entry.tags ?? []).map(t => t.toLowerCase());
      for (const tag of tags) {
        if (entryTags.includes(tag.toLowerCase())) score += 2;
      }
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map(s => s.entry);
  }

  /**
   * Return the n most recent entries across ALL project files.
   * Sorted by createdAt descending.
   *
   * @param {number} [n=20]
   * @returns {Promise<object[]>}
   */
  async recent(n = 20) {
    const all = await this.#readAll();
    return all
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, n);
  }

  /**
   * Return the n most recent entries for a specific project.
   * Reads only that project's file.
   *
   * @param {string} projectDir
   * @param {number} [n=50]
   * @returns {Promise<object[]>}
   */
  async byProject(projectDir, n = 50) {
    const entries = await this.#readFile(this.#filePath(projectDir));
    return entries
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, n);
  }
}
