/**
 * Kumo inference against the shipped packs and WASM: PyTorch parity (the benchmark's pass criterion), bit-identical
 * threaded lanes, head patches and integrity checks.
 */
import { describe, expect, test } from 'bun:test';
import { cpuThreadLimit, stackRegion } from '../../src/model/cpu-limits.ts';
import { createKumoPolicy, type HeadOp, type HeadVariant } from '../../src/model/kumo.ts';
import { createThreadedKumoPolicy, threadingUnavailable } from '../../src/model/threaded.ts';
import { packUrl, siteUrl } from '../../src/shared/site.ts';
import { TRUST } from '../../src/revisions/trust.ts';

interface Bench {
  warmup: number;
  x: number[][];
  logits: number[][];
}
const bench = (await Bun.file(siteUrl('assets/bench-fixtures.json')).json()) as Bench;
const fp32Reference = (await Bun.file(siteUrl('assets/bench-fp32.json')).json()) as { logits: number[][] };
const reference = (await Bun.file(new URL('../../source/model/tests/reference.json', import.meta.url)).json()) as {
  observations: number[][];
  variants: HeadVariant[];
  logits: number[][][];
};
/** The benchmark's parity bound (bench-worker.ts). */
const MAX_ERROR = 0.001;
const argmax = (v: number[]) => v.indexOf(Math.max(...v));

describe('W4 policy', async () => {
  const policy = await createKumoPolicy();

  test('matches the PyTorch reference logits and actions of the benchmark fixtures', () => {
    for (const [i, x] of bench.x.entries()) {
      const got = policy.infer(x, 'edited');
      expect(got.action).toBe(argmax(bench.logits[i]));
      for (let j = 0; j < 3; j++) expect(Math.abs(got.logits[j] - bench.logits[i][j])).toBeLessThan(MAX_ERROR);
    }
  });

  test('matches the PyTorch reference for every head variant', () => {
    for (const [k, variant] of reference.variants.entries())
      for (const [i, o] of reference.observations.entries()) {
        const got = policy.infer(o, variant).logits;
        for (let j = 0; j < 3; j++) expect(Math.abs(got[j] - reference.logits[k][i][j])).toBeLessThan(MAX_ERROR);
      }
  }, 30000);

  test('a custom patch equal to the shipped edit reproduces the edited head bit for bit', () => {
    policy.setHeadPatch(TRUST.edited);
    for (const x of bench.x.slice(0, 16))
      expect(policy.infer(x, 'custom').logits).toEqual(policy.infer(x, 'edited').logits);
    policy.clearHeadPatch();
    expect(() => policy.infer(bench.x[0], 'custom')).toThrow('Custom patch is unset');
  });

  test('rejects stale, duplicate and out-of-range head edits', () => {
    const code = TRUST.head.codes[5];
    const stale: HeadOp = [0, 5, code === 7 ? 6 : code + 1, 0];
    expect(() => policy.setHeadPatch([stale])).toThrow('baseline code mismatch');
    const valid: HeadOp = [0, 5, code, code === 7 ? 6 : code + 1];
    expect(() => policy.setHeadPatch([valid, valid])).toThrow();
    expect(() => policy.setHeadPatch([[3, 0, 0, 1]])).toThrow();
  });

  test('rejects malformed features and unknown variants', () => {
    expect(() => policy.infer(bench.x[0].slice(0, 13))).toThrow(RangeError);
    expect(() => policy.infer([...bench.x[0].slice(0, 13), NaN])).toThrow('Non-finite feature');
    expect(() => policy.infer(bench.x[0], 'fp32')).toThrow('Unknown policy');
  });

  test('dispose ends inference', () => {
    policy.dispose();
    expect(() => policy.infer(bench.x[0])).toThrow('Policy was disposed');
  });
});

test('FP32 policy matches the PyTorch FP32 reference', async () => {
  const policy = await createKumoPolicy({ precision: 'fp32' });
  for (const [i, x] of bench.x.entries()) {
    const got = policy.infer(x, 'fp32');
    expect(got.action).toBe(argmax(fp32Reference.logits[i]));
    for (let j = 0; j < 3; j++) expect(Math.abs(got.logits[j] - fp32Reference.logits[i][j])).toBeLessThan(MAX_ERROR);
  }
  expect(() => policy.infer(bench.x[0], 'edited')).toThrow('only accepts its unedited fp32 variant');
  expect(() => policy.setHeadPatch(TRUST.edited)).toThrow('does not accept W4 edits');
  policy.dispose();
}, 30000);

test('a tampered pack fails integrity verification', async () => {
  const bytes = new Uint8Array(await Bun.file(packUrl('w4', 'model-00.pack')).arrayBuffer());
  bytes[100] ^= 1;
  const readAsset = (name: string) => (name === 'model-00.pack' ? bytes : null);
  await expect(createKumoPolicy({ readAsset })).rejects.toThrow('failed integrity verification: model-00.pack');
});

test('threaded lanes produce bit-identical logits to the single-thread build', async () => {
  expect(threadingUnavailable()).toBeNull();
  const single = await createKumoPolicy();
  const threaded = await createThreadedKumoPolicy({ threads: 4 });
  expect(threaded.backend).toBe(cpuThreadLimit() >= 4 ? 'wasm-simd-threaded' : 'wasm-simd');
  const lanes = threaded.laneDiagnostics();
  for (const variant of reference.variants)
    for (const o of reference.observations.slice(0, 200))
      expect(threaded.infer(o, variant).logits).toEqual(single.infer(o, variant).logits);
  expect(threaded.laneDiagnostics().map((l) => l.passes)).not.toEqual(lanes.map((l) => l.passes));
  threaded.dispose();
  single.dispose();
}, 60000);

test('lane stacks are disjoint 16-byte aligned regions inside the linked stack', async () => {
  const module = await WebAssembly.compile(await Bun.file(siteUrl('model/policy-threads.wasm')).arrayBuffer());
  const memory = new WebAssembly.Memory({ initial: 1536, maximum: 1536, shared: true });
  const { exports } = await WebAssembly.instantiate(module, {
    env: { memory },
    math: { sin: Math.sin, cos: Math.cos, exp: Math.exp, tanh: Math.tanh },
  });
  const api = exports as unknown as Parameters<typeof stackRegion>[0];
  const regions = Array.from({ length: 4 }, (_, lane) => stackRegion(api, lane, 4));
  for (const [i, r] of regions.entries()) {
    expect(r.top % 16).toBe(0);
    expect(r.top - r.bottom).toBe(api.lane_stack_bytes());
    if (i) expect(r.top).toBe(regions[i - 1].bottom);
  }
  expect(() => stackRegion(api, 4, 4)).toThrow(RangeError);
  expect(() => stackRegion(api, 0, 9)).toThrow(RangeError);
});

test('cpuThreadLimit clamps reported cores to 1…8', () => {
  expect(cpuThreadLimit(0)).toBe(1);
  expect(cpuThreadLimit(3)).toBe(3);
  expect(cpuThreadLimit(64)).toBe(8);
});
