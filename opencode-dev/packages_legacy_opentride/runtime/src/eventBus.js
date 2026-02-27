import { setInterval, clearInterval } from 'node:timers';

function writeSse(res, { event, id, data }) {
  if (id) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of payload.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

export class SseEventBus {
  constructor({ heartbeatMs = 15000 } = {}) {
    this._heartbeatMs = heartbeatMs;
    this._subsBySession = new Map();
  }

  subscribe({ sessionId, res }) {
    const key = sessionId ?? '*';
    let set = this._subsBySession.get(key);
    if (!set) {
      set = new Set();
      this._subsBySession.set(key, set);
    }

    const sub = {
      res,
      key,
      heartbeat: setInterval(() => {
        try {
          res.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
          // ignored
        }
      }, this._heartbeatMs),
    };

    set.add(sub);
    return () => {
      clearInterval(sub.heartbeat);
      set.delete(sub);
      if (set.size === 0) this._subsBySession.delete(key);
    };
  }

  publish({ sessionId, envelope }) {
    const targets = new Set();
    const global = this._subsBySession.get('*');
    if (global) for (const sub of global) targets.add(sub);
    if (sessionId) {
      const scoped = this._subsBySession.get(sessionId);
      if (scoped) for (const sub of scoped) targets.add(sub);
    }

    for (const sub of targets) {
      try {
        writeSse(sub.res, { event: 'message', id: envelope.id, data: envelope });
      } catch {
        // ignored; connection cleanup happens via close handler
      }
    }
  }
}
