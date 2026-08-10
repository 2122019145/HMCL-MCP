# MCP TypeScript SDK — research for HMCL-MCP (stdio server)

Researched 2026-08-10 against live npm registry, the published 1.30.0 tarball, the typescript-sdk GitHub repo, and modelcontextprotocol.io. Every behavior marked `[VERIFIED LIVE]` was executed in a real server+client smoke test (files in `/tmp/mcp-smoke`: `src/server.ts`, `src/client.ts`).

---

## 1. Package name + latest version

- Package: `@modelcontextprotocol/sdk`
- Latest (dist-tag `latest`): **1.30.0**, published 2026-07-27.
  - Verified: `npm view @modelcontextprotocol/sdk version` → `1.30.0`; `dist-tags.latest` → `1.30.0` (https://www.npmjs.com/package/@modelcontextprotocol/sdk).
- Release line: **1.30.0 is the last v1 release**. The repo `main` branch is now v2 (see §6).
- The repo's `package.json` already pins `"@modelcontextprotocol/sdk": "^1.30.0"` — correct choice for now.

## 2. Recommended API — v1.30.0

### Import path

`McpServer` is exported from the **subpath** `@modelcontextprotocol/sdk/server/mcp.js`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
```

Verified in the 1.30.0 tarball: `dist/esm/server/mcp.d.ts` → `export declare class McpServer`; `dist/esm/server/mcp.js` (https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/server/mcp.ts).

### Registration method: `registerTool(...)` — `server.tool(...)` is deprecated

In 1.30.0 both exist, but every `tool()` overload is annotated `@deprecated Use registerTool instead`. Exact signature from `dist/esm/server/mcp.d.ts`:

```ts
registerTool<OutputArgs, InputArgs>(name: string, config: {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;      // Zod raw shape ({ a: z.number() }) or z.object(...)
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}, cb: ToolCallback<InputArgs>): RegisteredTool;
```

The deprecated `tool()` overloads (all present in 1.30.0): `tool(name, cb)`, `tool(name, description, cb)`, `tool(name, paramsSchemaOrAnnotations, cb)`, `tool(name, description, paramsSchemaOrAnnotations, cb)`, `tool(name, paramsSchema, annotations, cb)`, `tool(name, description, paramsSchema, annotations, cb)`.

**Use `server.registerTool(name, { title?, description, inputSchema }, handler)`** — matches both the current v1 API and the v2 API (see §6), so future migration is trivial.

### Zod peer dependency — REQUIRED, not currently in repo

`peerDependencies: { "zod": "^3.25 || ^4.0", "@cfworker/json-schema": "^4.1.1" }` with `peerDependenciesMeta: { "@cfworker/json-schema": { optional: true }, "zod": { optional: false } }` (verified in tarball `package.json`). The SDK internally imports `zod/v4` but works with Zod 3.25+ (README, https://www.npmjs.com/package/@modelcontextprotocol/sdk).

**Action: HMCL-MCP `package.json` must add `"zod": "^3.25.0"` (or `^4`) — it is missing today.** `[VERIFIED LIVE]` smoke test ran with `zod@3.25.76` and SDK 1.30.0 with zero warnings.

## 3. Stdio transport

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const transport = new StdioServerTransport();   // defaults to process.stdin / process.stdout
await server.connect(transport);
```

- Constructor: `new StdioServerTransport(stdin?, stdout?, { maxBufferSize? })` — defaults `_stdin = process.stdin`, `_stdout = process.stdout`; **Node.js only** (verified `dist/esm/server/stdio.d.ts` and `stdio.js`).
- **stdout must stay pure JSON-RPC.** `send()` writes the raw JSON-RPC line via `this._stdout.write(json)` (`stdio.js` line 72). Never `console.log` from the server process.
- **Logging**: use `console.error(...)` — the official tutorial does exactly this: `console.error("Weather MCP Server running on stdio")` (https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server). Alternatively `server.sendLoggingMessage({ level, data })` sends a `notifications/message` to the client (both `Server` and `McpServer` expose it; verified in `server/mcp.d.ts` and `server/index.d.ts`). There is **no `logger` export in the 1.30.0 package** (searched `dist/esm` — none).
- `[VERIFIED LIVE]`: e2e test ran with a `console.error` banner; stdout carried only JSON-RPC and the client parsed every message correctly.

## 4. Handler return shape + error handling

### Success shape

Return `{ content: [{ type: "text", text: string }] }`. `CallToolResult` schema (verified in `dist/esm/types.js`):

```ts
CallToolResultSchema = ResultSchema.extend({
  content: z.array(ContentBlockSchema).default([]),   // MUST be present if no outputSchema
  structuredContent: z.record(z.string(), z.unknown()).optional(), // MUST match outputSchema if one is defined
  isError: z.boolean().optional(),                    // default false
});
```

### Tool-level errors: `isError: true` (this is the mechanism clients/LLMs see)

Spec (https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling): two channels —
1. **Protocol errors** (unknown tool, malformed request, server errors) → JSON-RPC error responses (`{ code: -32602, ... }`).
2. **Tool execution errors** (API failures, input validation, business logic) → **successful result with `isError: true`**, so the LLM can read the message and self-correct. Clients SHOULD surface these to the model.

Two equivalent ways to produce a tool error (both `[VERIFIED LIVE]`):
- Return `{ content: [{ type: "text", text: "..." }], isError: true }` — full control over content.
- `throw new Error("...")` — the SDK's `CallToolRequestSchema` handler catches **anything** a tool handler throws and converts it via `createToolError(error.message)` → `{ content: [{ type: "text", text: msg }], isError: true }` (verified in `dist/esm/server/mcp.js` lines 133–142). The server does not crash.

### v1.30.0 quirk — everything comes back as `isError`, nothing throws on `tools/call`

`[VERIFIED LIVE]` against the actual package: the catch-all wraps **every** failure into an `isError: true` result, including:
- unknown tool name → `{ isError: true, content: [{ type: "text", text: "MCP error -32602: Tool nope not found" }] }` (client `callTool` did **not** throw)
- input-schema validation failure → `{ isError: true, text: "MCP error -32602: Input validation error: Invalid arguments for tool add: ..." }`

Only `ErrorCode.UrlElicitationRequired` (-32042) is rethrown as a JSON-RPC error. Same behavior in 1.29.0 (diff of the catch blocks is empty). `McpError`/`ErrorCode` still exist (`dist/esm/types.js`: `enum ErrorCode` — `ConnectionClosed -32000`, `RequestTimeout -32001`, `ParseError -32700`, `InvalidRequest -32600`, `MethodNotFound -32601`, `InvalidParams -32602`, `InternalError -32603`, `UrlElicitationRequired -32042`; `class McpError extends Error`), imported via `@modelcontextprotocol/sdk/types.js`. For tool handlers they are mostly redundant in 1.30.0 because of the wrapping; they matter for resources/prompts/completion callbacks and low-level `Server` handlers.

**Recommendation for HMCL-MCP**: return `{ content: [...], isError: true }` explicitly for recoverable failures (modpack not found, download failed) with a fix-oriented message; let unexpected exceptions bubble (SDK converts them). Prefer `console.error` + explicit `isError` over relying on the wrap for precise messages.

## 5. Node version, ESM/CJS

- v1 (`@modelcontextprotocol/sdk@1.30.0`): `engines.node >= 18` (tarball `package.json`). Repo sets `>=18` — OK.
- Package is `"type": "module"` with dual builds: `exports` map serves `dist/esm/*` for `import` and `dist/cjs/*` for `require` (verified tarball `package.json`). ESM + `tsconfig` `module: NodeNext` (repo already set) works; use the `.js` subpath specifiers exactly as shown in §2/§3.
- **Subpath imports are mandatory**: the 1.30.0 tarball's root export `.` points to `dist/esm/index.js` / `dist/cjs/index.js` which **do not exist in the tarball** (verified via `tar -tzf` — the only index files are `server/index.*`, `client/index.*`, `experimental/index.*`). Import from `@modelcontextprotocol/sdk/server/mcp.js`, `.../server/stdio.js`, `.../client/index.js`, `.../client/stdio.js`, `.../types.js` — never the bare package name.
- `globalThis.crypto` caveat: JWT/auth parts need Web Crypto (Node 18 has it natively; FAQ: https://ts.sdk.modelcontextprotocol.io/). Not relevant for a stdio server.

## 6. The 2.x generation — released, but not what `latest` points to

- The repo `main` branch is **v2** of the SDK, released alongside the **2026-07-28 MCP spec**; v2 docs: https://ts.sdk.modelcontextprotocol.io/v2/ (repo README: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md).
- v2 is split into **two packages** (both `2.0.0`, both `engines.node >= 20`, verified via `npm view`):
  - `@modelcontextprotocol/server` — server lib
  - `@modelcontextprotocol/client` — client lib
- v2 changes vs v1:
  - `McpServer` now from `@modelcontextprotocol/server`; stdio from `@modelcontextprotocol/server/stdio`.
  - **`server.tool()` is gone; `registerTool(name, { title?, description, inputSchema }, handler)` is the only API** (main-branch README and docs/server.md).
  - Schemas use **Standard Schema** — Zod v4 (`zod/v4`), Valibot, or ArkType (`import * as z from 'zod/v4'` in docs).
  - `McpError`/`ErrorCode` are replaced by **`ProtocolError`/`ProtocolErrorCode`** (docs/servers/errors.md: "Coming from v1? ProtocolError and ProtocolErrorCode replace v1's McpError and ErrorCode"). New codes `-32021 MissingRequiredClientCapability` and `-32022 UnsupportedProtocolVersion` (2026-07-28 protocol revision).
  - Tool-error semantics are the same: every handler exception → `isError: true` result; only `UrlElicitationRequiredError` escapes. An unknown tool name is a protocol-level error that **does throw** out of client `callTool` (v2 first-client doc, https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md).
- v1.x continues to get fixes for ≥6 months after v2's release (repo README). **Decision: stay on `@modelcontextprotocol/sdk@^1.30.0` (v1) for HMCL-MCP now** — it is npm `latest`, works with all current hosts, and the `registerTool` surface is shared with v2. The `@modelcontextprotocol/server`/`client` migration is mechanical when the time comes.
- Current official tutorial (https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server) already teaches v2 imports — do not copy its import lines verbatim into this v1 project; the v1 equivalents are in §2/§3.

## 7. Minimal working server (~40 lines, v1.30.0) — `[VERIFIED LIVE]`

```ts
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "hmcl-mcp", version: "0.1.0" });

server.registerTool(
  "greet",
  { title: "Greet", description: "Greet someone by name", inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: "text", text: `Hello, ${name}!` }] })
);

server.registerTool(
  "add",
  { title: "Add", description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => {
    if (a < 0 || b < 0) {
      return { content: [{ type: "text", text: "a and b must be non-negative" }], isError: true };
    }
    return { content: [{ type: "text", text: String(a + b) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("hmcl-mcp running on stdio"); // stderr only — stdout is JSON-RPC
}
main().catch((err) => { console.error("fatal:", err); process.exit(1); });
```

Compiled with repo's tsconfig (`module: NodeNext`, `"type": "module"`), run with `node dist/server.js`.

## 8. E2E testing: Client + StdioClientTransport — `[VERIFIED LIVE]`

```ts
// test/e2e.test.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "hmcl-mcp-test", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,       // or "node"
  args: ["dist/server.js"],        // server is spawned by the transport — never start it yourself
  stderr: "inherit",               // default "inherit": server console.error goes to test stderr
});
await client.connect(transport);   // runs the initialize handshake

const { tools } = await client.listTools();                    // -> { tools: [{ name, description, inputSchema, ... }] }
const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
// result: { content: [{ type: "text", text: "5" }] } — plus structuredContent?, isError? (false/absent)

await client.close();              // ends server stdin; kills process if needed — put in finally
```

- `StdioClientTransport` ctor: `{ command: string, args?: string[], env?: Record<string,string>, stderr?: IOType }` — `stderr: "pipe"` also available to assert on server logs (verified `dist/esm/client/stdio.d.ts`).
- v1.30.0 assertion rules for tests (verified live): failed handler and invalid args → **resolved** result with `isError: true`; unknown tool → **resolved** result with `isError: true` (v1.30.0 only — see §4; in v2 it throws). Assert on `result.isError === true` and message content, don't expect rejects.
- Client API surface (verified `dist/esm/client/index.d.ts`): `new Client({ name, version }, options?)`, `connect(transport)`, `listTools(params?)`, `callTool({ name, arguments? })`, `getServerCapabilities()`, `ping()`, `close()`. The v2 client docs describe the same verbs (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md).
- Repo's `npm test` script is `tsx --test test` — write one file that spawns the built server, asserts `listTools` contains the HMCL tools, calls success + failure paths, and `close()`s in `finally`.

## UNCERTAIN

- **Root `"."` export broken in 1.30.0**: exports map references `dist/esm/index.js` but the tarball has no such file (verified by listing). Importing the bare package name likely fails at runtime (not tested — we always used subpaths). This is presumably a packaging regression of the final v1 release; re-check on the next v1.x publish.
- **Unknown-tool → `isError: true` behavior** in v1.30.0/1.29.0 contradicts the 2026-07-28 spec (which treats unknown tool as a protocol error) and v2 SDK behavior. Verified live, but I could not find v1 docs stating this change; treat as v1-line behavior and re-verify when upgrading.
- **`server.tool()` deprecation date**: confirmed deprecated in 1.30.0; not checked when it was introduced (only that `registerTool` exists and is un-deprecated).
- **v1 docs site** (https://ts.sdk.modelcontextprotocol.io/) serves the v1 README; I did not crawl its tutorial pages (v1 source code + live tests were treated as primary). Old modelcontextprotocol.io tutorial URLs (`/docs/develop/build-mcp-server/typescript`, `/docs/2025-11-25/...`) return 404 — the docs site was restructured; the current tutorial lives at `/docs/2026-07-28/develop/build-server` (v2).
- **`globalThis.crypto` on Node 18**: FAQ claims polyfill may be needed for auth features on older runtimes; not exercised (unused by stdio servers).
- v2 `registerTool` exact TypeScript signature (Standard Schema generics) not read from source; shape confirmed from main-branch README + docs/server.md examples only.

---

## Summary (decision-relevant facts)

1. Use `@modelcontextprotocol/sdk@^1.30.0` (npm `latest`; last v1 release, 2026-07-27). Repo already pins it.
2. Add missing required peer dep `zod` (`^3.25 || ^4.0`) to package.json — the SDK hard-requires it; smoke-tested with zod 3.25.76.
3. Import only from subpaths: `@modelcontextprotocol/sdk/server/mcp.js`, `.../server/stdio.js`, `.../client/index.js`, `.../client/stdio.js`. The bare package import is broken in 1.30.0 (missing root index).
4. Register tools with `server.registerTool(name, { title?, description, inputSchema: { a: z.number() } }, handler)`; `server.tool()` is deprecated. Same signature shape as v2 → easy migration.
5. Stdio: `new StdioServerTransport()` + `await server.connect(transport)`. stdout carries only JSON-RPC; log via `console.error` (official tutorial pattern) or `server.sendLoggingMessage`.
6. Return `{ content: [{ type: "text", text }] }` on success; failures the model can fix → `isError: true` (explicit return or throw — SDK wraps throws; server never crashes).
7. In v1.30.0 every tools/call failure (bad args, unknown tool) resolves as `isError: true`; nothing rejects. Write tests accordingly; v2 will throw for unknown tools.
8. Node >= 18 (v1) / >= 20 (v2). Repo `type: module` + `module: NodeNext` matches the SDK's dual ESM/CJS build.
9. E2E tests: `Client` + `StdioClientTransport({ command: process.execPath, args: [...] })`; `connect()` → `listTools()` → `callTool()` → `close()` in `finally`. Verified working end-to-end.
10. v2 (packages `@modelcontextprotocol/server`/`@modelcontextprotocol/client` 2.0.0, spec 2026-07-28) exists but isn't `latest`; official tutorial now teaches v2. Stay on v1; migration = rename imports + `ProtocolError` instead of `McpError`.
