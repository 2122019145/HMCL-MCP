package hmcl.agent;

import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.locks.LockSupport;

/**
 * Entry point of the HMCL MCP javaagent.
 *
 * <p>Two entry modes (see agent/README.md):
 * <ul>
 *   <li>{@code main} — the supported path. The JVM is spawned as
 *       {@code java -javaagent:hmcl-agent.jar -cp HMCL-3.16.3.jar;hmcl-agent.jar hmcl.agent.AgentMain}
 *       (Main-Class in the agent manifest). HMCL's own JavaFX {@code Main} is never started.</li>
 *   <li>{@code premain} — deliberately minimal. When the agent is instrumented into an existing
 *       HMCL JVM, HMCL's UI bootstrapping would fight with the agent's own init, so premain only
 *       logs and does nothing else.</li>
 * </ul>
 */
public final class AgentMain {

    private AgentMain() {
    }

    /** Minimal premain: attach only, all real work happens in main(). */
    public static void premain(String agentArgs, Instrumentation inst) {
        System.err.println("[hmcl-agent] premain: HMCL MCP agent instrumented into JVM " + Runtime.version()
                + " (agent version " + agentVersion() + ")");
    }

    /**
     * Starts the headless HMCL core and the loopback HTTP JSON API.
     *
     * <p>System properties:
     * <ul>
     *   <li>{@code -Dhmcl.agent.port} — HTTP port (default 28501, loopback only)</li>
     *   <li>{@code -Dhmcl.agent.token} — bearer token for {@code X-HMCL-Agent-Token} (default "hmcl-mcp")</li>
     *   <li>{@code -Dhmcl.gameDir} — game directory holding versions/libraries/assets (default: JVM cwd)</li>
     *   <li>{@code -Dhmcl.home} / {@code -Dhmcl.dir} — HMCL user/workspace data dirs (passed by the
     *       caller; must be set before the JVM starts so Metadata picks them up)</li>
     * </ul>
     */
    public static void main(String[] args) {
        System.err.println("[hmcl-agent] HMCL MCP agent starting (agent version " + agentVersion() + ", JVM "
                + Runtime.version() + ")");
        try {
            int port = Integer.parseInt(System.getProperty("hmcl.agent.port", "28501"));
            String token = System.getProperty("hmcl.agent.token", "hmcl-mcp");
            Path gameDir = Path.of(System.getProperty("hmcl.gameDir", System.getProperty("user.dir", ".")))
                    .toAbsolutePath().normalize();
            Files.createDirectories(gameDir);

            AgentState state = AgentState.init(gameDir, token);
            GameProcessTracker tracker = new GameProcessTracker();

            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                tracker.stop();
                System.err.println("[hmcl-agent] JVM shutting down");
            }, "hmcl-agent-shutdown-hook"));

            HttpApi.start(state, tracker, port);
            System.err.println("[hmcl-agent] agent ready: http://127.0.0.1:" + port
                    + " (gameDir=" + gameDir + ", token=" + (token.isEmpty() ? "<empty>" : "<set>") + ")");
            keepJvmAlive();
        } catch (Throwable t) {
            System.err.println("[hmcl-agent] FATAL startup failure: " + t);
            t.printStackTrace(System.err);
            System.exit(1);
        }
    }

    /**
     * The HTTP server's request threads are daemon; without a non-daemon thread the JVM would exit
     * as soon as main() returns. This parked thread keeps the process alive until /shutdown.
     */
    private static void keepJvmAlive() {
        Thread keepAlive = new Thread(() -> LockSupport.park(), "hmcl-agent-keepalive");
        keepAlive.setDaemon(false);
        keepAlive.start();
    }

    /** Implementation-Version from the agent jar's own manifest. */
    private static String agentVersion() {
        Package pkg = AgentMain.class.getPackage();
        return (pkg != null && pkg.getImplementationVersion() != null)
                ? pkg.getImplementationVersion()
                : "dev";
    }
}
