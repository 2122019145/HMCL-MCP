#!/usr/bin/env node
/**
 * Build script for the HMCL MCP javaagent.
 *
 * Steps:
 *   1. Ensure agent/lib/ contains HMCL-3.16.3.jar (kept as-is) and the JavaFX
 *      base/graphics/controls -win jars HMCL 3.16.3 requires at runtime
 *      (pure-Java, headless-safe; only downloaded when missing).
 *   2. Determine the JavaFX version. HMCL 3.16.3 is a Gradle project — the
 *      HMCLCore/pom.xml this script used to consult does NOT exist in 3.16.3,
 *      so we read the authoritative source instead: the generated
 *      openjfx-dependencies.json from the same tag
 *      (HMCL/src/main/resources/assets/openjfx-dependencies.json), taking the
 *      windows-x86_64 "classic" line (JavaFX 21.0.8 for JDK 17/21 hosts).
 *   3. Compile all agent/src Java sources with `javac --release 17` against
 *      HMCL.jar + the JavaFX jars.
 *   4. Package into agent/build/hmcl-agent.jar with agent/MANIFEST.MF
 *      (Premain-Class / Main-Class: hmcl.agent.AgentMain).
 *
 * Exit code is non-zero on any failure. Run via `node agent/build.mjs`
 * or `npm run build:agent`.
 */

import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // project root
const AGENT_DIR = join(ROOT, 'agent');
const SRC_DIR = join(AGENT_DIR, 'src');
const LIB_DIR = join(AGENT_DIR, 'lib');
const BUILD_DIR = join(AGENT_DIR, 'build');
const AGENT_JAR = join(BUILD_DIR, 'hmcl-agent.jar');

const HMCL_JAR = join(LIB_DIR, 'HMCL-3.16.3.jar');
const JAVAFX_BASE = join(LIB_DIR, 'javafx-base-21.0.8-win.jar');
const JAVAFX_GRAPHICS = join(LIB_DIR, 'javafx-graphics-21.0.8-win.jar');
// javafx-controls is required at class-init time (LauncherSettings pulls in FXUtils,
// which references javafx.scene.control.Labeled) — see agent README.
const JAVAFX_CONTROLS = join(LIB_DIR, 'javafx-controls-21.0.8-win.jar');

const MAVEN = 'https://repo1.maven.org/maven2';
const HMCL_TAG = 'v3.16.3';
const POM_URL = `https://raw.githubusercontent.com/HMCL-dev/HMCL/${HMCL_TAG}/HMCLCore/pom.xml`;
const OPENJFX_JSON_URL = `https://raw.githubusercontent.com/HMCL-dev/HMCL/${HMCL_TAG}/HMCL/src/main/resources/assets/openjfx-dependencies.json`;

const isWindows = process.platform === 'win32';
const CLASSPATH_SEP = isWindows ? ';' : ':';

function fail(message, cause) {
  console.error(`[build:agent] ERROR: ${message}`);
  if (cause) console.error(cause);
  process.exitCode = 1;
}

