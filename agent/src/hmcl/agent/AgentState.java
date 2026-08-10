package hmcl.agent;

import javafx.application.Platform;
import org.jackhuang.hmcl.download.DefaultDependencyManager;
import org.jackhuang.hmcl.game.HMCLCacheRepository;
import org.jackhuang.hmcl.util.CacheRepository;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.DownloadProviders;
import org.jackhuang.hmcl.setting.GameDirectory;
import org.jackhuang.hmcl.setting.GameDirectoryID;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.util.PortablePath;
import org.jackhuang.hmcl.util.i18n.LocalizedText;

import java.nio.file.Path;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Process-wide agent state: the initialized HMCL core plus the loopback API configuration.
 *
 * <p>Init sequence (order matters, see docs/research/hmcl-java-api.md §4.g):
 * {@code SettingsManager.init()} → {@code DownloadProviders.init()} → {@code Accounts.init()} →
 * {@code GameDirectoryManager.init()}, then the game directory is switched to {@code -Dhmcl.gameDir}
 * so that {@code versions/}, {@code libraries/} and {@code assets/} land inside it.
 */
public final class AgentState {

    /** Game directory (workdir) — root of versions/, libraries/, assets/, logs/. */
    public final Path gameDir;
    /** Shared secret required in the X-HMCL-Agent-Token header of every request. */
    public final String token;
    /** The repository bound to the selected game directory. */
    public final HMCLGameRepository repository;
    /** Dependency manager for installs / launch completion checks (cached, see doc §5 note). */
    public final DefaultDependencyManager dependency;
    /**
     * Serializes state-mutating operations (version install, modpack install, launch).
     * HMCL's repository and version lists are not thread-safe; all mutations run under this lock.
     */
    public final ReentrantLock stateLock = new ReentrantLock();

    private AgentState(Path gameDir, String token, HMCLGameRepository repository,
                       DefaultDependencyManager dependency) {
        this.gameDir = gameDir;
        this.token = token;
        this.repository = repository;
        this.dependency = dependency;
    }

    /** Initializes HMCL core headlessly and binds the repository to {@code gameDir}. */
    public static AgentState init(Path gameDir, String token) throws Exception {
        initJavaFxToolkit();
        log("Initializing HMCL core: SettingsManager -> DownloadProviders -> Accounts -> GameDirectoryManager");
        SettingsManager.init();          // may throw IOException
        DownloadProviders.init();
        Accounts.init();
        GameDirectoryManager.init();

        // Wire the download cache to <gameDir>/cache. The real app binds
        // HMCLCacheRepository.REPOSITORY's directory to the common Minecraft directory;
        // without changeDirectory() its ETag index stays null and every download NPEs.
        CacheRepository.setInstance(HMCLCacheRepository.REPOSITORY);
        HMCLCacheRepository.REPOSITORY.setDirectory(gameDir.resolve("cache").toString());

        GameDirectory selected = selectOrCreateGameDirectory(gameDir);
        GameDirectoryManager.setSelectedGameDirectory(selected);
        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        repository.refreshVersions();

        log("Game directory '" + selected.getPath() + "' -> repository base "
                + repository.getBaseDirectory());
        return new AgentState(gameDir, token, repository, repository.getDependency());
    }

    /**
     * Starts the JavaFX toolkit so {@code Platform.runLater} works. HMCL's event bus fires
     * {@code RefreshedVersionsEvent} on every repository refresh, and the listener registered by
     * {@code GameDirectoryManager.init()} calls {@code FXUtils.runInFX} (= Platform.runLater);
     * without the toolkit that throws "Toolkit not initialized". No windows are ever created —
     * only the toolkit's event loop thread runs.
     */
    private static void initJavaFxToolkit() throws Exception {
        log("Initializing JavaFX toolkit (Platform.startup, headless) ...");
        try {
            Platform.startup(() -> { });
            Platform.setImplicitExit(false);
            log("JavaFX toolkit initialized");
        } catch (Throwable t) {
            throw new IllegalStateException(
                    "Cannot initialize the JavaFX toolkit headless; HMCL's event bus requires "
                            + "Platform.runLater (the session likely has no windowing access): " + t, t);
        }
    }

    /**
     * Finds a registered game directory pointing at {@code gameDir} or registers a new one.
     * Absolute paths live in the per-user store, relative paths in the per-workspace store
     * (mirrors HMCL's own {@code getGameDirectoryStore}).
     */
    private static GameDirectory selectOrCreateGameDirectory(Path gameDir) {
        for (GameDirectory existing : GameDirectoryManager.getGameDirectories()) {
            try {
                Path path = existing.getPath().toPath().toAbsolutePath().normalize();
                if (path.equals(gameDir)) {
                    log("Using existing registered game directory '" + existing.getPath() + "'");
                    return existing;
                }
            } catch (RuntimeException ignored) {
                // unreadable portable path — skip
            }
        }
        GameDirectory created = new GameDirectory(
                GameDirectoryID.generate(),
                LocalizedText.plain("hmcl-mcp-agent"),
                PortablePath.fromPath(gameDir));
        if (created.getPath().isAbsolute()) {
            GameDirectoryManager.addUserGameDirectory(created);
        } else {
            GameDirectoryManager.addLocalGameDirectory(created);
        }
        log("Registered new game directory '" + created.getPath() + "'");
        return created;
    }

    private static void log(String message) {
        System.err.println("[hmcl-agent] " + message);
    }
}
