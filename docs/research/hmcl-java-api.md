# HMCL 3.16.3 — Java Core API Research (for headless javaagent)

Research date: 2026-08-10. Sources: official release jar
`https://github.com/HMCL-dev/HMCL/releases/download/v3.16.3/HMCL-3.16.3.jar` (sha verified by
download, 4,243 entries) and the git tag `v3.16.3` source tarball
(`HMCL-3.16.3/HMCLCore/src/main/java/org/jackhuang/hmcl/...` and
`HMCL-3.16.3/HMCL/src/main/java/org/jackhuang/hmcl/...`). All `javap` output below was produced
with JDK 21 (`javap -classpath agent/lib/HMCL-3.16.3.jar <class>`).

> **TL;DR — API was heavily refactored in 3.16.** `ConfigHolder`, `Settings`,
> `DefaultGameVersionList`, `AuthList`, `ModpackHelper`(mod pkg), `RemoteVersion.install()` do
> **NOT** exist in 3.16.3. Real locations: `setting.SettingsManager`/`setting.LauncherSettings`,
> `download.game.GameVersionList`, `setting.Accounts`, `game.ModpackHelper`,
> `RemoteVersion.getInstallTask(DefaultDependencyManager, Version)`. The release jar does **not**
> bundle JavaFX; the agent JVM needs `javafx-base` + `javafx-graphics` on the classpath (both are
> pure-Java jars, usable headless). Gson IS bundled.

---

## 1. Artifact facts

```text
$ ls -l agent/lib/HMCL-3.16.3.jar
-rw-r--r-- 1 vfyjx 197609 10319057 Aug 10 17:58 agent/lib/HMCL-3.16.3.jar      # 10,319,057 bytes ≈ 9.84 MiB

$ jar tf agent/lib/HMCL-3.16.3.jar | wc -l
4243

$ unzip -p agent/lib/HMCL-3.16.3.jar META-INF/MANIFEST.MF
Manifest-Version: 1.0
Created-By: Copyright(c) 2013-2025 huangyuhui.
Implementation-Version: 3.16.3
Main-Class: org.jackhuang.hmcl.Main
Multi-Release: true
Add-Opens: java.base/java.lang java.base/java.lang.reflect java.base/jdk.internal.loader
  javafx.base/com.sun.javafx.binding ... javafx.graphics/com.sun.prism ... jdk.attach/sun.tools.attach
Enable-Native-Access: ALL-UNNAMED
Enable-Final-Field-Mutation: ALL-UNNAMED
```

- **Main-Class**: `org.jackhuang.hmcl.Main` (lives in the `HMCLBoot` module, not the UI module).
- **Premain-Class / Agent-Class**: **absent** — the agent must attach via `-javaagent:` with its
  own `Premain-Class` (or self-attach); HMCL provides no agent hook.
- **JavaFX bundled**: **NO** — `grep -c '^javafx/'` → `0`. The manifest's `Add-Opens` lists
  `javafx.*` modules because the desktop launcher runs with an **external** JavaFX runtime.
- **Gson bundled**: **YES** — `com/google/gson/Gson.class` present, 207 `com/google/gson/` entries
  (Gson 2.x shaded). No need to add Gson.
- `jar tf` is a "Multi-Release" jar (`META-INF/versions/` present); the agent is a `-javaagent`
  on the same classpath, so it sees the base (JDK-8-target) classes.

### 1.1 Headless class-load experiment (JDK 21, no JavaFX installed)

A tiny probe (`Class.forName(c, true, ...)`) with only `HMCL-3.16.3.jar` on the classpath:

```text
FAIL org.jackhuang.hmcl.task.Task               -> NoClassDefFoundError: javafx/beans/property/DoubleProperty
FAIL org.jackhuang.hmcl.modpack.ModpackInstallTask  (extends Task, same cause)
FAIL org.jackhuang.hmcl.setting.SettingsManager -> NoClassDefFoundError: javafx/beans/Observable
FAIL org.jackhuang.hmcl.setting.Accounts        -> javafx/beans/property/ObjectProperty
FAIL org.jackhuang.hmcl.setting.GameDirectoryManager -> javafx/beans/property/ObjectProperty
FAIL org.jackhuang.hmcl.setting.LauncherSettings-> javafx/scene/paint/Paint   (javafx.graphics!)
FAIL org.jackhuang.hmcl.auth.offline.OfflineAccountFactory / OfflineAccount / auth.Account -> javafx/beans/Observable
OK   org.jackhuang.hmcl.task.TaskExecutor, game.GameRepository, game.DefaultGameRepository,
     game.HMCLGameRepository, game.LaunchOptions, launch.DefaultLauncher, launch.Launcher,
     download.DefaultDependencyManager, download.game.GameVersionList, download.RemoteVersion,
     modpack.Modpack, auth.AuthInfo, util.io.FileUtils, Metadata, setting.DownloadProviders,
     java.JavaRuntime, game.HMCLGameLauncher, game.ModpackHelper
```

With `javafx-base-21.0.4-win.jar` added to the classpath **everything above loads**, and
`LauncherSettings` additionally requires `javafx.scene.paint.Paint` → also add `javafx-graphics`
(note: Maven Central's classifier-less `javafx-base-21.0.4.jar` is a 302-byte stub with
`Automatic-Module-Name: javafx.baseEmpty` — you must use the `-win` artifact).

**Conclusion**: the agent JVM must put `javafx-base` + `javafx-graphics` (openjfx 21.x, win) on the
classpath alongside `HMCL-3.16.3.jar`. These are pure-Java jars; loading and using
`javafx.beans`/properties does **not** initialize the toolkit, so this stays headless-safe. The
desktop "HMCL JVM" already has full JavaFX, so inside such a JVM no extra jars are needed. Avoid
calling `HMCLGameRepository.getVersionIconImage(...)` (needs `javafx.scene.image` toolkit) and
anything under `Schedulers.javafx()` from the agent.

---

## 2. Package map: where things actually live in 3.16.3

| You assumed (old API) | 3.16.3 reality |
|---|---|
| `setting.ConfigHolder` / `setting.Settings` | **gone**. `setting.SettingsManager` (static manager, `init()`), `setting.LauncherSettings` (per-workspace `launcher-settings.json`), `setting.UserSettings` (shared `user-settings.json`), `setting.UserState` / `setting.LauncherState` |
| `setting.Settings.instance()` | `SettingsManager.settings()` / `userSettings()` / `state()` |
| `setting.DownloadProviders` — wrong package | `org.jackhuang.hmcl.setting.DownloadProviders` (static `init()`, `getDownloadProvider()`) |
| `download.DefaultGameVersionList` | `org.jackhuang.hmcl.download.game.GameVersionList extends VersionList<GameRemoteVersion>` |
| `RemoteVersion.install(...)` | `RemoteVersion.getInstallTask(DefaultDependencyManager, Version)` → `Task<Version>` |
| `mod.ModpackHelper` / `mod.ModpackInstallTask` | `modpack.ModpackInstallTask` (core); `ModpackHelper` is `org.jackhuang.hmcl.game.ModpackHelper` (HMCL UI module!) |
| `auth.AuthList` | **gone**. Registry = `org.jackhuang.hmcl.setting.Accounts` (static `FACTORIES`, `FACTORY_OFFLINE`, `getAccounts()`, `setSelectedAccount`) |
| `auth.OfflineAccountFactory` | `org.jackhuang.hmcl.auth.offline.OfflineAccountFactory` |
| `launch.LaunchOptions` | `org.jackhuang.hmcl.game.LaunchOptions` + `LaunchOptions$Builder` — **no `authInfo` in the builder**; `AuthInfo` is passed to the `Launcher` constructor |
| `launch.Launcher.launch(...)` | `launch.Launcher` abstract; ctor `(GameRepository, Version, AuthInfo, LaunchOptions[, ProcessListener][, boolean daemon])`; `DefaultLauncher` concrete; UI uses `game.HMCLGameLauncher` (HMCL module) |
| `game.HMCLGameRepository.launch(...)` | No launch method. `HMCLGameRepository.getLaunchOptions(String, JavaRuntime, Path, List<String>, List<String>, boolean)` → `LaunchOptions$Builder` |

---

## 3. Exact javap signatures (verbatim, JDK 21)

### 3.1 `org.jackhuang.hmcl.game.LaunchOptions` + `LaunchOptions$Builder`

```text
Compiled from "LaunchOptions.java"
public class org.jackhuang.hmcl.game.LaunchOptions implements java.io.Serializable {
  private java.nio.file.Path gameDir;
  private org.jackhuang.hmcl.java.JavaRuntime java;
  private java.lang.String versionName;
  private java.lang.String versionType;
  private java.lang.String profileName;
  private final java.util.List<java.lang.String> gameArguments;
  private final java.util.List<java.lang.String> overrideJavaArguments;
  private final java.util.List<java.lang.String> javaArguments;
  private final java.util.List<java.lang.String> javaAgents;
  private final java.util.Map<java.lang.String, java.lang.String> environmentVariables;
  private java.lang.Integer minMemory;
  private java.lang.Integer maxMemory;
  private java.lang.Integer metaspace;
  private java.lang.Integer width;
  private java.lang.Integer height;
  private boolean fullscreen;
  private org.jackhuang.hmcl.game.QuickPlayOption quickPlayOption;
  private java.lang.String wrapper;
  private org.jackhuang.hmcl.game.ProxyOption proxyOption;
  private boolean noGeneratedJVMArgs;
  private boolean noGeneratedOptimizingJVMArgs;
  private java.lang.String preLaunchCommand;
  private java.lang.String postExitCommand;
  private boolean useCustomNatives;
  private java.lang.String nativesDir;
  private org.jackhuang.hmcl.game.ProcessPriority processPriority;
  private org.jackhuang.hmcl.game.GraphicsAPI graphicsBackend;
  private org.jackhuang.hmcl.game.Renderer renderer;
  private boolean useNativeGLFW;
  private boolean useNativeOpenAL;
  private boolean enableDebugLogOutput;
  private boolean allowAutoAgent;
  private boolean disableAutoGameOptions;
  private boolean daemon;
  public org.jackhuang.hmcl.game.LaunchOptions();
  public java.nio.file.Path getGameDir();
  public org.jackhuang.hmcl.java.JavaRuntime getJava();
  public java.lang.String getVersionName();
  public java.lang.String getVersionType();
  public java.lang.String getProfileName();
  public java.util.List<java.lang.String> getGameArguments();
  public java.util.List<java.lang.String> getOverrideJavaArguments();
  public java.util.List<java.lang.String> getJavaArguments();
  public java.util.List<java.lang.String> getJavaAgents();
  public java.util.Map<java.lang.String, java.lang.String> getEnvironmentVariables();
  public java.lang.Integer getMinMemory();
  public java.lang.Integer getMaxMemory();
  public java.lang.Integer getMetaspace();
  public java.lang.Integer getWidth();
  public java.lang.Integer getHeight();
  public boolean isFullscreen();
  public org.jackhuang.hmcl.game.QuickPlayOption getQuickPlayOption();
  public java.lang.String getWrapper();
  public org.jackhuang.hmcl.game.ProxyOption getProxyOption();
  public boolean isNoGeneratedJVMArgs();
  public boolean isNoGeneratedOptimizingJVMArgs();
  public java.lang.String getPreLaunchCommand();
  public java.lang.String getPostExitCommand();
  public boolean isUseCustomNatives();
  public java.lang.String getNativesDir();
  public org.jackhuang.hmcl.game.ProcessPriority getProcessPriority();
  public org.jackhuang.hmcl.game.GraphicsAPI getGraphicsBackend();
  public org.jackhuang.hmcl.game.Renderer getRenderer();
  public boolean isUseNativeGLFW();
  public boolean isUseNativeOpenAL();
  public boolean isEnableDebugLogOutput();
  public boolean isAllowAutoAgent();
  public boolean isDisableAutoGameOptions();
  public boolean isDaemon();
}
```

