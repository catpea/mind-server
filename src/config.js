/**
 * config.js — Persistent configuration for mind-server.
 *
 * Non-secret settings are stored in <targetDir>/.mind-server/config.json.
 * Secrets (API keys) always come from environment variables — never stored.
 *
 * Config shape:
 * {
 *   "port":      3002,
 *   "ai": {
 *     "provider": "anthropic" | "openai" | "local",
 *     "model":    "claude-sonnet-4-6",
 *     "baseUrl":  null | "http://localhost:11434/v1"
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
    provider: 'anthropic',
    model:    'claude-sonnet-4-6',
    baseUrl:  null,
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
}
