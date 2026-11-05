/** Real CacheStorage, Web Locks and model-pack requests in the built browser app. */
import { expect, test } from '@playwright/test';

test('workers share one verified download, repair damaged entries and reject mismatched versions', async ({ page }) => {
  const requests: string[] = [],
    errors: string[] = [];
  page.context().on('request', (r) => {
    if (r.url().endsWith('.pack')) requests.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('requestfailed', (r) => errors.push(r.url()));
  await page.goto('./');
  const concurrent = await page.evaluate(async () => {
    const cacheModule = new URL('model/asset-cache.js', location.href).href,
      siteModule = new URL('shared/site.js', location.href).href;
    const source = `
      import { loadModelChunk } from ${JSON.stringify(cacheModule)};
      import { packUrl, siteUrl } from ${JSON.stringify(siteModule)};
      onmessage = async () => {
        try {
          const manifest = await (await fetch(siteUrl('model/manifest.json'))).json();
          const result = await loadModelChunk(packUrl('w4', manifest.chunks[0].path), manifest.chunks[0]);
          postMessage({ size: result.bytes.length, encoding: result.encoding });
        } catch (error) { postMessage({ error: String(error) }); }
      };`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return await Promise.all(
        Array.from(
          { length: 3 },
          () =>
            new Promise<{ size: number; encoding: string }>((resolve, reject) => {
              const worker = new Worker(url, { type: 'module' });
              worker.onmessage = ({ data }) => {
                worker.terminate();
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              };
              worker.onerror = (e) => {
                worker.terminate();
                reject(new Error(e.message));
              };
              worker.postMessage(null);
            }),
        ),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  expect(requests).toHaveLength(1);
  expect(concurrent[0].size).toBeGreaterThan(0);
  expect(concurrent).toEqual([concurrent[0], concurrent[0], concurrent[0]]);

  const repaired = await page.evaluate(async () => {
    const { MODEL_CACHE_NAME, loadModelChunk } = (await import(
      new URL('model/asset-cache.js', location.href).href
    )) as typeof import('../../src/model/asset-cache.ts');
    const { packUrl, siteUrl } = (await import(
      new URL('shared/site.js', location.href).href
    )) as typeof import('../../src/shared/site.ts');
    const manifest = await (await fetch(siteUrl('model/manifest.json'))).json();
    const item = manifest.chunks[0],
      cache = await caches.open(MODEL_CACHE_NAME),
      [key] = await cache.keys();
    const bytes = new Uint8Array(await (await cache.match(key))!.arrayBuffer()),
      original = bytes[100];
    bytes[100] ^= 1;
    await cache.put(key, new Response(bytes));
    const restored = await loadModelChunk(packUrl('w4', item.path), item);
    return { original, restored: restored.bytes[100], size: restored.bytes.length };
  });
  expect(requests).toHaveLength(2);
  expect(repaired.restored).toBe(repaired.original);
  expect(repaired.size).toBe(concurrent[0].size);

  const version = await page.evaluate(async () => {
    const { MODEL_CACHE_NAME, loadModelChunk } = (await import(
      new URL('model/asset-cache.js', location.href).href
    )) as typeof import('../../src/model/asset-cache.ts');
    const { packUrl, siteUrl } = (await import(
      new URL('shared/site.js', location.href).href
    )) as typeof import('../../src/shared/site.ts');
    const item = (await (await fetch(siteUrl('model/manifest.json'))).json()).chunks[0];
    let error = '';
    try {
      await loadModelChunk(packUrl('w4', item.path), { ...item, sha256: '0'.repeat(64), rawSha256: '1'.repeat(64) });
    } catch (e) {
      error = String(e);
    }
    const valid = await loadModelChunk(packUrl('w4', item.path), item);
    return { error, entries: (await (await caches.open(MODEL_CACHE_NAME)).keys()).length, size: valid.bytes.length };
  });
  expect(requests).toHaveLength(3);
  expect(version.error).toContain('failed integrity verification');
  expect(version.entries).toBe(1);
  expect(version.size).toBe(concurrent[0].size);

  // A pack update (a new pinned commit) leaves no superseded copy of the same file behind.
  const superseded = await page.evaluate(async () => {
    const { MODEL_CACHE_NAME, loadModelChunk } = (await import(
      new URL('model/asset-cache.js', location.href).href
    )) as typeof import('../../src/model/asset-cache.ts');
    const { packUrl, siteUrl } = (await import(
      new URL('shared/site.js', location.href).href
    )) as typeof import('../../src/shared/site.ts');
    const item = (await (await fetch(siteUrl('model/manifest.json'))).json()).chunks[0],
      cache = await caches.open(MODEL_CACHE_NAME),
      current = packUrl('w4', item.path);
    const old = new URL(current.href.replace(/\/resolve\/[0-9a-f]{40}\//, '/resolve/' + '0'.repeat(40) + '/'));
    old.searchParams.set('evoweights_integrity', 'superseded');
    await cache.put(old.href, new Response(new Uint8Array(8)));
    for (const request of await cache.keys())
      if (request.url.split('?')[0] === current.href) await cache.delete(request);
    await loadModelChunk(current, item);
    return { current: current.href, kept: (await cache.keys()).map((r) => r.url.split('?')[0]) };
  });
  expect(requests).toHaveLength(4);
  expect(superseded.kept).toEqual([superseded.current]);
  expect(errors).toEqual([]);
});