```text
Compiled from "LaunchOptions.java"
public final class org.jackhuang.hmcl.game.LaunchOptions$Builder {
  public org.jackhuang.hmcl.game.LaunchOptions$Builder();
  public org.jackhuang.hmcl.game.LaunchOptions create();
  public java.util.List<java.lang.String> getGameArguments();
  public java.util.List<java.lang.String> getOverrideJavaArguments();
  public java.util.List<java.lang.String> getJavaArguments();
  public java.util.List<java.lang.String> getJavaAgents();
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setGameDir(java.nio.file.Path);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setJava(org.jackhuang.hmcl.java.JavaRuntime);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setVersionName(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setVersionType(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setProfileName(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setGameArguments(java.util.List<java.lang.String>);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setOverrideJavaArguments(java.util.List<java.lang.String>);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setJavaArguments(java.util.List<java.lang.String>);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setJavaAgents(java.util.List<java.lang.String>);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setEnvironmentVariables(java.util.Map<java.lang.String, java.lang.String>);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setMinMemory(java.lang.Integer);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setMaxMemory(java.lang.Integer);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setMetaspace(java.lang.Integer);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setWidth(java.lang.Integer);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setHeight(java.lang.Integer);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setFullscreen(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setQuickPlayOption(org.jackhuang.hmcl.game.QuickPlayOption);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setWrapper(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setProxyOption(org.jackhuang.hmcl.game.ProxyOption);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setNoGeneratedJVMArgs(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setNoGeneratedOptimizingJVMArgs(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setPreLaunchCommand(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setPostExitCommand(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setUseCustomNatives(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setNativesDir(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setProcessPriority(org.jackhuang.hmcl.game.ProcessPriority);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setGraphicsBackend(org.jackhuang.hmcl.game.GraphicsAPI);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setRenderer(org.jackhuang.hmcl.game.Renderer);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setUseNativeGLFW(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setUseNativeOpenAL(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setDaemon(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setEnableDebugLogOutput(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setAllowAutoAgent(boolean);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder setDisableAutoGameOptions(boolean);
}
```

> No `authInfo`, no `serverIp`, no `token` on the builder in 3.16 — those moved to the `Launcher`
> ctor (`AuthInfo`) and `LaunchOptions.proxyOption` / `GameServerPostCommand` etc.

### 3.2 `org.jackhuang.hmcl.game.GameRepository` (interface)

```text
Compiled from "GameRepository.java"
public interface org.jackhuang.hmcl.game.GameRepository extends org.jackhuang.hmcl.game.VersionProvider {
  public abstract boolean hasVersion(java.lang.String);
  public abstract org.jackhuang.hmcl.game.Version getVersion(java.lang.String) throws org.jackhuang.hmcl.game.VersionNotFoundException;
  public default org.jackhuang.hmcl.game.Version getResolvedVersion(java.lang.String) throws org.jackhuang.hmcl.game.VersionNotFoundException;
  public default org.jackhuang.hmcl.game.Version getResolvedPreservingPatchesVersion(java.lang.String) throws org.jackhuang.hmcl.game.VersionNotFoundException;
  public abstract int getVersionCount();
  public abstract java.util.Collection<org.jackhuang.hmcl.game.Version> getVersions();
  public abstract void refreshVersions();
  public default org.jackhuang.hmcl.task.Task<java.lang.Void> refreshVersionsAsync();
  public abstract java.nio.file.Path getVersionRoot(java.lang.String);
  public abstract java.nio.file.Path getRunDirectory(java.lang.String);
  public abstract java.nio.file.Path getLibrariesDirectory(org.jackhuang.hmcl.game.Version);
  public abstract java.nio.file.Path getLibraryFile(org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.game.Library);
  public abstract java.nio.file.Path getNativeDirectory(java.lang.String, org.jackhuang.hmcl.util.platform.Platform);
  public abstract java.nio.file.Path getModsDirectory(java.lang.String);
  public abstract java.nio.file.Path getResourcePackDirectory(java.lang.String);
  public abstract java.nio.file.Path getVersionJar(org.jackhuang.hmcl.game.Version);
  public abstract java.util.Optional<java.lang.String> getGameVersion(org.jackhuang.hmcl.game.Version);
  public default java.util.Optional<java.lang.String> getGameVersion(java.lang.String) throws org.jackhuang.hmcl.game.VersionNotFoundException;
  public default java.nio.file.Path getVersionJar(java.lang.String) throws org.jackhuang.hmcl.game.VersionNotFoundException;
  public abstract boolean renameVersion(java.lang.String, java.lang.String);
  public abstract java.nio.file.Path getActualAssetDirectory(java.lang.String, java.lang.String);
  public abstract java.nio.file.Path getAssetDirectory(java.lang.String, java.lang.String);
  public abstract java.util.Optional<java.nio.file.Path> getAssetObject(java.lang.String, java.lang.String, java.lang.String) throws java.io.IOException;
  public abstract java.nio.file.Path getAssetObject(java.lang.String, java.lang.String, org.jackhuang.hmcl.game.AssetObject);
  public abstract org.jackhuang.hmcl.game.AssetIndex getAssetIndex(java.lang.String, java.lang.String) throws java.io.IOException;
  public abstract java.nio.file.Path getIndexFile(java.lang.String, java.lang.String);
  public abstract java.nio.file.Path getLoggingObject(java.lang.String, java.lang.String, org.jackhuang.hmcl.game.LoggingInfo);
  public default java.util.Set<java.lang.String> getClasspath(org.jackhuang.hmcl.game.Version);
}
```

### 3.3 `org.jackhuang.hmcl.game.HMCLGameRepository` (public API; note javafx only in signatures)

```text
Compiled from "HMCLGameRepository.java"
public final class org.jackhuang.hmcl.game.HMCLGameRepository extends org.jackhuang.hmcl.game.DefaultGameRepository {
  public final org.jackhuang.hmcl.event.EventManager<org.jackhuang.hmcl.event.Event> onVersionIconChanged;
  public org.jackhuang.hmcl.game.HMCLGameRepository(org.jackhuang.hmcl.setting.GameDirectory);          // <-- ctor takes GameDirectory, NOT Path
  public org.jackhuang.hmcl.setting.GameDirectory getGameDirectory();
  public javafx.beans.binding.StringBinding selectedInstanceProperty();                                 // javafx (base) — avoid
  public java.lang.String getSelectedInstance();
  public void setSelectedInstance(java.lang.String);
  public void refreshSelectedInstance();
  public org.jackhuang.hmcl.download.DefaultDependencyManager getDependency();                          // uses DownloadProviders.getDownloadProvider()
  public org.jackhuang.hmcl.download.DefaultDependencyManager getDependency(org.jackhuang.hmcl.download.DownloadProvider);
  public java.nio.file.Path getRunDirectory(java.lang.String);
  public java.util.stream.Stream<org.jackhuang.hmcl.game.Version> getDisplayVersions();
  public void changeDirectory(java.nio.file.Path);
  public void clean(java.lang.String) throws java.io.IOException;
  public boolean removeVersionFromDisk(java.lang.String);
  public void duplicateVersion(java.lang.String, java.lang.String, boolean) throws java.io.IOException;
  public java.nio.file.Path getInstanceMetadataDirectory(java.lang.String);
  public java.nio.file.Path getInstanceConfigDirectory(java.lang.String);
  public java.nio.file.Path getInstanceStateDirectory(java.lang.String);
  public org.jackhuang.hmcl.setting.GameSettings$Instance createInstanceGameSettings(java.lang.String);
  public org.jackhuang.hmcl.setting.GameSettings$Instance getInstanceGameSettings(java.lang.String);
  public org.jackhuang.hmcl.setting.GameSettings$Instance getInstanceGameSettingsOrCreate(java.lang.String);
  public boolean isInstanceGameSettingsReadOnly(java.lang.String);
  public void forceOverwriteInstanceGameSettings(java.lang.String);
  public org.jackhuang.hmcl.setting.GameSettings$Preset getParentGameSettings(org.jackhuang.hmcl.setting.GameSettings$Instance);
  public boolean shouldIsolateNewInstance(boolean);
  public void applyDefaultIsolationSettingForNewInstance(java.lang.String, boolean);
  public org.jackhuang.hmcl.setting.GameSettings$Effective getEffectiveGameSettings(java.lang.String);
  public java.util.Optional<java.nio.file.Path> getVersionIconFile(java.lang.String);
  public void setVersionIconFile(java.lang.String, java.nio.file.Path) throws java.io.IOException;
  public void deleteIconFile(java.lang.String);
  public javafx.scene.image.Image getVersionIconImage(java.lang.String);                                // javafx (graphics) — avoid
  public void saveGameSettings(java.lang.String);
  public org.jackhuang.hmcl.game.LaunchOptions$Builder getLaunchOptions(java.lang.String, org.jackhuang.hmcl.java.JavaRuntime, java.nio.file.Path, java.util.List<java.lang.String>, java.util.List<java.lang.String>, boolean);
  public java.nio.file.Path getModpackConfiguration(java.lang.String);
  public void markVersionAsModpack(java.lang.String);
  public void undoMark(java.lang.String);
  public void markVersionLaunchedAbnormally(java.lang.String);
  public boolean unmarkVersionLaunchedAbnormally(java.lang.String);
  public static boolean isValidVersionId(java.lang.String);
  public boolean versionIdConflicts(java.lang.String);
  public static long getAutoAllocatedMemory(long);
  public static org.jackhuang.hmcl.game.ProxyOption getProxyOption();
}
```

### 3.4 `org.jackhuang.hmcl.game.DefaultGameRepository` (public API)

```text
Compiled from "DefaultGameRepository.java"
public class org.jackhuang.hmcl.game.DefaultGameRepository implements org.jackhuang.hmcl.game.GameRepository {
  public org.jackhuang.hmcl.game.DefaultGameRepository(java.nio.file.Path);
  public java.nio.file.Path getBaseDirectory();
  public void setBaseDirectory(java.nio.file.Path);
  public boolean hasVersion(java.lang.String);
  public org.jackhuang.hmcl.game.Version getVersion(java.lang.String);
  public int getVersionCount();
  public java.util.Collection<org.jackhuang.hmcl.game.Version> getVersions();
  public java.nio.file.Path getLibrariesDirectory(org.jackhuang.hmcl.game.Version);
  public java.nio.file.Path getLibraryFile(org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.game.Library);
  public java.nio.file.Path getArtifactFile(org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.game.Artifact);
  public java.nio.file.Path getRunDirectory(java.lang.String);
  public java.nio.file.Path getVersionJar(org.jackhuang.hmcl.game.Version);
  public java.util.Optional<java.lang.String> getGameVersion(org.jackhuang.hmcl.game.Version);
  public java.nio.file.Path getNativeDirectory(java.lang.String, org.jackhuang.hmcl.util.platform.Platform);
  public java.nio.file.Path getModsDirectory(java.lang.String);
  public java.nio.file.Path getResourcePackDirectory(java.lang.String);
  public java.nio.file.Path getVersionRoot(java.lang.String);
  public java.nio.file.Path getVersionJson(java.lang.String);
  public org.jackhuang.hmcl.game.Version readVersionJson(java.lang.String) throws java.io.IOException, com.google.gson.JsonParseException;
  public org.jackhuang.hmcl.game.Version readVersionJson(java.nio.file.Path) throws java.io.IOException, com.google.gson.JsonParseException;
  public boolean renameVersion(java.lang.String, java.lang.String);
  public boolean removeVersionFromDisk(java.lang.String);
  public void refreshVersions();
  public org.jackhuang.hmcl.game.AssetIndex getAssetIndex(java.lang.String, java.lang.String) throws java.io.IOException;
  public java.nio.file.Path getActualAssetDirectory(java.lang.String, java.lang.String);
  public java.nio.file.Path getAssetDirectory(java.lang.String, java.lang.String);
  public java.util.Optional<java.nio.file.Path> getAssetObject(java.lang.String, java.lang.String, java.lang.String) throws java.io.IOException;
  public java.nio.file.Path getAssetObject(java.lang.String, java.lang.String, org.jackhuang.hmcl.game.AssetObject);
  public java.nio.file.Path getIndexFile(java.lang.String, java.lang.String);
  public java.nio.file.Path getLoggingObject(java.lang.String, java.lang.String, org.jackhuang.hmcl.game.LoggingInfo);
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> saveAsync(org.jackhuang.hmcl.game.Version);
  public boolean isLoaded();
  public java.nio.file.Path getModpackConfiguration(java.lang.String);
  public org.jackhuang.hmcl.modpack.ModpackConfiguration<?> readModpackConfiguration(java.lang.String) throws java.io.IOException, org.jackhuang.hmcl.game.VersionNotFoundException;
  public boolean isModpack(java.lang.String);
  public org.jackhuang.hmcl.addon.mod.ModManager getModManager(java.lang.String);
  public java.nio.file.Path getSavesDirectory(java.lang.String);
  public java.nio.file.Path getBackupsDirectory(java.lang.String);
  public java.nio.file.Path getSchematicsDirectory(java.lang.String);
}
```

