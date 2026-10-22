#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { startHttp } from './http.js';

async function main() {
  const transport = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
  if (transport === 'http') {
    await startHttp();
    return;
  }

  const { server, readonly, registeredCount, skippedDestructive } = buildServer();
  await server.connect(new StdioServerTransport());
  const modeLabel = readonly ? 'READONLY' : 'full';
  console.error(
    `Datto RMM MCP Server running (mode: ${modeLabel}, ${registeredCount} tools registered, ${skippedDestructive} destructive skipped)`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
