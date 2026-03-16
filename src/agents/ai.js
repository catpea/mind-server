/**
 * ai.js — Multi-provider AI client. Zero external dependencies.
 *
 * Supports three providers, all via native fetch:
 *
 *   anthropic — Claude API (ANTHROPIC_API_KEY env var)
 *   openai    — OpenAI API (OPENAI_API_KEY env var)
 *   local     — Any OpenAI-compatible endpoint (ollama, LM Studio, llama.cpp…)
 *               No API key required. baseUrl from config.
 *
 * Configuration comes from the Config object (loaded from .mind-server/config.json).
 * Secrets (keys) always come from environment variables — never config files.
 *
 * Usage:
 *   import { createAI } from './ai.js';
 *   const ai = createAI(config.getAI());
 *
 *   if (ai.isAvailable()) {
 *     const text = await ai.ask('What is 2+2?', { system: 'Be concise.' });
 *     const data = await ai.askJSON('List 3 colors.'); // → ['red', 'green', 'blue']
 *   }
 *
 * Markdown guards:
 *   Local models often ignore "reply with JSON only" and wrap in code fences.
 *   askJSON() applies three progressive parsing strategies before throwing.
 */

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

// ── Provider implementations ──────────────────────────────────────────────────

async function callAnthropic(prompt, { system, model, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const body = {
    model,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  };
  if (system) body.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

async function callOpenAI(prompt, { system, model, maxTokens, baseUrl, apiKey }) {
  const url  = `${baseUrl}/chat/completions`;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const body = { model, max_tokens: maxTokens, messages, stream: false };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`AI API ${res.status} at ${url}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an AI client configured from a config.getAI() result.
 * @param {object} cfg - { provider, model, baseUrl }
 */
export function createAI(cfg = {}) {
  const provider  = cfg.provider  ?? 'anthropic';
  const model     = cfg.model     ?? (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');
  const baseUrl   = cfg.baseUrl   ?? (provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434/v1');
  const maxTokens = cfg.maxTokens ?? 4096;

  function available() {
    if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
    if (provider === 'openai')    return Boolean(process.env.OPENAI_API_KEY);
    if (provider === 'local')     return true; // local needs no key
    return false;
  }

  async function ask(prompt, opts = {}) {
    if (!available()) return null;

    const options = {
      system:    opts.system    ?? null,
      model:     opts.model     ?? model,
      maxTokens: opts.maxTokens ?? maxTokens,
      baseUrl,
      apiKey:    provider === 'openai' ? process.env.OPENAI_API_KEY : null,
    };

    if (provider === 'anthropic') return callAnthropic(prompt, options);
    if (provider === 'local')     return callOpenAI(prompt, { ...options, apiKey: null });
    if (provider === 'openai')    return callOpenAI(prompt, options);

    throw new Error(`Unknown AI provider: ${provider}`);
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

  return {
    isAvailable: available,
    provider,
    model,
    ask,
    askJSON,
  };
}

// ── Convenience singleton (for backwards compat / simple scripts) ─────────────
// Agents use createAI() directly — this is for ad-hoc use.
export const isAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
export const ask     = (prompt, opts) => createAI().ask(prompt, opts);
export const askJSON = (prompt, opts) => createAI().askJSON(prompt, opts);
