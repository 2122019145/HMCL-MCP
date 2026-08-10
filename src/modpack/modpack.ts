/**
 * Modpack tools: search / get / download / install modpacks.
 *
 * Everything goes through HMCL's own addon repositories inside the headless
 * HMCL JVM (ModrinthRemoteAddonRepository / CurseForgeRemoteAddonRepository):
 * search, project info, downloads (SHA-1 verified via HMCL's FileDownloadTask)
 * and install. CurseForge uses HMCL's embedded API key, so no
 * HMCL_MCP_CURSEFORGE_API_KEY is required for search/download (the env var is
 * still passed to HMCL as an optional override via -Dhmcl.curseforge.apikey).
 *
 * Handlers NEVER throw for user-level failures — they return
 * `{ ok: false, error }` so the server layer produces a clean MCP isError.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { ensureAgent } from '../hmcl-client.js';
import type {
  AgentHandle,
  Ctx,
  InstalledModpack,
  ModpackSource,
  ToolDef,
  ToolResult,
} from '../types.js';
import { fail, ok } from '../types.js';

const DEFAULT_LIMIT = 20;

const SOURCE_SCHEMA = z.enum(['modrinth', 'curseforge']);

function toSource(value: unknown): ModpackSource {
  return value === 'curseforge' ? 'curseforge' : 'modrinth';
}

function toLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), 100)
    : DEFAULT_LIMIT;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run `fn` and convert any throw into a `fail(...)` ToolResult. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(errText(err));
  }
}

/** Start (or reuse) the HMCL agent; throws with an actionable message on failure. */
async function agentOf(ctx: Ctx): Promise<AgentHandle> {
  try {
    return await ensureAgent(ctx);
  } catch (err) {
    throw new Error(
      `HMCL agent could not be started: ${errText(err)}. Make sure the HMCL jar and ` +
        `hmcl-agent.jar are in ${ctx.hmclDir} (use install_hmcl) and that ` +
        `${ctx.javaPath ?? 'java on PATH'} is a JDK 17+.`
    );
  }
}

/** Unwrap an AgentResult into its payload; throws with the agent's error message. */
function requireOk<T = unknown>(result: { ok: boolean; error?: string; data?: unknown }): T {
  if (!result.ok) throw new Error(result.error ?? 'unknown agent error');
  return result.data as T;
}

/**
 * Best-effort mapping of the agent's install response into InstalledModpack.
 * The agent may return the ModpackConfiguration (keys type/name/version) or a
 * summary with name/format/gameVersion/modLoader; we accept either and fall
 * back to the pack file extension and the instance naming convention.
 */
function toInstalledModpack(
  ctx: Ctx,
  data: unknown,
  packPath: string,
  requestedName?: string
): InstalledModpack {
  const rec = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

  const name = str(rec.name) ?? requestedName ?? basename(packPath).replace(/\.[^.]+$/, '');
  const rawFormat = str(rec.format);
  const type = str(rec.type); // ModpackConfiguration.type: HMCL|CurseForge|Modrinth|MultiMC|MCBBS|Server
  const lower = packPath.toLowerCase();
  const format: InstalledModpack['format'] =
    rawFormat === 'mrpack' || rawFormat === 'curseforge' || rawFormat === 'hmcl'
      ? rawFormat
      : type === 'Modrinth'
        ? 'mrpack'
        : type === 'CurseForge'
          ? 'curseforge'
          : lower.endsWith('.mrpack')
            ? 'mrpack'
            : lower.endsWith('.zip')
              ? 'curseforge'
              : 'hmcl';
  return {
    name,
    path: str(rec.path) ?? join(ctx.workdir, 'versions', name),
    format,
    gameVersion: str(rec.gameVersion),
    modLoader: str(rec.modLoader),
  };
}

/** Install `packPath` through the HMCL agent; throws on failure. */
async function installWithAgent(ctx: Ctx, packPath: string, name?: string): Promise<InstalledModpack> {
  const agent = await agentOf(ctx);
  const result = await agent.installModpack(packPath, name);
  if (!result.ok) {
    throw new Error(`HMCL failed to install the modpack: ${result.error}`);
  }
  return toInstalledModpack(ctx, result.data, packPath, name);
}

