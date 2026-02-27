import { newId } from './ids.js';

export class RuntimeState {
  constructor() {
    this.sessions = new Map();
    this.runs = new Map();
    this.permissions = new Map();
    this.pendingPermissions = new Map();
    this.permissionGrants = new Map();
  }

  createSession({ workspaceRoot, cwd } = {}) {
    const id = newId();
    const createdAt = Date.now();
    const session = {
      id,
      createdAt,
      workspaceRoot,
      cwd,
      state: 'active',
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { closed: false, alreadyClosed: false };
    if (session.state === 'closed') return { closed: true, alreadyClosed: true };
    session.state = 'closed';
    return { closed: true, alreadyClosed: false };
  }
}

