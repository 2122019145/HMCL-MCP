/**
 * Modrinth API v2 client — keyless, 300 req/min/IP, CORS-open
 * (docs/research/modpack-apis.md §1). The identifying User-Agent is added by
 * fetchJson (Modrinth requires it).
 *
 * All functions throw Error on failure; the tool layer (modpack.ts) converts
 * them into `fail(...)` results.
 */

import type { ModpackSummary, ModpackVersion } from '../types.js';
import { fetchJson } from '../util/http.js';

const BASE = 'https://api.modrinth.com/v2';

/** Search facet restricting results to modpacks: JSON-encoded, URL-encoded. */
const MODPACK_FACETS = encodeURIComponent(JSON.stringify([['project_type:modpack']]));

interface ModrinthHit {
  project_id?: string;
  slug?: string;
  author?: string;
  title?: string;
  description?: string;
  /** Supported Minecraft versions. */
  versions?: string[];
}

interface ModrinthProject {
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  game_versions?: string[];
}

interface ModrinthFile {
  primary?: boolean;
  url?: string;
  filename?: string;
  /** Bytes. */
  size?: number;
  hashes?: { sha1?: string; sha512?: string };
}

interface ModrinthVersion {
  id?: string;
  name?: string;
  version_number?: string;
  game_versions?: string[];
  files?: ModrinthFile[];
}

function projectUrl(slugOrId: string): string {
  return `https://modrinth.com/modpack/${slugOrId}`;
}

function mapHit(hit: ModrinthHit): ModpackSummary {
  const slug = hit.slug ?? hit.project_id ?? '';
  return {
    source: 'modrinth',
    id: slug,
    title: hit.title ?? slug,
    description: hit.description ?? '',
    authors: hit.author ? [hit.author] : [],
    versions: Array.isArray(hit.versions) ? hit.versions.map(String) : [],
    url: projectUrl(slug),
  };
}

/** Map a version, picking the primary file; null when the version has no files. */
function mapVersion(v: ModrinthVersion): ModpackVersion | null {
  const files = Array.isArray(v.files) ? v.files : [];
  if (files.length === 0) return null; // skip versions without downloadable files
  const file = files.find((f) => f.primary === true) ?? files[0];
  return {
    id: v.id ?? '',
    version: v.version_number ?? v.name ?? v.id ?? '',
    gameVersions: (v.game_versions ?? []).map(String),
    url: file.url ?? '',
    filename: file.filename ?? 'modpack.mrpack',
    size: typeof file.size === 'number' ? file.size : 0,
    sha1: file.hashes?.sha1,
  };
}

/** Search modpacks. `query` may be empty to list everything. */
export async function searchModpacks(query: string, limit: number): Promise<ModpackSummary[]> {
  const n = Math.min(Math.max(limit, 1), 100);
  const url = `${BASE}/search?query=${encodeURIComponent(query)}&facets=${MODPACK_FACETS}&limit=${n}`;
  const body = await fetchJson<{ hits?: ModrinthHit[] }>(url);
  return (body.hits ?? []).map(mapHit);
}

/** Project details by slug or 8-char id. */
export async function getModpack(id: string): Promise<ModpackSummary> {
  const path = encodeURIComponent(id);
  let project: ModrinthProject;
  try {
    project = await fetchJson<ModrinthProject>(`${BASE}/project/${path}`);
  } catch (err) {
    throw new Error(
      `Modrinth project '${id}' not found (${err instanceof Error ? err.message : String(err)})`
    );
  }
  const slug = project.slug ?? id;
  // The project endpoint has no author field; the team members endpoint does.
  // Best-effort: a failure here keeps the summary usable with authors = [].
  let authors: string[] = [];
  try {
    const members = await fetchJson<{ user?: { username?: string } }[]>(
      `${BASE}/project/${path}/members`
    );
    authors = members.map((m) => m.user?.username ?? '').filter((n) => n !== '');
  } catch {
    // ignore — authors are informational
  }
  return {
    source: 'modrinth',
    id: slug,
    title: project.title ?? slug,
    description: project.description ?? '',
    authors,
    versions: (project.game_versions ?? []).map(String),
    url: projectUrl(slug),
  };
}

/** Versions of a project, newest first (each mapped from its primary file). */
export async function getVersions(id: string, limit = 20): Promise<ModpackVersion[]> {
  const n = Math.min(Math.max(limit, 1), 100);
  const url = `${BASE}/project/${encodeURIComponent(id)}/version?limit=${n}`;
  const body = await fetchJson<ModrinthVersion[]>(url);
  return body
    .map(mapVersion)
    .filter((v): v is ModpackVersion => v !== null);
}

/** Single version by its 8-char version id. */
export async function getVersion(versionId: string): Promise<ModpackVersion> {
  const v = await fetchJson<ModrinthVersion>(`${BASE}/version/${encodeURIComponent(versionId)}`);
  const mapped = mapVersion(v);
  if (!mapped) {
    throw new Error(`Modrinth version '${versionId}' has no downloadable file`);
  }
  return mapped;
}
