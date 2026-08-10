/**
 * CurseForge API v1 client (docs/research/modpack-apis.md §3).
 *
 * Every call requires an API key sent as `x-api-key`; without one CurseForge
 * answers 403. The key comes from ctx.curseforgeApiKey
 * (HMCL_MCP_CURSEFORGE_API_KEY) and is checked by the tool layer (modpack.ts)
 * before any call — the functions here assume it is present.
 *
 * All functions throw Error on failure; the tool layer converts them into
 * `fail(...)` results.
 */

import type { ModpackSummary, ModpackVersion } from '../types.js';
import { fetchJson } from '../util/http.js';

const BASE = 'https://api.curseforge.com/v1';
const GAME_ID = 432; // Minecraft
const MODPACK_CLASS_ID = 4471; // "Modpacks" class

function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey };
}

interface CfHash {
  value?: string;
  /** HashAlgo enum: 1 = sha1, 2 = md5. */
  algo?: number;
}

interface CfFile {
  id?: number;
  displayName?: string;
  fileName?: string;
  /** Bytes. */
  fileLength?: number;
  /** Frequently null for modpack files — resolve via getFileDownloadUrl. */
  downloadUrl?: string | null;
  gameVersions?: string[];
  hashes?: CfHash[];
}

interface CfMod {
  id?: number;
  slug?: string;
  name?: string;
  summary?: string;
  authors?: { name?: string }[];
  latestFiles?: CfFile[];
}

interface CfEnvelope<T> {
  data: T;
}

function mapMod(mod: CfMod): ModpackSummary {
  const versions = new Set<string>();
  for (const file of mod.latestFiles ?? []) {
    for (const gv of file.gameVersions ?? []) versions.add(String(gv));
  }
  const slug = mod.slug ?? String(mod.id ?? '');
  return {
    source: 'curseforge',
    id: String(mod.id ?? ''),
    title: mod.name ?? slug,
    description: mod.summary ?? '',
    authors: (mod.authors ?? []).map((a) => a.name ?? '').filter((n) => n !== ''),
    versions: [...versions],
    url: `https://www.curseforge.com/minecraft/modpacks/${slug}`,
  };
}

function mapFile(file: CfFile): ModpackVersion {
  return {
    id: String(file.id ?? ''),
    version: file.displayName ?? file.fileName ?? String(file.id ?? ''),
    gameVersions: (file.gameVersions ?? []).map(String),
    url: file.downloadUrl ?? '',
    filename: file.fileName ?? 'modpack.zip',
    size: typeof file.fileLength === 'number' ? file.fileLength : 0,
    sha1: file.hashes?.find((h) => h.algo === 1)?.value, // HashAlgo: 1 = sha1
  };
}

/** Search modpacks. `query` may be empty to list everything. */
export async function searchModpacks(query: string, limit: number, apiKey: string): Promise<ModpackSummary[]> {
  const pageSize = Math.min(Math.max(limit, 1), 50); // pageSize max is 50
  const url = `${BASE}/mods/search?gameId=${GAME_ID}&classId=${MODPACK_CLASS_ID}&searchFilter=${encodeURIComponent(query)}&pageSize=${pageSize}`;
  const body = await fetchJson<CfEnvelope<CfMod[]>>(url, { headers: authHeaders(apiKey) });
  return (body.data ?? []).map(mapMod);
}

/** Project details by numeric id. */
export async function getModpack(id: string, apiKey: string): Promise<ModpackSummary> {
  try {
    const body = await fetchJson<CfEnvelope<CfMod>>(`${BASE}/mods/${encodeURIComponent(id)}`, {
      headers: authHeaders(apiKey),
    });
    return mapMod(body.data);
  } catch (err) {
    throw new Error(
      `CurseForge project '${id}' not found (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/** Files of a project, latest first (each mapped as a version). */
export async function getVersions(id: string, apiKey: string, limit = 20): Promise<ModpackVersion[]> {
  const pageSize = Math.min(Math.max(limit, 1), 50);
  const url = `${BASE}/mods/${encodeURIComponent(id)}/files?pageSize=${pageSize}`;
  const body = await fetchJson<CfEnvelope<CfFile[]>>(url, { headers: authHeaders(apiKey) });
  return (body.data ?? []).map(mapFile);
}

/** Single file of a project (a specific pack version). */
export async function getFile(modId: string, fileId: string, apiKey: string): Promise<ModpackVersion> {
  try {
    const body = await fetchJson<CfEnvelope<CfFile>>(
      `${BASE}/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}`,
      { headers: authHeaders(apiKey) }
    );
    return mapFile(body.data);
  } catch (err) {
    throw new Error(
      `CurseForge file '${fileId}' of project '${modId}' not found (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Resolve a working download URL for a file. The `downloadUrl` field on File
 * objects is frequently null for modpack files, so this endpoint is the
 * reliable path. Returns the URL string.
 */
export async function getFileDownloadUrl(modId: string, fileId: string, apiKey: string): Promise<string> {
  const body = await fetchJson<unknown>(
    `${BASE}/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download-url`,
    { headers: authHeaders(apiKey) }
  );
  if (typeof body === 'string' && body !== '') return body;
  if (body !== null && typeof body === 'object') {
    const data = (body as { data?: unknown }).data;
    if (typeof data === 'string' && data !== '') return data;
  }
  throw new Error(
    `CurseForge returned no download URL for file '${fileId}' of project '${modId}'`
  );
}
