import Fastify from 'fastify';
import { SseEventBus } from './eventBus.js';
import { RuntimeState } from './state.js';
import { createHandlers } from './handlers.js';
import { makeResponse, normalizeError } from './protocol.js';

export function createRuntimeServer({ logger = false } = {}) {
  const app = Fastify({ logger });
  const bus = new SseEventBus();
  const state = new RuntimeState();
  const handlers = createHandlers({ state, bus });

  app.get('/health', async () => ({ ok: true }));

  app.get('/events', async (request, reply) => {
    const { sessionId } = request.query ?? {};

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    reply.raw.write(`: connected ${Date.now()}\n\n`);

    const unsubscribe = bus.subscribe({ sessionId, res: reply.raw });

    request.raw.on('close', () => {
      unsubscribe();
    });

    reply.hijack();
  });

  app.post('/rpc', async (request, reply) => {
    const req = request.body;
    if (!req || typeof req !== 'object') {
      reply.code(400);
      return makeResponse({ request: { id: 'unknown', type: 'unknown' }, payload: { error: { code: 'bad_request', message: 'Invalid JSON body' } } });
    }

    if (req.kind !== 'request' || typeof req.type !== 'string') {
      reply.code(400);
      return makeResponse({ request: req, payload: { error: { code: 'bad_request', message: 'Expected kind=request and a string type' } } });
    }

    const handler = handlers[req.type];
    if (!handler) {
      reply.code(404);
      return makeResponse({ request: req, payload: { error: { code: 'not_supported', message: `Unknown request type: ${req.type}` } } });
    }

    try {
      const payload = await handler(req);
      if (payload?.error) {
        return makeResponse({ request: req, payload: { error: payload.error } });
      }
      return makeResponse({ request: req, payload: { result: payload?.result } });
    } catch (e) {
      reply.code(500);
      return makeResponse({ request: req, payload: { error: normalizeError(e) } });
    }
  });

  return { app, bus, state };
}
