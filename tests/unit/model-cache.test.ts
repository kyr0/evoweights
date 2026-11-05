/** The shared pack validator and uncached fallback use actual released bytes and a throwaway HTTP server. */
import { expect, test } from 'bun:test';
import { loadModelChunk, verifyModelChunk } from '../../src/model/asset-cache.ts';
import type { ModelManifest } from '../../src/model/kumo.ts';
import { packUrl, siteUrl } from '../../src/shared/site.ts';
import { packDir, servePublic } from './static-server.ts';

const manifest = (await Bun.file(siteUrl('model/manifest.json')).json()) as ModelManifest;
const item = manifest.chunks[0];

test('pack validation accepts both released gzip bytes and transparently decompressed bytes', async () => {
  const bytes = new Uint8Array(await Bun.file(packUrl('w4', item.path)).arrayBuffer());
  expect((await verifyModelChunk(bytes, item)).encoding).toBe('gzip');
  const raw = new Uint8Array(
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
  );
  expect((await verifyModelChunk(raw, item)).encoding).toBe('raw');
  raw[100] ^= 1;
  await expect(verifyModelChunk(raw, item)).rejects.toThrow('failed integrity verification');
  await expect(verifyModelChunk(bytes.slice(1), item)).rejects.toThrow('failed integrity verification');
});

test('without browser storage, the loader verifies real HTTP downloads and preserves abort and HTTP errors', async () => {
  const server = servePublic(packDir),
    url = packUrl('w4', item.path, server.url);
  try {
    const chunk = await loadModelChunk(url, item);
    expect(chunk.encoding).toBe('gzip');
    expect(chunk.bytes.length).toBe(item.bytes);
    const abort = new AbortController();
    abort.abort();
    await expect(loadModelChunk(url, item, abort.signal)).rejects.toThrow('aborted');
    await expect(loadModelChunk(new URL('missing.pack', server.url), item)).rejects.toThrow('HTTP 404');
  } finally {
    server.stop();
  }
});
