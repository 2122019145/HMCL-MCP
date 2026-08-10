# Setup guide

Covers the setup steps the `install_hmcl` tool automates, plus how the working directory works, how to reuse an existing game directory, and security notes.

## 1. Manual HMCL install (alternative to `install_hmcl`)

If you prefer to install HMCL by hand, or `install_hmcl` fails (e.g. GitHub API rate limit):

1. Download HMCL from the official page <https://hmcl.huangyuhui.net/download> or from the GitHub releases page <https://github.com/HMCL-dev/HMCL/releases/latest> (asset `HMCL-<version>.jar`).
2. Place the jar at `<hmclDir>/HMCL.jar` — by default `<workdir>/hmcl/HMCL.jar`.
3. Build and place the agent jar. From the project root:

   ```bash
   npm run build:agent        # needs javac: downloads javafx jars + compiles agent/build/hmcl-agent.jar
   mkdir -p ~/.hmcl-mcp/hmcl  # or wherever HMCL_DIR points
   cp agent/build/hmcl-agent.jar <hmclDir>/hmcl-agent.jar
   cp agent/build/javafx-*.jar <hmclDir>/
   ```

   (`install_hmcl` does exactly this automatically when HMCL.jar is missing.)
4. Verify with `check_environment` → `hasHmclJar: true`, `hasAgentJar: true`, non-empty `javafxJars`, then `start_hmcl`.

## 2. The working directory (`HMCL_MCP_WORKDIR`)

Default: `~/.hmcl-mcp`. This is both the HMCL game root and the HMCL 3.16+ workspace:

```
<workdir>/
├── versions/<id>/          # game instances: <id>.json (launch manifest), optional
│                           #   modpack.json (imported packs), <id>.jar, mods/, config/, saves/
├── libraries/              # shared Minecraft/loader libraries (HMCL-compatible layout)
├── assets/                 # game assets / asset indexes
├── mcpacks/                # modpack files downloaded by download_modpack
├── hmcl/                   # HMCL.jar + hmcl-agent.jar + javafx jars (the HMCL_DIR folder)
└── .hmcl/                  # HMCL 3.16+ workspace config: config/, state/, cache/, logs/
```

- `install_hmcl` writes into `<hmclDir>` (default `<workdir>/hmcl`) and creates it if needed.
- The agent JVM is started with `-Dhmcl.gameDir=<workdir>`, `-Dhmcl.home=<workdir>` and `-Dhmcl.dir=<workdir>`, so HMCL treats `<workdir>` as both its game root and workspace — everything stays self-contained.

## 3. Reusing an existing game directory

You don't have to start from an empty workdir:

- Point `HMCL_MCP_WORKDIR` at an existing HMCL game directory (one that already contains `versions/`, `libraries/`, `assets/`). Installed versions and modpacks are picked up automatically by `list_versions` / `list_modpacks` and can be launched directly.
- A plain vanilla `.minecraft`-style directory also works for versions: `versions/<id>/<id>.json` is all `list_versions` needs; HMCL completes missing libraries/assets on launch.
- **HMCL version compatibility**: the agent is built against HMCL 3.16.3 and uses its core APIs (`SettingsManager`, `DownloadProviders`, `Accounts`, `Task.run()`). Older pre-3.16 installs use the legacy `hmcl.json` layout — HMCL migrates it on first start, but the agent itself is only tested against 3.16.x. Keep the HMCL jar at 3.16.x unless you know the APIs you depend on still exist.
- Paths containing `!` are rejected by HMCL — choose a workdir without `!`.

## 4. Security notes

- The agent binds **`127.0.0.1` only** (loopback) — it is not reachable from the network.
- Every agent request must carry the `X-HMCL-Agent-Token` header; the token is set via `HMCL_MCP_AGENT_TOKEN` (default `hmcl-mcp`). Change it from the default if other local processes are a concern — anyone who can read your config/process environment can also read the token.
- The MCP server itself is a **stdio** server: it never listens on a port; it only connects to the agent on loopback.
- No credentials are stored in the repo; the optional CurseForge API key comes from the environment only.
