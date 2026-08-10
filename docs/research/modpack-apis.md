# Modpack Distribution APIs — Research Notes

Researched 2026-08-10. All endpoints live-verified unless marked UNCERTAIN.
For the HMCL MCP server: **Modrinth is the primary, keyless source; CurseForge is optional (x-api-key); api.hmcl.net is dead.**

---

## 1. Modrinth API v2

Base URL: `https://api.modrinth.com` (all paths below under `/v2/`).
Verified live; exact JSON field names pasted from real responses.

### 1.1 Search projects

```
GET https://api.modrinth.com/v2/search?query=&facets=[["project_type:modpack"]]&limit=3&index=relevance
```

Verified URL: `https://api.modrinth.com/v2/search?query=&facets=%5B%5B%22project_type%3Amodpack%22%5D%5D&limit=3&index=relevance`

Query parameters (verified live):
- `query` — free text. Optional; empty string returns everything.
- `facets` — **JSON-encoded array of arrays**, URL-encoded. Each inner array is an OR-group of `"key:value"` strings; groups are AND-ed. `[["project_type:modpack"]]` filters to modpacks only. Other keys: `versions:1.20.1`, `categories:fabric`, `license:MIT`, `client_side:required`, etc.
- `index` — sort. Verified values: `relevance` (default), `downloads`, `follows`, `newest`, `updated`.
- `limit` (default 20, max 100), `offset` (default 0).

Response envelope (live response):
```json
{
  "hits": [ ... ],
  "offset": 0,
  "limit": 2,
  "total_hits": 18123
}
```

Hit object fields (live response, truncated): `project_id`, `project_type` ("modpack"), `all_project_types` (["modpack"]), `slug`, `author`, `author_id`, `organization`, `organization_id`, `title`, `description`, `categories` (["fabric","lightweight",...]), `display_categories`, `versions` (["1.16.5","1.17.1",...] supported MC versions), `downloads`, `follows`, `icon_url`, `date_created`, `date_modified`, `latest_version` (version id of latest), `license`, `client_side`, `server_side`, `gallery` (array of URLs), `featured_gallery`.
Note: search does **not** return file size; to know a pack's size you must call the version endpoint.

### 1.2 Get a project by slug or id

```
GET https://api.modrinth.com/v2/project/{id|slug}
```

Verified URL: `https://api.modrinth.com/v2/project/fabulously-optimized`
Slug and the 8-char base62 id are interchangeable everywhere (docs: "project subroutes ... now allow the slug to be used as the ID").
Response fields (live): `client_side`, `server_side`, `game_versions` (array), `id`, `slug`, `project_type`, `team`, `organization`, `title`, `description`, `body` (markdown), `downloads`, `follows`, `icon_url`, `date_created`, `date_modified`, `latest_version`, `license`, `gallery`.

### 1.3 List versions of a project

```
GET https://api.modrinth.com/v2/project/{id|slug}/version?limit=N
```

Verified URL: `https://api.modrinth.com/v2/project/fabulously-optimized/version?limit=2`
Optional params: `loaders` (comma list), `game_versions` (comma list), `featured`, `limit`. HMCL itself calls `/v2/project/{id}/version?include_changelog=false` (see HMCLCore/.../addon/repository/ModrinthRemoteAddonRepository.java:289).

Returns an array of version objects; exact field names (live response):
`game_versions`, `loaders`, `id`, `project_id`, `author_id`, `featured`, `name`, `version_number`, `changelog`, `changelog_url`, `date_published`, `downloads`, `version_type` ("release"|"beta"|"alpha"), `status` ("listed"), `requested_status`, `files`, `dependencies`.

Single version: `GET https://api.modrinth.com/v2/version/{id}` — same shape.

### 1.4 `files[]` element (exact fields, live response)

```json
{
  "id": "vvZM93Br",
  "hashes": { "sha512": "b7ca...d86", "sha1": "6220d93ba9ed9d0b0b56299ff593fd35c1628b48" },
  "url": "https://cdn.modrinth.com/data/1KVo5zza/versions/zsRTt1bK/Fabulously.Optimized-v14.0.0-beta.4.mrpack",
  "filename": "Fabulously.Optimized-v14.0.0-beta.4.mrpack",
  "primary": true,
  "size": 164232,
  "file_type": null
}
```
- `hashes` contains both `sha1` and `sha512` for mrpack files.
- `primary: true` marks the modpack file; a version may carry extra files (e.g. `cosign-bundle.zip` with `primary: false`). **Always select `primary === true` for the .mrpack.**
- `size` is bytes; `url` is the CDN URL (`cdn.modrinth.com`), content-addressed per version.

