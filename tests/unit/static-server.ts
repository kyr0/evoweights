/**
 * Throwaway HTTP server for public/ (or another directory), for tests that need network-shaped responses. Bun's `fetch(file://…).blob()` returns a
 * file-backed Blob that `new Blob([…, blob])` silently drops (Bun 1.4.3), which the browser never sees; serving over HTTP
 * gives the same in-memory Blobs a browser gets.
 */
import { join, normalize } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
export const publicDir = join(repo, 'public');
/** The local copy of the Hugging Face model packs (`make setup`). */
export const packDir = join(repo, '.cache', 'model');

export function servePublic(dir = publicDir): { url: URL; stop(): void } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const local = normalize(join(dir, decodeURIComponent(new URL(request.url).pathname)));
      const file = Bun.file(local);
      if (!local.startsWith(dir) || !(await file.exists())) return new Response('Not found', { status: 404 });
      return new Response(file);
    },
  });
  return { url: new URL(`http://127.0.0.1:${server.port}/`), stop: () => void server.stop(true) };
}
