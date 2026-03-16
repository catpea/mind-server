/**
 * sse.js — Server-Sent Events hub.
 *
 * Keeps a set of active SSE response streams. Any code can call
 * `hub.broadcast(event, data)` and all connected clients receive it.
 *
 * Usage (server.js):
 *   import { SseHub } from './sse.js';
 *   const hub = new SseHub();
 *
 *   // In a route handler:
 *   hub.connect(req, res);
 *
 *   // Anywhere else:
 *   hub.broadcast('post:created', { id: 'abc', title: 'Hello' });
 */

export class SseHub {
  #clients = new Set();

  /**
   * Attach an HTTP response as an SSE client.
   * Sets the correct headers and keeps the connection alive.
   * Removes the client when it disconnects.
   */
  connect(req, res) {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
    res.write(':ok\n\n'); // initial ping so client knows it's live

    const client = res;
    this.#clients.add(client);

    // Heartbeat every 25s to keep connection alive through proxies
    const hb = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch { this.#clients.delete(client); }
    }, 25_000);

    req.on('close', () => {
      clearInterval(hb);
      this.#clients.delete(client);
    });
  }

  /**
   * Broadcast an event to all connected clients.
   * @param {string} event - SSE event name (e.g. 'post:created')
   * @param {object} data  - JSON-serializable payload
   */
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) {
      try {
        client.write(payload);
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  /** Number of currently connected clients. */
  get size() { return this.#clients.size; }
}