### 3.5 Launchers

```text
Compiled from "Launcher.java"
public abstract class org.jackhuang.hmcl.launch.Launcher {
  protected final org.jackhuang.hmcl.game.GameRepository repository;
  protected final org.jackhuang.hmcl.game.Version version;
  protected final org.jackhuang.hmcl.auth.AuthInfo authInfo;
  protected final org.jackhuang.hmcl.game.LaunchOptions options;
  protected final org.jackhuang.hmcl.launch.ProcessListener listener;
  protected final boolean daemon;
  public org.jackhuang.hmcl.launch.Launcher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions);
  public org.jackhuang.hmcl.launch.Launcher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions, org.jackhuang.hmcl.launch.ProcessListener);
  public org.jackhuang.hmcl.launch.Launcher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions, org.jackhuang.hmcl.launch.ProcessListener, boolean);
  public abstract void makeLaunchScript(java.nio.file.Path) throws java.io.IOException;
  public abstract org.jackhuang.hmcl.util.platform.ManagedProcess launch() throws java.io.IOException, java.lang.InterruptedException;
}

Compiled from "DefaultLauncher.java"
public class org.jackhuang.hmcl.launch.DefaultLauncher extends org.jackhuang.hmcl.launch.Launcher {
  public org.jackhuang.hmcl.launch.DefaultLauncher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions);
  public org.jackhuang.hmcl.launch.DefaultLauncher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions, org.jackhuang.hmcl.launch.ProcessListener);
  public org.jackhuang.hmcl.launch.DefaultLauncher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions, org.jackhuang.hmcl.launch.ProcessListener, boolean);
  public java.util.Map<java.lang.String, java.lang.Boolean> getFeatures();
  public void decompressNatives(java.nio.file.Path) throws org.jackhuang.hmcl.launch.NotDecompressingNativesException;
  public java.nio.file.Path getLog4jConfigurationFile();
  public void extractLog4jConfigurationFile() throws java.io.IOException;
  public org.jackhuang.hmcl.util.platform.ManagedProcess launch() throws java.io.IOException, java.lang.InterruptedException;
  public void makeLaunchScript(java.nio.file.Path) throws java.io.IOException;
}

Compiled from "HMCLGameLauncher.java"
public final class org.jackhuang.hmcl.game.HMCLGameLauncher extends org.jackhuang.hmcl.launch.DefaultLauncher {
  public org.jackhuang.hmcl.game.HMCLGameLauncher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions);
  public org.jackhuang.hmcl.game.HMCLGameLauncher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions, org.jackhuang.hmcl.launch.ProcessListener);
  public org.jackhuang.hmcl.game.HMCLGameLauncher(org.jackhuang.hmcl.game.GameRepository, org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.auth.AuthInfo, org.jackhuang.hmcl.game.LaunchOptions, org.jackhuang.hmcl.launch.ProcessListener, boolean);
  public org.jackhuang.hmcl.util.platform.ManagedProcess launch() throws java.io.IOException, java.lang.InterruptedException;
  public void makeLaunchScript(java.nio.file.Path) throws java.io.IOException;
}
```

`ProcessListener` (both core & used by UI) and the launch result:

```text
public interface org.jackhuang.hmcl.launch.ProcessListener {
  public default void setProcess(org.jackhuang.hmcl.util.platform.ManagedProcess);
  public abstract void onLog(java.lang.String, boolean);
  public abstract void onExit(int, org.jackhuang.hmcl.launch.ProcessListener$ExitType);
}

public final class org.jackhuang.hmcl.util.platform.ManagedProcess {
  public org.jackhuang.hmcl.util.platform.ManagedProcess(java.lang.ProcessBuilder) throws java.io.IOException;
  public org.jackhuang.hmcl.util.platform.ManagedProcess(java.lang.Process, java.util.List<java.lang.String>);
  public java.lang.Process getProcess();
  public java.util.List<java.lang.String> getCommands();
  public java.lang.String getClasspath();
  public java.util.Map<java.lang.String, java.lang.Object> getProperties();
  public java.util.List<java.lang.String> getLines(java.util.function.Predicate<java.lang.String>);
  public void addLine(java.lang.String);
  public void addRelatedThread(java.lang.Thread);
  public void pumpInputStream(java.util.function.Consumer<java.lang.String>);
  public void pumpErrorStream(java.util.function.Consumer<java.lang.String>);
  public boolean isRunning();
  public int getExitCode();
  public void stop();
  public void destroyRelatedThreads();
}
```

### 3.6 Auth

```text
Compiled from "OfflineAccountFactory.java"
public final class org.jackhuang.hmcl.auth.offline.OfflineAccountFactory extends org.jackhuang.hmcl.auth.AccountFactory<org.jackhuang.hmcl.auth.offline.OfflineAccount> {
  public org.jackhuang.hmcl.auth.offline.OfflineAccountFactory(org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorArtifactProvider);
  public org.jackhuang.hmcl.auth.AccountFactory$AccountLoginType getLoginType();
  public org.jackhuang.hmcl.auth.offline.OfflineAccount create(java.lang.String, java.util.UUID);        // <-- agent path: no UI needed
  public org.jackhuang.hmcl.auth.offline.OfflineAccount create(org.jackhuang.hmcl.auth.CharacterSelector, java.lang.String, java.lang.String, org.jackhuang.hmcl.auth.AccountFactory$ProgressCallback, java.lang.Object);
  public org.jackhuang.hmcl.auth.offline.OfflineAccount fromStorage(com.google.gson.JsonObject, com.google.gson.JsonObject);
  public static java.util.UUID getUUIDFromUserName(java.lang.String);                                    // deterministic UUID for a name
}

Compiled from "OfflineAccount.java"   (public API)
public class org.jackhuang.hmcl.auth.offline.OfflineAccount extends org.jackhuang.hmcl.auth.Account {
  public java.util.UUID getProfileID();
  public java.lang.String getProfileName();
  public org.jackhuang.hmcl.auth.offline.Skin getSkin();
  public void setSkin(org.jackhuang.hmcl.auth.offline.Skin);
  public org.jackhuang.hmcl.auth.AuthInfo logInWithoutSkin() throws org.jackhuang.hmcl.auth.AuthenticationException;
  public org.jackhuang.hmcl.auth.AuthInfo logIn() throws org.jackhuang.hmcl.auth.AuthenticationException;   // <-- the call that yields AuthInfo
  public org.jackhuang.hmcl.auth.AuthInfo playOffline() throws org.jackhuang.hmcl.auth.AuthenticationException;
  public void writeMetadata(com.google.gson.JsonObject);
  public javafx.beans.binding.ObjectBinding<...> getTextures();   // javafx — avoid
}

Compiled from "AuthInfo.java"
public class org.jackhuang.hmcl.auth.AuthInfo implements java.lang.AutoCloseable {
  public static final java.lang.String USER_TYPE_MSA;
  public static final java.lang.String USER_TYPE_MOJANG;
  public static final java.lang.String USER_TYPE_LEGACY;
  public org.jackhuang.hmcl.auth.AuthInfo(java.lang.String, java.util.UUID, java.lang.String, java.lang.String, java.lang.String);
  public java.lang.String getUsername();
  public java.util.UUID getUUID();
  public java.lang.String getAccessToken();
  public java.lang.String getUserType();
  public java.lang.String getUserProperties();
  public org.jackhuang.hmcl.game.Arguments getLaunchArguments(org.jackhuang.hmcl.game.LaunchOptions) throws java.io.IOException;
  public void close() throws java.lang.Exception;
}
```

Account registry (`setting.Accounts`), public API:

```text
Compiled from "Accounts.java"
public final class org.jackhuang.hmcl.setting.Accounts {
  public static final org.jackhuang.hmcl.game.OAuthServer$Factory OAUTH_CALLBACK;
  public static final org.jackhuang.hmcl.auth.offline.OfflineAccountFactory FACTORY_OFFLINE;
  public static final org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorAccountFactory FACTORY_AUTHLIB_INJECTOR;
  public static final org.jackhuang.hmcl.auth.microsoft.MicrosoftAccountFactory FACTORY_MICROSOFT;
  public static final java.util.List<org.jackhuang.hmcl.auth.AccountFactory<?>> FACTORIES;
  public static java.lang.String getLoginType(org.jackhuang.hmcl.auth.AccountFactory<?>);
  public static org.jackhuang.hmcl.auth.AccountFactory<?> getAccountFactory(java.lang.String);
  public static org.jackhuang.hmcl.auth.authlibinjector.BoundAuthlibInjectorAccountFactory getAccountFactoryByAuthlibInjectorServer(org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorServer);
  public static org.jackhuang.hmcl.auth.AccountFactory<?> getAccountFactory(org.jackhuang.hmcl.auth.Account);
  public static boolean isAccountFilesReadOnly(boolean);
  public static boolean isAccountFilesReadOnly(org.jackhuang.hmcl.auth.Account);
  public static boolean canRemoveAccount(org.jackhuang.hmcl.auth.Account);
  public static boolean canMoveAccount(org.jackhuang.hmcl.auth.Account);
  public static void forceOverwriteAccountFiles(boolean) throws java.io.IOException;
  public static void forceOverwriteAccountFiles(org.jackhuang.hmcl.auth.Account) throws java.io.IOException;
  public static void forceOverwriteAccountFiles() throws java.io.IOException;
  public static void init();
  public static javafx.collections.ObservableList<org.jackhuang.hmcl.auth.Account> getAccounts();
  public static org.jackhuang.hmcl.auth.Account getSelectedAccount();
  public static void setSelectedAccount(org.jackhuang.hmcl.auth.Account);
  public static javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.auth.Account> selectedAccountProperty();
  public static java.lang.String getLocalizedLoginTypeName(org.jackhuang.hmcl.auth.AccountFactory<?>);
  public static java.lang.String localizeErrorMessage(java.lang.Exception);
}
```

### 3.7 Settings / config

