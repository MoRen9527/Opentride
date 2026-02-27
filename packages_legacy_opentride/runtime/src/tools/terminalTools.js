import { spawn } from 'node:child_process';
import { newId } from '../ids.js';

export const terminalTools = {
  'terminal.exec': async ({ input, onEvent }) => {
    const { command, cwd } = input ?? {};
    if (!command) throw new Error('Missing command');

    const terminalId = newId();
    onEvent?.({ terminalId, kind: 'started', cwd, command });

    return await new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (buf) => {
        const data = buf.toString('utf8');
        stdout += data;
        onEvent?.({ terminalId, kind: 'data', stream: 'stdout', data });
      });
      child.stderr?.on('data', (buf) => {
        const data = buf.toString('utf8');
        stderr += data;
        onEvent?.({ terminalId, kind: 'data', stream: 'stderr', data });
      });

      child.on('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 0;
        onEvent?.({ terminalId, kind: 'ended', exitCode });
        resolve({ terminalId, exitCode, stdout, stderr });
      });
    });
  },
};
