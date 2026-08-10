# HMCL MCP Server

MCP (Model Context Protocol) server that lets AI agents drive **HMCL** (Hello Minecraft! Launcher, https://hmcl.huangyuhui.net) programmatically: install Minecraft versions, search/download/import modpacks (Modrinth + CurseForge), and launch/stop the game.

HMCL has **no command line interface** (no `--launch`, no `--import`, no headless mode), so this project injects a small **javaagent** into a headless HMCL JVM and drives HMCL's core classes directly. Modpack search/download/install all run through HMCL's own addon repositories inside the agent (Modrinth, and CurseForge with HMCL's embedded API key — no user key needed); listing installed versions/modpacks is a local filesystem scan.

## Architecture

```
┌──────────────────────────────┐   stdio (JSON-RPC only)   ┌────────────────────────────────┐
│  MCP client / AI agent       │ ◀────────────────────────▶ │  Node MCP server (this repo)   │
└──────────────────────────────┘                            └───────────────┬────────────────┘
                                                      filesystem scans      │ HTTP JSON API
                                                <workdir>/versions/,        │ 127.0.0.1:<port>
                                                mcpacks/ (search/download)  │ X-HMCL-Agent-Token
                                                                             ▼
                                                              ┌────────────────────────────────┐
                                                              │  Headless HMCL JVM              │
                                                              │  java -javaagent:hmcl-agent.jar │
                                                              │  -Dhmcl.gameDir=<workdir> …      │
                                                              │  -cp HMCL.jar;javafx-*.jar       │
                                                              │  hmcl.agent.AgentMain            │
                                                              └────────────────────────────────┘
```

- **Node MCP server** (`src/`, TypeScript, stdio transport): registers 13 tools, drives HMCL's own Modrinth/CurseForge modpack repositories for search/download/install, scans `<workdir>/versions/` on disk for installed versions and modpacks, and talks to the agent over loopback HTTP.
- **Java agent** (`agent/`, compiled by `npm run build:agent`): injected into HMCL with `-javaagent`; initializes HMCL core headlessly (`SettingsManager.init()` → `DownloadProviders.init()` → `Accounts.init()`) and exposes a loopback HTTP JSON API (`/status`, `/versions/install`, `/modpack/install`, `/launch`, `/launch/stop`, `/shutdown`) on `127.0.0.1:<port>`. A non-daemon HTTP thread keeps the JVM alive.
- **No launcher GUI**: the HMCL window never opens. When you launch the game, the **game window itself opens normally** (the game is a separate child process).

HMCL-compatible directory layout inside the workdir: `versions/<id>/`, `libraries/`, `assets/`, `mcpacks/` (downloaded pack files), `hmcl/` (HMCL.jar + hmcl-agent.jar + javafx jars), `.hmcl/` (HMCL 3.16+ workspace config).

## Requirements

- Node.js 18+ (24 recommended) — MCP SDK 1.30.0, `npm install`
- JDK 17+ with `javac` (21 recommended) — HMCL itself requires Java 17; `javac` is needed to compile the agent jar
- Internet access on first run (HMCL jar, javafx jars, Minecraft versions/libraries/assets)

## Tools (13)

| Tool | Args | Description |
|---|---|---|
| `check_environment` | — | Java path + version, workdir, hmcl dir contents (HMCL.jar / hmcl-agent.jar / javafx jars), agent running status, version/modpack counts |
| `install_hmcl` | — | Download latest HMCL jar into `<hmclDir>/HMCL.jar` if missing, then build the agent jar (`node agent/build.mjs`, needs javac) and copy `hmcl-agent.jar` + javafx jars into `<hmclDir>/` |
| `start_hmcl` | — | Start the headless HMCL JVM with the agent (no-op if already running) and return agent `/status` |
| `stop_hmcl` | — | Stop the headless HMCL JVM (agent `/shutdown`) and confirm it is down |
| `list_versions` | — | Scan `<workdir>/versions/`; a dir counts as a version when it contains `<id>/<id>.json` → `[{id, path, hasJar}]` |
| `install_version` | `mc_version` (string) | Install a vanilla Minecraft version through the agent's HMCL download pipeline |
| `search_modpacks` | `query` (string), `source` (`modrinth`\|`curseforge`, optional), `limit` (number, optional) | Search modpacks via HMCL's own repositories (CurseForge uses HMCL's embedded key — no user key needed) |
| `get_modpack` | `id` (string), `source` (optional) | Project details + latest version for one modpack (id = Modrinth slug or CurseForge numeric id) |
| `download_modpack` | `id` (string), `versionId` (string, optional), `source` (optional) | Download the pack file into `<workdir>/mcpacks/` (sha1-verified); `versionId` picks a specific version, defaults to latest |
| `install_modpack` | `id` (string, optional), `versionId` (string, optional), `path` (string, optional), `name` (string, optional), `source` (optional) | Download (if `id` given, or `path` to a local file) then agent-install the pack as an instance under `<workdir>/versions/<name>/` |
| `list_modpacks` | — | Scan `<workdir>/versions/*/modpack.json` → `[{name, path, format, gameVersion?, modLoader?}]` (format: `mrpack` / `curseforge` / `hmcl`) |
| `launch_game` | `version` (string), `username` (string, default Steve), `maxMemory` (number, MB), `javaPath` (string), `extraArgs` (string[]) | Launch an instance as an offline account; the game opens as a child process |
| `stop_game` | — | Stop the running game process (agent `/launch/stop`) |

All handlers return structured data on success and an error message on failure (MCP `isError` result) — they never crash the server.

## Quick start

```bash
npm install          # install dependencies
npm run build        # compile the MCP server → dist/
npm run build:agent  # download javafx jars + compile agent/build/hmcl-agent.jar (javac required)
```

Register the server in your MCP client:

```json
{
  "mcpServers": {
    "hmcl-mcp": {
      "command": "node",
      "args": ["D:/ProjectDir/AgentFarm/HMCL-MCP/dist/index.js"]
    }
  }
}
```

Environment variables can be set in the client's `env` object, in your shell, or via a `.env` file — see [`.env.example`](.env.example) and `docs/setup.md`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HMCL_MCP_WORKDIR` | `~/.hmcl-mcp` | HMCL working directory (game root + user data): `versions/`, `libraries/`, `assets/`, `mcpacks/`, `.hmcl/` |
| `HMCL_MCP_HMCL_DIR` | `<workdir>/hmcl` | Directory holding `HMCL.jar`, `hmcl-agent.jar` and the javafx jars |
| `HMCL_MCP_JAVA` | `java` on PATH | Java binary used to launch the headless HMCL JVM |
| `HMCL_MCP_CURSEFORGE_API_KEY` | *(none)* | Optional CurseForge API key override, passed to HMCL as `-Dhmcl.curseforge.apikey`; without it search/install still work via HMCL's embedded key |
| `HMCL_MCP_AGENT_PORT` | `28501` | Agent HTTP port on `127.0.0.1` |
| `HMCL_MCP_AGENT_TOKEN` | `hmcl-mcp` | Shared token, sent as the `X-HMCL-Agent-Token` header |

## Typical agent workflows

1. **Modpack: search → install → launch**

   `search_modpacks(query: "fabulously optimized")` → `get_modpack(id: "fabulously-optimized")` → `install_modpack(id: "fabulously-optimized", name: "fabulously-optimized")` (downloads and installs in one step, all through HMCL) → `launch_game(version: "fabulously-optimized", username: "Steve")` — note: `launch_game`'s `version` is the **instance name** from `install_modpack`/`list_modpacks`, not the Minecraft version number

2. **Vanilla: install a version → launch**

   `install_version(mc_version: "1.21.4")` → `launch_game(version: "1.21.4", username: "Steve")`

3. **First run / fresh setup**

   `check_environment` (verify java + hmcl dir) → `install_hmcl` (downloads HMCL.jar, builds the agent jar) → `start_hmcl` (boots the headless JVM, agent responds on `/status`)

4. **Cleanup**

   `stop_game` (stop the running game) → `stop_hmcl` (stop the headless JVM)

## Troubleshooting

- **`javac not found` / java missing**: installing a JDK is the user's responsibility — install JDK 17+ (21 recommended) and make sure both `java` and `javac` are on PATH (or set `HMCL_MCP_JAVA`).
- **First run downloads**: `install_hmcl` downloads HMCL.jar (~10 MB) from GitHub releases and `npm run build:agent` downloads `javafx-base`/`javafx-graphics` from Maven Central — both need internet and can take a minute.
- **`install_hmcl` fails with HTTP 403/429**: GitHub API rate limit — download `HMCL-<version>.jar` manually and place it at `<hmclDir>/HMCL.jar` (see `docs/setup.md`), then re-run.
- **CurseForge errors (403)**: missing/invalid API key — CurseForge is optional; use Modrinth (keyless) for search/install.
- **Headless means no launcher window**: only the game window appears, on `launch_game`.
- **Port conflict**: change `HMCL_MCP_AGENT_PORT` and restart; the agent binds `127.0.0.1` only.
- **Paths containing `!`**: HMCL refuses to run when the working directory or jar path contains `!` — use a path without it.

## Docs

- [`docs/setup.md`](docs/setup.md) — manual HMCL install, workdir layout, reusing an existing game directory, security notes
- [`docs/research/`](docs/research/) — research notes (MCP SDK, HMCL Java API, HMCL CLI/modpack formats, Modrinth/CurseForge APIs)
- `src/types.ts` — the shared contract (tools, types, cross-module interfaces)
