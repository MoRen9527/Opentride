import { newId } from './ids.js';
import { makeEvent, normalizeError } from './protocol.js';
import { PermissionManager } from './permissionManager.js';
import { fsTools } from './tools/fsTools.js';
import { terminalTools } from './tools/terminalTools.js';

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return m?.text ?? '';
  }
  return '';
}

export function createHandlers({ state, bus }) {
  const permissions = new PermissionManager({ state, bus });

  async function emitToolState({ sessionId, runId, toolCall }) {
    bus.publish({
      sessionId,
      envelope: makeEvent({
        type: 'tool.state',
        sessionId,
        requestId: null,
        payload: { sessionId, runId, toolCall },
      }),
    });
  }

  async function emitTerminalEvent({ sessionId, runId, terminal }) {
    bus.publish({
      sessionId,
      envelope: makeEvent({
        type: 'terminal.event',
        sessionId,
        requestId: null,
        payload: { sessionId, runId, terminal },
      }),
    });
  }

  async function executeTool({ session, runId, messageId, name, input }) {
    const toolCallId = newId();
    const toolCall = {
      id: toolCallId,
      name,
      status: 'pending',
      messageId,
      input: input ?? {},
      timing: { queuedAt: Date.now() },
    };

    await emitToolState({ sessionId: session.id, runId, toolCall });

    const scope = name;
    const preview =
      name.startsWith('fs.')
        ? { paths: [String(input?.path ?? '')] }
        : name.startsWith('terminal.')
          ? { command: String(input?.command ?? '') }
          : undefined;

    const perm = await permissions.require({
      sessionId: session.id,
      runId,
      scope,
      reason: `Allow tool ${name}`,
      toolRef: { toolCallId, messageId },
      constraints: { pathBase: 'workspaceRelative' },
      preview,
    });

    if (perm.status !== 'approved') {
      toolCall.status = 'canceled';
      toolCall.error = { code: 'permission_denied', message: 'Permission denied' };
      toolCall.timing.startedAt = Date.now();
      toolCall.timing.endedAt = Date.now();
      await emitToolState({ sessionId: session.id, runId, toolCall });
      throw new Error('Permission denied');
    }

    toolCall.status = 'running';
    toolCall.timing.startedAt = Date.now();
    await emitToolState({ sessionId: session.id, runId, toolCall });

    try {
      let result;
      if (fsTools[name]) {
        result = await fsTools[name]({ workspaceRoot: session.workspaceRoot, input });
      } else if (terminalTools[name]) {
        result = await terminalTools[name]({
          input,
          onEvent: (terminal) => emitTerminalEvent({ sessionId: session.id, runId, terminal }),
        });
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      toolCall.status = 'completed';
      toolCall.result = result;
      toolCall.timing.endedAt = Date.now();
      await emitToolState({ sessionId: session.id, runId, toolCall });
      return result;
    } catch (e) {
      toolCall.status = 'error';
      toolCall.error = normalizeError(e, 'tool_error');
      toolCall.timing.endedAt = Date.now();
      await emitToolState({ sessionId: session.id, runId, toolCall });
      throw e;
    }
  }

  return {
    hello: async (req) => {
      return {
        result: {
          server: { name: 'opentride-runtime', version: '0.1.0' },
          protocol: { v: '1.0' },
          capabilities: { sse: true, jsonRpc: false },
          eventStream: { path: '/events', query: ['sessionId'] },
        },
      };
    },

    'session.create': async (req) => {
      const session = state.createSession(req.payload);
      bus.publish({
        sessionId: session.id,
        envelope: makeEvent({
          type: 'session.updated',
          sessionId: session.id,
          requestId: req.id,
          payload: { sessionId: session.id, patch: { state: session.state, cwd: session.cwd } },
        }),
      });
      return { result: { session } };
    },

    'session.get': async (req) => {
      const { sessionId } = req.payload ?? {};
      const session = state.getSession(sessionId);
      if (!session) return { error: { code: 'not_found', message: `Unknown sessionId: ${sessionId}` } };
      return { result: { session } };
    },

    'session.close': async (req) => {
      const { sessionId } = req.payload ?? {};
      const res = state.closeSession(sessionId);
      return { result: res };
    },

    'run.start': async (req) => {
      const { sessionId, input } = req.payload ?? {};
      const session = state.getSession(sessionId);
      if (!session) return { error: { code: 'not_found', message: `Unknown sessionId: ${sessionId}` } };
      if (session.state === 'closed') return { error: { code: 'session_closed', message: 'Session is closed' } };

      const runId = newId();
      state.runs.set(runId, { runId, sessionId, status: 'running', createdAt: Date.now() });

      bus.publish({
        sessionId,
        envelope: makeEvent({ type: 'run.started', sessionId, requestId: req.id, payload: { sessionId, runId } }),
      });

      const messageId = newId();
      const userText = lastUserText(input?.messages);

      schedule(async () => {
        try {
          const run = state.runs.get(runId);
          if (!run || run.status !== 'running') return;

          const toolSpec = parseToolSpec(userText);
          let finalText;
          if (toolSpec) {
            const result = await executeTool({
              session,
              runId,
              messageId,
              name: toolSpec.name,
              input: toolSpec.input,
            });
            finalText = `Tool ${toolSpec.name} completed.\n\nResult:\n${safeStringify(result)}`;
          } else {
            finalText = `Echo: ${userText}`;
          }

          const chunks = chunkText(finalText, 16);
          for (const delta of chunks) {
            const run2 = state.runs.get(runId);
            if (!run2 || run2.status !== 'running') break;
            bus.publish({
              sessionId,
              envelope: makeEvent({
                type: 'chat.delta',
                sessionId,
                requestId: req.id,
                payload: { sessionId, runId, messageId, deltaText: delta },
              }),
            });
            await sleep(40);
          }

          const run3 = state.runs.get(runId);
          if (run3 && run3.status === 'running') {
            bus.publish({
              sessionId,
              envelope: makeEvent({
                type: 'chat.completed',
                sessionId,
                requestId: req.id,
                payload: { sessionId, runId, messageId, finalText, finishReason: 'stop' },
              }),
            });

            run3.status = 'completed';
            bus.publish({
              sessionId,
              envelope: makeEvent({
                type: 'run.completed',
                sessionId,
                requestId: req.id,
                payload: { sessionId, runId, status: 'completed', summary: { tokens: null } },
              }),
            });
          }
        } catch (e) {
          const run4 = state.runs.get(runId);
          if (run4) run4.status = 'failed';
          bus.publish({
            sessionId,
            envelope: makeEvent({
              type: 'run.failed',
              sessionId,
              requestId: req.id,
              payload: { sessionId, runId, status: 'failed', error: normalizeError(e) },
            }),
          });
        }
      });

      return { result: { run: { runId, status: 'running' }, acceptedAt: Date.now() } };
    },

    'run.cancel': async (req) => {
      const { sessionId, runId, reason } = req.payload ?? {};
      const run = state.runs.get(runId);
      if (!run || run.sessionId !== sessionId) return { error: { code: 'not_found', message: `Unknown runId: ${runId}` } };
      run.status = 'cancelled';
      bus.publish({
        sessionId,
        envelope: makeEvent({
          type: 'run.cancelled',
          sessionId,
          requestId: req.id,
          payload: { sessionId, runId, status: 'cancelled', reason },
        }),
      });
      return { result: { cancelled: true } };
    },

    'permission.reply': async (req) => {
      try {
        const { sessionId, permissionId, decision } = req.payload ?? {};
        const res = permissions.reply({ sessionId, permissionId, decision });
        if (!res.recorded) return { error: res.error };

        const pending = res.pending;
        state.permissions.set(permissionId, { sessionId, permissionId, decision, ts: Date.now() });

        const picked = pending.permission.options.find((o) => o.optionId === decision?.optionId);
        const status = picked?.effect?.startsWith('allow') ? 'approved' : 'rejected';

        bus.publish({
          sessionId,
          envelope: makeEvent({
            type: 'permission.resolved',
            sessionId,
            requestId: req.id,
            payload: {
              sessionId,
              runId: pending.runId,
              permissionId,
              resolution: { status, optionId: decision?.optionId },
            },
          }),
        });

        return { result: { recorded: true, effectiveScope: picked?.effect === 'allow_always' ? 'session' : 'once' } };
      } catch (e) {
        return { error: normalizeError(e, 'permission_error') };
      }
    },
  };
}

function parseToolSpec(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  // Minimal command convention for now:
  // - terminal.exec <command>
  // - fs.readFile <path>
  // - fs.writeFile <path> <<<content
  // - fs.listDir <path>
  const m = t.match(/^(terminal\.exec|fs\.readFile|fs\.writeFile|fs\.listDir)\s+([\s\S]+)$/);
  if (!m) return null;

  const name = m[1];
  const rest = m[2];

  if (name === 'terminal.exec') {
    return { name, input: { command: rest.trim() } };
  }

  if (name === 'fs.readFile' || name === 'fs.listDir') {
    return { name, input: { path: rest.trim() } };
  }

  if (name === 'fs.writeFile') {
    const idx = rest.indexOf('<<<');
    if (idx === -1) {
      return { name, input: { path: rest.trim(), content: '', overwrite: true } };
    }
    const p = rest.slice(0, idx).trim();
    const content = rest.slice(idx + 3);
    return { name, input: { path: p, content, overwrite: true } };
  }

  return null;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function schedule(fn) {
  setTimeout(() => {
    Promise.resolve(fn()).catch(() => undefined);
  }, 0);
}
