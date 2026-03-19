/**
 * ai.js — Local AI client. Zero external dependencies.
 *
 * Supports local OpenAI-compatible endpoints (ollama, LM Studio, llama.cpp, etc.)
 * No API key required. Configure baseUrl in .mind-server/config.json.
 *
 * Usage:
 *   import { createAI } from './ai.js';
 *   const ai = createAI(config.getAI());
 *
 *   const text = await ai.ask('What is 2+2?', { system: 'Be concise.' });
 *   const data = await ai.askJSON('List 3 colors.'); // → ['red', 'green', 'blue']
 *
 * Markdown guards:
 *   Local models often ignore "reply with JSON only" and wrap in code fences.
 *   askJSON() applies three progressive parsing strategies before throwing.
 */

import { retryWithBackoff } from '../utils.js';

// ── JSON parser with markdown guards ─────────────────────────────────────────

/**
 * Parse JSON from an AI response robustly.
 * Strategies (applied in order):
 *   1. Direct JSON.parse
 *   2. Strip markdown code fences (```json...```) then parse
 *   3. Extract first {...} or [...] block then parse
 */
export function parseJSON(text) {
  if (!text?.trim()) throw new Error('AI returned empty response');

  // Strategy 1: direct
  try { return JSON.parse(text.trim()); } catch { /* try next */ }

  // Strategy 2: strip code fences
  const stripped = text
    .replace(/^```(?:json|js|javascript)?\s*\n?/gim, '')
    .replace(/\n?\s*```\s*$/gim, '')
    .trim();
  try { return JSON.parse(stripped); } catch { /* try next */ }

  // Strategy 3: extract first JSON block
  const objMatch = stripped.match(/(\{[\s\S]*\})/);
  if (objMatch) { try { return JSON.parse(objMatch[1]); } catch { /* try next */ } }

  const arrMatch = stripped.match(/(\[[\s\S]*\])/);
  if (arrMatch) { try { return JSON.parse(arrMatch[1]); } catch { /* try next */ } }

  throw new Error(`Could not parse JSON from AI response:\n${text.slice(0, 300)}`);
}

// ── Provider implementation ───────────────────────────────────────────────────

// Errors worth retrying: transient network/server issues.
// Do NOT retry 400/401/403 (client errors) — they'll fail every time.
function isRetryable(err) {
  if (!err?.message) return true; // unknown — optimistically retry
  const msg = err.message;
  if (/429/.test(msg)) return true;  // rate limited
  if (/5\d\d/.test(msg)) return true; // server-side error
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(msg)) return true;
  return false;
}

async function callLocal(prompt, { system, model, maxTokens, baseUrl }) {
  const url      = `${baseUrl}/chat/completions`;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = { model, max_tokens: maxTokens, messages, stream: false };

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI API ${res.status} at ${url}: ${text}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an AI client configured from a config.getAI() result.
 *
 * Multi-model routing:
 *   cfg.fastModel — model for triage/dispatch agents (Amy, Vera, Kimberly)
 *                   defaults to same as full model if not set
 *   cfg.fullModel — model for implementation agents (Erica, Rita, Monica, Heather)
 *                   same as `model` if not specified
 *
 * The returned object has:
 *   .ask / .askJSON / .isAvailable  — full model (default)
 *   .fast.ask / .fast.askJSON       — fast model for quick decisions
 *   .full.ask / .full.askJSON       — alias to default (for symmetry)
 *
 * @param {object} cfg - { model, fastModel, fullModel, baseUrl, maxTokens }
 */
export function createAI(cfg = {}) {
  const model     = cfg.model     ?? 'llama3';
  const baseUrl   = cfg.baseUrl   ?? 'http://localhost:11434/v1';
  const maxTokens = cfg.maxTokens ?? 4096;
  const fastModel = cfg.fastModel ?? model;
  const fullModel = cfg.fullModel ?? model;

  async function ask(prompt, opts = {}) {
    const options = {
      system:    opts.system    ?? null,
      model:     opts.model     ?? model,
      maxTokens: opts.maxTokens ?? maxTokens,
      baseUrl,
    };

    return retryWithBackoff(() => callLocal(prompt, options), {
      retries:     3,
      baseMs:      1000,
      label:       'local',
      shouldRetry: isRetryable,
    });
  }

  async function askJSON(prompt, opts = {}) {
    // Reinforce JSON requirement — especially important for local models
    const fullPrompt = [
      prompt,
      '',
      '---',
      'IMPORTANT: Reply with ONLY valid JSON. No markdown. No code fences. No explanation.',
      'Start your response with { or [ and end with } or ]',
    ].join('\n');

    const text = await ask(fullPrompt, opts);
    if (!text) return null;
    return parseJSON(text);
  }

  // Fast client — uses fastModel for triage/dispatch decisions
  function makeFast() {
    async function askFast(prompt, opts = {}) {
      return ask(prompt, { ...opts, model: fastModel });
    }
    async function askJSONFast(prompt, opts = {}) {
      return askJSON(prompt, { ...opts, model: fastModel });
    }
    return { ask: askFast, askJSON: askJSONFast, isAvailable: () => true, model: fastModel };
  }

  const fast = makeFast();

  return {
    isAvailable: () => true,
    provider:    'local',
    model:       fullModel,
    fastModel,
    ask,
    askJSON,
    /** Fast client — use for triage, dispatch, classification. */
    fast,
    /** Full client — alias to default, for symmetric ctx.ai.full.ask(...) usage. */
    full: { ask, askJSON, isAvailable: () => true, model: fullModel },
  };
}
