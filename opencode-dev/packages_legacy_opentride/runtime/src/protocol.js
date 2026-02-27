import { newId } from './ids.js';

const PROTOCOL_V = '1.0';

export function nowMs() {
  return Date.now();
}

export function makeResponse({ request, payload, error }) {
  const responsePayload = payload ?? {};
  if ((responsePayload?.result != null) && (responsePayload?.error != null)) {
    throw new Error('Response payload must have either result or error, not both.');
  }
  if (error != null) {
    if (responsePayload?.result != null) {
      throw new Error('Response cannot have both payload.result and envelope.error');
    }
    if (responsePayload?.error == null) {
      responsePayload.error = error;
    }
  }

  return {
    v: PROTOCOL_V,
    kind: 'response',
    type: request?.type,
    id: newId(),
    requestId: request?.id,
    sessionId: request?.sessionId,
    ts: nowMs(),
    payload: responsePayload,
  };
}

export function makeEvent({ type, sessionId, requestId, payload, streamId }) {
  return {
    v: PROTOCOL_V,
    kind: 'event',
    type,
    id: newId(),
    requestId,
    sessionId,
    ts: nowMs(),
    streamId,
    payload: payload ?? {},
  };
}

export function normalizeError(err, code = 'internal_error') {
  if (!err) return { code, message: 'Unknown error' };
  if (typeof err === 'object' && typeof err.code === 'string') return err;
  if (err instanceof Error) return { code, message: err.message };
  return { code, message: String(err) };
}
