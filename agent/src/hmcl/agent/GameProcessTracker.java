package hmcl.agent;

import org.jackhuang.hmcl.launch.ProcessListener;
import org.jackhuang.hmcl.util.platform.ManagedProcess;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Tracks the single game process launched by the agent and redirects its output to a log file.
 *
 * <p>State is cleared by the {@link ProcessListener#onExit} callback, which HMCL's
 * {@code ExitWaiter} fires when the game process terminates (see DefaultLauncher.startMonitors).
 */
public final class GameProcessTracker {

    private final Object monitor = new Object();
    private ManagedProcess process;
    private long pid;
    private String instanceId;
    private Path logFile;
    private boolean running;

    /** True while a tracked game process is running. */
    public boolean isRunning() {
        synchronized (monitor) {
            return running;
        }
    }

    /** PID of the running game, or null when no game is running. */
    public Long pid() {
        synchronized (monitor) {
            return running ? pid : null;
        }
    }

    public String instanceId() {
        synchronized (monitor) {
            return running ? instanceId : null;
        }
    }

    public Path logFile() {
        synchronized (monitor) {
            return running ? logFile : null;
        }
    }

    /** Registers a freshly launched process as the tracked game. */
    public void attach(ManagedProcess process, long pid, String instanceId, Path logFile) {
        synchronized (monitor) {
            this.process = process;
            this.pid = pid;
            this.instanceId = instanceId;
            this.logFile = logFile;
            this.running = true;
        }
    }

    /**
     * Sends a stop signal to the tracked game; returns false when no game is running.
     * A daemon watchdog force-kills the process if it does not exit within 5 seconds.
     */
    public boolean stop() {
        ManagedProcess target;
        synchronized (monitor) {
            if (!running || process == null) {
                return false;
            }
            target = process;
        }
        long targetPid = pid;
        System.err.println("[hmcl-agent] Stopping game process " + targetPid + " ...");
        target.stop();
        Thread watchdog = new Thread(() -> {
            try {
                Thread.sleep(5000);
            } catch (InterruptedException ignored) {
                return;
            }
            if (target.isRunning()) {
                System.err.println("[hmcl-agent] Game did not exit within 5s; force killing " + targetPid);
                target.getProcess().destroyForcibly();
            }
        }, "hmcl-agent-stop-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        return true;
    }

    /**
     * Creates a {@link ProcessListener} that writes the game's stdout/stderr into {@code logFile}.
     * HMCL calls {@code listener.setProcess(process)} and pumps both streams into
     * {@link ProcessListener#onLog(String, boolean)} as long as a listener is present
     * (without one the game would inherit the agent's stdout/stderr instead).
     */
    public ProcessListener newListener(Path logFile) throws IOException {
        return new GameLogListener(logFile);
    }

    private final class GameLogListener implements ProcessListener {

        private final BufferedWriter writer;

        GameLogListener(Path logFile) throws IOException {
            Files.createDirectories(logFile.getParent());
            this.writer = Files.newBufferedWriter(logFile, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        }

        @Override
        public void onLog(String log, boolean isError) {
            try {
                synchronized (writer) {
                    writer.write((isError ? "[stderr] " : "[stdout] ") + log);
                    writer.newLine();
                    writer.flush();
                }
            } catch (IOException e) {
                System.err.println("[hmcl-agent] Failed to write game log: " + e);
            }
        }

        @Override
        public void onExit(int exitCode, ProcessListener.ExitType exitType) {
            synchronized (writer) {
                try {
                    writer.write("== game process exited: code=" + exitCode + " type=" + exitType + " ==");
                    writer.newLine();
                    writer.flush();
                    writer.close();
                } catch (IOException ignored) {
                    // log file may already be gone — nothing sensible to do
                }
            }
            synchronized (monitor) {
                running = false;
                process = null;
                pid = 0;
                instanceId = null;
                logFile = null;
            }
            System.err.println("[hmcl-agent] Game exited: code=" + exitCode + " type=" + exitType);
        }
    }
}
