# HMCL Research: CLI, Config, Modpacks, Releases

Research target: Hello Minecraft! Launcher (HMCL), repo `HMCL-dev/HMCL`.
Versions investigated: `main` branch (= 3.17.x dev, commit 8210c77), stable tag `v3.16.3` (latest stable, released 2026-07-25), legacy tags `v3.14.1` and `v3.2.114`.
Unless noted otherwise, claims below were verified against the source files cited (fetched from `raw.githubusercontent.com` on 2026-08-10) and live API responses.

---

## 1. CLI arguments — there are NONE for users

**Headline finding: HMCL has no user-facing CLI.** `--launch`, `--workdir`, `--import`, `--account`, `--java`, `--version`, `--help` do **not** exist in any version from 3.2 to 3.17-dev. There is no headless mode and no way to trigger a launch or modpack import from the command line.

Verified entry chain (each file was read in full):

- Boot: `HMCLBoot/src/main/java/org/jackhuang/hmcl/Main.java` (main branch) — checks `java.version` feature >= 17, then calls `EntryPoint.main(args)`. The only place `args` is inspected is `showErrorAndExit(args)` where `args[0].equals("--apply-to")` changes the error dialog text. Source: https://github.com/HMCL-dev/HMCL/blob/main/HMCLBoot/src/main/java/org/jackhuang/hmcl/Main.java
- `HMCL/src/main/java/org/jackhuang/hmcl/EntryPoint.java` — JavaFX bootstrap only, passes `args` through to `Launcher.main(args)`. https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/EntryPoint.java
- `HMCL/src/main/java/org/jackhuang/hmcl/Launcher.java` — `main(String[] args)` calls exactly one consumer: `if (UpdateHandler.processArguments(args)) { ... return; }` then launches the JavaFX UI unconditionally. https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/Launcher.java
- `HMCL/src/main/java/org/jackhuang/hmcl/upgrade/UpdateHandler.java` — `processArguments` handles only:
  - `args.length == 2 && args[0].equals("--apply-to")` → applies a downloaded update jar to `Paths.get(args[1])` (internal self-update; also used by the old nested-jar migration). https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/upgrade/UpdateHandler.java

Same result on `v3.2.114` (`HMCL/src/main/java/org/jackhuang/hmcl/Main.java` at that tag: `main(String[] args)` only calls `UpdateHandler.processArguments(args)`). https://github.com/HMCL-dev/HMCL/blob/v3.2.114/HMCL/src/main/java/org/jackhuang/hmcl/Main.java

### What *does* control HMCL behavior from outside