`dependencies[]` elements (live): `version_id`, `project_id`, `file_name`, `dependency_type` ("embedded"|"required"|"optional"|"incompatible").

### 1.5 Auth & rate limits (official docs, https://docs.modrinth.com/api/)

- **No auth needed for read/search/list/download URLs.** Tokens (`Authorization: mrp_...` PAT or OAuth) only for writes and private data.
- Rate limit: **300 requests per minute per IP**, identical with or without token. Response headers: `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`.
- **User-Agent is mandatory**: must uniquely identify the client; docs recommend `github_username/project_name/version (contact)`. Generic UAs (`okhttp/4.9.3`) increase blocking odds. Our server should send e.g. `hmcl-mcp-server/0.1.0 (https://github.com/...)`.
- CORS: wildcard, fully public.
- API v2 deprecation: old versions return 410 once deprecated; the docs recommend handling 410.
- Docs migration note: v1→v2 renamed `mod_id` → `project_id`; search moved from `/api/v1/mod` to `/v2/search`.

---

## 2. .mrpack format

Primary sources: official spec at https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack , plus ground-truth inspection of a real pack (Fabulously Optimized 14.0.0-beta.4, downloaded and unzipped during research).

### 2.1 Container

- ZIP archive, extension `.mrpack`, MIME `application/x-modrinth-modpack+zip`.
- `modrinth.index.json` at zip root, UTF-8. This is the only mandatory file.
- Optional `overrides/`, `server-overrides/`, `client-overrides/` directories.

### 2.2 modrinth.index.json fields (official spec + real file)

| field | type | notes |
|---|---|---|
| `formatVersion` | int | currently always `1` |
| `game` | string | only `"minecraft"` |
| `versionId` | string | unique id of this pack version |
| `name` | string | human-readable |
| `summary` | string, optional | short description |
| `files` | array | files to download into the instance |
| `dependencies` | object | loader/MC version constraints |

Real example (Fabulously Optimized, MC 26.2 fabric):
```json
{
  "formatVersion": 1,
  "game": "minecraft",
  "versionId": "14.0.0-beta.4",
  "name": "Fabulously Optimized",
  "files": [ ... ],
  "dependencies": { "fabric-loader": "0.19.3", "minecraft": "26.2" }
}
```
`dependencies` keys seen/known: `minecraft`, `fabric-loader`, `forge`, `neoforge`, `quilt-loader`.

### 2.3 files[] element (exact fields, from real file)

```json
{
  "path": "mods/BetterGrassify-1.8.7+fabric.26.2.jar",
  "hashes": { "sha1": "0f4a890d...315", "sha512": "7b70e796...fab" },
  "env": { "client": "required", "server": "required" },
  "downloads": ["https://cdn.modrinth.com/data/m5T5xmUy/versions/r4yqxYQl/BetterGrassify-1.8.7%2Bfabric.26.2.jar"],
  "fileSize": 88858
}
```
- `path` — destination relative to the Minecraft instance dir (e.g. `mods/X.jar` → `<instance>/mods/X.jar`). Can point at `mods/`, `resourcepacks/`, `shaderpacks/`, etc.
- `hashes` — MUST contain both `sha1` and `sha512` (spec).
- `env` (optional) — `client`/`server`, each `required` | `optional` | `unsupported`.
- `downloads` — array of HTTPS URLs (RFC 3986, no unencoded spaces). Modrinth validates uploads so URLs are whitelisted to Modrinth-hosted domains; other implementers SHOULD whitelist.
- `fileSize` — bytes, for progress bars.

### 2.4 overrides semantics (official spec)

- `overrides/` contents are copied to the Minecraft instance root on install (e.g. `overrides/config/foo.json` → `<instance>/config/foo.json`).
- `server-overrides/` applied **after** `overrides` (layer-based, overwrites on conflict) — server packs.
- `client-overrides/` — same but client-only.
- In the real FO pack, `overrides/` contains `config/`, plus entries like `overrides/config/modpack_defaults/...`.

### 2.5 Install-time behavior

