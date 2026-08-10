/**
 * HTTP helpers shared by the tool modules.
 *
 * All requests send a User-Agent identifying this server: Modrinth requires
 * an identifying User-Agent (generic ones increase blocking odds), CurseForge
 * accepts any. Search/download of modpacks is done by Node directly against
 * the Modrinth / CurseForge REST APIs (docs/research/modpack-apis.md).
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** User-Agent sent on every request. */
export const HTTP_USER_AGENT = 'hmcl-mcp/0.1.0';

/** Abort timeout: 30 s for API calls, 5 min for file downloads. */
export const API_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export interface FetchJsonOptions {
  /** Extra headers (e.g. x-api-key for CurseForge). User-Agent is always added. */
  headers?: Record<string, string>;
  /** Abort timeout in ms. Defaults to API_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * GET `url` and parse the JSON body.
 *
 * Throws Error on network failure, HTTP error status (message includes the
 * status text), or invalid JSON. Never returns a non-2xx body.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': HTTP_USER_AGENT, ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `Request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(
      `Invalid JSON response from ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export type DownloadResult =
  | { ok: true; path: string; size: number }
  | { ok: false; error: string };

/**
 * Stream `url` to `dest` (creating parent directories), optionally verifying
 * the SHA-1 of the downloaded bytes.
 *
 * Never throws for user-level failures — returns `{ ok: false, error }`
 * instead. On any failure (HTTP error, stream error, SHA-1 mismatch) the
 * partial file is removed so a corrupt pack never stays in mcpacks/.
 */
export async function downloadFile(url: string, dest: string, sha1?: string): Promise<DownloadResult> {
  try {
    await mkdir(dirname(dest), { recursive: true });
    const res = await fetch(url, {
      headers: { 'User-Agent': HTTP_USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText} for ${url}` };
    }
    if (!res.body) {
      return { ok: false, error: `Download from ${url} returned no body` };
    }
    const hash = createHash('sha1');
    let size = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(res.body, hasher, createWriteStream(dest));
    if (sha1) {
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== sha1.toLowerCase()) {
        await rm(dest, { force: true });
        return {
          ok: false,
          error: `SHA-1 mismatch for ${url}: expected ${sha1}, got ${actual}`,
        };
      }
    }
    return { ok: true, path: dest, size };
  } catch (err) {
    await rm(dest, { force: true });
    return {
      ok: false,
      error: `Download failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
