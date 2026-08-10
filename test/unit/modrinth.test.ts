/**
 * Unit tests for src/modpack/modrinth.ts — Modrinth API v2 mapping logic.
 *
 * No network: global fetch is mocked per-test via t.mock.method. Fixtures are
 * shaped like the real /v2/search and /v2/project/<id>/version responses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchModpacks, getVersions, getVersion } from '../../src/modpack/modrinth.ts';

const BASE = 'https://api.modrinth.com/v2';
/** URL-encoded `[["project_type:modpack"]]` — what the real client sends. */
const MODPACK_FACETS = encodeURIComponent(JSON.stringify([['project_type:modpack']]));

function jsonFetch(fixture: unknown, onUrl?: (url: string) => void) {
  return async (url: string) => {
    onUrl?.(url);
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('searchModpacks', () => {
  it('maps /v2/search hits into ModpackSummary (slug, author, versions coerced to strings)', async (t) => {
    const fixture = {
      hits: [
        {
          project_id: 'abc123',
          slug: 'my-pack',
          author: 'author1',
          title: 'My Pack',
          description: 'desc',
          versions: ['1.20.4', '1.20.1', 123],
        },
        { project_id: 'def456', author: 'author2', title: 'No Slug Pack' },
        { project_id: 'ghi789' },
      ],
    };
    t.mock.method(globalThis, 'fetch', jsonFetch(fixture));

    const result = await searchModpacks('foo', 3);
    assert.equal(result.length, 3);

    // Full hit: slug wins over project_id.
    assert.equal(result[0].source, 'modrinth');
    assert.equal(result[0].id, 'my-pack');
    assert.equal(result[0].title, 'My Pack');
    assert.equal(result[0].description, 'desc');
    assert.deepEqual(result[0].authors, ['author1']);
    assert.deepEqual(result[0].versions, ['1.20.4', '1.20.1', '123']);
    assert.equal(result[0].url, 'https://modrinth.com/modpack/my-pack');

    // No slug: project_id fallback.
    assert.equal(result[1].id, 'def456');
    assert.equal(result[1].title, 'No Slug Pack');
    assert.deepEqual(result[1].authors, ['author2']);
    assert.deepEqual(result[1].versions, []);
    assert.equal(result[1].url, 'https://modrinth.com/modpack/def456');

    // Minimal hit: title/description fall back to slug/id, no authors.
    assert.equal(result[2].id, 'ghi789');
    assert.equal(result[2].title, 'ghi789');
    assert.equal(result[2].description, '');
    assert.deepEqual(result[2].authors, []);
  });

  it('sends the modpack facet, the query and the requested limit', async (t) => {
    let url = '';
    t.mock.method(globalThis, 'fetch', jsonFetch({ hits: [] }, (u) => (url = u)));

    await searchModpacks('sky factory', 7);
    assert.ok(url.startsWith(`${BASE}/search?`), url);
    assert.ok(url.includes(`query=${encodeURIComponent('sky factory')}`), url);
    assert.ok(url.includes(`facets=${MODPACK_FACETS}`), url);
    assert.ok(url.includes('limit=7'), url);
  });

  it('clamps the limit to 1..100', async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', jsonFetch({ hits: [] }, (u) => urls.push(u)));

    await searchModpacks('', 500);
    await searchModpacks('', 0);
    await searchModpacks('', -3);
    assert.equal(urls.length, 3);
    assert.ok(urls[0].includes('limit=100'), urls[0]);
    assert.ok(urls[1].includes('limit=1'), urls[1]);
    assert.ok(urls[2].includes('limit=1'), urls[2]);
  });
});

describe('getVersions', () => {
  it('picks the primary file and skips versions without files', async (t) => {
    const fixture = [
      {
        id: 'v1',
        version_number: '1.0.0',
        game_versions: ['1.20.4'],
        files: [
          { primary: false, url: 'https://x/alt', filename: 'alt.mrpack', size: 10 },
          {
            primary: true,
            url: 'https://x/main',
            filename: 'main.mrpack',
            size: 12345,
            hashes: { sha1: 'deadbeef' },
          },
        ],
      },
      { id: 'v2', version_number: '2.0.0', game_versions: ['1.21'], files: [] },
      {
        id: 'v3',
        version_number: '3.0.0',
        game_versions: ['1.21.1'],
        files: [{ url: 'https://x/first', filename: 'first.mrpack', size: 77 }],
      },
    ];
    t.mock.method(globalThis, 'fetch', jsonFetch(fixture));

    const result = await getVersions('proj');
    assert.equal(result.length, 2); // v2 (no files) skipped

    // v1: primary file wins.
    assert.equal(result[0].id, 'v1');
    assert.equal(result[0].version, '1.0.0');
    assert.deepEqual(result[0].gameVersions, ['1.20.4']);
    assert.equal(result[0].url, 'https://x/main');
    assert.equal(result[0].filename, 'main.mrpack');
    assert.equal(result[0].size, 12345);
    assert.equal(result[0].sha1, 'deadbeef');

    // v3: no primary → first file used; no hashes → sha1 undefined.
    assert.equal(result[1].id, 'v3');
    assert.equal(result[1].url, 'https://x/first');
    assert.equal(result[1].filename, 'first.mrpack');
    assert.equal(result[1].sha1, undefined);
  });

  it('clamps the limit to 1..100', async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', jsonFetch([], (u) => urls.push(u)));

    await getVersions('proj', 500);
    await getVersions('proj', 0);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes(`limit=100`), urls[0]);
    assert.ok(urls[1].includes('limit=1'), urls[1]);
  });
});

describe('getVersion', () => {
  it('maps a single version with its (only) file', async (t) => {
    const fixture = {
      id: 'vid1234',
      name: 'Version Name',
      game_versions: ['1.20.1'],
      files: [{ url: 'https://x/pack.mrpack', filename: 'pack.mrpack', size: 999 }],
    };
    t.mock.method(globalThis, 'fetch', jsonFetch(fixture));

    const result = await getVersion('vid1234');
    assert.equal(result.id, 'vid1234');
    assert.equal(result.version, 'Version Name'); // name used when version_number missing
    assert.equal(result.url, 'https://x/pack.mrpack');
    assert.equal(result.filename, 'pack.mrpack');
    assert.equal(result.size, 999);
    assert.equal(result.sha1, undefined);
  });

  it('falls back version → name → id and filename/size defaults', async (t) => {
    const fixture = { id: 'vid5678', files: [{}] };
    t.mock.method(globalThis, 'fetch', jsonFetch(fixture));

    const result = await getVersion('vid5678');
    assert.equal(result.version, 'vid5678');
    assert.equal(result.url, '');
    assert.equal(result.filename, 'modpack.mrpack');
    assert.equal(result.size, 0);
  });

  it('throws a clear error when the version has no downloadable file', async (t) => {
    t.mock.method(globalThis, 'fetch', jsonFetch({ id: 'vid9999', files: [] }));

    await assert.rejects(
      () => getVersion('vid9999'),
      (err: unknown) => err instanceof Error && err.message.includes(`'vid9999' has no downloadable file`),
    );
  });
});
