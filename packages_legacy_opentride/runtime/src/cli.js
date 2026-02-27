#!/usr/bin/env node
import { createRuntimeServer } from './server.js';

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 4317, logger: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--logger') out.logger = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  // eslint-disable-next-line no-console
  console.log('opentride-runtime --host 127.0.0.1 --port 4317 [--logger]');
  process.exit(0);
}

if (!Number.isFinite(args.port) || args.port <= 0) {
  // eslint-disable-next-line no-console
  console.error('Invalid --port');
  process.exit(2);
}

const { app } = createRuntimeServer({ logger: args.logger });
await app.listen({ host: args.host, port: args.port });

const address = app.server.address();
// eslint-disable-next-line no-console
console.log('opentride-runtime listening', address);