```text
Compiled from "SettingsManager.java"   (public API)
public final class org.jackhuang.hmcl.setting.SettingsManager {
  public static final java.nio.file.Path USER_SETTINGS_LOCATION;
  public static final java.nio.file.Path USER_STATE_LOCATION;
  public static org.jackhuang.hmcl.setting.LauncherSettings settings();
  public static org.jackhuang.hmcl.setting.UserSettings userSettings();
  public static org.jackhuang.hmcl.setting.UserState userState();
  public static org.jackhuang.hmcl.setting.LauncherState state();
  public static org.jackhuang.hmcl.setting.AuthlibInjectorServerList authlibInjectorServers();
  public static java.nio.file.Path localConfigDirectory();
  public static java.nio.file.Path settingsLocation();
  public static java.nio.file.Path stateLocation();
  public static java.nio.file.Path authlibInjectorServersLocation();
  public static java.nio.file.Path gameDirectoriesLocation();
  public static java.nio.file.Path userGameDirectoriesLocation();
  public static java.nio.file.Path gameSettingsLocation();
  public static java.nio.file.Path gameAccountsLocation();
  public static java.nio.file.Path userGameAccountsLocation();
  public static org.jackhuang.hmcl.setting.GameSettingsPresets gameSettingsPresets();
  public static javafx.collections.ObservableList<org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorServer> getAuthlibInjectorServers();
  public static javafx.collections.ObservableList<com.google.gson.JsonObject> getAccountMetadataRecords();
  public static javafx.collections.ObservableList<com.google.gson.JsonObject> getUserAccountMetadataRecords();
  public static javafx.collections.ObservableList<org.jackhuang.hmcl.setting.GameSettings$Preset> getGameSettings();
  public static org.jackhuang.hmcl.setting.GameSettings$Preset getGameSettings(org.jackhuang.hmcl.setting.GameSettingsPresetID);
  public static org.jackhuang.hmcl.setting.GameSettings$Preset getDefaultGameSettingsPresetOrCreate();
  public static boolean isNewlyCreated();
  public static boolean isOwnerChanged();
  public static boolean hasReadOnlyCoreSettings();
  public static boolean isGameSettingsReadOnly();
  public static boolean isLocalGameDirectoriesReadOnly();
  public static boolean isUserGameDirectoriesReadOnly();
  public static boolean isGameAccountsReadOnly();
  public static boolean isUserGameAccountsReadOnly();
  public static boolean isAuthlibInjectorServersReadOnly();
  public static boolean isUserSettingsReadOnly();
  public static void forceOverwriteGameSettings();
  public static void forceOverwriteLocalGameDirectories();
  public static void forceOverwriteUserGameDirectories();
  public static void forceOverwriteGameAccounts() throws java.io.IOException;
  public static void forceOverwriteUserGameAccounts() throws java.io.IOException;
  public static void forceOverwriteAuthlibInjectorServers();
  public static void init() throws java.io.IOException;
}
```

`LauncherSettings` (per-workspace config; relevant subset):

```text
public final class org.jackhuang.hmcl.setting.LauncherSettings extends ... ObservableSetting ... {
  public static org.jackhuang.hmcl.setting.LauncherSettings fromJson(com.google.gson.JsonObject) throws com.google.gson.JsonParseException;
  public org.jackhuang.hmcl.setting.LauncherSettings();
  public java.lang.String toJson();
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.setting.EnumCommonDirectory> commonDirectoryTypeProperty();
  public javafx.beans.property.StringProperty commonDirectoryProperty();
  public static java.lang.String getDefaultCommonDirectory();
  public java.lang.String getResolvedCommonDirectory();
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.setting.DownloadSource> versionListSourceProperty();
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.setting.DownloadSource> fileDownloadSourceProperty();
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.setting.GameDirectoryID> selectedGameDirectoryProperty();
  public javafx.collections.ObservableMap<org.jackhuang.hmcl.setting.GameDirectoryID, java.lang.String> getSelectedInstance();
  public java.lang.String getSelectedInstance(org.jackhuang.hmcl.setting.GameDirectoryID);
  public void setSelectedInstance(org.jackhuang.hmcl.setting.GameDirectoryID, java.lang.String);
  public javafx.beans.property.StringProperty preferredLoginTypeProperty();
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.auth.AccountID> selectedAccountProperty();
  // (theme/background/log fields omitted — irrelevant headless)
}
```

Game directory types (needed to construct the repository):

```text
public final class org.jackhuang.hmcl.setting.GameDirectory implements javafx.beans.Observable {
  public org.jackhuang.hmcl.setting.GameDirectoryID getId();
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.util.PortablePath> pathProperty();
  public org.jackhuang.hmcl.util.PortablePath getPath();
  public void setPath(org.jackhuang.hmcl.util.PortablePath);
  public javafx.beans.property.ObjectProperty<org.jackhuang.hmcl.util.i18n.LocalizedText> nameProperty();
  public org.jackhuang.hmcl.util.i18n.LocalizedText getName();
  public void setName(org.jackhuang.hmcl.util.i18n.LocalizedText);
  public org.jackhuang.hmcl.setting.GameDirectory(org.jackhuang.hmcl.setting.GameDirectoryID, org.jackhuang.hmcl.util.i18n.LocalizedText, org.jackhuang.hmcl.util.PortablePath);
  public org.jackhuang.hmcl.setting.GameDirectory(org.jackhuang.hmcl.setting.GameDirectoryID, org.jackhuang.hmcl.util.i18n.LocalizedText, org.jackhuang.hmcl.util.PortablePath, org.jackhuang.hmcl.setting.GameSettingsPresetID);
}

public final class org.jackhuang.hmcl.setting.GameDirectoryID extends java.lang.Record implements org.jackhuang.hmcl.util.TypedID {
  public static final java.lang.String PREFIX;
  public static final org.jackhuang.hmcl.setting.GameDirectoryID NIL;
  public org.jackhuang.hmcl.setting.GameDirectoryID(java.util.UUID);
  public static org.jackhuang.hmcl.setting.GameDirectoryID parse(java.lang.String);
  public static org.jackhuang.hmcl.setting.GameDirectoryID generate();
  public java.util.UUID uuid();
}

public final class org.jackhuang.hmcl.setting.GameDirectories extends ... ObservableSetting ... {
  public javafx.collections.ObservableList<org.jackhuang.hmcl.setting.GameDirectory> getGameDirectories();
}

public final class org.jackhuang.hmcl.setting.GameDirectoryManager {
  public static org.jackhuang.hmcl.setting.GameDirectoryID newGameDirectoryId();
  public static void init();
  public static javafx.collections.ObservableList<org.jackhuang.hmcl.setting.GameDirectory> getGameDirectories();
  public static void addLocalGameDirectory(org.jackhuang.hmcl.setting.GameDirectory);
  public static void addUserGameDirectory(org.jackhuang.hmcl.setting.GameDirectory);
  public static void removeGameDirectory(org.jackhuang.hmcl.setting.GameDirectory);
  public static org.jackhuang.hmcl.setting.GameDirectory getSelectedGameDirectory();
  public static org.jackhuang.hmcl.game.HMCLGameRepository getSelectedRepository();
  public static void setSelectedGameDirectory(org.jackhuang.hmcl.setting.GameDirectory);
  public static void setSelectedInstance(java.lang.String);
  public static java.lang.String getSelectedInstance();
  public static void registerVersionsListener(java.util.function.Consumer<org.jackhuang.hmcl.game.HMCLGameRepository>);
}
```

Supporting value types:

```text
public final class org.jackhuang.hmcl.util.PortablePath {
  public static org.jackhuang.hmcl.util.PortablePath of(java.lang.String);
  public static org.jackhuang.hmcl.util.PortablePath fromPath(java.nio.file.Path);
  public java.lang.String getPath();
  public boolean isAbsolute();
  public java.nio.file.Path toPath();
}
public final class org.jackhuang.hmcl.util.i18n.LocalizedText {
  public static org.jackhuang.hmcl.util.i18n.LocalizedText plain(java.lang.String);
  public org.jackhuang.hmcl.util.i18n.LocalizedText(java.lang.String);
}
```

### 3.8 Download

```text
Compiled from "DownloadProviders.java"   (setting package!)
public final class org.jackhuang.hmcl.setting.DownloadProviders {
  public static void init();
  public static org.jackhuang.hmcl.download.DownloadProvider getDownloadProvider();
  public static java.lang.String localizeErrorMessage(java.lang.Throwable);
}

public interface org.jackhuang.hmcl.download.DownloadProvider {
  public abstract java.util.List<java.net.URI> getVersionListURLs();
  public abstract java.util.List<java.net.URI> getAssetObjectCandidates(java.lang.String);
  public abstract java.lang.String injectURL(java.lang.String);
  public default java.util.List<java.net.URI> injectURLWithCandidates(java.lang.String);
  public default java.util.List<java.net.URI> injectURLsWithCandidates(java.util.List<java.lang.String>);
  public abstract org.jackhuang.hmcl.download.VersionList<?> getVersionListById(java.lang.String);
  public abstract int getConcurrency();
}

Compiled from "RemoteVersion.java"
public class org.jackhuang.hmcl.download.RemoteVersion implements java.lang.Comparable<org.jackhuang.hmcl.download.RemoteVersion> {
  public org.jackhuang.hmcl.download.RemoteVersion(java.lang.String, java.lang.String, java.lang.String, java.time.Instant, java.util.List<java.lang.String>);
  public org.jackhuang.hmcl.download.RemoteVersion(java.lang.String, java.lang.String, java.lang.String, java.time.Instant, org.jackhuang.hmcl.download.RemoteVersion$Type, java.util.List<java.lang.String>);
  public java.lang.String getLibraryId();
  public java.lang.String getGameVersion();
  public java.lang.String getSelfVersion();
  public java.lang.String getFullVersion();
  public java.time.Instant getReleaseDate();
  public java.util.List<java.lang.String> getUrls();
  public org.jackhuang.hmcl.download.RemoteVersion$Type getVersionType();
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> getInstallTask(org.jackhuang.hmcl.download.DefaultDependencyManager, org.jackhuang.hmcl.game.Version);   // <-- install entry point
}

Compiled from "VersionList.java"
public abstract class org.jackhuang.hmcl.download.VersionList<T extends org.jackhuang.hmcl.download.RemoteVersion> {
  public org.jackhuang.hmcl.download.VersionList();
  public boolean isLoaded();
  public boolean isLoaded(java.lang.String);
  public abstract boolean hasType();
  public abstract org.jackhuang.hmcl.task.Task<?> refreshAsync();
  public org.jackhuang.hmcl.task.Task<?> refreshAsync(java.lang.String);
  public org.jackhuang.hmcl.task.Task<?> loadAsync(java.lang.String);
  public final java.util.Collection<T> getVersions(java.lang.String);
  public java.util.Optional<T> getVersion(java.lang.String, java.lang.String);
}

Compiled from "GameVersionList.java"
public final class org.jackhuang.hmcl.download.game.GameVersionList extends org.jackhuang.hmcl.download.VersionList<org.jackhuang.hmcl.download.game.GameRemoteVersion> {
  public org.jackhuang.hmcl.download.game.GameVersionList(org.jackhuang.hmcl.download.DownloadProvider);
  public boolean hasType();
  public org.jackhuang.hmcl.task.Task<?> refreshAsync();
}

Compiled from "GameRemoteVersion.java"
public final class org.jackhuang.hmcl.download.game.GameRemoteVersion extends org.jackhuang.hmcl.download.RemoteVersion {
  public org.jackhuang.hmcl.download.game.GameRemoteVersion(java.lang.String, java.lang.String, java.util.List<java.lang.String>, org.jackhuang.hmcl.game.ReleaseType, java.time.Instant);
  public org.jackhuang.hmcl.game.ReleaseType getType();
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> getInstallTask(org.jackhuang.hmcl.download.DefaultDependencyManager, org.jackhuang.hmcl.game.Version);
}

Compiled from "DefaultDependencyManager.java"   (public API)
public class org.jackhuang.hmcl.download.DefaultDependencyManager extends org.jackhuang.hmcl.download.AbstractDependencyManager {
  public org.jackhuang.hmcl.download.DefaultDependencyManager(org.jackhuang.hmcl.game.DefaultGameRepository, org.jackhuang.hmcl.download.DownloadProvider, org.jackhuang.hmcl.download.DefaultCacheRepository);
  public org.jackhuang.hmcl.game.DefaultGameRepository getGameRepository();
  public org.jackhuang.hmcl.download.DownloadProvider getDownloadProvider();
  public org.jackhuang.hmcl.download.DefaultCacheRepository getCacheRepository();
  public org.jackhuang.hmcl.download.GameBuilder gameBuilder();
  public org.jackhuang.hmcl.task.Task<?> checkGameCompletionAsync(org.jackhuang.hmcl.game.Version, boolean);
  public org.jackhuang.hmcl.task.Task<?> checkLibraryCompletionAsync(org.jackhuang.hmcl.game.Version, boolean);
  public org.jackhuang.hmcl.task.Task<?> checkPatchCompletionAsync(org.jackhuang.hmcl.game.Version, boolean);
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> installLibraryAsync(java.lang.String, org.jackhuang.hmcl.game.Version, java.lang.String, java.lang.String);
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> installLibraryAsync(org.jackhuang.hmcl.game.Version, org.jackhuang.hmcl.download.RemoteVersion);
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> installLibraryAsync(org.jackhuang.hmcl.game.Version, java.nio.file.Path);
  public org.jackhuang.hmcl.task.Task<org.jackhuang.hmcl.game.Version> removeLibraryAsync(org.jackhuang.hmcl.game.Version, java.lang.String);
}

public abstract class org.jackhuang.hmcl.download.AbstractDependencyManager implements org.jackhuang.hmcl.download.DependencyManager {
  public org.jackhuang.hmcl.download.VersionList<?> getVersionList(java.lang.String);
}

Compiled from "GameBuilder.java"
public abstract class org.jackhuang.hmcl.download.GameBuilder {
  public org.jackhuang.hmcl.download.GameBuilder();
  public java.lang.String getName();
  public org.jackhuang.hmcl.download.GameBuilder name(java.lang.String);
  public org.jackhuang.hmcl.download.GameBuilder gameVersion(java.lang.String);
  public org.jackhuang.hmcl.download.GameBuilder version(java.lang.String, java.lang.String);
  public org.jackhuang.hmcl.download.GameBuilder version(org.jackhuang.hmcl.download.RemoteVersion);
  public abstract org.jackhuang.hmcl.task.Task<?> buildAsync();
}
```

