/**
 * Unit tests for src/hmcl/tools.ts — local filesystem scans (scanVersions /
 * scanModpacks via the list_versions / list_modpacks handlers) and
 * java -version parsing (parseJavaVersion). Fixture dirs are built under a
 * temp workdir; no network (probeAgent hits an unused loopback port).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Ctx, ToolDef } from '../../src/types.ts';
import { createHmclTools, parseJavaVersion } from '../../src/hmcl/tools.ts';

let workdir: string;
let tools: ToolDef[];
let ctx: Ctx;

async function write(dir: string, name: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content);
}

before(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmcl-mcp-tools-test-'));
  const versions = path.join(workdir, 'versions');

  // 1) plain vanilla instance: <id>/<id>.json + <id>.jar → hasJar true
  await write(path.join(versions, '1.20.4'), '1.20.4.json', JSON.stringify({ id: '1.20.4' }));
  await write(path.join(versions, '1.20.4'), '1.20.4.jar', 'fake jar');

  // 2) empty dir → not a version (no <id>/<id>.json)
  await fs.mkdir(path.join(versions, 'empty-dir'), { recursive: true });

  // 3) Modrinth modpack instance
  await write(path.join(versions, 'pack1'), 'pack1.json', JSON.stringify({ id: 'pack1' }));
  await write(
    path.join(versions, 'pack1'),
    'modpack.json',
    JSON.stringify({
      type: 'Modrinth',
      manifest: { dependencies: { minecraft: '1.20.1', forge: '47.1.0' } },
    }),
  );

  // 4) CurseForge modpack instance
  await write(path.join(versions, 'pack2'), 'pack2.json', JSON.stringify({ id: 'pack2' }));
  await write(
    path.join(versions, 'pack2'),
    'modpack.json',
    JSON.stringify({
      type: 'CurseForge',
      manifest: {
        minecraft: { version: '1.19.2', modLoaders: [{ id: 'forge-43.2.0', primary: true }] },
      },
    }),
  );

  // 5) HMCL modpack instance
  await write(path.join(versions, 'pack3'), 'pack3.json', JSON.stringify({ id: 'pack3' }));
  await write(
    path.join(versions, 'pack3'),
    'modpack.json',
    JSON.stringify({ type: 'HMCL', manifest: { gameVersion: '1.21' } }),
  );

  // 6) unreadable modpack.json → skipped by list_modpacks (still a version)
  await write(path.join(versions, 'badmod'), 'badmod.json', JSON.stringify({ id: 'badmod' }));
  await write(path.join(versions, 'badmod'), 'modpack.json', 'not-json{{{');

  // 7) unsupported modpack type → skipped by list_modpacks (still a version)
  await write(path.join(versions, 'notype'), 'notype.json', JSON.stringify({ id: 'notype' }));
  await write(path.join(versions, 'notype'), 'modpack.json', JSON.stringify({ type: 'Foo' }));

  ctx = {
    workdir,
    hmclDir: path.join(workdir, 'hmcl'),
    javaPath: null,
    curseforgeApiKey: null,
    agentPort: 49152, // unused loopback port — probeAgent fails fast, no network
    agentToken: 'test-token',
    log: () => {},
  };
  tools = createHmclTools(ctx);
});

after(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

function handler(name: string): ToolDef['handler'] {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} not registered`);
  return tool.handler;
}

describe('list_versions (scanVersions)', () => {
  it('lists only dirs containing <id>/<id>.json, with hasJar from <id>.jar, sorted by id', async () => {
    const res = await handler('list_versions')({});
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const versions = res.data as Array<{ id: string; path: string; hasJar: boolean }>;

    assert.deepEqual(
      versions.map((v) => v.id),
      ['1.20.4', 'badmod', 'notype', 'pack1', 'pack2', 'pack3'], // empty-dir skipped
    );
    for (const v of versions) {
      assert.equal(v.path, path.join(workdir, 'versions', v.id));
    }
    const byId = new Map(versions.map((v) => [v.id, v]));
    assert.equal(byId.get('1.20.4')?.hasJar, true); // jar present
    assert.equal(byId.get('pack1')?.hasJar, false); // no pack1.jar
    assert.equal(byId.get('badmod')?.hasJar, false);
  });

  it('returns [] when the versions dir does not exist', async () => {
    const emptyCtx: Ctx = { ...ctx, workdir: path.join(workdir, 'no-such-workdir') };
    const emptyTools = createHmclTools(emptyCtx);
    const res = await emptyTools.find((t) => t.name === 'list_versions')!.handler({});
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.data, []);
  });
});

describe('list_modpacks (scanModpacks)', () => {
  it('maps Modrinth/CurseForge/HMCL types with best-effort manifest fields, sorted by name', async () => {
    const res = await handler('list_modpacks')({});
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const packs = res.data as Array<{
      name: string;
      path: string;
      format: string;
      gameVersion?: string;
      modLoader?: string;
    }>;

    assert.deepEqual(
      packs.map((p) => p.name),
      ['pack1', 'pack2', 'pack3'], // badmod (bad json) and notype (unsupported) skipped
    );

    // Modrinth: dependencies.minecraft → gameVersion; forge dep → modLoader
    assert.equal(packs[0].format, 'mrpack');
    assert.equal(packs[0].gameVersion, '1.20.1');
    assert.equal(packs[0].modLoader, 'forge');
    assert.equal(packs[0].path, path.join(workdir, 'versions', 'pack1'));

    // CurseForge: minecraft.version + modLoaders[0].id 'forge-43.2.0' → forge
    assert.equal(packs[1].format, 'curseforge');
    assert.equal(packs[1].gameVersion, '1.19.2');
    assert.equal(packs[1].modLoader, 'forge');

    // HMCL: manifest.gameVersion; no modLoader
    assert.equal(packs[2].format, 'hmcl');
    assert.equal(packs[2].gameVersion, '1.21');
    assert.equal(packs[2].modLoader, undefined);
  });

  it('returns [] when the versions dir does not exist', async () => {
    const emptyCtx: Ctx = { ...ctx, workdir: path.join(workdir, 'no-such-workdir') };
    const emptyTools = createHmclTools(emptyCtx);
    const res = await emptyTools.find((t) => t.name === 'list_modpacks')!.handler({});
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.data, []);
  });
});

describe('parseJavaVersion', () => {
  it('parses openjdk 21 stderr output', () => {
    assert.equal(parseJavaVersion('openjdk version "21.0.10" 2026-01-20 LTS'), '21.0.10');
  });

  it('parses java 8 output', () => {
    assert.equal(parseJavaVersion('java version "1.8.0_292"\nJava(TM) SE Runtime Environment ...'), '1.8.0_292');
  });

  it('ignores warning lines before the version line', () => {
    const text = [
      'Picked up JAVA_TOOL_OPTIONS: -Dfoo=bar',
      'openjdk version "17.0.9" 2023-10-24',
      'OpenJDK 64-Bit Server VM (build 17.0.9+9, mixed mode, sharing)',
    ].join('\n');
    assert.equal(parseJavaVersion(text), '17.0.9');
  });

  it('parses a version line on stdout', () => {
    assert.equal(parseJavaVersion('openjdk version "25.0.1" 2026-04-15\n'), '25.0.1');
  });

  it('handles CRLF line endings', () => {
    assert.equal(parseJavaVersion('openjdk version "21.0.10" 2026-01-20 LTS\r\n'), '21.0.10');
  });

  it('falls back to the first line when no version string matches', () => {
    const text = 'OpenJDK 64-Bit Server VM warning: ignoring option Foo\n';
    assert.equal(parseJavaVersion(text), 'OpenJDK 64-Bit Server VM warning: ignoring option Foo');
  });

  it('returns unknown for empty output', () => {
    assert.equal(parseJavaVersion(''), 'unknown');
  });
});

describe('check_environment wiring', () => {
  it('reports java through a real spawn of the JDK, plus version/modpack counts and agent probe', async (t) => {
    // detectJava runs `java -version`; needs a real JVM on PATH. Skip (not fail)
    // on machines without one — the project itself requires a JDK to build.
    const probe = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 15_000 });
    if (probe.error || typeof probe.status !== 'number' || probe.status !== 0) {
      t.skip('no usable java on PATH');
      return;
    }

    const probeCtx: Ctx = { ...ctx, javaPath: 'java' };
    const probeTools = createHmclTools(probeCtx);
    const res = await probeTools.find((t) => t.name === 'check_environment')!.handler({});
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const env = res.data as {
      java: { path: string; version: string } | null;
      versionsCount: number;
      modpacksCount: number;
      agentRunning: boolean;
    };
    // Real `java -version` → parseJavaVersion extracts e.g. "21.0.10" from
    // `openjdk version "21.0.10" 2026-01-20 LTS` on stderr.
    assert.equal(env.java?.path, 'java');
    assert.match(env.java?.version ?? '', /^\d+\.\d+\.\d+/);
    assert.equal(env.versionsCount, 6);
    assert.equal(env.modpacksCount, 3);
    assert.equal(env.agentRunning, false); // nothing listens on the probe port
  });
});
