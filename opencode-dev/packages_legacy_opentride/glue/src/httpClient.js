import { parseSse } from './sseParser.js';

export class OpenTrideHttpClient {
  constructor({ baseUrl }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return await res.json();
  }

  async rpc(envelope) {
    const res = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`rpc invalid json (status=${res.status}): ${text.slice(0, 200)}`);
    }
    return json;
  }

  /**
   * Subscribe to SSE stream.
   * @returns {Promise<{ close: () => void }>} handle
   */
  async subscribeEvents({ sessionId, signal, onEnvelope, onRaw }) {
    const url = new URL(`${this.baseUrl}/events`);
    if (sessionId) url.searchParams.set('sessionId', sessionId);

    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      signal,
    });

    if (!res.ok) throw new Error(`events failed: ${res.status}`);
    if (!res.body) throw new Error('events response has no body');

    const aborter = new AbortController();
    const combined = signal ? anySignal([signal, aborter.signal]) : aborter.signal;

    // Note: fetch() body stream is tied to this response; parse loop ends on abort.
    (async () => {
      for await (const msg of parseSse(res.body)) {
        if (combined.aborted) break;
        onRaw?.(msg);
        if (msg?.data) {
          try {
            const env = JSON.parse(msg.data);
            onEnvelope?.(env);
          } catch {
            // ignore invalid json data
          }
        }
      }
    })().catch(() => undefined);

    return {
      close: () => aborter.abort(),
    };
  }
}

function anySignal(signals) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) return s;
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
