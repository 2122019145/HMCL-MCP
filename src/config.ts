/**
 * Runtime configuration resolved from the environment (see src/types.ts `Ctx`).
 *
 * Env vars:
 *   HMCL_MCP_WORKDIR            working dir (game root + user data root), default ~/.hmcl-mcp
 *   HMCL_MCP_HMCL_DIR           dir holding HMCL.jar + hmcl-agent.jar, default <workdir>/hmcl
 *   HMCL_MCP_JAVA               java binary for the headless HMCL JVM, default auto-detect ('java')
 *   HMCL_MCP_CURSEFORGE_API_KEY optional CurseForge API key
 *   HMCL_MCP_AGENT_PORT         agent HTTP port, default 28501
 *   HMCL_MCP_AGENT_TOKEN        shared agent token (X-HMCL-Agent-Token header), default 'hmcl-mcp'
 */

import os from 'node:os';
import path from 'node:path';
import type { Ctx } from './types.js';

const DEFAULT_WORKDIR = '~/.hmcl-mcp';
const DEFAULT_AGENT_PORT = 28501;
const DEFAULT_AGENT_TOKEN = 'hmcl-mcp';

/** Expand a leading `~`/`~/` to the OS home directory, then absolutize. */
function expandHome(value: string): string {
  const expanded =
    value === '~'
      ? os.homedir()
      : value.startsWith('~/') || value.startsWith('~\\')
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(expanded);
}

/** Resolve the runtime Ctx from process env (injectable for tests). */
export function resolveCtx(env: NodeJS.ProcessEnv = process.env): Ctx {
  const workdir = expandHome(env.HMCL_MCP_WORKDIR?.trim() || DEFAULT_WORKDIR);
  const hmclDir = expandHome(env.HMCL_MCP_HMCL_DIR?.trim() || path.join(workdir, 'hmcl'));

  const javaRaw = env.HMCL_MCP_JAVA?.trim();
  const javaPath = javaRaw ? javaRaw : null;

  const curseforgeRaw = env.HMCL_MCP_CURSEFORGE_API_KEY?.trim();
  const curseforgeApiKey = curseforgeRaw ? curseforgeRaw : null;

  const agentPortRaw = env.HMCL_MCP_AGENT_PORT?.trim() || String(DEFAULT_AGENT_PORT);
  const agentPort = Number(agentPortRaw);
  if (!Number.isInteger(agentPort) || agentPort < 1 || agentPort > 65535) {
    throw new Error(
      `HMCL_MCP_AGENT_PORT must be an integer between 1 and 65535, got '${agentPortRaw}'`,
    );
  }

  const agentToken = env.HMCL_MCP_AGENT_TOKEN?.trim() || DEFAULT_AGENT_TOKEN;

  const log = (message: string): void => {
    console.error('[hmcl-mcp] ' + message);
  };

  return { workdir, hmclDir, javaPath, curseforgeApiKey, agentPort, agentToken, log };
}

/** Default singleton context, resolved once at import time. */
export const ctx: Ctx = resolveCtx();
