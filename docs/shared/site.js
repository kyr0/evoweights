const fromSource = import.meta.url.endsWith('.ts');
const root = new URL(fromSource ? '../../public/' : '../', import.meta.url);
const moduleExtension = fromSource ? '.ts' : '.js';
/**
 * The model packs (`*.pack`, about 100 MB) live on Hugging Face, not in this repository, at a pinned commit so the files
 * always match the manifests in `public/model/`. Each precision has its own folder there (`4bit/`, `fp32/`).
 * VERIFIED: the resolve endpoint and its CDN redirect send `Access-Control-Allow-Origin`, so a CORS fetch passes the
 * page's `Cross-Origin-Embedder-Policy: require-corp`.
 * Integrity does not depend on this host: every pack is checked by SHA-256 against a same-origin manifest before use.
 */
export const MODEL_PACK_URL = 'https://huggingface.co/kyr0/evoweights-evolutionary-weight-space-fine-tuning/resolve/1ab6f962a9c88c8e0186f7665654c1a1c18087dd/base/';
// Under `bun test` packs come from the local copy that `make setup` downloads (same folders), so tests never call Hugging Face.
const packRoot = fromSource ? new URL('../../.cache/model/', import.meta.url) : new URL(MODEL_PACK_URL);
/** URL of a static file, given its path below the site root (for example `model/manifest.json`). */
export function siteUrl(path) {
    return new URL(path, root);
}
/** Path of a model pack below the pack root, given the precision of the manifest that names it. */
export function packPath(precision, file) {
    return (precision === 'fp32' ? 'fp32/' : '4bit/') + file;
}
/** URL of a model pack named in a manifest (for example `model-00.pack`), below `root` (Hugging Face by default). */
export function packUrl(precision, file, root = packRoot) {
    return new URL(packPath(precision, file), root);
}
/** URL of a compiled module for `new Worker(...)`, given its path below `src/` without extension (for example `workers/play-worker`). */
export function moduleUrl(path) {
    return new URL('../' + path + moduleExtension, import.meta.url);
}
