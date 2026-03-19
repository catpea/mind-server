/**
 * config.js — Persistent configuration for mind-server.
 *
 * Non-secret settings are stored in <targetDir>/.mind-server/config.json.
 *
 * Config shape:
 * {
 *   "port":      3002,
 *   "ai": {
 *     "model":    "llama3",
 *     "baseUrl":  "http://localhost:11434/v1"
 *   }
 * }
 *
 * Usage:
 *   const cfg = await Config.load(mindDir);
 *   await cfg.set('port', 3003);
 *   console.log(cfg.get('port')); // 3003
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join }                from 'node:path';

const DEFAULTS = {
  port: 3002,
  ai: {
    model:   'llama3',
    baseUrl: 'http://localhost:11434/v1',
  },
};

export class Config {
  #path;
  #data;

  constructor(mindDir, data = {}) {
    this.#path = join(mindDir, 'config.json');
    this.#data = { ...DEFAULTS, ...data, ai: { ...DEFAULTS.ai, ...(data.ai ?? {}) } };
  }

  static async load(mindDir) {
    let data = {};
    try {
      const text = await readFile(join(mindDir, 'config.json'), 'utf8');
      data = JSON.parse(text);
    } catch { /* first run — use defaults */ }
    return new Config(mindDir, data);
  }

  get(key)              { return this.#data[key]; }
  getAI()               { return { ...this.#data.ai }; }
  all()                 { return { ...this.#data }; }

  async set(key, value) {
    this.#data[key] = value;
    await this.#save();
  }

  async merge(updates) {
    if (updates.ai) {
      this.#data.ai = { ...this.#data.ai, ...updates.ai };
      delete updates.ai;
    }
    Object.assign(this.#data, updates);
    await this.#save();
  }

  async #save() {
    await writeFile(this.#path, JSON.stringify(this.#data, null, 2));
  }

  /**
   * Watch config.json for changes and call callback(newConfig) when it changes.
   * Returns an unwatch function.
   * Debounced 200ms to avoid double-fires on save.
   */
  watch(callback) {
    import('node:fs').then(({ watch }) => {
      let debounce = null;
      const watcher = watch(this.#path, () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          try {
            const text = await readFile(this.#path, 'utf8');
            const data = JSON.parse(text);
            this.#data = { ...DEFAULTS, ...data, ai: { ...DEFAULTS.ai, ...(data.ai ?? {}) } };
            callback(this.#data);
          } catch { /* ignore malformed config during save */ }
        }, 200);
      });
      this._watcher = watcher; // store for unwatch
    }).catch(() => {}); // fs.watch might not be available
    return () => this._watcher?.close();
  }
}