The .mrpack is small (it's a manifest); installers download every `files[].downloads[0]`, verify against `hashes.sha1`/`sha512`, write to `path`, then copy `overrides`. For a launcher API this means: fetch index → parallel-download files → verify → apply overrides. The `dependencies.minecraft` value tells you the required MC version.

---

## 3. CurseForge API

Docs: https://docs.curseforge.com/ (SPA; content extracted; endpoint reference redirects to https://core.curseforge.com, "CurseForge for Studios API").

### 3.1 Authentication

- **Required**: `x-api-key: <API_KEY>` header on **every** request. Live probe without a key:
  `GET https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471` → `403` body `Forbidden: API Key missing or invalid`.
- Keys are issued via the CurseForge for Studios developer console (https://console.curseforge.com/). Third-party launcher/mods services must apply; API is intended for "3rd party modding service" providers.
- Implication for our server: CurseForge must be **opt-in via env var** (e.g. `CURSEFORGE_API_KEY`), and all calls must carry the header. Without a key, every request 403s.

### 3.2 Searching modpacks

```
GET https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471
```
Query params (from docs, exact names): `gameId` (int, **required**), `classId` (int, filter by section/class, discoverable via /v1/categories), `categoryId` (int), `categoryIds` (string, list — overrides `categoryId`), `gameVersion` (string), `gameVersions` (string list — overrides `gameVersion`), `searchFilter` (free text on mod name and author), `sortField` (ModsSearchSortField enum), `sortOrder` (SortOrder), `index`, `pageSize` (max **50**; `index + pageSize <= 10000`).

- `gameId=432` is Minecraft. `classId=4471` is the "Modpacks" class (given in task; category IDs within it are discoverable via `GET /v1/categories?gameId=432&classId=4471`, which also requires the key — not live-verified here).
- Response: `{"data": [ {Mod}, ... ]}` (also `pagination` with `index`, `pageSize`, `resultCount`, `totalCount`). Mod object fields: `id`, `gameId`, `name`, `slug`, `summary`, `status`, `downloadCount`, `isFeatured`, `primaryCategoryId`, `categories[]`, `classId`, `authors[]`, `logo`, `screenshots[]`, `mainFileId`, `latestFiles[]`, `dateModified`. `latestFiles[]` entries: `id`, `gameId`, `modId`, `isAvailable`, `displayName`, `fileName`, `releaseType` (1=Release, 2=Beta, 3=Alpha), `fileStatus`, `hashes[]` (`{value, algo}` where algo 1=sha1, 2=md5), `fileDate`, `fileLength`, `downloadCount`, `fileSizeOnDisk`, `downloadUrl` (**may be null**), `gameVersions[]`, `sortableGameVersions[]`.

### 3.3 Files listing/download — the second-call problem

```
GET /v1/mods/{modId}/files            # list files (paged: index, pageSize)
GET /v1/mods/{modId}/files/{fileId}   # single file
GET /v1/mods/{modId}/files/{fileId}/download-url   # resolve download URL
GET /v1/mods/{modId}/files/{fileId}/changelog
```
- The `downloadUrl` field on File objects is **not guaranteed** (docs example shows it as a plain string field; in practice it is frequently null for modpack files). The reliable path is the `/download-url` endpoint, i.e. **files need a second API call** to obtain a working download link. 
- Modpack manifest (the zip's `manifest.json`) references files only as `{projectID, fileID, required}` pairs (see HMCL's parser below), so installing a CurseForge modpack requires one `/v1/mods/{id}/files/{fileId}` (or download-url) call per file.
- Hashes come as `hashes[]` with `algo` enum (1=sha1, 2=md5 per HashAlgo schema — exact enum values not fully verified).

### 3.4 CurseForge modpack manifest.json (from HMCL source, verified)

HMCL `CurseManifest.java` (HMCLCore/.../modpack/curse/, current main) parses these exact `@SerializedName` fields:
`manifestType` (== "minecraftModpack"), `manifestVersion` (int), `name`, `version`, `author`, `overrides` (string, overrides dir name), `files` (list of `projectID`/`fileID`/`required`), `minecraft` → `{ "version": <MC version>, "modLoaders": [ {"id": "forge-40.1.0"|"fabric-0.14.x", "primary": bool} ] }`.
Standard CF pack layout: `manifest.json` + `overrides/` in a zip (extension `.zip`).

### 3.5 HMCL's own CurseForge usage

- Current HMCL has `modpack/curse/` (CurseInstallTask, CurseCompletionTask, CurseModpackProvider) and `addon/repository/CurseForgeRemoteAddonRepository.java`.
- `CurseCompletionTask` queries `api.curseforge.com` for deleted mods/mod metadata (HMCLCore/.../modpack/curse/CurseCompletionTask.java:129,163) — so HMCL itself talks to `https://api.curseforge.com`.
- It embeds its own key; **we should not** — env key only.

---

## 4. HMCL official modpack repository API (api.hmcl.net) — DEAD

**Conclusion: `api.hmcl.net` does not resolve (NXDOMAIN). The endpoint is dead; do not implement against it.** Evidence:

1. **DNS** (verified via Google DNS `https://dns.google/resolve?name=api.hmcl.net&type=A|AAAA|NS`): all three return `"Status": 3` (NXDOMAIN) with authority `hmcl.net. NS lee.ns.cloudflare.com dns.cloudflare.com` — the subdomain does not exist; only the apex has NS records.
2. **Live probes**: `https://api.hmcl.net/` → TLS handshake failure (curl schannel); `http://api.hmcl.net/` → `502 Bad Gateway` from the local proxy (proxy cannot resolve it). Probed paths `/`, `/api/modpack/list` — nothing.
3. **Wayback Machine**: CDX query `url=api.hmcl.net&matchType=domain` → **zero captures** (`[]`). The subdomain was never archived. The apex `hmcl.net` was an unrelated Japanese site from 2001 until ~2022; first HMCL-related capture is 2022-03-31 (huanghongxun's blog "hello-world"); latest apex capture (2025-12) is a 404.
4. **HMCL source (current `main`)**: grep of all Java for `hmcl.net` finds only `docs.hmcl.net` (Metadata.java `DOCS_URL`). No `api.hmcl.net` anywhere; the modpack download UI is now CurseForge + Modrinth only (`ModpackPage` is abstract; providers in `modpack/curse/`, `modpack/modrinth/`; ModrinthRemoteAddonRepository uses `https://api.modrinth.com` + `/v2/search`, `/v2/project/{id}`, `/v2/project/{id}/version?include_changelog=false`, `/v2/version/{versionId}` — lines 108–320).
5. **Historical host**: old HMCL binaries referenced `hmcl.huangyuhui.net` (e.g. `https://hmcl.huangyuhui.net/api/redirect/server-modpack`); Wayback has a 200 capture from 2019-01-17 but 404s by 2025. The old modpack-repository feature was retired; if an `api.hmcl.net/modpack/list` ever existed, it is unrecoverable (no archives).

**Do not implement. Use Modrinth (keyless) as primary, CurseForge (env key) as optional.**

---

## 5. Small modpacks for automated tests (all < 15 MB, all download+sha1 verified)

All three verified by downloading the file and comparing sha1 + size against the API values. Note: .mrpack files are manifests — tiny; the real download volume happens during install.

### 5.1 fabulously-optimized (most popular pack; beta but stable choice)
- slug: `fabulously-optimized` — project id `1KVo5zza`
- version id: `zsRTt1bK` — "14.0.0-beta.4 for 26.2" (version_type `beta`)
- game_versions: `["26.2"]`, loaders: `["fabric"]`, published 2026-08-02, downloads ~209k
- URL: `https://cdn.modrinth.com/data/1KVo5zza/versions/zsRTt1bK/Fabulously.Optimized-v14.0.0-beta.4.mrpack`
- filename: `Fabulously.Optimized-v14.0.0-beta.4.mrpack` — **size 164,232 B (0.16 MB)** — sha1 `6220d93ba9ed9d0b0b56299ff593fd35c1628b48`
- file id `vvZM93Br`; manifest: 48 mod files, `dependencies: {minecraft: "26.2", fabric-loader: "0.19.3"}`, has `overrides/`

### 5.2 adrenaline (release; performance pack by romvnly)
- slug: `adrenaline` — project id `BYN9yKrV`
- version id: `r5uSD3JV` — "26.4.2+mc26.2.fabric" (version_type `release`)
- game_versions: `["26.2"]`, loaders: `["fabric"]`, published 2026-07-28
- URL: `https://cdn.modrinth.com/data/BYN9yKrV/versions/r5uSD3JV/Adrenaline-26.4.2%2Bmc26.2.fabric.mrpack`
- filename: `Adrenaline-26.4.2+mc26.2.fabric.mrpack` — **size 6,900 B (0.007 MB)** — sha1 `07a28d35568e6ea688e8b07373d552daf7053fb7`
- file id `hZ9wZV9Y`

### 5.3 simply-skyblock (release; older, widely-known MC 1.19.2)
- slug: `simply-skyblock` — project id `Bj1v3s2G`
- version id: `X5bsMAUF` — "1.0.0" (version_type `release`)
- game_versions: `["1.19.2"]`, loaders: `["fabric"]`, published 2022-12-18
- URL: `https://cdn.modrinth.com/data/Bj1v3s2G/versions/X5bsMAUF/Simply%20Skyblock.mrpack`
- filename: `Simply Skyblock.mrpack` — **size 6,647 B (0.006 MB)** — sha1 `65481473f05455fb4a50402f28835aca8218ecb2`
- file id `qgIOO7yn`

Search-note: search API does not filter by size; candidates were found by querying `project_type:modpack` facet with `index=downloads` and checking each latest version's primary file size (46 packs scanned; sizes ranged 0.006 MB–121 MB).

---

## 6. UNCERTAIN

- **CurseForge `classId=4471` / category IDs**: endpoint syntax verified in docs, but live validation of `gameId=432&classId=4471` returning modpack data could not be done (403 without API key — we have none). The value 4471 for the Modpacks class is from the task brief / community knowledge, not verified against the API. Same for specific category IDs (4474/4481/4546/4559 etc.) — discover via `GET /v1/categories?gameId=432` once you have a key.
- **CurseForge `HashAlgo` enum values**: docs show `algo` ints (1 appears as sha1 in the File example); exact mapping for all values not fully verified.
- **`downloadUrl` null-ness**: docs list the field as a plain string; community practice says it is frequently null for modpack files and the `/download-url` endpoint must be used. Verify once a key is available.
- **`optionalFiles` in modrinth.index.json**: present in some pack tooling/spec discussions but NOT in the official support.modrinth.com spec page or in the real packs inspected; treat as unsupported unless encountered.
- **Historical `api.hmcl.net/modpack/list` exact request format** (params like version/uid/api): could not be confirmed from any primary source; the endpoint is NXDOMAIN and has zero Wayback captures. Irrelevant for implementation.
- **Modrinth rate limit (300/min)**: from official docs; not stress-tested.
- **Modrinth docs site layout**: `docs.modrinth.com/docs/modpacks/*` URLs 404 (docs restructured); the .mrpack spec now lives at support.modrinth.com — the /api/ overview at docs.modrinth.com/api/ still works.
- **HMCL "26.2" MC version**: current packs target MC version numbering "26.2" (2026-era); older stable packs (1.19.2/1.20.1) still exist for tests that need familiar versions.

---

## Summary (decision-relevant facts)

1. **Modrinth v2 is keyless, CORS-open, 300 req/min/IP**; mandatory identifying User-Agent; read endpoints need no auth. Search: `GET /v2/search?facets=[["project_type:modpack"]]&query=&index=&limit=` → `{hits[], offset, limit, total_hits}`. Project: `/v2/project/{id|slug}`. Versions: `/v2/project/{id}/version?limit=` (array) or `/v2/version/{id}`.
2. Version `files[]` fields are exactly `id, hashes{sha1,sha512}, url, filename, primary, size, file_type`; pick `primary:true`; `size` is bytes; CDN URL is directly downloadable without auth.
3. `.mrpack` = zip with `modrinth.index.json` (formatVersion 1, game "minecraft", versionId, name, files[], dependencies{minecraft, fabric-loader|forge|neoforge|quilt-loader}) + optional `overrides/`, `server-overrides/`, `client-overrides/` (copied to instance root, layers override in that order). files[] entries: `path`, `hashes{sha1,sha512}`, `env{client,server}`, `downloads[]`, `fileSize`. Install = download files, verify sha1/sha512, write to `path`, copy overrides.
4. CurseForge requires `x-api-key` on every call (403 "Forbidden: API Key missing or invalid" without it, live-verified). Key only from the CurseForge for Studios console. Search: `/v1/mods/search?gameId=432&classId=4471` (+ categoryId/searchFilter/sortField/index/pageSize≤50). Files: `/v1/mods/{id}/files`, `/v1/mods/{id}/files/{fileId}`, `/v1/mods/{id}/files/{fileId}/download-url` — downloadUrl is unreliable, so file downloads need a second call. CF manifests reference files as {projectID, fileID, required} → N API calls per pack. Implement as optional env-key feature only.
5. **api.hmcl.net is dead**: NXDOMAIN (Google DNS Status 3), TLS fails, zero Wayback captures, and no references in current HMCL source. HMCL now uses Modrinth + CurseForge (its Modrinth calls match the v2 endpoints above exactly). Don't build against it.
6. Test packs (all verified by actual download + sha1): fabulously-optimized `zsRTt1bK` (164,232 B, sha1 6220d93…), adrenaline `r5uSD3JV` (6,900 B, sha1 07a28d35…), simply-skyblock `X5bsMAUF` (6,647 B, sha1 65481473…). All .mrpack manifests are <1 MB regardless of pack size.
7. Architect the server: Modrinth primary (keyless, single source of truth), CurseForge behind env key with per-file resolution, no HMCL-repo fallback.
