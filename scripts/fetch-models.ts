/**
 * Downloads the model packs named in public/model/*manifest.json from Hugging Face (`MODEL_PACK_URL`, a pinned commit)
 * into .cache/model/, the local copy `bun test` and `source/model/check.ts` read. Packs already present with the right
 * SHA-256 are kept, so a second run makes no request. Exits non-zero when a download fails or a digest differs.
 *
 * Why a local copy instead of fetching in each test: VERIFIED: AGENTS.md rules out live external services in tests. The
 * deployed site downloads the same files on demand and checks them against the same manifests.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelManifest } from '../src/model/kumo.ts';
import { MODEL_PACK_URL, packPath } from '../src/shared/site.ts';

const root = join(import.meta.dir, '..');
const cache = join(root, '.cache', 'model');
const manifests = [
  { file: 'manifest.json', precision: 'w4' },
  { file: 'original-manifest.json', precision: 'fp32' },
] as const;

function log(level: string, message: string): void {
  console.log(`${new Date().toISOString()} ${level} ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function matches(bytes: Uint8Array, chunk: ModelManifest['chunks'][number]): boolean {
  if (bytes.length === chunk.bytes && sha256(bytes) === chunk.sha256) return true;
  return bytes.length === chunk.rawBytes && sha256(bytes) === chunk.rawSha256;
}

mkdirSync(join(cache, '4bit'), { recursive: true });
mkdirSync(join(cache, 'fp32'), { recursive: true });
let fetched = 0,
  kept = 0;
for (const { file: name, precision } of manifests) {
  const manifest = (await Bun.file(join(root, 'public', 'model', name)).json()) as ModelManifest;
  for (const chunk of manifest.chunks) {
    const relative = packPath(precision, chunk.path),
      target = join(cache, relative);
    const local = Bun.file(target);
    if ((await local.exists()) && matches(new Uint8Array(await local.arrayBuffer()), chunk)) {
      kept++;
      continue;
    }
    const url = new URL(relative, MODEL_PACK_URL);
    const response = await fetch(url);
    if (!response.ok) {
      log('ERROR', `download failed path=${chunk.path} status=${response.status} url=${url.href}`);
      process.exit(1);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!matches(bytes, chunk)) {
      log('ERROR', `digest mismatch path=${chunk.path} manifest=${name}`);
      process.exit(1);
    }
    await Bun.write(target + '.part', bytes);
    renameSync(target + '.part', target);
    fetched++;
    log('INFO', `downloaded path=${relative} bytes=${bytes.length}`);
  }
}
log('INFO', `model packs ready dir=.cache/model downloaded=${fetched} kept=${kept}`);
