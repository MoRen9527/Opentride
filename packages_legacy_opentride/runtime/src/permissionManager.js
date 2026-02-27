import { newId } from './ids.js';
import { makeEvent, normalizeError } from './protocol.js';

function grantKey({ sessionId, scope, previewKey }) {
  return `${sessionId}:${scope}:${previewKey ?? '*'}`;
}

function makePreviewKey(preview) {
  if (!preview) return '*';
  if (preview.command) return `cmd:${preview.command}`;
  if (Array.isArray(preview.paths) && preview.paths.length) return `paths:${preview.paths.join('|')}`;
  return '*';
}

export class PermissionManager {
  constructor({ state, bus, timeoutMs = 5 * 60 * 1000 } = {}) {
    this._state = state;
    this._bus = bus;
    this._timeoutMs = timeoutMs;
  }

  async require({ sessionId, runId, scope, reason, toolRef, constraints, preview }) {
    const previewKey = makePreviewKey(preview);
    const existing = this._state.permissionGrants.get(grantKey({ sessionId, scope, previewKey }));
    if (existing?.effect === 'allow_always') {
      return { status: 'approved', effect: 'allow_always', optionId: existing.optionId };
    }

    const permissionId = newId();
    const options = [
      { optionId: 'allow_once', label: 'Allow once', effect: 'allow_once' },
      { optionId: 'allow_always', label: 'Always allow', effect: 'allow_always' },
      { optionId: 'reject_once', label: 'Reject', effect: 'reject_once' },
    ];

    const permission = {
      permissionId,
      scope,
      reason,
      toolRef,
      constraints,
      preview,
      options,
    };

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timeout = setTimeout(() => {
      this._state.pendingPermissions.delete(permissionId);
      reject(normalizeError(new Error('Permission request timed out'), 'permission_timeout'));
    }, this._timeoutMs);

    this._state.pendingPermissions.set(permissionId, {
      permission,
      sessionId,
      runId,
      previewKey,
      resolve: (decision) => {
        clearTimeout(timeout);
        resolve(decision);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    this._bus.publish({
      sessionId,
      envelope: makeEvent({
        type: 'permission.request',
        sessionId,
        requestId: null,
        payload: { sessionId, runId, permission },
      }),
    });

    const decision = await promise;

    const picked = options.find((o) => o.optionId === decision?.optionId);
    if (!picked) return { status: 'rejected', effect: 'reject_once', optionId: 'reject_once' };

    if (picked.effect === 'allow_always') {
      this._state.permissionGrants.set(grantKey({ sessionId, scope, previewKey }), {
        optionId: picked.optionId,
        effect: picked.effect,
        ts: Date.now(),
      });
    }

    return { status: picked.effect.startsWith('allow') ? 'approved' : 'rejected', effect: picked.effect, optionId: picked.optionId };
  }

  reply({ sessionId, permissionId, decision }) {
    const pending = this._state.pendingPermissions.get(permissionId);
    if (!pending) {
      return { recorded: false, error: { code: 'not_found', message: `Unknown permissionId: ${permissionId}` } };
    }

    if (pending.sessionId !== sessionId) {
      return { recorded: false, error: { code: 'bad_request', message: 'sessionId mismatch for permissionId' } };
    }

    this._state.pendingPermissions.delete(permissionId);
    pending.resolve(decision);
    return { recorded: true, pending };
  }
}