function log(message) {
  console.log(`[build:agent] ${message}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(dest, body);
  log(`  → ${dest} (${body.length} bytes)`);
}

/**
 * JavaFX version used by HMCL 3.16.3 for JDK-17-class hosts on Windows x86_64.
 * Primary source is the pom (as originally designed); 3.16.3 has no pom, so we
 * fall back to the tag's generated openjfx-dependencies.json (windows-x86_64,
 * "classic" line). 21.0.8 is the expected result.
 */
async function resolveJavaFxVersion() {
  // 1. Try the pom (works for future tags that reintroduce Maven).
  try {
    const response = await fetch(POM_URL, { redirect: 'follow' });
    if (response.ok) {
      const pom = await response.text();
      const direct = pom.match(/<javafx\.version>([0-9][0-9.]*)<\/javafx\.version>/);
      if (direct) return direct[1];
      const dep = pom.match(
        /<artifactId>javafx-(?:base|graphics)<\/artifactId>\s*<version>([0-9][0-9.]*)<\/version>/
      );
      if (dep) return dep[1];
      log('pom.xml exists but declares no JavaFX version — falling back to openjfx-dependencies.json');
    }
  } catch (err) {
    log(`pom.xml unavailable (${err.message}) — falling back to openjfx-dependencies.json`);
  }

  // 2. Authoritative source for 3.16.3: generated OpenJFX dependency table.
  const response = await fetch(OPENJFX_JSON_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`GET ${OPENJFX_JSON_URL} failed: HTTP ${response.status}`);
  }
  const table = await response.json();
  const platform = table['windows-x86_64'];
  if (!platform) throw new Error('openjfx-dependencies.json: windows-x86_64 platform not found');
  const classic = (platform.classic ?? []).find((m) => m.module === 'javafx.base');
  if (!classic) throw new Error('openjfx-dependencies.json: no javafx.base in windows-x86_64.classic');
  log(`JavaFX version for HMCL ${HMCL_TAG} (windows-x86_64, classic): ${classic.version}`);
  return classic.version;
}

async function ensureDependencies() {
  if (!(await exists(HMCL_JAR))) {
    fail(`HMCL jar missing: ${HMCL_JAR}`);
    throw new Error('HMCL jar missing');
  }

  if ((await exists(JAVAFX_BASE)) && (await exists(JAVAFX_GRAPHICS)) && (await exists(JAVAFX_CONTROLS))) {
    log('JavaFX jars already present, skipping download');
    return;
  }

  const version = await resolveJavaFxVersion();
  const baseUrl = `${MAVEN}/org/openjfx`;
  if (!(await exists(JAVAFX_BASE))) {
    await download(`${baseUrl}/javafx-base/${version}/javafx-base-${version}-win.jar`, JAVAFX_BASE);
  }
  if (!(await exists(JAVAFX_GRAPHICS))) {
    await download(
      `${baseUrl}/javafx-graphics/${version}/javafx-graphics-${version}-win.jar`,
      JAVAFX_GRAPHICS
    );
  }
  if (!(await exists(JAVAFX_CONTROLS))) {
    await download(
      `${baseUrl}/javafx-controls/${version}/javafx-controls-${version}-win.jar`,
      JAVAFX_CONTROLS
    );
  }
}

async function findJavaSources(dir) {
  const sources = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await findJavaSources(full)));
    } else if (entry.isFile() && entry.name.endsWith('.java')) {
      sources.push(full);
    }
  }
  return sources;
}

async function compile() {
  const sources = await findJavaSources(SRC_DIR);
  if (sources.length === 0) {
    throw new Error(`no Java sources found under ${SRC_DIR}`);
  }
  await mkdir(BUILD_DIR, { recursive: true });

  const classpath = [HMCL_JAR, JAVAFX_BASE, JAVAFX_GRAPHICS, JAVAFX_CONTROLS].join(CLASSPATH_SEP);
  const args = [
    '--release', '17',
    '-encoding', 'UTF-8',
    '-cp', classpath,
    '-d', BUILD_DIR,
    ...sources.map((src) => relative(ROOT, src)),
  ];
  log(`javac ${args.join(' ')}`);
  execFileSync('javac', args, { cwd: ROOT, stdio: 'inherit' });
  log(`Compiled ${sources.length} source file(s) into ${BUILD_DIR}`);
}

async function packageJar() {
  const manifest = join(AGENT_DIR, 'MANIFEST.MF');
  await mkdir(BUILD_DIR, { recursive: true });
  // On Windows, `jar cfm` cannot overwrite a jar that is still open (e.g. a running agent JVM
  // launched from agent/build/hmcl-agent.jar). Delete it first and fail with a clear message
  // when it is locked.
  try {
    await rm(AGENT_JAR, { force: true });
  } catch (err) {
    fail(
      `cannot replace ${AGENT_JAR}: the file is locked by another process. ` +
      'Stop any running agent JVM (POST /shutdown or kill the hmcl.agent.AgentMain process) and retry.'
    );
    throw err;
  }
  execFileSync('jar', ['cfm', AGENT_JAR, manifest, '-C', BUILD_DIR, '.'], { stdio: 'inherit' });
  const info = await stat(AGENT_JAR);
  log(`Packaged ${AGENT_JAR} (${info.size} bytes)`);
}

/**
 * Stage the JavaFX jars next to hmcl-agent.jar in agent/build/, where
 * install_hmcl (src/hmcl/tools.ts) picks them up to copy into the HMCL dir
 * for the agent JVM's runtime classpath.
 */
async function stageJavaFx() {
  for (const jar of [JAVAFX_BASE, JAVAFX_GRAPHICS, JAVAFX_CONTROLS]) {
    const target = join(BUILD_DIR, basename(jar));
    await copyFile(jar, target);
    log(`Staged ${basename(jar)} → ${target}`);
  }
}

async function main() {
  await ensureDependencies();
  await compile();
  await packageJar();
  await stageJavaFx();
  log('Build succeeded: ' + AGENT_JAR);
}

main().catch((err) => {
  fail('build failed', err);
});
