/**
 * Static server for the built docs/ with the cross-origin isolation headers of public/_headers, so shared-memory WASM threads work
 * locally exactly as on a host that honours _headers. Logs one ISO-8601 line per request; exits cleanly on SIGTERM.
 *
 * VERIFIED: the three headers equal `public/_headers`. Bun.serve needs no tool beyond the pinned Bun, where Caddy or
 * `python -m http.server` would need a header config or a dependency of their own.
 */
import { join, normalize } from 'node:path';

const docs = join(import.meta.dir, '..', 'docs');
const port = Number(process.env.PORT ?? 8080);
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function log(level: string, message: string): void {
  console.log(`${new Date().toISOString()} ${level} ${message}`);
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const local = normalize(join(docs, path.endsWith('/') ? path + 'index.html' : path));
    const file = Bun.file(local);
    const found = local.startsWith(docs) && (await file.exists());
    log('INFO', `${request.method} ${path} status=${found ? 200 : 404}`);
    if (!found) return new Response('Not found', { status: 404, headers });
    return new Response(file, { headers });
  },
});

log('INFO', `serving docs/ url=http://localhost:${server.port}/`);
process.on('SIGTERM', () => {
  log('INFO', 'SIGTERM: stopping');
  void server.stop().then(() => process.exit(0));
});
