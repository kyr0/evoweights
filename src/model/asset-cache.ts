/**
 * Verified weight packs shared by play, benchmarks, training and exports, across tabs and workers.
 *
 * Why Cache Storage rather than the browser's HTTP cache: VERIFIED: Hugging Face answers each pack URL with a 302 marked
 * `cache-control: no-store` (observed 2026-11-05), so every visit would contact huggingface.co again. Cache Storage is
 * not integrity-checked, so every hit is verified against the manifest digest before use.
 */
import { sha256 } from '../shared/sha256.ts';
import type { ManifestChunk } from './kumo.ts';

export const MODEL_CACHE_NAME = 'evoweights-model-packs-v1';

export interface VerifiedModelChunk {
  bytes: Uint8Array<ArrayBuffer>;
  encoding: 'gzip' | 'raw';
}

/** Accept compressed packs or hosts that transparently decompress them, using the manifest's hashes. */
export async function verifyModelChunk(
  bytes: Uint8Array<ArrayBuffer>,
  item: ManifestChunk,
): Promise<VerifiedModelChunk> {
  if (bytes.length === item.bytes || bytes.length === item.rawBytes) {
    const digest = await sha256(bytes);
    if (bytes.length === item.bytes && digest === item.sha256) return { bytes, encoding: 'gzip' };
    if (bytes.length === item.rawBytes && digest === item.rawSha256) return { bytes, encoding: 'raw' };
  }
  throw new Error('Policy asset failed integrity verification: ' + item.path);
}

async function modelCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE_NAME);
  } catch {
    // Private browsing or storage restrictions must not prevent a model from running.
    return null;
  }
}

/**
 * Delete copies of the same pack file (same precision folder and file name) stored under another URL or digest, such
 * as an earlier pinned commit. Without this, every pack update would leave up to 99 MB of unreachable entries behind.
 */
async function dropSuperseded(cache: Cache, key: URL): Promise<void> {
  const file = (url: URL) => url.pathname.split('/').slice(-2).join('/');
  for (const request of await cache.keys()) {
    const other = new URL(request.url);
    if (other.href !== key.href && file(other) === file(key)) await cache.delete(request);
  }
}

/** Cache only verified bytes. New manifest hashes get new entries; damaged entries are fetched again. */
export async function loadModelChunk(url: URL, item: ManifestChunk, signal?: AbortSignal): Promise<VerifiedModelChunk> {
  signal?.throwIfAborted();
  const cache = await modelCache();
  const key = new URL(url);
  key.searchParams.set('evoweights_integrity', `${item.sha256}:${item.rawSha256}:${item.bytes}:${item.rawBytes}`);
  const load = async (): Promise<VerifiedModelChunk> => {
    signal?.throwIfAborted();
    if (cache) {
      try {
        const hit = await cache.match(key.href);
        if (hit) {
          const verified = await verifyModelChunk(new Uint8Array(await hit.arrayBuffer()), item);
          signal?.throwIfAborted();
          return verified;
        }
      } catch {
        signal?.throwIfAborted();
        await cache.delete(key.href).catch(() => {});
      }
    }
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Could not download model asset ${url.href}`, { cause: error });
    }
    if (!response.ok) throw new Error(`Model asset ${url.href} returned HTTP ${response.status}`);
    const verified = await verifyModelChunk(new Uint8Array(await response.arrayBuffer()), item);
    signal?.throwIfAborted();
    if (cache) {
      try {
        await cache.put(key.href, new Response(verified.bytes));
        await dropSuperseded(cache, key);
      } catch {
        // A full or unavailable cache affects reuse, not inference with these verified bytes.
      }
    }
    signal?.throwIfAborted();
    return verified;
  };
  // Recheck the cache inside the lock: concurrent workers/tabs share the first completed download.
  const locks = globalThis.navigator?.locks;
  return cache && locks ? locks.request(MODEL_CACHE_NAME + ':' + key.href, { signal }, load) : load();
}