export function createModpackTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: 'search_modpacks',
      description:
        "Search modpacks with HMCL's own repositories: Modrinth (default) or CurseForge (HMCL's embedded API key — no HMCL_MCP_CURSEFORGE_API_KEY needed). " +
        'Returns ModpackSummary[]: id (slug), title, description, authors, url.',
      inputSchema: {
        query: z.string(),
        source: SOURCE_SCHEMA.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      handler: async (input) => {
        const query = typeof input.query === 'string' ? input.query : '';
        if (!query.trim()) return fail('search_modpacks requires a non-empty query');
        const source = toSource(input.source);
        const limit = toLimit(input.limit);
        return guard(async () => {
          const data = requireOk<unknown>(await (await agentOf(ctx)).searchModpacks(source, query, limit));
          const hits = (data as { hits?: unknown }).hits;
          return ok(Array.isArray(hits) ? hits : data);
        });
      },
    },
    {
      name: 'get_modpack',
      description:
        'Get details of a modpack project (id = Modrinth slug or CurseForge slug) through HMCL: summary + available versions ' +
        '(id = version name, version, gameVersions, loaders) and the latest version.',
      inputSchema: {
        source: SOURCE_SCHEMA.optional(),
        id: z.string(),
      },
      handler: async (input) => {
        const source = toSource(input.source);
        const id = typeof input.id === 'string' ? input.id : '';
        if (!id) return fail('get_modpack requires a modpack id');
        return guard(async () => {
          const data = requireOk<unknown>(await (await agentOf(ctx)).getModpack(source, id));
          const rec = (data ?? {}) as Record<string, unknown>;
          const versions = Array.isArray(rec.versions) ? rec.versions : [];
          return ok({ summary: rec.summary ?? null, versions, latest: versions[0] ?? null });
        });
      },
    },
    {
      name: 'download_modpack',
      description:
        "Download a modpack file through HMCL into <workdir>/mcpacks/ (SHA-1 verified via HMCL's downloader). " +
        'Pass versionId (a version name from get_modpack) to pick a specific version; defaults to the latest. ' +
        'Returns {id, version, gameVersions, filename, path, size, sha1}.',
      inputSchema: {
        source: SOURCE_SCHEMA.optional(),
        id: z.string(),
        versionId: z.string().optional(),
      },
      handler: async (input) => {
        const source = toSource(input.source);
        const id = typeof input.id === 'string' ? input.id : '';
        if (!id) return fail('download_modpack requires a modpack id');
        const versionId =
          typeof input.versionId === 'string' && input.versionId ? input.versionId : undefined;
        return guard(async () =>
          ok(requireOk(await (await agentOf(ctx)).downloadModpack(source, id, versionId)))
        );
      },
    },
    {
      name: 'install_modpack',
      description:
        'Install a modpack as a game instance under <workdir>/versions/. Either pass path to a local .mrpack/.zip file, ' +
        'or id (plus optional versionId) to download it first via HMCL; name is the instance name (defaults to the pack name). ' +
        'Requires the HMCL agent — it is started automatically if possible.',
      inputSchema: {
        source: SOURCE_SCHEMA.optional(),
        id: z.string().optional(),
        versionId: z.string().optional(),
        path: z.string().optional(),
        name: z.string().optional(),
      },
      handler: async (input) => {
        const source = toSource(input.source);
        const id = typeof input.id === 'string' && input.id ? input.id : undefined;
        const versionId =
          typeof input.versionId === 'string' && input.versionId ? input.versionId : undefined;
        const packPath = typeof input.path === 'string' && input.path ? input.path : undefined;
        const name =
          typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
        if (!id && !packPath) {
          return fail(
            'install_modpack requires either id (source, to download the pack) or path (a local modpack file)'
          );
        }
        if (packPath && !existsSync(packPath)) {
          return fail(`Modpack file not found: ${packPath}`);
        }
        return guard(async () => {
          let file = packPath;
          if (!file) {
            const agent = await agentOf(ctx);
            const data = requireOk<unknown>(await agent.downloadModpack(source, id!, versionId));
            const p = (data as { path?: unknown }).path;
            if (typeof p !== 'string' || !p) {
              throw new Error('HMCL download did not return a file path');
            }
            file = p;
          }
          return ok(await installWithAgent(ctx, file, name));
        });
      },
    },
  ];
}