### 3.9 Modpack

```text
Compiled from "Modpack.java"   (public API)
public abstract class org.jackhuang.hmcl.modpack.Modpack {
  public static final java.util.Set<java.lang.String> SUPPORTED_ICON_EXTS;
  public static final java.util.Set<java.lang.String> SUPPORTED_ICON_NAMES;
  public java.lang.String getName();
  public org.jackhuang.hmcl.modpack.Modpack setName(java.lang.String);
  public java.lang.String getAuthor();
  public java.lang.String getVersion();
  public java.lang.String getGameVersion();
  public java.lang.String getDescription();
  public java.nio.charset.Charset getEncoding();
  public org.jackhuang.hmcl.modpack.ModpackManifest getManifest();
  public abstract org.jackhuang.hmcl.task.Task<?> getInstallTask(org.jackhuang.hmcl.download.DefaultDependencyManager, java.nio.file.Path, java.lang.String, java.lang.String);
  public static boolean acceptFile(java.lang.String, java.util.List<java.lang.String>, java.util.List<java.lang.String>);
}

Compiled from "ModpackInstallTask.java"   (core task; per-type providers subclass it)
public class org.jackhuang.hmcl.modpack.ModpackInstallTask<T> extends org.jackhuang.hmcl.task.Task<java.lang.Void> {
  public org.jackhuang.hmcl.modpack.ModpackInstallTask(java.nio.file.Path, java.nio.file.Path, java.nio.charset.Charset, java.util.List<java.lang.String>, java.util.function.Predicate<java.lang.String>, org.jackhuang.hmcl.modpack.ModpackConfiguration<T>);
  public void execute() throws java.lang.Exception;
}

Compiled from "ModpackConfiguration.java"
public final class org.jackhuang.hmcl.modpack.ModpackConfiguration<T> implements org.jackhuang.hmcl.util.gson.Validation {
  public static <T> com.google.gson.reflect.TypeToken<org.jackhuang.hmcl.modpack.ModpackConfiguration<T>> typeOf(java.lang.Class<T>);
  public org.jackhuang.hmcl.modpack.ModpackConfiguration();
  public org.jackhuang.hmcl.modpack.ModpackConfiguration(T, java.lang.String, java.lang.String, java.lang.String, java.util.List<org.jackhuang.hmcl.modpack.ModpackConfiguration$FileInformation>);
  public T getManifest();
  public java.lang.String getType();
  public java.lang.String getName();
  public java.lang.String getVersion();
  public org.jackhuang.hmcl.modpack.ModpackConfiguration<T> setManifest(T);
  public org.jackhuang.hmcl.modpack.ModpackConfiguration<T> setOverrides(java.util.List<org.jackhuang.hmcl.modpack.ModpackConfiguration$FileInformation>);
  public org.jackhuang.hmcl.modpack.ModpackConfiguration<T> setVersion(java.lang.String);
  public java.util.List<org.jackhuang.hmcl.modpack.ModpackConfiguration$FileInformation> getOverrides();
  public void validate() throws com.google.gson.JsonParseException;
}

Compiled from "ModpackHelper.java"   (HMCL module, org.jackhuang.hmcl.game!)
public final class org.jackhuang.hmcl.game.ModpackHelper {
  public static org.jackhuang.hmcl.modpack.ModpackProvider getProviderByType(java.lang.String);
  public static boolean isFileModpackByExtension(java.nio.file.Path);
  public static org.jackhuang.hmcl.modpack.Modpack readModpackManifest(java.nio.file.Path, java.nio.charset.Charset) throws org.jackhuang.hmcl.modpack.UnsupportedModpackException, org.jackhuang.hmcl.game.ManuallyCreatedModpackException;
  public static org.jackhuang.hmcl.modpack.ModpackConfiguration<?> readModpackConfiguration(java.nio.file.Path) throws java.io.IOException;
  public static org.jackhuang.hmcl.task.Task<?> getInstallTask(org.jackhuang.hmcl.game.HMCLGameRepository, org.jackhuang.hmcl.modpack.server.ServerModpackManifest, java.lang.String, org.jackhuang.hmcl.modpack.Modpack);
  public static org.jackhuang.hmcl.task.Task<?> getInstallManuallyCreatedModpackTask(java.nio.file.Path, java.lang.String, java.nio.charset.Charset);
  public static org.jackhuang.hmcl.task.Task<?> getInstallTask(org.jackhuang.hmcl.game.HMCLGameRepository, java.nio.file.Path, java.lang.String, org.jackhuang.hmcl.modpack.Modpack, java.lang.String);
  public static org.jackhuang.hmcl.task.Task<java.lang.Void> getUpdateTask(org.jackhuang.hmcl.game.HMCLGameRepository, org.jackhuang.hmcl.modpack.server.ServerModpackManifest, java.nio.charset.Charset, java.lang.String, org.jackhuang.hmcl.modpack.ModpackConfiguration<?>) throws org.jackhuang.hmcl.modpack.UnsupportedModpackException;
  public static org.jackhuang.hmcl.task.Task<?> getUpdateTask(org.jackhuang.hmcl.game.HMCLGameRepository, java.nio.file.Path, java.nio.charset.Charset, java.lang.String, org.jackhuang.hmcl.modpack.ModpackConfiguration<?>) throws org.jackhuang.hmcl.modpack.UnsupportedModpackException, org.jackhuang.hmcl.game.ManuallyCreatedModpackException, org.jackhuang.hmcl.modpack.MismatchedModpackTypeException;
}
```

### 3.10 Task / TaskExecutor / Schedulers

```text
Compiled from "Task.java"   (public/protected API; private lambdas trimmed)
public abstract class org.jackhuang.hmcl.task.Task<T> {
  public org.jackhuang.hmcl.task.Task();
  public final org.jackhuang.hmcl.task.Task$TaskSignificance getSignificance();
  public final org.jackhuang.hmcl.task.Task<T> setSignificance(org.jackhuang.hmcl.task.Task$TaskSignificance);
  protected final boolean isCancelled();
  public java.lang.String getStage();
  protected final void setStage(java.lang.String);
  public java.lang.String getInheritedStage();
  public java.util.Map<java.lang.String, java.lang.Object> getProperties();
  public final org.jackhuang.hmcl.task.Task$TaskState getState();
  public final java.lang.Exception getException();
  public final java.util.concurrent.Executor getExecutor();
  public final org.jackhuang.hmcl.task.Task<T> setExecutor(java.util.concurrent.Executor);
  public boolean isDependentsSucceeded();
  public boolean isDependenciesSucceeded();
  public boolean isRelyingOnDependents();
  public boolean isRelyingOnDependencies();
  public java.lang.String getName();
  public org.jackhuang.hmcl.task.Task<T> setName(java.lang.String);
  public T getResult();
  public org.jackhuang.hmcl.task.Task<T> storeTo(java.util.function.Consumer<T>);
  public boolean doPreExecute();
  public void preExecute() throws java.lang.Exception;
  public abstract void execute() throws java.lang.Exception;
  public boolean doPostExecute();
  public void postExecute() throws java.lang.Exception;
  public java.util.Collection<? extends org.jackhuang.hmcl.task.Task<?>> getDependents();
  public java.util.Collection<? extends org.jackhuang.hmcl.task.Task<?>> getDependencies();
  public org.jackhuang.hmcl.event.EventManager<org.jackhuang.hmcl.task.TaskEvent> onDone();
  public javafx.beans.property.ReadOnlyDoubleProperty progressProperty();      // javafx.base — safe headless
  public final T run() throws java.lang.Exception;                             // SYNCHRONOUS — see §4.f
  public final org.jackhuang.hmcl.task.TaskExecutor executor();                // = new AsyncTaskExecutor(this)
  public final org.jackhuang.hmcl.task.TaskExecutor executor(boolean);
  public final org.jackhuang.hmcl.task.TaskExecutor executor(org.jackhuang.hmcl.task.TaskListener);
  public final void start();
  public final boolean test();
  // composition helpers: thenApplyAsync / thenAcceptAsync / thenRunAsync / thenSupplyAsync /
  // thenComposeAsync / withComposeAsync / withRunAsync / whenComplete / wrapResult / withStage /
  // withFakeProgress / withStagesHints / withCounter
  // static factories: runAsync / composeAsync / supplyAsync / completed / allOf / runSequentially / fromCompletableFuture
}

Compiled from "TaskExecutor.java"
public abstract class org.jackhuang.hmcl.task.TaskExecutor {
  public org.jackhuang.hmcl.task.TaskExecutor(org.jackhuang.hmcl.task.Task<?>);
  public void addTaskListener(org.jackhuang.hmcl.task.TaskListener);
  public java.lang.Exception getException();
  public abstract org.jackhuang.hmcl.task.TaskExecutor start();
  public abstract boolean test();
  public abstract void cancel();
  public boolean isCancelled();
}

Compiled from "AsyncTaskExecutor.java"
public final class org.jackhuang.hmcl.task.AsyncTaskExecutor extends org.jackhuang.hmcl.task.TaskExecutor {
  public org.jackhuang.hmcl.task.AsyncTaskExecutor(org.jackhuang.hmcl.task.Task<?>);
  public org.jackhuang.hmcl.task.TaskExecutor start();
  public boolean test();
  public void cancel();
}

public interface org.jackhuang.hmcl.task.TaskListener {
  // default onStart(TaskExecutor); onStop(boolean success, TaskExecutor); onProgress(...) etc.
}

Compiled from "Schedulers.java"
public final class org.jackhuang.hmcl.task.Schedulers {
  public static java.util.concurrent.ExecutorService newVirtualThreadPerTaskExecutor(java.lang.String);
  public static java.util.concurrent.ExecutorService io();
  public static java.util.concurrent.Executor javafx();      // avoid in agent (needs FX thread)
  public static java.util.concurrent.Executor defaultScheduler();   // agent-safe
  public static void shutdown();
}
```

