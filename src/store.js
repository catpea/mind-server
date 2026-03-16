/**
 * store.js — UUID-file event store (und-inspired).
 *
 * Each record lives in its own directory as a series of revision files:
 *
 *   <dataDir>/<collection>/<id>/<rev>-<uuid>.json
 *
 * - No in-memory DB, no snapshots, no ORMs.
 * - Thread-safe: two concurrent writes produce two separate UUID files.
 *   Same revision number → conflict signal (detectable, not fatal).
 * - Current state = last file in alphanumeric-sorted listing.
 * - Soft-delete: write a tombstone `{ id, _deleted: true }`.
 * - Human-readable: every record is plain JSON on disk.
 *
 * Usage:
 *   const store = new Store('./data');
 *   const post = await store.put('posts', { id: 'abc', title: 'Hello' });
 *   const latest = await store.get('posts', 'abc');
 *   const all = await store.all('posts');  // [{ id, ... }, ...]
 *   const exists = await store.has('posts', 'abc');
 */

import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  #dataDir;

  constructor(dataDir) {
    this.#dataDir = resolve(dataDir);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  #collectionDir(collection) {
    return join(this.#dataDir, collection);
  }

  #objectDir(collection, id) {
    return join(this.#dataDir, collection, id);
  }

  async #ensureDir(dir) {
    await mkdir(dir, { recursive: true });
  }

  /** Alphanum sort: '10-x' > '9-x' because we zero-pad revisions. */
  #sortFiles(files) {
    return files.slice().sort((a, b) => {
      const ra = parseInt(a.split('-')[0], 10);
      const rb = parseInt(b.split('-')[0], 10);
      return ra - rb;
    });
  }

  async #latestFile(collection, id) {
    const dir = this.#objectDir(collection, id);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return null;
    }
    if (!files.length) return null;
    return this.#sortFiles(files).at(-1);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Check whether a record exists (has at least one revision file).
   */
  async has(collection, id) {
    const file = await this.#latestFile(collection, id);
    return file !== null;
  }

  /**
   * Get the current revision of a record, or null if it doesn't exist.
   * Returns null for soft-deleted records (_deleted: true).
   */
  async get(collection, id) {
    const file = await this.#latestFile(collection, id);
    if (!file) return null;
    const text = await readFile(join(this.#objectDir(collection, id), file), 'utf8');
    const data = JSON.parse(text);
    return data._deleted ? null : data;
  }

  /**
   * Write a new revision of a record.
   * data.id is required. Increments rev automatically.
   * Returns the saved record (with rev + uid fields added).
   */
  async put(collection, data) {
    if (!data?.id) throw new Error('store.put: data.id is required');

    const dir = this.#objectDir(collection, data.id);
    await this.#ensureDir(dir);

    // Determine next revision
    let rev = 0;
    const latest = await this.#latestFile(collection, data.id);
    if (latest) {
      rev = parseInt(latest.split('-')[0], 10);
    }
    rev += 1;

    const uid = randomUUID();
    const record = { ...data, rev, uid, updatedAt: data.updatedAt ?? new Date().toISOString() };
    if (!data.createdAt) record.createdAt = record.updatedAt;

    // Zero-pad rev to 8 digits for correct alphanumeric sort
    const filename = `${String(rev).padStart(8, '0')}-${uid}.json`;
    await writeFile(join(dir, filename), JSON.stringify(record, null, 2));

    return record;
  }

  /**
   * Soft-delete a record by writing a tombstone revision.
   */
  async del(collection, id) {
    return this.put(collection, { id, _deleted: true });
  }

  /**
   * List all live (non-deleted) records in a collection.
   * Expensive on large collections — use sparingly or cache at board level.
   */
  async all(collection) {
    const dir = this.#collectionDir(collection);
    let ids;
    try {
      ids = await readdir(dir);
    } catch {
      return [];
    }

    const results = await Promise.all(ids.map(id => this.get(collection, id)));
    return results.filter(Boolean);
  }

  /**
   * List all IDs in a collection (including deleted ones).
   */
  async ids(collection) {
    const dir = this.#collectionDir(collection);
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  /**
   * List all revisions of a record (for audit/debug).
   * Returns array of { rev, uid, filename, data } sorted oldest→newest.
   */
  async revisions(collection, id) {
    const dir = this.#objectDir(collection, id);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const sorted = this.#sortFiles(files);
    return Promise.all(sorted.map(async filename => {
      const text = await readFile(join(dir, filename), 'utf8');
      return { filename, data: JSON.parse(text) };
    }));
  }
}
