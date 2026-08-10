/**
 * Unit tests for src/config.ts — env parsing of the runtime Ctx.
 * Pure logic, no network. `resolveCtx(env)` is injectable, so nothing touches
 * process.env here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { resolveCtx } from '../../src/config.ts';

const home = os.homedir();

describe('resolveCtx defaults', () => {
  it('expands the default workdir ~/.hmcl-mcp against the OS home', () => {
    const ctx = resolveCtx({});
    assert.equal(ctx.workdir, path.resolve(home, '.hmcl-mcp'));
  });

  it('defaults hmclDir to <workdir>/hmcl', () => {
    const ctx = resolveCtx({});
    assert.equal(ctx.hmclDir, path.join(ctx.workdir, 'hmcl'));
    assert.equal(ctx.hmclDir, path.resolve(home, '.hmcl-mcp', 'hmcl'));
  });

  it('defaults agentPort to 28501 and token to hmcl-mcp', () => {
    const ctx = resolveCtx({});
    assert.equal(ctx.agentPort, 28501);
    assert.equal(ctx.agentToken, 'hmcl-mcp');
  });

  it('defaults javaPath and curseforgeApiKey to null', () => {
    const ctx = resolveCtx({});
    assert.equal(ctx.javaPath, null);
    assert.equal(ctx.curseforgeApiKey, null);
  });
});

describe('resolveCtx overrides', () => {
  it('honors an absolute HMCL_MCP_WORKDIR', () => {
    const ctx = resolveCtx({ HMCL_MCP_WORKDIR: 'D:/game/root' });
    assert.equal(ctx.workdir, path.resolve('D:/game/root'));
    // hmclDir still derives from the overridden workdir unless set explicitly
    assert.equal(ctx.hmclDir, path.join(ctx.workdir, 'hmcl'));
  });

  it('resolves a relative HMCL_MCP_WORKDIR against the cwd', () => {
    const ctx = resolveCtx({ HMCL_MCP_WORKDIR: 'relative/dir' });
    assert.equal(ctx.workdir, path.resolve('relative/dir'));
  });

  it('expands a bare ~ to the home dir', () => {
    const ctx = resolveCtx({ HMCL_MCP_WORKDIR: '~' });
    assert.equal(ctx.workdir, home);
  });

  it('expands ~/ prefixes in HMCL_MCP_WORKDIR', () => {
    const ctx = resolveCtx({ HMCL_MCP_WORKDIR: '~/mc' });
    assert.equal(ctx.workdir, path.join(home, 'mc'));
  });

  it('honors an independent HMCL_MCP_HMCL_DIR (including ~ expansion)', () => {
    const ctx = resolveCtx({ HMCL_MCP_HMCL_DIR: '~/hmcl-install' });
    assert.equal(ctx.hmclDir, path.join(home, 'hmcl-install'));
    assert.notEqual(ctx.hmclDir, path.join(ctx.workdir, 'hmcl'));
  });

  it('trims whitespace from all env values', () => {
    const ctx = resolveCtx({
      HMCL_MCP_WORKDIR: '  /tmp/ws/workdir  ',
      HMCL_MCP_JAVA: '  /opt/jdk21/bin/java  ',
      HMCL_MCP_CURSEFORGE_API_KEY: '  abc-123  ',
      HMCL_MCP_AGENT_TOKEN: '  tok-42  ',
    });
    assert.equal(ctx.workdir, path.resolve('/tmp/ws/workdir'));
    assert.equal(ctx.javaPath, '/opt/jdk21/bin/java');
    assert.equal(ctx.curseforgeApiKey, 'abc-123');
    assert.equal(ctx.agentToken, 'tok-42');
  });

  it('parses HMCL_MCP_AGENT_PORT as a number', () => {
    const ctx = resolveCtx({ HMCL_MCP_AGENT_PORT: '39001' });
    assert.equal(ctx.agentPort, 39001);
  });

  it('treats an empty HMCL_MCP_AGENT_PORT as the default', () => {
    const ctx = resolveCtx({ HMCL_MCP_AGENT_PORT: '' });
    assert.equal(ctx.agentPort, 28501);
  });

  it('treats an empty HMCL_MCP_AGENT_TOKEN as the default', () => {
    const ctx = resolveCtx({ HMCL_MCP_AGENT_TOKEN: '' });
    assert.equal(ctx.agentToken, 'hmcl-mcp');
  });

  it('falls back to the default when HMCL_MCP_JAVA is empty', () => {
    const ctx = resolveCtx({ HMCL_MCP_JAVA: '' });
    assert.equal(ctx.javaPath, null);
  });
});

describe('resolveCtx invalid port', () => {
  for (const [label, value] of [
    ['non-numeric', 'abc'],
    ['float', '28501.5'],
    ['below range', '0'],
    ['negative', '-1'],
    ['above range', '65536'],
  ] as const) {
    it(`throws a clear error for ${label} port '${value}'`, () => {
      assert.throws(
        () => resolveCtx({ HMCL_MCP_AGENT_PORT: value }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes('HMCL_MCP_AGENT_PORT must be an integer between 1 and 65535') &&
          err.message.includes(`'${value}'`),
      );
    });
  }

  it('accepts the range boundaries', () => {
    assert.equal(resolveCtx({ HMCL_MCP_AGENT_PORT: '1' }).agentPort, 1);
    assert.equal(resolveCtx({ HMCL_MCP_AGENT_PORT: '65535' }).agentPort, 65535);
  });
});

describe('resolveCtx log', () => {
  it('returns a working stderr log function', () => {
    const ctx = resolveCtx({});
    assert.equal(typeof ctx.log, 'function');
    // Smoke: must not throw. (console.error output is expected on stderr.)
    ctx.log('unit-test message');
  });
});