### 3.11 Misc

```text
Compiled from "JavaRuntime.java"   (needed by getLaunchOptions)
public final class org.jackhuang.hmcl.java.JavaRuntime implements java.lang.Comparable<org.jackhuang.hmcl.java.JavaRuntime> {
  public static final org.jackhuang.hmcl.java.JavaRuntime CURRENT_JAVA;
  public static final int CURRENT_VERSION;
  public static org.jackhuang.hmcl.java.JavaRuntime of(java.nio.file.Path, org.jackhuang.hmcl.java.JavaInfo, boolean);
  public org.jackhuang.hmcl.java.JavaRuntime(java.nio.file.Path, org.jackhuang.hmcl.java.JavaInfo, boolean, boolean);
  public boolean isManaged();
  public java.nio.file.Path getBinary();
  public java.lang.String getVersion();
  public org.jackhuang.hmcl.util.platform.Platform getPlatform();
  public int getParsedVersion();
  public java.lang.String getVendor();
  public boolean isJDK();
  public static org.jackhuang.hmcl.java.JavaRuntime getDefault();     // <-- agent path
}

Compiled from "FileUtils.java"   (org.jackhuang.hmcl.util.io; public API)
public final class org.jackhuang.hmcl.util.io.FileUtils {
  public static java.nio.file.Path toPath(java.io.File);
  public static java.util.List<java.nio.file.Path> toPaths(java.util.List<java.io.File>);
  public static java.lang.String getNameWithoutExtension(java.nio.file.Path);
  public static java.lang.String getExtension(java.nio.file.Path);
  public static java.nio.file.Path toAbsolute(java.nio.file.Path);
  public static java.lang.String getAbsolutePath(java.nio.file.Path);
  public static boolean isNameValid(java.lang.String);
  public static long size(java.nio.file.Path);
  public static java.lang.String readTextMaybeNativeEncoding(java.nio.file.Path) throws java.io.IOException;
  public static void deleteDirectory(java.nio.file.Path) throws java.io.IOException;
  public static void copyDirectory(java.nio.file.Path, java.nio.file.Path) throws java.io.IOException;
  public static void cleanDirectory(java.nio.file.Path) throws java.io.IOException;
  public static void copyFile(java.nio.file.Path, java.nio.file.Path) throws java.io.IOException;
  public static void saveSafely(java.nio.file.Path, java.lang.String) throws java.io.IOException;
  public static java.util.List<java.nio.file.Path> listFilesByExtension(java.nio.file.Path, java.lang.String);
}
```

---

## 4. Source call chains (v3.16.3 tag, quoted)

Source layout: core = `HMCLCore/src/main/java/org/jackhuang/hmcl/...`; UI/HMCL-specific =
`HMCL/src/main/java/org/jackhuang/hmcl/...`; boot = `HMCLBoot/src/main/java/org/jackhuang/hmcl/...`.

### 4.a Version install chain

**Entry point in the UI** — `HMCL/src/main/java/org/jackhuang/hmcl/ui/main/MainPage.java`
("download/install latest release" flow):

```java
private void launchNoGame() {
    DownloadProvider downloadProvider = DownloadProviders.getDownloadProvider();
    VersionList<?> versionList = downloadProvider.getVersionListById("game");

    Holder<String> gameVersionHolder = new Holder<>();
    Task<?> task = versionList.refreshAsync("")
            .thenSupplyAsync(() -> versionList.getVersions("").stream()
                    .filter(it -> it.getVersionType() == RELEASE)
                    .filter(it -> NativePatcher.checkSupportedStatus(...) != ...UNSUPPORTED)
                    .sorted()
                    .findFirst()
                    .orElseThrow(() -> new IOException("No versions found")))
            .thenComposeAsync(version -> {
                HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
                DefaultDependencyManager dependency = repository.getDependency();
                String gameVersion = gameVersionHolder.value = version.getGameVersion();

                return dependency.gameBuilder()
                        .name(gameVersion)
                        .gameVersion(gameVersion)
                        .buildAsync();
            })
            .whenComplete(any -> GameDirectoryManager.getSelectedRepository().refreshVersions())
            .whenComplete(Schedulers.javafx(), (result, exception) -> { ... setSelectedInstance ... });
    Controllers.taskDialog(task, ...);
}
```

**Wizard install** — `HMCL/src/main/java/org/jackhuang/hmcl/ui/download/DownloadPage.java`
(`VanillaInstallWizardProvider`), shows provider + dependency manager construction and the
`GameBuilder` sequence with optional mod loaders:

```java
public VanillaInstallWizardProvider(HMCLGameRepository repository, GameRemoteVersion gameVersion) {
    this.repository = repository;
    this.gameVersion = gameVersion;
    this.downloadProvider = DownloadProviders.getDownloadProvider();
    this.dependencyManager = repository.getDependency(downloadProvider);
}
...
private Task<Void> finishVersionDownloadingAsync(SettingsMap settings) {
    GameBuilder builder = dependencyManager.gameBuilder();

    String name = (String) settings.get("name");
    builder.name(name);
    builder.gameVersion(((RemoteVersion) settings.get(LibraryAnalyzer.LibraryType.MINECRAFT.getPatchId())).getGameVersion());

    settings.asStringMap().forEach((key, value) -> {
        if (!LibraryAnalyzer.LibraryType.MINECRAFT.getPatchId().equals(key)
                && value instanceof RemoteVersion remoteVersion)
            builder.version(remoteVersion);                       // forge/fabric/optifine/... remote versions
    });

    repository.applyDefaultIsolationSettingForNewInstance(name, settings.isInstallingModdedVersion());
    return builder.buildAsync().whenComplete(any -> {
        repository.refreshVersions();
    }).thenRunAsync(Schedulers.javafx(), () -> repository.setSelectedInstance(name));
}
```

`GameRemoteVersion.getInstallTask(...)` is what each loader/game uses under the hood
(`HMCLCore/src/main/java/org/jackhuang/hmcl/download/game/GameRemoteVersion.java`,
`.../forge/ForgeRemoteVersion.java` etc. all override it). For plain vanilla the `GameBuilder`
flow above is the supported path; `RemoteVersion.getInstallTask(dependencyManager, baseVersion)`
also works directly (`Task<Version>`).

**Where providers come from** — `HMCL/src/main/java/org/jackhuang/hmcl/setting/DownloadProviders.java`:

```java
static {
    String bmclapiRoot = System.getProperty("hmcl.bmclapi.override", "https://bmclapi2.bangbang93.com");
    BMCLAPI_PROVIDER = new BMCLAPIDownloadProvider(bmclapiRoot);
    MOJANG_PROVIDER = new MojangDownloadProvider();
    DEFAULT_PROVIDER = createDownloadProvider(DownloadSource.DEFAULT, DownloadSource.DEFAULT);
    PROVIDER_WRAPPER = new DownloadProviderWrapper(DEFAULT_PROVIDER);
}
...
private static List<DownloadProvider> getCandidates(DownloadSource source) {
    ...
    return switch (normalized) {
        case DEFAULT -> LocaleUtils.IS_CHINA_MAINLAND
                ? List.of(BMCLAPI_PROVIDER, MOJANG_PROVIDER)
                : List.of(MOJANG_PROVIDER, BMCLAPI_PROVIDER);
        case OFFICIAL -> List.of(MOJANG_PROVIDER);
        case MIRROR -> List.of(BMCLAPI_PROVIDER, MOJANG_PROVIDER);
    };
}
public static DownloadProvider getDownloadProvider() { return PROVIDER_WRAPPER; }
```

`DownloadProviders.init()` re-creates the provider wrapper from
`settings().versionListSourceProperty()` / `fileDownloadSourceProperty()` and wires download
threads; it must be called after `SettingsManager.init()`.

### 4.b Launch chain

UI: `HMCL/src/main/java/org/jackhuang/hmcl/ui/versions/Versions.java` →

```java
public static void launch(HMCLGameRepository repository, String id, Consumer<LauncherHelper>... injecters) {
    if (!checkVersionForLaunching(repository, id))
        return;
    ensureSelectedAccount(account -> {
        LauncherHelper launcherHelper = new LauncherHelper(repository, account, id);
        for (Consumer<LauncherHelper> injecter : injecters) {
            injecter.accept(launcherHelper);
        }
        launcherHelper.launch();
    });
}
```

`HMCL/src/main/java/org/jackhuang/hmcl/game/LauncherHelper.java` — the essential part of
`launch0()` (dependencies / GUI-dialogs trimmed):

```java
DefaultDependencyManager dependencyManager = repository.getDependency();
AtomicReference<Version> version = new AtomicReference<>(MaintainTask.maintain(repository, repository.getResolvedVersion(selectedVersion)));
Optional<String> gameVersion = repository.getGameVersion(version.get());
boolean integrityCheck = repository.unmarkVersionLaunchedAbnormally(selectedVersion);
...
TaskExecutor executor = checkGameState(repository, setting, version.get())          // resolves JavaRuntime (GameSettings.Effective → JavaManager / JavaRuntime.getDefault())
        .thenComposeAsync(... NativePatcher.patchNative ...)
        .thenComposeAsync(() -> Task.allOf(
                dependencyManager.checkGameCompletionAsync(version.get(), integrityCheck),   // <-- downloads missing libs/assets
                ...))
        ...
        .thenComposeAsync(() -> logIn(account).withStage("launch.state.logging_in"))
        .thenComposeAsync(authInfo -> Task.supplyAsync(() -> {
            LaunchOptions.Builder launchOptionsBuilder = repository.getLaunchOptions(
                    selectedVersion, javaVersionRef.get(), repository.getBaseDirectory(), javaAgents, javaArguments, scriptFile != null);
            ...
            LaunchOptions launchOptions = launchOptionsBuilder.create();
            return new HMCLGameLauncher(
                    repository,
                    version.get(),
                    authInfo,                       // <-- AuthInfo is a Launcher ctor arg, NOT in the builder
                    launchOptions,
                    launcherVisibility == LauncherVisibility.CLOSE
                            ? null
                            : new HMCLProcessListener(repository, version.get(), authInfo, launchOptions, launchingLatch, ...)
            );
        }).thenComposeAsync(launcher -> Task.supplyAsync(launcher::launch))
        .thenAcceptAsync(process -> { ... PROCESSES.add(new WeakReference<>(process)); ... }))
        ...
        .executor();
executor.addTaskListener(new TaskListener() {
    @Override
    public void onStop(boolean success, TaskExecutor executor) {
        ...
        if (!success) {
            Exception ex = executor.getException();
            ...
        }
    }
});
```

`logIn(Account)` (same file):

