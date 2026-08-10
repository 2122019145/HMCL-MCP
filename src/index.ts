/**
 * HMCL MCP server entry point (stdio).
 * stdout is reserved for JSON-RPC — all logging goes to stderr via ctx.log.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ctx } from './config.js';
import { createMcpServer, getLastToolCount } from './server.js';

async function main(): Promise<void> {
  const server = await createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  ctx.log(
    `HMCL MCP server ready — workdir=${ctx.workdir} agentPort=${ctx.agentPort} ` +
      `tools=${getLastToolCount()}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    ctx.log(`received ${signal}, shutting down`);
    try {
      await server.close();
    } catch (err) {
      ctx.log(`error while closing server: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[hmcl-mcp] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
