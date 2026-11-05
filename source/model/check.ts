/**
 * Compare rebuilt policy WASMs with the shipped ones in public/model: both run the same runtime (src/model) and model
 * packs on the 616 reference observations (three head variants), and every logit must match bit for bit, for the SIMD
 * build and the 4-thread build alike. The runtime takes the WASM from `baseURL`, so a small server maps the two WASM
 * names to the build directory and everything else to public/model; the packs come from .cache/model (`make models`).
 * Usage: bun source/model/check.ts [BUILD_DIR=source/model/build]
 */
import assert from 'node:assert/strict';
import { join, normalize } from 'node:path';
import { createKumoPolicy, type HeadVariant } from '../../src/model/kumo.ts';
import { createThreadedKumoPolicy } from '../../src/model/threaded.ts';

const here = import.meta.dir;
const shipped = join(here, '../../public/model');
const build = process.argv[2] ?? join(here, 'build');
const test = (await Bun.file(join(here, 'tests/reference.json')).json()) as {
  observations: number[][];
  variants: HeadVariant[];
};

function serve(wasmDir: string) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const name = normalize(new URL(request.url).pathname).replace(/^\/+/, '');
      const dir = name.endsWith('.wasm') ? wasmDir : shipped;
      const file = Bun.file(join(dir, name));
      return file.size ? new Response(file) : new Response('Not found', { status: 404 });
    },
  });
}

async function logits(wasmDir: string, threaded: boolean): Promise<Float32Array> {
  const server = serve(wasmDir);
  try {
    const baseURL = `http://127.0.0.1:${server.port}/`;
    const policy = threaded ? await createThreadedKumoPolicy({ threads: 4, baseURL }) : await createKumoPolicy({ baseURL });
    if (threaded) assert.equal((policy as { backend?: string }).backend, 'wasm-simd-threaded');
    const out: number[] = [];
    for (const variant of test.variants) for (const o of test.observations) out.push(...policy.infer(o, variant).logits);
    policy.dispose();
    return Float32Array.from(out);
  } finally {
    void server.stop(true);
  }
}

for (const threaded of [false, true]) {
  const a = await logits(shipped, threaded),
    b = await logits(build, threaded);
  const differing = a.reduce((n, x, i) => n + Number(x !== b[i]), 0);
  console.log((threaded ? 'policy-threads.wasm' : 'policy-simd.wasm') + ':', a.length, 'logits,', differing, 'differ');
  assert.equal(differing, 0);
}
process.exit(0);