```java
private Task<AuthInfo> logIn(Account account) {
    return Task.composeAsync(() -> {
        try {
            if (disableOfflineSkin && account instanceof OfflineAccount offlineAccount)
                return Task.completed(offlineAccount.logInWithoutSkin());
            else
                return Task.completed(account.logIn());          // <-- account.logIn() → AuthInfo
        } catch (CredentialExpiredException e) { ... UI dialog ... }
        catch (AuthenticationException e) { ... UI dialog, falls back to account.playOffline() ... }
    });
}
```

`checkGameState(...)` returns a `Task<JavaRuntime>`; the headless-usable fallback it ends at is
`JavaRuntime.getDefault()` (see lines ~389–470, `Lang.requireNonNullElse(java, JavaRuntime.getDefault())`).

`HMCLGameRepository.getLaunchOptions` (`HMCL/src/main/java/org/jackhuang/hmcl/game/HMCLGameRepository.java`)
fills the builder from `GameSettings.Effective` (memory, jvm args, window size, proxy…):

```java
public LaunchOptions.Builder getLaunchOptions(String version, JavaRuntime javaVersion, Path gameDir, List<String> javaAgents, List<String> javaArguments, boolean makeLaunchScript) {
    GameSettings.Effective vs = getEffectiveGameSettings(version);
    ...
    LaunchOptions.Builder builder = new LaunchOptions.Builder()
            .setGameDir(gameDir)
            .setJava(javaVersion)
            .setVersionType(Metadata.TITLE)
            .setVersionName(version)
            .setProfileName(Metadata.TITLE)
            .setGameArguments(StringUtils.tokenize(vs.getInheritable(GameSettings::gameArgumentsProperty)))
            .setOverrideJavaArguments(StringUtils.tokenize(vs.getInheritable(GameSettings::jvmOptionsProperty)))
            .setMaxMemory(maxMemory)
            .setMinMemory(vs.getInheritable(GameSettings::minMemoryProperty))
            .setMetaspace(Lang.toIntOrNull(vs.getInheritable(GameSettings::permSizeProperty)))
            .setEnvironmentVariables(...)
            .setWidth(vs.getWidth())
            .setHeight(vs.getHeight())
            .setFullscreen(vs.getInheritable(GameSettings::windowTypeProperty) == GameWindowType.FULLSCREEN)
            .setWrapper(vs.getInheritable(GameSettings::commandWrapperProperty))
            .setProxyOption(getProxyOption())
            .setPreLaunchCommand(...)
            .setPostExitCommand(...)
            .setNoGeneratedJVMArgs(noJVMOptions)
            .setNoGeneratedOptimizingJVMArgs(...)
            .setUseCustomNatives(...)
            ...;
}
```

### 4.c Modpack import chain

UI: `HMCL/src/main/java/org/jackhuang/hmcl/ui/download/LocalModpackPage.java`:

```java
manifest = ModpackHelper.readModpackManifest(selectedFile, encoding);   // → org.jackhuang.hmcl.modpack.Modpack
```

Then the install task is built by `HMCL/src/main/java/org/jackhuang/hmcl/game/ModpackHelper.java`
(also used from `ui/main/RootPage.java:281`). Core of `getInstallTask(HMCLGameRepository, Path, String, Modpack, String)`:

```java
public static Task<?> getInstallTask(HMCLGameRepository repository, Path zipFile, String name, Modpack modpack, String iconUrl) {
    repository.markVersionAsModpack(name);

    ExceptionalRunnable<?> success = () -> {
        repository.refreshVersions();
        GameSettings.Instance setting = repository.getInstanceGameSettingsOrCreate(name);
        repository.undoMark(name);
        if (setting != null) {
            setting.getOverrideProperties().add(GameSettings.PROPERTY_RUNNING_DIRECTORY);
        }
    };
    ...
    if (modpack.getManifest() instanceof MultiMCInstanceConfiguration)
        return modpack.getInstallTask(repository.getDependency(), zipFile, name, iconUrl)
                .whenComplete(Schedulers.defaultScheduler(), success, failure)
                .thenComposeAsync(createMultiMCPostInstallTask(repository, (MultiMCInstanceConfiguration) modpack.getManifest(), name))
                .withStagesHints(new Task.StagesHint("hmcl.modpack"), new Task.StagesHint("hmcl.modpack.download", List.of("hmcl.install.assets", "hmcl.install.libraries")));
    else if (modpack.getManifest() instanceof McbbsModpackManifest)
        ... McbbsModpackLocalInstallTask ...;
    else
        return modpack.getInstallTask(repository.getDependency(), zipFile, name, iconUrl)
                .whenComplete(Schedulers.javafx(), success, failure)
                .withStagesHints(...);
}
```

`Modpack.getInstallTask(DefaultDependencyManager, Path zipFile, String name, String iconUrl)` is the
abstract contract implemented per provider (MultiMC: `MultiMCModpackInstallTask`, CurseForge:
`CurseInstallTask`, Modrinth: `ModrinthInstallTask`, MCBBS: `McbbsModpackLocalInstallTask`, …).
These wrap `MinecraftInstanceTask` / `ModpackInstallTask`. The task writes the instance JSON under
`versions/<name>` and the `ModpackConfiguration` (`type`/`manifest`/`name`/`version`/`overrides`)
to `repository.getModpackConfiguration(name)` — see `HMCLModpackInstallTask`
(`HMCL/src/main/java/org/jackhuang/hmcl/game/HMCLModpackInstallTask.java:76`):

```java
dependents.add(new MinecraftInstanceTask<>(zipFile, modpack.getEncoding(), Collections.singletonList("/minecraft"), modpack, HMCLModpackProvider.INSTANCE, modpack.getName(), modpack.getVersion(), repository.getModpackConfiguration(name)).withStage("hmcl.modpack"));
```

Direct low-level alternative (no HMCL-module helper, core only):
`new ModpackInstallTask(modpackFile, destDir, charset, subDirectories, callback, configuration)`
— this one just unpacks files; the per-provider tasks (which also resolve/install the modloader
libraries) are in `org.jackhuang.hmcl.modpack.*` (e.g. `MultiMCModpackInstallTask`,
`CurseInstallTask`, `ModrinthInstallTask`, `McbbsModpackLocalInstallTask`, all
`extends ModpackInstallTask<T>`; constructors take `(DefaultDependencyManager, Path file, Path dest, String name, Modpack modpack)` — see e.g. `MultiMCModpackInstallTask` javap if needed).

### 4.d Offline account creation

UI: `HMCL/src/main/java/org/jackhuang/hmcl/ui/account/CreateAccountPane.java`:

```java
loginTask = Task.supplyAsync(() -> factory.create(new DialogCharacterSelector(), username, password, null, additionalData))
        .whenComplete(Schedulers.javafx(), account -> { ... completeLogin(account); ... });
```

where for offline `additionalData = new OfflineAccountFactory.AdditionalData(uuid, null)`. Then:

```java
private void completeLogin(Account account) {
    int oldIndex = Accounts.getAccounts().indexOf(account);
    if (oldIndex == -1) {
        Accounts.getAccounts().add(account);
    } else { ... }
    Accounts.setSelectedAccount(account);
    ...
}
```

The offline UUID default is deterministic:
`txtUUID.promptTextProperty().bind(... OfflineAccountFactory.getUUIDFromUserName(name).toString())`.

**Agent path (no UI)**: `Accounts.FACTORY_OFFLINE.create(name, uuid)` (or
`OfflineAccountFactory.getUUIDFromUserName(name)` for the deterministic UUID), then
`account.logIn()` → `AuthInfo`. Adding to the registry (`Accounts.getAccounts().add(account)`) is
optional for launching — `AuthInfo` is self-contained.

### 4.e Properties controlling dirs (3.16.3)

`HMCL/src/main/java/org/jackhuang/hmcl/Metadata.java` (static init, quoted verbatim):

```java
public static final Path CURRENT_DIRECTORY = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
public static final Path MINECRAFT_DIRECTORY = OperatingSystem.getWorkingDirectory("minecraft");
public static final Path HMCL_USER_HOME;
public static final Path HMCL_LOCAL_HOME;
public static final Path DEPENDENCIES_DIRECTORY;

static {
    String hmclHome = System.getProperty("hmcl.home", System.getenv("HMCL_USER_HOME"));
    if (StringUtils.isBlank(hmclHome)) {
        if (OperatingSystem.CURRENT_OS.isLinuxOrBSD()) {
            String xdgData = System.getenv("XDG_DATA_HOME");
            if (StringUtils.isNotBlank(xdgData)) {
                HMCL_USER_HOME = Path.of(xdgData, "hmcl").toAbsolutePath().normalize();
            } else {
                HMCL_USER_HOME = Path.of(System.getProperty("user.home"), ".local", "share", "hmcl").toAbsolutePath().normalize();
            }
        } else {
            HMCL_USER_HOME = OperatingSystem.getWorkingDirectory("hmcl");
        }
    } else {
        HMCL_USER_HOME = Path.of(hmclHome).toAbsolutePath().normalize();
    }

    String hmclCurrentDir = System.getProperty("hmcl.dir", System.getenv("HMCL_LOCAL_HOME"));
    HMCL_LOCAL_HOME = StringUtils.isNotBlank(hmclCurrentDir)
            ? Path.of(hmclCurrentDir).toAbsolutePath().normalize()
            : CURRENT_DIRECTORY.resolve(".hmcl");

    String hmclDependencies = System.getProperty("hmcl.dependencies.dir", System.getenv("HMCL_DEPENDENCIES_DIR"));
    DEPENDENCIES_DIRECTORY = StringUtils.isNotBlank(hmclDependencies)
            ? Path.of(hmclDependencies).toAbsolutePath().normalize()
            : HMCL_LOCAL_HOME.resolve("dependencies");
}
```

`HMCLCore/.../util/platform/OperatingSystem.java`:

```java
public static Path getWorkingDirectory(String folder) {
    String home = System.getProperty("user.home", ".");
    switch (OperatingSystem.CURRENT_OS) {
        case LINUX:
        case FREEBSD:  return Paths.get(home, "." + folder).toAbsolutePath();
        case WINDOWS:
            String appdata = System.getenv("APPDATA");
            return Paths.get(appdata == null ? home : appdata, "." + folder).toAbsolutePath();
        case MACOS:    return Paths.get(home, "Library", "Application Support", folder).toAbsolutePath();
        default:       return Paths.get(home, folder).toAbsolutePath();
    }
}
```

**Precedence summary (Windows defaults)**:

| Property / env | Meaning | Windows default |
|---|---|---|
| `hmcl.home` → `HMCL_USER_HOME` | user (shared) data | `%APPDATA%\.hmcl` |
| `hmcl.dir` → `HMCL_LOCAL_HOME` | workspace (local) data | `<cwd>\.hmcl` |
| `hmcl.dependencies.dir` → `DEPENDENCIES_DIRECTORY` | shared caches | `HMCL_LOCAL_HOME\dependencies` |
| (none) → `MINECRAFT_DIRECTORY` | common Minecraft dir | `%APPDATA%\.minecraft` |

**Which dir controls `versions/`, `libraries/`, `assets/`**: the **selected GameDirectory** whose
default is the **common directory** — `LauncherSettings`:

```java
/// Returns the default common Minecraft directory path.
public static String getDefaultCommonDirectory() {
    return Metadata.MINECRAFT_DIRECTORY.toString();
}

public String getResolvedCommonDirectory() {
    EnumCommonDirectory type = commonDirectoryType.get();
    String customPath = commonDirectory.get();
    return type == EnumCommonDirectory.CUSTOM && StringUtils.isNotBlank(customPath)
            ? customPath
            : getDefaultCommonDirectory();
}
```

So by default `versions/`, `libraries/`, `assets/` live in `%APPDATA%\.minecraft` (Windows),
overridable via the `commonDirectory`/`commonDirectoryType` settings or by registering a custom
`GameDirectory`.