JVM system properties and environment variables (official docs page, https://docs.hmcl.net/launcher/jvm-options-and-env.html — raw: https://github.com/HMCL-dev/HMCL-docs/blob/main/_launcher/jvm-options-and-env.md):

| Knob | Effect |
|---|---|
| `-Dhmcl.home=<path>` / env `HMCL_USER_HOME` | Override HMCL global (user) data folder — `Metadata.HMCL_USER_HOME` |
| `-Dhmcl.dir=<path>` / env `HMCL_LOCAL_HOME` | Override the `.hmcl` folder (workspace folder) — `Metadata.HMCL_LOCAL_HOME` |
| `-Dhmcl.dependencies.dir` / env `HMCL_DEPENDENCIES_DIR` | Override `.hmcl/dependencies` |
| `-Dhmcl.version.override`, `-Dhmcl.update_source.override`, `-Dhmcl.bmclapi.override`, `-Dhmcl.curseforge.apikey`, `-Dhmcl.microsoft.auth.id/secret`, `-Dhmcl.openjfx.repo`, `-Dhmcl.native.backend`, `-Dhmcl.self_integrity_check.disable=true`, ... | Misc overrides (full table in docs page above) |
| `HMCL_JAVA_OPTS` | JVM options for the bundled HMCLauncher |
| `HMCL_JAVA_HOME` | Java path used by HMCLauncher |
| `HMCL_JRES` | Extra Java paths HMCL will detect |
| `HMCL_FONT`, `HMCL_FORCE_GPU`, `HMCL_ANIMATION_FRAME_RATE`, `HMCL_UI_SCALE` | UI behavior (also in `Launcher.setupJavaFXVMOptions`) |

Source of the path-resolution precedence: `HMCL/src/main/java/org/jackhuang/hmcl/Metadata.java` — `HMCL_USER_HOME` = `-Dhmcl.home` → `HMCL_USER_HOME` env → (Linux: `$XDG_DATA_HOME/hmcl` or `~/.local/share/hmcl`; else `OperatingSystem.getWorkingDirectory("hmcl")`); `HMCL_LOCAL_HOME` = `-Dhmcl.dir` → `HMCL_LOCAL_HOME` env → `<cwd>/.hmcl`. https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/Metadata.java

### Does "launch" need a GUI? What happens when the game exits?

Moot as a CLI question (no CLI launch exists), but the runtime model:

- The game is launched by HMCL as a **separate child java process**: `DefaultLauncher.launch()` builds a `ProcessBuilder` (`new ProcessBuilder(rawCommandLine).directory(runDirectory.toFile())`) and starts it; the game's stdout is pumped to HMCL's log view. Source: `HMCLCore/src/main/java/org/jackhuang/hmcl/launch/DefaultLauncher.java` (lines ~566–615). https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/launch/DefaultLauncher.java
- A watcher thread (`ExitWaiter`, `HMCLCore/.../launch/ExitWaiter.java`) blocks on `process.waitFor()`, then fires `ProcessStoppedEvent` / `ProcessExitedAbnormallyEvent` / `JVMLaunchFailedEvent` and runs the instance's post-exit command. **HMCL itself keeps running after the game exits** (it never exits with the game). https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/launch/ExitWaiter.java
- Everything is JavaFX; a display session is required. No `--headless` or server mode.

---

## 2. Config format — `hmcl.json` is LEGACY; 3.16+ uses split files under `.hmcl/`

### 2a. Current layout (stable 3.16.3 and 3.17-dev) — no single config file

All files live under `HMCL_LOCAL_HOME` = `<cwd>/.hmcl` by default (i.e. **relative to the process working directory, not the jar location**). Verified in `HMCL/src/main/java/org/jackhuang/hmcl/setting/SettingsManager.java` (constants at top of file):

```
.hmcl/
├── config/
│   ├── launcher-settings.json      # launcher-wide settings (see keys below)
│   ├── game-directories.json       # {"schema": {...}, "directories": [ ... ]}
│   ├── game-settings.json          # GameSettingsPresets (shared presets store)
│   ├── accounts.json               # AccountMetadataStore: {"schema":..., "accounts":[<opaque records>]}
│   └── authlib-injector-servers.json
├── state/
│   ├── launcher-state.json
│   └── user-state.json / ...migration-receipt.json files
├── cache/                          # download cache, server metadata cache
├── private/
│   └── account-private-data.json   # account TOKENS (secrets live here, not in accounts.json)
├── dependencies/                   # -Dhmcl.dependencies.dir override
└── logs/
```

User-level (shared across workspaces), under `HMCL_USER_HOME` (= `-Dhmcl.home` / `HMCL_USER_HOME` env / `%APPDATA%\hmcl` on Windows per `OperatingSystem.getWorkingDirectory("hmcl")`):
`.hmcl`-style `config/user-settings.json`, `config/user-accounts.json`, `config/user-game-directories.json`, `state/user-state.json`, `private/user-account-private-data.json`. Legacy user files: `<HMCL_USER_HOME>/config.json`, `<HMCL_USER_HOME>/accounts.json`.

**Every split file has a `"schema"` member** — format `{"name": "<file-kind>", "version": "1.0.0"}` (`JsonSchema.PROPERTY_SCHEMA` = `"schema"`). Example from code: `new JsonSchema("game-directories", new JsonSchema.Version(1, 0, 0))`.

Key fields of `.hmcl/config/launcher-settings.json` (from `LauncherSettings.java`, `@SerializedName` names): `schema`, `language`, `acceptPreviewUpdate`, `disableAutoShowUpdateDialog`, `disableAprilFools`, `commonDirectoryType` (`"DEFAULT"` | `"CUSTOM"`, enum `EnumCommonDirectory`), `commonDirectory` (string path, used when type=CUSTOM), `logLines`, `themeBrightnessMode`, `customThemeColor`, `themeColorType`, `themeColorStyle`, `titleBarTransparent`, `windowTransparent`, `backgroundType`, `builtinBackgroundId`, `customBackgroundImagePath`, `networkBackgroundImageUrl`, `backgroundOpacity`, `launcherFontFamily`, `logFontFamily`, `logFontSize`, `autoDownloadThreads`, `downloadThreads`, `versionListSource`, `fileDownloadSource`, `defaultAddonSource`, `hasProxyAuth`, `proxyHost`, `proxyPort`, `proxyUser`, ... and `selectedGameDirectory` (a `GameDirectoryID`, nullable). https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/setting/LauncherSettings.java

**There is no `gameDir` and no `jvm` field in the modern config.** Game directories and per-instance Java settings are stored separately:

- `.hmcl/config/game-directories.json`: `{"schema": ..., "directories": [{"id": "game-directory:<uuid>", "path": "<relative-or-absolute>", "name": {...}?, "legacyGameSettings": "<preset-id>"?}]}` (`GameDirectories.java` / `GameDirectory.java` Serializer emits exactly `id`, `name`, `path`, `legacyGameSettings`). The default entry is `{"id": "game-directory:<fixed-uuid>", "path": ".minecraft"}` — relative to cwd (`GameDirectoryManager.CURRENT_GAME_DIRECTORY_PATH = PortablePath.of(".minecraft")`). https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/setting/GameDirectoryManager.java
- Per-instance settings: `<gameDir>/versions/<id>/.hmcl/config/instance-game-settings.json` — an inheritable-property JSON whose keys include `parent`, `icon`, `overrideProperties`, `javaType`, `customJavaVersion`, `customJavaPath`, `detectedJava` (`{"version": "...", "pathHash": "..."}`), `jvmOptions`, `noJVMOptions`, `noOptimizingJVMOptions`, `notCheckJVM`, `notCheckGame`, `autoMemory`, ... (all `@SerializedName` in `setting/GameSettings.java`). https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/setting/GameSettings.java
- Accounts: `.hmcl/config/accounts.json` = `{"schema":..., "accounts": [<opaque account JSON>]}`; **tokens are NOT here** — they live in `.hmcl/private/account-private-data.json` (`AccountPrivateData`). Legacy account `type` strings: `"offline"`, `"microsoft"`, `"authlibInjector"` (`Accounts.java` at v3.14.1 maps exactly these). https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/setting/AccountMetadataStore.java

### 2b. Legacy format (`hmcl.json`), used before 3.16 — still read as migration input

Per `LegacyConfigMigrator.java`: *"HMCL used `hmcl.json` and `.hmcl.json` as the main per-workspace config files before HMCL 3.16. Those files are now legacy inputs only: migration reads them, writes a new launcher settings file, and leaves the original files unchanged."* https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/setting/LegacyConfigMigrator.java

- File names: `hmcl.json` (Windows / portable), `.hmcl.json` (Linux).
- Location (v3.14.1 `ConfigHolder.locateConfig()`): 1) `<cwd>/hmcl.json`; 2) `<jar-dir>/hmcl.json` (only if the jar is writable) or `<jar-dir>/.hmcl.json` (Linux); 3) create at `<cwd>/hmcl.json`. **It sat next to the working directory / jar, NOT inside `.hmcl/`.** https://github.com/HMCL-dev/HMCL/blob/v3.14.1/HMCL/src/main/java/org/jackhuang/hmcl/setting/ConfigHolder.java
- Field names at v3.14.1 (from `Config.java` `@SerializedName`): `_version` (legacy config version, last value 2), `uiVersion`, `x`, `y`, `width`, `height` (window), `localization`, `promptedVersion`, `acceptPreviewUpdate`, `disableAutoShowUpdateDialog`, `disableAprilFools`, `shownTips`, `commonDirType` (`"DEFAULT"`/`"CUSTOM"`), `commonpath` (default `Metadata.MINECRAFT_DIRECTORY` = `%APPDATA%/.minecraft` on Windows), `logLines`, `themeBrightness`, `theme`, `fontFamily`, `fontSize`, `launcherFontFamily`, `animationDisabled`, `titleTransparent`, `backgroundType`, `bgpath`, `bgurl`, `bgpaint`, `proxyType`, `proxyHost`, `proxyPort`, `proxyUserName`, `selectedAccount`, `accounts` (array of account records with `type` in {offline, microsoft, authlibInjector}), `selectedProfile`, `configurations` (map: profile name → `Profile` JSON), `allowAutoAgent`, `disableAutoGameOptions`, `downloadSource`, ... https://github.com/HMCL-dev/HMCL/blob/v3.14.1/HMCL/src/main/java/org/jackhuang/hmcl/setting/Config.java
- `Profile` JSON: `{"gameDir": "<path>", "selectedVersion": "...", "useRelativePath": bool}` (from `Profile`'s custom adapter at v3.14.1; default gameDir `Path.of(".minecraft")`). So `gameDir` was **per-profile**, and the global common dir was `commonDirType` + `commonpath`.
- Per-version Java/settings in legacy: file `versions/<id>/hmclversion.cfg` (JSON) with keys `usesGlobal`, `javaVersionType`, `javaVersion`, `defaultJavaPath`, `javaDir`, `wrapper`, `maxMemory`, `minMemory`, `autoMemory`, `javaArgs`, `minecraftArgs`, `environmentVariables`, `noJVMArgs`, `noOptimizingJVMArgs`, `notCheckJVM`, `notCheckGame`, `serverIp`, `fullscreen`, `width`, `height`, ... (`VersionSetting.java` at v3.14.1; file name from `LegacyGameSettingsMigrator.LEGACY_INSTANCE_SETTINGS_FILENAME = "hmclversion.cfg"`). https://github.com/HMCL-dev/HMCL/blob/v3.14.1/HMCL/src/main/java/org/jackhuang/hmcl/setting/VersionSetting.java
- The migration renames (legacy → modern keys), from `LegacyConfigMigrator`: `commonDirType`→`commonDirectoryType`, `commonpath`→`commonDirectory`, `themeBrightness`→`themeBrightnessMode`, `titleTransparent`→`titleBarTransparent`, `theme`→`customThemeColor`, `fontFamily`→`logFontFamily`, `fontSize`→`logFontSize`, `bgpath`/`backgroundImage`→`customBackgroundImagePath`, `bgurl`/`backgroundImageUrl`→`networkBackgroundImageUrl`, `bgpaint`/`backgroundPaint`→`customBackgroundPaint`, `proxyUserName`→`proxyUser`.

### 2c. Installed modpacks are NOT registered in any config field

There is **no `modpacks` array/field** in the legacy `hmcl.json` nor in any modern split config. An installed modpack is just a game instance; HMCL recognizes it by the presence of `<gameDir>/versions/<id>/modpack.json` (`DefaultGameRepository.isModpack(id)` = `Files.exists(getModpackConfiguration(id))`). https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/game/DefaultGameRepository.java

---

## 3. Installed modpacks on disk

Instance id = the modpack name chosen at import (`ModpackInstallWizardProvider`: `GameInstanceID instanceId = new GameInstanceID(name)`; name is validated: ASCII-only, must not already exist). https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/ui/download/ModpackInstallWizardProvider.java

Layout (default game dir = `<cwd>/.minecraft`, unless `game-directories.json` points elsewhere):

```
<gameDir>/versions/<id>/
├── <id>.json                       # GameInstanceManifest (launch metadata)
├── modpack.json                    # ModpackConfiguration (see below)
├── .hmcl/config/instance-game-settings.json   # per-instance settings (3.16+)
├── .hmcl/state/ ...                # per-instance state
├── icon.png / icon.jpg ...         # optional instance icon
├── mods/, config/, saves/, logs/ ...          # the actual game files (run dir = instance root by default)
```

- `versions/` is directly under the selected **game directory** (`DefaultGameRepository`: `versionsDirectory = gameDirectory.resolve("versions")`; instance root = `versions/<id>/`).
- `modpack.json` content — `ModpackConfiguration<T>` with exact keys `manifest` (the provider-specific manifest object), `type` (provider name: `"HMCL"` | `"CurseForge"` | `"Modrinth"` | `"MultiMC"` | `"MCBBS"` | `"Server"`), `name`, `version`, `overrides` (array of `{"path": "<relative>", "hash": "<sha1?>", "downloadURL": "<url>"}` records used for update checks). https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/modpack/ModpackConfiguration.java
- `<id>.json` is the `GameInstanceManifest` — the vanilla-style version JSON (fields `id`, `jar`, `minecraftArguments`/`arguments`, `mainClass`, `libraries`, `assetIndex`, `javaVersion`, `releaseTime`, `type`, ...). Saved by `DefaultGameRepository.saveAsync()` → `getInstanceJson(id)` = `versions/<id>/<id>.json`.

---

## 4. Modpack zip formats and import behavior

### Formats HMCL imports (detection order in `ModpackHelper.readModpackManifest`)

`ModpackHelper` (`HMCL/src/main/java/org/jackhuang/hmcl/game/ModpackHelper.java`) tries providers in this order; each looks for its marker file inside the zip:

| Format | Marker file | Manifest keys | Verified at |
|---|---|---|---|
| MCBBS | `mcbbs.packmeta` or `manifest.json` | `mcbbs.packmeta` → `McbbsModpackManifest` | `modpack/mcbbs/McbbsModpackProvider.java` |
| CurseForge | `manifest.json` (root) | `manifestType` (`"minecraftModpack"`), `manifestVersion`, `name`, `version`, `author`, `overrides`, `minecraft` = `{"version": "...", "modLoaders": [{"id": "forge-...", "primary": bool}]}`, `files` = `[{"projectID": int, "fileID": int, "fileName": "...", "url": "...", "required": bool}]` | `modpack/curse/CurseManifest.java`, `CurseManifestMinecraft.java`, `CurseManifestFile.java` |
| Modrinth (mrpack) | `modrinth.index.json` (root) | `game` (`"minecraft"`), `formatVersion`, `versionId`, `name`, `summary`, `files` = `[{"path": "...", "hashes": {"sha1": "...", "sha512": "..."}, "env": {"client": "...", "server": "..."}?, "downloads": ["<url>"], "fileSize": int}]`, `dependencies` = `{"minecraft": "1.20.1", "forge": "...", ...}` | `modpack/modrinth/ModrinthManifest.java` |
| HMCL native | `modpack.json` (root) + `minecraft/pack.json` | `modpack.json` keys: `name`, `author`, `version`, `gameVersion`, `description` (camelCase, from `Modpack.java`); `minecraft/pack.json` = `GameInstanceManifest`; if `pack.json` has no `jar`, `gameVersion` must be set in `modpack.json` | `game/HMCLModpackProvider.java`, `modpack/Modpack.java` |
| MultiMC | `<instance>/instance.cfg` (plus `mmc-pack.json` in the instance dir) | MultiMC format | `modpack/multimc/MultiMCModpackProvider.java` |
| Server auto-update pack | `server-manifest.json` (root) | `name`, `author`, `version`, `description`, `fileApi`, `files` (`ModpackConfiguration.FileInformation` list), `addons` | `modpack/server/ServerModpackManifest.java`; docs: https://docs.hmcl.net/modpack/serverpack.html |

### Is there a CLI import command?

**No.** Import is GUI-only (主页 → 下载 → 整合包 → 导入; `LocalModpackPage`). There is no headless equivalent.

### What HMCL does on import

Flow (from `ModpackHelper.getInstallTask` + per-format install tasks):

1. Parse the zip manifest (providers in the order above) → a `Modpack` (name/version/gameVersion/description + provider manifest).
2. Create the game instance: `dependencyManager.newGameBuilder().name(<id>).gameVersion(...)` → produces `versions/<id>/<id>.json` (builds the launch manifest, installs vanilla/libraries).
3. Extract files into the instance run directory (`versions/<id>/`):
   - HMCL pack: everything under `/minecraft` **except** `minecraft/pack.json` (`HMCLModpackInstallTask`: `new ModpackInstallTask<>(zipFile, run, encoding, List.of("/minecraft"), it -> !"pack.json".equals(it), config)`).
   - CurseForge: the `overrides/` directory named by `manifest.overrides()` (`CurseInstallTask`); the `files[]` are **downloaded from CurseForge** (projectID/fileID; uses the CurseForge API key when configured) and installed as addons into `mods/` etc.
   - Modrinth: `/client-overrides` and `/overrides` extracted; `files[]` downloaded from `downloads[0]` URLs and installed.
   - MultiMC: instance dir contents; server pack: files fetched from `fileApi` base URL.
4. Reinstall loader libraries (Forge/NeoForge/Fabric/Quilt/OptiFine etc.) for the target game version via the dependency manager (analyzed from `pack.json` for HMCL packs).
5. Write `<instanceRoot>/modpack.json` (`ModpackConfiguration`) via `MinecraftInstanceTask`; also computes `overrides` list with SHA-1 hashes of extracted files (used later by update checks).
6. Optional: download instance icon (`icon.png` at instance root).
7. On failure the instance is deleted (`repository.removeInstanceFromDisk`); on success `repository.refresh()` and the instance becomes selected.

Sources: `HMCL/src/main/java/org/jackhuang/hmcl/game/HMCLModpackInstallTask.java`; `HMCLCore/.../modpack/curse/CurseInstallTask.java`; `modpack/modrinth/ModrinthInstallTask.java`; `modpack/MinecraftInstanceTask.java`; `game/ModpackHelper.java` (all on `main`).

---

## 5. Release download URLs

- Latest stable: **v3.16.3**, published 2026-07-25 (GitHub API: `GET https://api.github.com/repos/HMCL-dev/HMCL/releases/latest`).
- Asset naming: `HMCL-<version>.<ext>` with `<ext>` ∈ {`jar`, `exe`, `sh`, `deb`}, plus `<name>.sha256` checksum files. Confirmed live assets for v3.16.3:
  - `https://github.com/HMCL-dev/HMCL/releases/download/v3.16.3/HMCL-3.16.3.jar` (10,319,057 B)
  - `https://github.com/HMCL-dev/HMCL/releases/download/v3.16.3/HMCL-3.16.3.exe` (10,773,201 B)
  - `.../HMCL-3.16.3.sh`, `.../HMCL-3.16.3.deb`
- Pattern (from `.github/workflows/release.yml`): `https://github.com/HMCL-dev/HMCL/releases/download/v<VERSION>/HMCL-<VERSION>.<ext>`; the workflow uploads exactly `exe, jar, sh, deb` + `.sha256` files. https://github.com/HMCL-dev/HMCL/blob/main/.github/workflows/release.yml
- Official download page: https://hmcl.huangyuhui.net/download (source constant `Metadata.PUBLISH_URL` / `DOWNLOAD_URL`); self-update JSON API: `https://hmcl.huangyuhui.net/api/update_link` (`Metadata.HMCL_UPDATE_URL`).
- Note: the latest stable at research time is 3.16.x, **not 3.14.x**; 3.14.x tags exist (e.g. `v3.14.1`) but are old.

---

## 6. JSON API / RPC / automation interface

**None.** HMCL exposes no JSON API, no RPC, no automation endpoint:

- The only local HTTP server is `OAuthServer` (`HMCL/src/main/java/org/jackhuang/hmcl/game/OAuthServer.java`) — a loopback callback for Microsoft OAuth login. `HMCLCore/.../util/io/HttpServer.java` is just its HTTP helper.
- The only program arguments are the internal `--apply-to <path>` (self-update) described above.
- Integration surface = files on disk + the `-Dhmcl.*` properties / `HMCL_*` env vars listed in §1. An MCP server must therefore either drive the HMCL UI (not practical) or read/write HMCL's config and instance files while HMCL is not running, and manage the game process itself.

---

## 7. Java version required to run HMCL

- **Minimum: Java 17** (`HMCLBoot/.../Main.java`: `MINIMUM_JAVA_VERSION = 17`; `Metadata.MINIMUM_REQUIRED_JAVA_VERSION = 17`), **recommended: Java 21** (`Metadata.RECOMMENDED_JAVA_VERSION = 21`). Same constants at `v3.14.1`. https://github.com/HMCL-dev/HMCL/blob/main/HMCL/src/main/java/org/jackhuang/hmcl/Metadata.java
- HMCL auto-detects installed Java and can download a suitable runtime itself (docs FAQ: "HMCL 会自动管理 Java"; download API default `https://api.foojay.io/disco/v3.0`, see `-Dhmcl.discoapi.override`). https://docs.hmcl.net/faq.html
- The `.exe` (~10.7 MB) does not embed a JRE (too small); it still needs Java 17+ available (or HMCL's auto-download path). *Not independently verified for the exact exe stub behavior — see UNCERTAIN.*

---

## 8. Config next to exe vs workdir — how `--workdir`-style behavior actually works

There is no `--workdir` flag. Instead:

- **Legacy (≤3.15):** `hmcl.json` was discovered first at `<cwd>/hmcl.json`, then `<jar-dir>/hmcl.json` (jar dir only if the jar file is writable), else created at `<cwd>/hmcl.json` (`ConfigHolder.locateConfig()`, v3.14.1). So "portable" behavior depended on *where you launched from* (cwd), falling back to jar-adjacent if you launched from the jar's folder.
- **Modern (3.16+):** the workspace config is always `<cwd>/.hmcl/` (`Metadata.HMCL_LOCAL_HOME = CURRENT_DIRECTORY.resolve(".hmcl")`, where `CURRENT_DIRECTORY = System.getProperty("user.dir")`). Launching HMCL with a different working directory (e.g. `cd D:/my-hmcl && java -jar HMCL.jar`) gives you a separate, fully portable workspace including its own `.minecraft` default game dir (`game-directories.json` default `path: ".minecraft"` is cwd-relative). This is exactly the "workdir" isolation pattern an MCP server should use: start HMCL with `cwd = <workspace>` (and optionally `-Dhmcl.home` for a dedicated user home) to get a self-contained HMCL install per modpack.
- Caveats: `Metadata.checkDirectoryPath()` (HMCLBoot `Main`) **refuses to run if the cwd or jar path contains `!`**; the legacy migrator also warns if the config dir owner is root.

---

## UNCERTAIN

- **`--launch`-style arguments in third-party HMCL forks:** verified absent in the official repo (v3.2.114, v3.14.1, v3.16.3, main). A fork could add them; not checked.
- **`.exe` internals:** whether the Windows exe bundles a JRE or downloads one on first run was not verified (no public HMCL-Builder repo; the exe is produced on their CI). Size suggests no embedded JRE. The `.jar` with `java -jar` + Java 17+ is the safe automation path.
- **Default Windows paths for `HMCL_USER_HOME`:** per code, `OperatingSystem.getWorkingDirectory(folder)` on Windows = `Paths.get(%APPDATA%, "." + folder)` → default `HMCL_USER_HOME` = `%APPDATA%\.hmcl` (and default common directory `%APPDATA%\.minecraft`). Read from source only, not executed.
- **Exact account record schema** in `accounts.json` (modern) and the legacy `accounts[]` entries: entries are opaque `JsonObject`s; the per-type fields (e.g. microsoft token shape) were not enumerated — tokens are in `private/account-private-data.json`, and writing accounts programmatically is not documented anywhere.
- **`selectedGameDirectory` value**: stored as `GameDirectoryID` (`"game-directory:<uuid>"`), but whether the JSON is a plain string was inferred from `GameDirectoryID.Adapter` (`TypedID.Adapter` — serializes as string with the `game-directory:` prefix); not observed in a real file.
- **Whether 3.16.0 stable releases before 3.16.3 had the split config**: the split landed in dev 3.16.0.347; 3.16.3 (checked) has it. Intermediate 3.16.0/3.16.1/3.16.2 not individually checked.

---

## Summary (decision-relevant facts)

1. **HMCL has no user CLI**: `--launch`, `--workdir`, `--import`, `--account`, `--java`, `--version`, `--help` do not exist in any official version (verified 3.2 → 3.17-dev source). Only program arg: internal `--apply-to <path>` (self-update). All operations are GUI-only; HMCL is a JavaFX app and needs a display session.
2. Path overrides are via JVM props/env: `-Dhmcl.dir` / `HMCL_LOCAL_HOME` (workspace folder), `-Dhmcl.home` / `HMCL_USER_HOME` (user data), plus `HMCL_JAVA_HOME`, `HMCL_JAVA_OPTS`, `HMCL_JRES`. Launching with `cwd=<folder>` isolates the whole workspace.
3. Latest stable is **v3.16.3** (2026-07-25); assets `HMCL-3.16.3.{jar,exe,sh,deb}` at `https://github.com/HMCL-dev/HMCL/releases/download/v3.16.3/HMCL-3.16.3.jar` etc. Download page: hmcl.huangyuhui.net/download.
4. HMCL requires **Java 17+ (recommended 21)** to run; the game itself is launched as a separate child java process and HMCL stays open after the game exits.
5. **Config is NOT `hmcl.json` anymore** (that's pre-3.16): 3.16+ uses `<cwd>/.hmcl/config/{launcher-settings,game-directories,game-settings,accounts,authlib-injector-servers}.json`, `<cwd>/.hmcl/state/`, and `<cwd>/.hmcl/private/account-private-data.json` (tokens). Every file carries a `"schema"` member.
6. Game dirs: `.hmcl/config/game-directories.json` → `directories[]` entries `{id:"game-directory:<uuid>", path}`; default `path: ".minecraft"` (cwd-relative). Per-instance Java settings: `versions/<id>/.hmcl/config/instance-game-settings.json` keys `javaType/customJavaVersion/customJavaPath/detectedJava/jvmOptions/...`.
7. **No `modpacks` registry field exists**; an imported modpack is a game instance under `<gameDir>/versions/<name>/` (name = instance id) recognized by `modpack.json` (`ModpackConfiguration`: keys `manifest`, `type`, `name`, `version`, `overrides[]`), plus `<name>.json` (GameInstanceManifest) and the extracted game files.
8. Imports support 6 zip formats (detection markers): MCBBS (`mcbbs.packmeta`), CurseForge (`manifest.json`), Modrinth mrpack (`modrinth.index.json`), HMCL native (`modpack.json` + `minecraft/pack.json`), MultiMC (`instance.cfg`), Server pack (`server-manifest.json`). Import = create instance + extract/download files into `versions/<name>/` + write `modpack.json`; GUI-only.
9. No JSON API/RPC/automation surface exists (only the Microsoft-OAuth loopback HTTP server) — the MCP server must operate on HMCL's files directly and manage the game process itself.
10. Legacy (≤3.15) `hmcl.json` sat at `<cwd>`/jar dir with keys `_version`, `commonDirType`, `commonpath`, `gameDir` (per-profile in `configurations`), `accounts[]`, `selectedAccount`; per-version java in `versions/<id>/hmclversion.cfg`. 3.16+ reads it once and migrates.
