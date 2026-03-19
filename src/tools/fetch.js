/**
 * tools/fetch.js — Fetch a URL and return readable text.
 *
 * Strips HTML tags so agents can read web content without noise.
 * Returns a consistent result object — never throws.
 *
 * Usage:
 *   const result = await fetchUrl('https://osv.dev/query', { method: 'POST', json: payload });
 *   if (result.ok) console.log(result.text);
 *
 * Result shape:
 *   { ok: boolean, status: number|null, text: string, json: object|null }
 */

const DEFAULT_TIMEOUT = 10_000; // 10 s
const MAX_BODY        = 100_000; // 100 KB — prevent huge pages from eating memory

/**
 * Strip HTML tags and collapse whitespace for readability.
 * Preserves text content, code in <pre> blocks, and link hrefs.
 */
function stripHtml(html) {
  return html
    // Preserve <pre> blocks as-is (code snippets)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    // Replace block elements with newlines
    .replace(/<\/?(p|div|section|article|h[1-6]|li|tr|br)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch a URL with timeout.
 *
 * @param {string}  url
 * @param {object}  [opts]
 * @param {string}  [opts.method]   — HTTP method (default: 'GET')
 * @param {object}  [opts.headers]  — Additional headers
 * @param {object}  [opts.json]     — Request body as JSON (sets Content-Type automatically)
 * @param {number}  [opts.timeout]  — Timeout in ms (default: 10 000)
 * @returns {Promise<{ ok: boolean, status: number|null, text: string, json: object|null }>}
 */
export async function fetchUrl(url, { method = 'GET', headers = {}, json, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  try {
    const reqHeaders = { 'User-Agent': 'mind-server/1.0', ...headers };
    const body       = json ? JSON.stringify(json) : undefined;
    if (json) reqHeaders['Content-Type'] = 'application/json';

    const res     = await fetch(url, { method, headers: reqHeaders, body, signal: controller.signal });
    const rawText = (await res.text()).slice(0, MAX_BODY);

    const contentType = res.headers.get('content-type') ?? '';
    const isHtml      = contentType.includes('text/html');
    const text        = isHtml ? stripHtml(rawText) : rawText;

    let parsed = null;
    if (contentType.includes('application/json') || (!isHtml && rawText.trimStart().startsWith('{'))) {
      try { parsed = JSON.parse(rawText); } catch { /* not valid JSON */ }
    }

    return { ok: res.ok, status: res.status, text: text.slice(0, MAX_BODY), json: parsed };
  } catch (err) {
    const msg = err.name === 'AbortError' ? `[fetch] timed out after ${timeout}ms` : err.message;
    return { ok: false, status: null, text: msg, json: null };
  } finally {
    clearTimeout(timer);
  }
}