**hmcl.json in 3.16.3**: gone. Config files are split per-workspace vs shared
(`HMCL/src/main/java/org/jackhuang/hmcl/setting/SettingsManager.java`):

```java
private static final Path LOCAL_CONFIG_FILES_DIRECTORY = Metadata.HMCL_LOCAL_HOME.resolve("config");
private static final Path LOCAL_STATE_DIRECTORY   = Metadata.HMCL_LOCAL_HOME.resolve("state");
private static final Path LOCAL_CACHE_DIRECTORY   = Metadata.HMCL_LOCAL_HOME.resolve("cache");
private static final Path USER_CONFIG_FILES_DIRECTORY = Metadata.HMCL_USER_HOME.resolve("config");
...
public static final Path USER_SETTINGS_LOCATION = USER_CONFIG_FILES_DIRECTORY.resolve("user-settings.json");
// per-workspace:
//   <HMCL_LOCAL_HOME>/config/launcher-settings.json        (the old hmcl.json role; legacy hmcl.json is migrated by LegacyConfigMigrator)
//   <HMCL_LOCAL_HOME>/config/game-directories.json
//   <HMCL_LOCAL_HOME>/config/authlib-injector-servers.json
//   <HMCL_LOCAL_HOME>/state/launcher-state.json
// shared (user):
//   <HMCL_USER_HOME>/config/user-settings.json, /state/user-state.json, /config/user-game-directories.json
```

### 4.f Task execution semantics

`HMCLCore/src/main/java/org/jackhuang/hmcl/task/Task.java` — **`run()` is fully synchronous on
the calling thread**:

```java
public final T run() throws Exception {
    if (getSignificance().shouldLog())
        LOG.trace("Executing task: " + getName());

    for (Task<?> task : getDependents())
        doSubTask(task);            // recursively task.run() on THIS thread
    execute();
    for (Task<?> task : getDependencies())
        doSubTask(task);            // recursively task.run() on THIS thread
    fireDoneEvent(this, false);

    return getResult();
}

public final TaskExecutor executor() {
    return new AsyncTaskExecutor(this);
}
```

Headless usage: `task.run()` (blocking, throws `Exception` — or inspect `task.getException()`),
or `TaskExecutor ex = task.executor(); ex.start(); ...` and afterwards `ex.getException()` /
`ex.test()` (blocking, returns success boolean). `AsyncTaskExecutor.start()` runs the task graph
on `CompletableFuture`'s common pool (schedulers: `Schedulers.io()`, `Schedulers.defaultScheduler()`);
**avoid `Schedulers.javafx()`** in the agent (needs the JavaFX application thread). `Task.test()` =
`start()` + block on `future.get()`.

Note: `ModpackHelper`'s success/failure hooks use `Schedulers.javafx()` in the MultiMC/MCBBS
branches; for the headless agent prefer `whenComplete(Schedulers.defaultScheduler(), ...)` or
simply `task.run()`/`executor().test()` and skip the refresh-on-success hooks (call
`repository.refreshVersions()` yourself afterwards).

### 4.g Full init sequence (from the desktop app)

`HMCL/src/main/java/org/jackhuang/hmcl/Launcher.java` (init()):

```java
SettingsManager.init();            // reads/writes config files (may throw IOException)
...
initializeSettingsRuntime();       // runLater(...) in the real app; headless: call directly:
DownloadProviders.init();
ProxyManager.init();
Accounts.init();
GameDirectoryManager.init();
AuthlibInjectorServers.init();
AnimationUtils.init();             // javafx animations — SKIP headless
CacheRepository.setInstance(HMCLCacheRepository.REPOSITORY);
```

---

## 5. Recommended agent skeleton (premain → HTTP JSON API)

```java
public class Agent {
    // premain: runs before HMCL's own Main; must not touch javafx.application

    public static void premain(String agentArgs, Instrumentation inst) {
        // 1. dirs — set BEFORE any HMCL class that reads Metadata is initialized:
        //    -Dhmcl.home=... (or env HMCL_USER_HOME)  → user data
        //    -Dhmcl.dir=...  (or env HMCL_LOCAL_HOME) → workspace data (config/game-directories.json...)
        //    (versions/libraries/assets default to %APPDATA%\.minecraft via common directory)

        // 2. HMCL init (order matters; SettingsManager first)
        SettingsManager.init();                      // throws IOException
        DownloadProviders.init();                    // wires bmclapi/mojang provider from settings
        Accounts.init();                             // loads account metadata (optional but harmless)
        GameDirectoryManager.init();                 // optional — or construct your own repository:
        // HMCLGameRepository repository = new HMCLGameRepository(
        //     new GameDirectory(GameDirectoryID.generate(),
        //                       LocalizedText.plain("agent"),
        //                       PortablePath.fromPath(Path.of("D:/minecraft"))));

        // 3. Install a version (vanilla)
        DownloadProvider provider = DownloadProviders.getDownloadProvider();       // AutoDownloadProvider (BMCLAPI↔Mojang)
        VersionList<?> list = provider.getVersionListById("game");                 // GameVersionList
        list.refreshAsync("").run();                                               // sync network fetch
        GameRemoteVersion remote = (GameRemoteVersion) list
                .getVersions("").stream().filter(v -> v.getFullVersion().equals("1.21.4")).findFirst().orElseThrow();
        DefaultDependencyManager dep = repository.getDependency();                 // or getDependency(provider)
        dep.gameBuilder().name("1.21.4").gameVersion("1.21.4").buildAsync().run(); // install
        // with loaders: builder.version(forgeRemoteVersion); or remoteVersion.getInstallTask(dep, baseVersion).run();
        repository.refreshVersions();
        Version version = repository.getResolvedVersion("1.21.4");

        // 4. Import a modpack
        Modpack modpack = ModpackHelper.readModpackManifest(Path.of("pack.zip"), Charset.forName("UTF-8"));
        ModpackHelper.getInstallTask(repository, Path.of("pack.zip"), "MyPack", modpack, "").run();
        repository.refreshVersions();

        // 5. Offline account → AuthInfo
        OfflineAccount account = Accounts.FACTORY_OFFLINE.create("Steve", OfflineAccountFactory.getUUIDFromUserName("Steve"));
        AuthInfo authInfo = account.logIn();                                       // throws AuthenticationException

        // 6. Pre-launch completion check (downloads missing libs/assets)
        dep.checkGameCompletionAsync(repository.getResolvedVersion("1.21.4"), false).run();

        // 7. Launch (headless-safe core launcher)
        LaunchOptions options = repository.getLaunchOptions(
                "1.21.4", JavaRuntime.getDefault(), repository.getBaseDirectory(),
                List.of(), List.of(), false).create();
        ManagedProcess process = new DefaultLauncher(
                repository, version, authInfo, options, null /*ProcessListener*/, true /*daemon*/).launch();

        // 8. Serve HTTP JSON API (own thread / HttpServer); expose
        //    /versions /install /launch /stop → process.stop() ...
    }
}
```

Notes:
- `Task.run()` makes every step synchronous & throwable — no FX thread, no listeners needed.
  Use `task.executor().test()` if you want progress callbacks via `TaskListener`.
- Keep one `HMCLGameRepository`; `getDependency()` allocates a fresh
  `DefaultDependencyManager` per call — cache it if used repeatedly.
- Avoid: `Schedulers.javafx()`, `HMCLGameRepository.getVersionIconImage`, `FXUtils`,
  `Controllers.*`, `HMCLGameLauncher` (UI module, ties into process-tracking singletons) unless
  you reproduce the UI's `LauncherHelper` flow — `DefaultLauncher` is the direct core equivalent.
- `authInfo.close()` exists (AutoCloseable) — call it after the game exits if you care about
  token hygiene.

---

## 6. UNCERTAIN / unverified

1. **`SettingsManager.init()` + `DownloadProviders.init()` executed headless** — class-loading is
   verified (javafx-base+graphics on classpath), but I did not run a full init+install+launch
   cycle in a JVM here (no network-verified install, no game launch). `SettingsManager.init()`
   does file I/O + observable setup (no toolkit calls seen in source), `DownloadProviders.init()`
   only touches `FetchTask` executors and properties — both look headless-safe, but a smoke test
   is recommended before shipping.
2. **`LauncherSettings` needs `javafx.graphics`** (`ObjectProperty<Paint>` fields) — verified by
   class-load experiment. If you never touch theme/background properties you can avoid
   `LauncherSettings` and use `SettingsManager.settings()` only for
   `versionListSourceProperty`/`commonDirectory` reads; the class still must load, so keep
   javafx-graphics on the classpath.
3. **`Accounts.init()`** — loads account metadata JSON via `SettingsManager`; the offline
   `create(...)` + `logIn()` path itself is UI-independent (only `AuthlibInjectorArtifactProvider`
   is passed to the factory ctor; `FACTORY_OFFLINE` comes pre-wired with
   `AuthlibInjectorArtifactProvider.INSTANCE` — exact wiring in `Accounts` static block not
   quoted; assumed safe because the UI constructs accounts from a background task with the same
   factory).
4. **`DefaultLauncher.launch()` vs `HMCLGameLauncher.launch()`** — the UI always uses
   `HMCLGameLauncher` (adds HMCL-specific JVM args / log4j setup). `DefaultLauncher` is the
   plain core launcher; its exact JVM-arg output for a real version was not run. If the game
   fails to boot with `DefaultLauncher`, mirror `HMCLGameLauncher.getConfigurations()`/`appendJvmArgs`.
5. **`VersionList.getVersion(gameVersion, selfVersion)`** semantics (exact key format for
   `getVersion("1.21.4", "1.21.4")`) not exercised; the quoted UI code always uses
   `getVersions(gameVersion)` + streaming filters, so prefer that.
6. **`MaintainTask.maintain` + `NativePatcher.patchNative`** (HMCL module, used by
   `LauncherHelper` before launch) are skipped in the skeleton; they handle memory-patch advice
   and Mesa/GLFW natives. Skipping is fine for vanilla 1.13+; for old versions (≤1.12) HMCL
   applies its memory patch via `NativePatcher` — check `needPatchMemoryUtil` if launch issues
   arise.
7. **Gson version bundled** — 3.16.3 shades Gson 2.x (207 entries, `com/google/gson/Gson.class`
   present); exact minor version not verified (not needed to call the API).
8. `SettingsManager.init()` is `throws IOException` and the app also handles `SambaException`;
   agent should mirror that try/catch.
9. `OfflineAccountFactory.AdditionalData(UUID, Skin)` javap captured; the UI passes `(uuid, null)`.

## 7. Reproduction commands

```bash
# artifact inspection
jar tf agent/lib/HMCL-3.16.3.jar | wc -l
unzip -p agent/lib/HMCL-3.16.3.jar META-INF/MANIFEST.MF
# class signatures
javap -classpath agent/lib/HMCL-3.16.3.jar -p org.jackhuang.hmcl.game.LaunchOptions\$Builder
javap -classpath agent/lib/HMCL-3.16.3.jar org.jackhuang.hmcl.game.HMCLGameRepository
# headless load probe (JDK 21, no system JavaFX)
java -cp "$(cygpath -w /tmp)/javafx-base-win.jar;$(cygpath -w /tmp)/javafx-graphics-win.jar;agent/lib/HMCL-3.16.3.jar" TestLoad <class...>
# javafx-base / javafx-graphics 21.0.4 (win classifier!) from Maven Central:
# https://repo1.maven.org/maven2/org/openjfx/javafx-base/21.0.4/javafx-base-21.0.4-win.jar
# (the classifier-less jar is a 302-byte stub — do not use)
```
