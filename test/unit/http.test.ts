/**
 * Unit tests for src/util/http.ts downloadFile — SHA-1 verification against a
 * tiny local HTTP server on 127.0.0.1 (no external network).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadFile } from '../../src/util/http.ts';

const BODY = Buffer.from(
  'hmcl-mcp downloadFile unit test payload 0123456789 — sha1 verification over localhost',
);
const SHA1 = createHash('sha1').update(BODY).digest('hex');

let server: http.Server;
let baseUrl: string;
let tmp: string;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/404') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url === '/chunked') {
      // Split the body across writes to exercise streaming hash accumulation.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(BODY.subarray(0, 10));
      setTimeout(() => res.end(BODY.subarray(10)), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hmcl-mcp-http-test-'));
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

async function expectRemoved(dest: string): Promise<void> {
  await assert.rejects(
    () => fs.access(dest),
    (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
  );
}

describe('downloadFile SHA-1 verification', () => {
  it('returns ok with path+size when the sha1 matches', async () => {
    const dest = path.join(tmp, 'match', 'pack.mrpack');
    const result = await downloadFile(`${baseUrl}/ok`, dest, SHA1);

    assert.equal(result.ok, true);
    if (!result.ok) return; // type narrowing
    assert.equal(result.path, dest);
    assert.equal(result.size, BODY.length);
    assert.deepEqual(await fs.readFile(dest), BODY);
  });

  it('accepts an uppercase sha1 (comparison is case-insensitive)', async () => {
    const dest = path.join(tmp, 'case', 'pack.mrpack');
    const result = await downloadFile(`${baseUrl}/ok`, dest, SHA1.toUpperCase());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.size, BODY.length);
  });

  it('returns ok:false with a SHA-1 mismatch message and removes the partial file', async () => {
    const dest = path.join(tmp, 'mismatch', 'pack.mrpack');
    const wrongSha1 = '0'.repeat(40); // definitely not the real sha1
    const result = await downloadFile(`${baseUrl}/ok`, dest, wrongSha1);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes('SHA-1 mismatch'), result.error);
    assert.ok(result.error.includes(wrongSha1), result.error);
    assert.ok(result.error.includes(SHA1), result.error);
    await expectRemoved(dest); // corrupt file must not stay behind
  });

  it('hashes the full streamed body (chunked response)', async () => {
    const dest = path.join(tmp, 'chunked', 'pack.mrpack');
    const result = await downloadFile(`${baseUrl}/chunked`, dest, SHA1);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.size, BODY.length);
    assert.deepEqual(await fs.readFile(dest), BODY);
  });

  it('skips verification when no sha1 is given', async () => {
    const dest = path.join(tmp, 'nosha1', 'pack.mrpack');
    const result = await downloadFile(`${baseUrl}/ok`, dest);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.size, BODY.length);
  });

  it('returns ok:false on HTTP error status without leaving a file', async () => {
    const dest = path.join(tmp, 'http404', 'pack.mrpack');
    const result = await downloadFile(`${baseUrl}/404`, dest);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes('HTTP 404'), result.error);
    await expectRemoved(dest);
  });

  it('creates missing parent directories', async () => {
    const dest = path.join(tmp, 'deep', 'nested', 'dirs', 'pack.mrpack');
    const result = await downloadFile(`${baseUrl}/ok`, dest, SHA1);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(await fs.readFile(dest), BODY);
  });
});
