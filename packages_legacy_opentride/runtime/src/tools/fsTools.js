import fs from 'node:fs/promises';
import path from 'node:path';

function resolvePath({ workspaceRoot, inputPath }) {
  if (!workspaceRoot) throw new Error('Missing workspaceRoot');
  if (!inputPath) throw new Error('Missing path');
  const resolved = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(workspaceRoot, inputPath);
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, resolved);
  const escapes = rel.startsWith('..') || path.isAbsolute(rel);
  return { resolved, escapesWorkspace: escapes, workspaceRoot: root };
}

export const fsTools = {
  'fs.readFile': async ({ workspaceRoot, input }) => {
    const { path: p, encoding = 'utf8' } = input ?? {};
    const { resolved } = resolvePath({ workspaceRoot, inputPath: p });
    const content = await fs.readFile(resolved, { encoding });
    return { path: resolved, encoding, content };
  },

  'fs.writeFile': async ({ workspaceRoot, input }) => {
    const { path: p, content, encoding = 'utf8', overwrite = false } = input ?? {};
    const { resolved } = resolvePath({ workspaceRoot, inputPath: p });
    if (!overwrite) {
      try {
        await fs.access(resolved);
        return { ok: false, path: resolved, error: { code: 'already_exists', message: 'File exists (set overwrite=true)' } };
      } catch {
        // ok
      }
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content ?? '', { encoding });
    return { ok: true, path: resolved };
  },

  'fs.listDir': async ({ workspaceRoot, input }) => {
    const { path: p = '.' } = input ?? {};
    const { resolved } = resolvePath({ workspaceRoot, inputPath: p });
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return {
      path: resolved,
      entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
    };
  },
};
