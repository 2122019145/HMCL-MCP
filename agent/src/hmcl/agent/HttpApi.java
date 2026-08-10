package hmcl.agent;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.jackhuang.hmcl.addon.RemoteAddon;
import org.jackhuang.hmcl.addon.RemoteAddonRepository;
import org.jackhuang.hmcl.addon.repository.CurseForgeRemoteAddonRepository;
import org.jackhuang.hmcl.addon.repository.ModrinthRemoteAddonRepository;
import org.jackhuang.hmcl.auth.AuthInfo;
import org.jackhuang.hmcl.auth.AuthenticationException;
import org.jackhuang.hmcl.auth.offline.OfflineAccount;
import org.jackhuang.hmcl.auth.offline.OfflineAccountFactory;
import org.jackhuang.hmcl.download.VersionList;
import org.jackhuang.hmcl.download.DownloadProvider;
import org.jackhuang.hmcl.download.game.GameRemoteVersion;
import org.jackhuang.hmcl.game.GameJavaVersion;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.game.LaunchOptions;
import org.jackhuang.hmcl.game.Library;
import org.jackhuang.hmcl.game.ModpackHelper;
import org.jackhuang.hmcl.game.Version;
import org.jackhuang.hmcl.game.VersionNotFoundException;
import org.jackhuang.hmcl.java.JavaInfo;
import org.jackhuang.hmcl.java.JavaInfoUtils;
import org.jackhuang.hmcl.java.JavaRuntime;
import org.jackhuang.hmcl.launch.DefaultLauncher;
import org.jackhuang.hmcl.launch.ProcessListener;
import org.jackhuang.hmcl.modpack.Modpack;
import org.jackhuang.hmcl.modpack.curse.CurseManifest;
import org.jackhuang.hmcl.modpack.modrinth.ModrinthManifest;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.DownloadProviders;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.FileDownloadTask;
import org.jackhuang.hmcl.util.io.JarUtils;
import org.jackhuang.hmcl.util.platform.ManagedProcess;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Loopback HTTP JSON API (127.0.0.1 only). Every request must carry
 * {@code X-HMCL-Agent-Token: <token>}, otherwise 403 is returned.
 *
 * <p>Responses: success {@code {"ok":true, ...payload...}}, failure {@code {"ok":false, "error": "..."}}.
 * Install / launch operations run synchronously on the request thread (blocking
 * {@code Task.executor().test()}) and are serialized with {@link AgentState#stateLock};
 * see agent/README.md for the protocol.
 */
public final class HttpApi {

    static final String TOKEN_HEADER = "X-HMCL-Agent-Token";

    private static final DateTimeFormatter LOG_TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS");

    private HttpApi() {
    }

    /** Starts the loopback server. Request threads are daemon; AgentMain's keepalive thread keeps the JVM alive. */
    public static void start(AgentState state, GameProcessTracker tracker, int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        server.createContext("/", exchange -> handle(state, tracker, exchange));
        ExecutorService executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "hmcl-agent-http");
            thread.setDaemon(true);
            return thread;
        });
        server.setExecutor(executor);
        server.start();
        System.err.println("[hmcl-agent] HTTP server listening on 127.0.0.1:" + port);
    }

    // ------------------------------------------------------------------ routing

    private static void handle(AgentState state, GameProcessTracker tracker, HttpExchange exchange) {
        try {
            String provided = exchange.getRequestHeaders().getFirst(TOKEN_HEADER);
            if (!constantTimeEquals(provided, state.token)) {
                respond(exchange, 403, failJson("Invalid or missing " + TOKEN_HEADER));
                return;
            }

            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            switch (path) {
                case "/status" -> {
                    if (requirePost(exchange, method, "GET")) {
                        status(state, tracker, exchange);
                    }
                }
                case "/versions/install" -> {
                    if (requirePost(exchange, method, "POST")) {
                        installVersion(state, exchange);
                    }
                }
                case "/modpack/install" -> {
                    if (requirePost(exchange, method, "POST")) {
                        installModpack(state, exchange);
                    }
                }
                case "/modpack/search" -> {
                    if (requirePost(exchange, method, "POST")) {
                        searchModpacks(state, exchange);
                    }
                }
                case "/modpack/info" -> {
                    if (requirePost(exchange, method, "POST")) {
                        modpackInfo(state, exchange);
                    }
                }
                case "/modpack/download" -> {
                    if (requirePost(exchange, method, "POST")) {
                        downloadModpack(state, exchange);
                    }
                }
                case "/launch" -> {
                    if (requirePost(exchange, method, "POST")) {
                        launch(state, tracker, exchange);
                    }
                }
                case "/launch/stop" -> {
                    if (requirePost(exchange, method, "POST")) {
                        stopGame(tracker, exchange);
                    }
                }
                case "/shutdown" -> {
                    if (requirePost(exchange, method, "POST")) {
                        shutdown(exchange);
                    }
                }
                default -> respond(exchange, 404, failJson("Not found: " + path));
            }
        } catch (Throwable t) {
            System.err.println("[hmcl-agent] Error handling " + exchange.getRequestMethod() + " "
                    + exchange.getRequestURI() + ": " + t);
            t.printStackTrace(System.err);
            try {
                if (t instanceof IOException
                        && t.getMessage() != null
                        && t.getMessage().startsWith("Malformed JSON request body")) {
                    respond(exchange, 400, failJson(t.getMessage()));
                } else {
                    respond(exchange, 500, failJson("Internal agent error: " + message(t)));
                }
            } catch (IOException ignored) {
                // response already committed or connection dropped
            }
        } finally {
            exchange.close();
        }
    }

    private static boolean requirePost(HttpExchange exchange, String actual, String expected)
            throws IOException {
        if (actual.equals(expected)) {
            return true;
        }
        respond(exchange, 405, failJson("Method not allowed: " + actual + " (expected " + expected + ")"));
        return false;
    }

    // ------------------------------------------------------------------ routes

    private static void status(AgentState state, GameProcessTracker tracker, HttpExchange exchange)
            throws IOException {
        JsonObject out = new JsonObject();
        out.addProperty("hmclVersion", JarUtils.getAttribute("hmcl.version", "unknown"));
        out.addProperty("workdir", state.gameDir.toString());
        out.addProperty("java", System.getProperty("java.home", ""));
        // Rescan the versions dir so the list reflects disk state (versions may
        // have been installed by an earlier agent process or while we were down).
        state.repository.refreshVersions();
        JsonArray versions = new JsonArray();
        state.repository.getVersions().stream()
                .map(Version::getId)
                .sorted()
                .forEach(versions::add);
        out.add("versions", versions);
        out.addProperty("running", tracker.isRunning());
        Long pid = tracker.pid();
        if (pid != null) {
            out.addProperty("gamePid", pid);
        }
        respond(exchange, 200, okJson(out));
    }

    /** POST /versions/install {"version":"1.20.4"} — vanilla install via the repository's dependency manager. */
    private static void installVersion(AgentState state, HttpExchange exchange) throws IOException {
        JsonObject body = parseBody(exchange);
        String id = stringOrNull(body, "version");
        if (id == null || id.isBlank()) {
            respond(exchange, 200, failJson("Missing required field 'version'"));
            return;
        }
        if (!HMCLGameRepository.isValidVersionId(id)) {
            respond(exchange, 200, failJson("Invalid version id: '" + id + "'"));
            return;
        }

        state.stateLock.lock();
        try {
            if (state.repository.hasVersion(id)) {
                respond(exchange, 200, failJson("Version '" + id + "' is already installed"));
                return;
            }

            log("Refreshing remote game version list ...");
            @SuppressWarnings("unchecked")
            VersionList<GameRemoteVersion> list =
                    (VersionList<GameRemoteVersion>) DownloadProviders.getDownloadProvider().getVersionListById("game");
            runTask(list.refreshAsync(""), "Refreshing the remote version list");

            GameRemoteVersion remote = list.getVersions("").stream()
                    .filter(v -> id.equals(v.getFullVersion()))
                    .findFirst()
                    .orElse(null);
            if (remote == null) {
                respond(exchange, 200, failJson("Minecraft version '" + id
                        + "' not found in the remote version list"));
                return;
            }

            log("Installing Minecraft " + remote.getFullVersion() + " ...");
            runTask(state.dependency.gameBuilder()
                    .name(id)
                    .gameVersion(id)
                    .buildAsync(), "Installing Minecraft " + id);
            state.repository.refreshVersions();

            JsonObject out = new JsonObject();
            out.addProperty("id", id);
            respond(exchange, 200, okJson(out));
        } catch (Throwable t) {
            log("Version install failed: " + t);
            t.printStackTrace(System.err);
            respond(exchange, 200, failJson("Version install failed: " + message(t)));
        } finally {
            state.stateLock.unlock();
        }
    }

    /**
     * POST /modpack/install {"path":"D:/packs/pack.zip","name":"MyPack"}
     * Installs the pack into a new instance via ModpackHelper.getInstallTask.
     */
    private static void installModpack(AgentState state, HttpExchange exchange) throws IOException {
        JsonObject body = parseBody(exchange);
        String pathStr = stringOrNull(body, "path");
        String name = stringOrNull(body, "name");
        if (pathStr == null || pathStr.isBlank()) {
            respond(exchange, 200, failJson("Missing required field 'path'"));
            return;
        }
        Path zip = Path.of(pathStr).toAbsolutePath().normalize();
        if (!Files.isRegularFile(zip)) {
            respond(exchange, 200, failJson("Modpack file not found: " + zip));
            return;
        }

        Modpack modpack = readModpackManifest(zip);
        if (modpack == null) {
            respond(exchange, 200, failJson("Unsupported or unreadable modpack file: " + zip
                    + " (expected a .zip in mrpack/curseforge/multimc/mcbbs/hmcl format)"));
            return;
        }
        String instanceName = (name == null || name.isBlank()) ? modpack.getName() : name;
        if (instanceName == null || instanceName.isBlank()) {
            respond(exchange, 200, failJson("Modpack has no name; pass 'name' explicitly"));
            return;
        }
        if (!HMCLGameRepository.isValidVersionId(instanceName)) {
            respond(exchange, 200, failJson("Invalid instance name: '" + instanceName + "'"));
            return;
        }

        state.stateLock.lock();
        try {
            if (state.repository.versionIdConflicts(instanceName)) {
                respond(exchange, 200, failJson("An instance named '" + instanceName + "' already exists"));
                return;
            }

            log("Installing modpack '" + instanceName + "' from " + zip + " ...");
            runTask(ModpackHelper.getInstallTask(state.repository, zip, instanceName, modpack, ""),
                    "Installing modpack " + instanceName);
            state.repository.refreshVersions();
            log("Modpack installed: " + instanceName);

            JsonObject out = new JsonObject();
            out.addProperty("name", instanceName);
            out.addProperty("format", formatOf(modpack));
            String gameVersion = modpack.getGameVersion();
            if (gameVersion != null && !gameVersion.isBlank()) {
                out.addProperty("gameVersion", gameVersion);
            }
            String loader = detectLoaderQuietly(state.repository, instanceName);
            if (loader != null) {
                out.addProperty("modLoader", loader);
            }
            respond(exchange, 200, okJson(out));
        } catch (Throwable t) {
            log("Modpack install failed: " + t);
            t.printStackTrace(System.err);
            respond(exchange, 200, failJson("Modpack install failed: " + message(t)));
        } finally {
            state.stateLock.unlock();
        }
    }

    /**
     * POST /launch {"version":"1.20.4","username":"Steve","maxMemory":4096,"javaPath":"...","extraArgs":[...]}
     * Pre-launch completion check, offline login, then DefaultLauncher.launch().
     */
    // ------------------------------------------------------------------ modpack search/download (HMCL-native repositories)

    /** HMCL's own modpack repositories: Modrinth (no key) and CurseForge (HMCL's embedded API key). */
    private static RemoteAddonRepository repoFor(String source) {
        return switch (source == null ? "modrinth" : source) {
            case "curseforge" -> CurseForgeRemoteAddonRepository.MODPACKS;
            default -> ModrinthRemoteAddonRepository.MODPACKS;
        };
    }

    private static JsonObject addonJson(RemoteAddon addon) {
        JsonObject out = new JsonObject();
        out.addProperty("id", addon.slug());
        out.addProperty("title", addon.title());
        out.addProperty("description", addon.description());
        JsonArray authors = new JsonArray();
        if (addon.author() != null) {
            authors.add(addon.author());
        }
        out.add("authors", authors);
        out.add("versions", new JsonArray());
        if (addon.pageUrl() != null) {
            out.addProperty("url", addon.pageUrl());
        }
        return out;
    }

    /** POST /modpack/search {"source":"modrinth|curseforge","query":"...","limit":N} */
    private static void searchModpacks(AgentState state, HttpExchange exchange) throws IOException {
        JsonObject body = parseBody(exchange);
        String query = stringOrNull(body, "query");
        if (query == null || query.isBlank()) {
            respond(exchange, 200, failJson("Missing required field 'query'"));
            return;
        }
        int limit = 20;
        if (body.has("limit")) {
            limit = Math.max(1, Math.min(50, body.get("limit").getAsInt()));
        }
        try {
            RemoteAddonRepository repo = repoFor(stringOrNull(body, "source"));
            DownloadProvider provider = DownloadProviders.getDownloadProvider();
            // NOTE: HMCL's signature is search(provider, gameVersion, category, offset, pageSize, searchFilter, ...)
            // — the query goes LAST-ish, gameVersion must be non-null ("" = all versions).
            RemoteAddonRepository.SearchResult result = repo.search(provider, "", null, 0, limit, query,
                    RemoteAddonRepository.SortType.POPULARITY, RemoteAddonRepository.SortOrder.DESC);
            JsonObject out = new JsonObject();
            JsonArray hits = new JsonArray();
            result.getResults().forEach(addon -> hits.add(addonJson(addon)));
            out.add("hits", hits);
            out.addProperty("totalPages", result.getTotalPages());
            respond(exchange, 200, okJson(out));
        } catch (Exception e) {
            respond(exchange, 200, failJson("Modpack search failed: " + message(e)));
        }
    }

    /** POST /modpack/info {"source":...,"id":"slug"} → project summary + version list. */
    private static void modpackInfo(AgentState state, HttpExchange exchange) throws IOException {
        JsonObject body = parseBody(exchange);
        String id = stringOrNull(body, "id");
        if (id == null || id.isBlank()) {
            respond(exchange, 200, failJson("Missing required field 'id'"));
            return;
        }
        try {
            RemoteAddonRepository repo = repoFor(stringOrNull(body, "source"));
            DownloadProvider provider = DownloadProviders.getDownloadProvider();
            RemoteAddon addon = repo.getModById(provider, id);
            JsonObject out = new JsonObject();
            out.add("summary", addonJson(addon));
            JsonArray versions = new JsonArray();
            repo.getRemoteVersionsById(provider, id).limit(50).forEach(v -> {
                JsonObject vo = new JsonObject();
                vo.addProperty("id", v.name());
                vo.addProperty("version", v.version());
                JsonArray gv = new JsonArray();
                v.gameVersions().forEach(gv::add);
                vo.add("gameVersions", gv);
                JsonArray loaders = new JsonArray();
                v.loaders().forEach(l -> loaders.add(l.toString()));
                vo.add("loaders", loaders);
                versions.add(vo);
            });
            out.add("versions", versions);
            respond(exchange, 200, okJson(out));
        } catch (Exception e) {
            respond(exchange, 200, failJson("Modpack info failed: " + message(e)));
        }
    }

    /** POST /modpack/download {"source":...,"id":"slug","versionId"?} → HMCL downloads the pack file (sha1-verified) into <workdir>/mcpacks/. */
    private static void downloadModpack(AgentState state, HttpExchange exchange) throws IOException {
        JsonObject body = parseBody(exchange);
        String id = stringOrNull(body, "id");
        if (id == null || id.isBlank()) {
            respond(exchange, 200, failJson("Missing required field 'id'"));
            return;
        }
        String wantedVersion = stringOrNull(body, "versionId");
        try {
            RemoteAddonRepository repo = repoFor(stringOrNull(body, "source"));
            DownloadProvider provider = DownloadProviders.getDownloadProvider();
            RemoteAddon.Version version = null;
            for (RemoteAddon.Version v : repo.getRemoteVersionsById(provider, id).limit(200).toList()) {
                if (wantedVersion == null || wantedVersion.isBlank()
                        || wantedVersion.equals(v.name()) || wantedVersion.equals(v.version())) {
                    version = v;
                    break;
                }
            }
            if (version == null) {
                respond(exchange, 200, failJson("No downloadable version found for '" + id + "'"
                        + (wantedVersion != null ? " (version '" + wantedVersion + "')" : "")));
                return;
            }
            RemoteAddon.File file = version.file();
            if (file == null || file.url() == null || file.url().isBlank()) {
                respond(exchange, 200, failJson("Version '" + version.name() + "' has no downloadable file"));
                return;
            }
            Path dir = state.gameDir.resolve("mcpacks");
            Files.createDirectories(dir);
            String filename = (file.filename() != null && !file.filename().isBlank())
                    ? file.filename().replaceAll("[\\\\/:*?\"<>|]", "_")
                    : version.name() + ".zip";
            Path target = dir.resolve(filename);
            log("Downloading modpack '" + id + "' version '" + version.name() + "' -> " + target);
            state.stateLock.lock();
            try {
                runTask(new FileDownloadTask(file.url(), target, file.getIntegrityCheck()),
                        "Downloading modpack " + id);
            } finally {
                state.stateLock.unlock();
            }
            JsonObject out = new JsonObject();
            out.addProperty("id", version.name());
            out.addProperty("version", version.version());
            JsonArray gv = new JsonArray();
            version.gameVersions().forEach(gv::add);
            out.add("gameVersions", gv);
            out.addProperty("filename", target.getFileName().toString());
            out.addProperty("path", target.toString());
            out.addProperty("size", Files.size(target));
            if (file.hashes() != null && file.hashes().get("sha1") != null) {
                out.addProperty("sha1", file.hashes().get("sha1"));
            }
            respond(exchange, 200, okJson(out));
        } catch (Exception e) {
            respond(exchange, 200, failJson("Modpack download failed: " + message(e)));
        }
    }

    private static void launch(AgentState state, GameProcessTracker tracker, HttpExchange exchange)
            throws IOException {
        JsonObject body = parseBody(exchange);
        String versionId = stringOrNull(body, "version");
        if (versionId == null || versionId.isBlank()) {
            versionId = GameDirectoryManager.getSelectedInstance();
        }
        if (versionId == null || versionId.isBlank()) {
            respond(exchange, 200, failJson("Missing 'version' and no selected instance; pass 'version'"));
            return;
        }
        String username = stringOrNull(body, "username");
        if (username == null || username.isBlank()) {
            username = "Steve";
        }
        Integer maxMemory = intOrNull(body, "maxMemory");
        String javaPath = stringOrNull(body, "javaPath");
        List<String> extraArgs = stringArrayOrNull(body, "extraArgs");

        state.stateLock.lock();
        try {
            if (tracker.isRunning()) {
                respond(exchange, 200, failJson("A game is already running (pid " + tracker.pid()
                        + "); stop it first via /launch/stop"));
                return;
            }

            Version version;
            try {
                // Rescan first: the instance may have been installed after this JVM started.
                state.repository.refreshVersions();
                version = state.repository.getResolvedVersion(versionId);
            } catch (VersionNotFoundException e) {
                List<String> installed = state.repository.getVersions().stream()
                        .map(Version::getId).sorted().toList();
                respond(exchange, 200, failJson("Version '" + versionId + "' is not installed. Installed: "
                        + (installed.isEmpty() ? "(none)" : String.join(", ", installed))));
                return;
            }

            JavaRuntime java = resolveJavaRuntime(javaPath);
            log("Launching '" + version.getId() + "' with Java " + java.getBinary());

            // Preflight: fail with an actionable message when the resolved Java is older
            // than the version's requirement (HMCL otherwise emits a cryptic JVM error,
            // e.g. "Unrecognized option: --sun-misc-unsafe-memory-access=allow" for Java 24/25 versions).
            GameJavaVersion required = version.getJavaVersion();
            if (required != null && required.majorVersion() > 0 && java.getParsedVersion() < required.majorVersion()) {
                respond(exchange, 200, failJson("Instance '" + versionId + "' requires Java "
                        + required.majorVersion() + "+ but the resolved Java is " + java.getParsedVersion()
                        + " (" + java.getBinary() + "). Install a matching JDK or pass javaPath."));
                return;
            }

            // Same pre-launch check the HMCL UI runs: downloads missing libraries/assets.
            log("Checking game completion (libraries/assets) ...");
            runTask(state.dependency.checkGameCompletionAsync(version, false), "Game completion check");

            OfflineAccount account = Accounts.FACTORY_OFFLINE.create(
                    username, OfflineAccountFactory.getUUIDFromUserName(username));
            AuthInfo authInfo;
            try {
                authInfo = account.logIn();
            } catch (AuthenticationException e) {
                respond(exchange, 200, failJson("Offline login failed: " + message(e)));
                return;
            }

            LaunchOptions.Builder builder = state.repository.getLaunchOptions(
                    version.getId(),
                    java,
                    state.repository.getBaseDirectory(),
                    List.of(),
                    extraArgs == null ? List.of() : extraArgs,
                    false);
            if (maxMemory != null && maxMemory > 0) {
                builder.setMaxMemory(maxMemory);
            }
            LaunchOptions options = builder.create();

            Path logFile = state.gameDir.resolve("logs")
                    .resolve(version.getId() + "-" + LOG_TIMESTAMP.format(LocalDateTime.now()) + ".log");
            Files.createDirectories(logFile.getParent());
            ProcessListener listener = tracker.newListener(logFile);

            ManagedProcess process = new DefaultLauncher(
                    state.repository, version, authInfo, options, listener, true).launch();
            long pid = process.getProcess().pid();
            tracker.attach(process, pid, version.getId(), logFile);
            log("Game launched: pid=" + pid + " instance=" + version.getId() + " log=" + logFile);

            JsonObject out = new JsonObject();
            out.addProperty("pid", pid);
            out.addProperty("instanceId", version.getId());
            out.addProperty("gameVersion", state.repository.getGameVersion(version).orElse(version.getId()));
            String loader = detectLoader(version);
            if (loader != null) {
                out.addProperty("loader", loader);
            }
            out.addProperty("java", java.getBinary().toString());
            out.addProperty("logPath", logFile.toString());
            respond(exchange, 200, okJson(out));
        } catch (Throwable t) {
            log("Launch failed: " + t);
            t.printStackTrace(System.err);
            respond(exchange, 200, failJson("Launch failed: " + message(t)));
        } finally {
            state.stateLock.unlock();
        }
    }

    private static void stopGame(GameProcessTracker tracker, HttpExchange exchange) throws IOException {
        boolean stopped = tracker.stop();
        JsonObject out = new JsonObject();
        out.addProperty("message", stopped
                ? "Stop signal sent to the game process"
                : "No game is currently running");
        respond(exchange, 200, okJson(out));
    }

    /** Replies first, then exits the JVM after ~200ms so the response flushes. */
    private static void shutdown(HttpExchange exchange) throws IOException {
        JsonObject out = new JsonObject();
        out.addProperty("message", "Shutting down");
        respond(exchange, 200, okJson(out));
        Thread timer = new Thread(() -> {
            try {
                Thread.sleep(200);
            } catch (InterruptedException ignored) {
                // exit anyway
            }
            System.err.println("[hmcl-agent] Shutdown requested via HTTP; exiting");
            System.exit(0);
        }, "hmcl-agent-shutdown-timer");
        timer.setDaemon(true);
        timer.start();
    }

    // ------------------------------------------------------------------ helpers

    /**
     * Runs an HMCL task to completion on the caller's thread and throws when it fails.
     *
     * <p>Deliberately NOT {@code Task.run()}: HMCL's task graph (e.g.
     * {@code MultipleSourceVersionList}, {@code whenComplete} actions) relies on
     * {@code isDependentsSucceeded()}/{@code getException()}, which only the
     * {@code AsyncTaskExecutor} machinery maintains — {@code run()} never sets them.
     * {@code executor().test()} starts the graph on the shared pool and blocks until done;
     * failures surface via the root task's {@code getException()}.
     */
    private static void runTask(Task<?> task, String what) throws IOException {
        boolean success = task.executor().test();
        if (!success) {
            Exception failure = task.getException();
            throw new IOException(what + " failed"
                    + (failure != null ? ": " + message(failure) : ""));
        }
    }

    private static JavaRuntime resolveJavaRuntime(String javaPath) throws IOException {
        if (javaPath == null || javaPath.isBlank()) {
            JavaRuntime runtime = JavaRuntime.getDefault();
            if (runtime == null) {
                throw new IOException("No default Java runtime available (java.home has no java executable)");
            }
            return runtime;
        }
        Path binary = Path.of(javaPath).toAbsolutePath().normalize();
        if (!Files.isRegularFile(binary)) {
            throw new IOException("Java binary not found: " + binary);
        }
        // Same probe HMCL's JavaManager uses (runs "<java> -classpath <hmcl.jar> org.glavo.info.Main").
        JavaInfo info = JavaInfoUtils.fromExecutable(binary);
        return JavaRuntime.of(binary, info, false);
    }

    /**
     * Reads the modpack manifest, trying UTF-8 first and GBK as a fallback (Chinese packs are
     * often GBK-encoded). Returns null when the file is not a readable modpack.
     */
    private static Modpack readModpackManifest(Path zip) {
        try {
            return ModpackHelper.readModpackManifest(zip, StandardCharsets.UTF_8);
        } catch (Throwable e1) {
            try {
                return ModpackHelper.readModpackManifest(zip, Charset.forName("GBK"));
            } catch (Throwable e2) {
                log("readModpackManifest failed: " + e1 + " / " + e2);
                return null;
            }
        }
    }

    private static String formatOf(Modpack modpack) {
        Object manifest = modpack.getManifest();
        if (manifest instanceof ModrinthManifest) {
            return "mrpack";
        }
        if (manifest instanceof CurseManifest) {
            return "curseforge";
        }
        // MultiMC, MCBBS, HMCL and server packs map to HMCL's own instance format.
        return "hmcl";
    }

    private static String detectLoaderQuietly(HMCLGameRepository repository, String id) {
        try {
            return detectLoader(repository.getResolvedVersion(id));
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Heuristic loader detection by scanning the resolved version's libraries for known loader
     * artifacts. Mirrors what LibraryAnalyzer reports for the common cases.
     */
    private static String detectLoader(Version version) {
        for (Library library : version.getLibraries()) {
            String name = library.getName();
            if (name == null) {
                continue;
            }
            if (name.startsWith("net.fabricmc:fabric-loader:")) {
                return "fabric";
            }
            if (name.startsWith("org.quiltmc:quilt-loader:")) {
                return "quilt";
            }
            if (name.startsWith("net.neoforged:neoforge:")) {
                return "neoforge";
            }
            if (name.startsWith("net.minecraftforge:forge:")) {
                return "forge";
            }
            if (name.startsWith("com.mumfrey:liteloader:")) {
                return "liteloader";
            }
            if (name.startsWith("optifine:OptiFine:")) {
                return "optifine";
            }
        }
        return null;
    }

    private static JsonObject parseBody(HttpExchange exchange) throws IOException {
        byte[] bytes = exchange.getRequestBody().readAllBytes();
        if (bytes.length == 0) {
            return new JsonObject();
        }
        // Strict parsing: Gson's JsonParser is lenient by default (unquoted strings, stray
        // tokens) which would silently turn malformed bodies into empty objects.
        try (JsonReader reader = new JsonReader(
                new InputStreamReader(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8))) {
            reader.setStrictness(Strictness.STRICT);
            JsonElement element = JsonParser.parseReader(reader);
            if (element.isJsonObject()) {
                return element.getAsJsonObject();
            }
            throw new IOException("Malformed JSON request body: expected a JSON object");
        } catch (JsonParseException e) {
            throw new IOException("Malformed JSON request body: " + e.getMessage());
        }
    }

    private static String stringOrNull(JsonObject obj, String key) {
        if (!obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        JsonElement element = obj.get(key);
        if (!element.isJsonPrimitive()) {
            return null;
        }
        JsonPrimitive primitive = element.getAsJsonPrimitive();
        return primitive.getAsString();
    }

    private static Integer intOrNull(JsonObject obj, String key) {
        if (!obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(key).getAsInt();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static List<String> stringArrayOrNull(JsonObject obj, String key) {
        if (!obj.has(key) || !obj.get(key).isJsonArray()) {
            return null;
        }
        List<String> result = new ArrayList<>();
        for (JsonElement element : obj.getAsJsonArray(key)) {
            if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()) {
                result.add(element.getAsString());
            }
        }
        return result;
    }

    private static String okJson(JsonObject payload) {
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        if (payload != null && !payload.isEmpty()) {
            for (String key : payload.keySet()) {
                out.add(key, payload.get(key));
            }
        }
        return out.toString();
    }

    private static String failJson(String error) {
        JsonObject out = new JsonObject();
        out.addProperty("ok", false);
        out.addProperty("error", error);
        return out.toString();
    }

    private static void respond(HttpExchange exchange, int code, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private static String message(Throwable t) {
        String msg = t.getMessage();
        return (msg == null || msg.isBlank()) ? t.toString() : msg;
    }

    private static void log(String message) {
        System.err.println("[hmcl-agent] " + message);
    }
}
