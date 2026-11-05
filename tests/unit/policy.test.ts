/** Decision policies, the runtime facade and the head-projection benchmark reference. */
import { describe, expect, test } from 'bun:test';
import { createArena } from '../../src/engine/arena.ts';
import { createKumoPolicy } from '../../src/model/kumo.ts';
import { buildW4Controller, createDecisionPolicy, modelFor } from '../../src/policy/decision-policy.ts';
import { revisionReference } from '../../src/policy/revision-benchmark.ts';
import { openRuntime, percentile } from '../../src/policy/runtime.ts';
import { TRUST } from '../../src/revisions/trust.ts';
import { siteUrl } from '../../src/shared/site.ts';

const bench = (await Bun.file(siteUrl('assets/bench-fixtures.json')).json()) as { x: number[][]; logits: number[][] };

test('modelFor maps the live policies to precision and head', () => {
  expect(modelFor('dnp')).toEqual({ precision: 'w4', head: 'edited' });
  expect(modelFor('original')).toEqual({ precision: 'fp32', head: 'fp32' });
  expect(modelFor('dnp', { ops: [], tactical: TRUST.controller })).toEqual({ precision: 'w4', head: 'custom' });
  expect(() => modelFor('original', { ops: [], tactical: TRUST.controller })).toThrow();
  expect(() => modelFor('other')).toThrow(RangeError);
});

test('the shipped controller files equal the trusted release controller', async () => {
  const read = async (name: string) => (await fetch(siteUrl('tactical/' + name))).json();
  const [graft, combat, facing] = await Promise.all(
    ['graft.json', 'combat-weights.json', 'facing-weights.json'].map(read),
  );
  expect({ graft, combat, facing }).toEqual(structuredClone(TRUST.controller));
});

describe('W4 controller in a live game', async () => {
  const [kumo, arena] = await Promise.all([createKumoPolicy(), createArena({ seed: 9000 })]);

  async function play(seed: number, steps: number) {
    const policy = await createDecisionPolicy('dnp');
    let s = arena.reset(seed);
    const commands: string[] = [];
    for (let i = 0; i < steps && !s.done; i++) {
      const d = policy.decide(s, kumo.infer(s.features, policy.head));
      expect(d.forward && d.backward).toBeFalsy();
      expect(d.action).toBeGreaterThanOrEqual(0);
      expect(d.action).toBeLessThanOrEqual(3);
      commands.push(`${d.action}${+!!d.backward}${+!!d.forward}`);
      s = arena.step(d.action, !!d.backward, !!d.forward);
    }
    return { commands: commands.join(','), tic: s.tic, kills: s.kills };
  }

  test('decisions are valid commands and replay deterministically', async () => {
    const first = await play(9001, 400),
      second = await play(9001, 400);
    expect(second).toEqual(first);
    expect(new Set(first.commands.split(',')).size).toBeGreaterThan(2);
  }, 30000);

  test('the fetched recipe and the trusted controller decide identically', async () => {
    const fetched = await createDecisionPolicy('dnp');
    const trusted = buildW4Controller(TRUST.controller, 'edited');
    let s = arena.reset(9002);
    for (let i = 0; i < 200 && !s.done; i++) {
      const core = kumo.infer(s.features, 'edited');
      const a = fetched.decide(s, core),
        b = trusted.decide(s, core);
      expect(b).toEqual(a);
      s = arena.step(a.action, !!a.backward, !!a.forward);
    }
  }, 30000);

  test('the original policy passes Kumo logits through without movement', async () => {
    const original = await createDecisionPolicy('original');
    const core = { logits: [1, 2, 3], action: 2 };
    expect(original.decide(arena.state(), core)).toEqual({ ...core, forward: false, backward: false });
  });
});

describe('runtime facade', () => {
  test('wasm backend serves the edited head', async () => {
    const runtime = await openRuntime('wasm');
    expect(runtime.info()).toEqual({ backend: 'wasm-simd', threads: 1, reason: null });
    const got = await runtime.infer(bench.x[0], 'edited');
    expect(got.action).toBe(bench.logits[0].indexOf(Math.max(...bench.logits[0])));
    runtime.dispose();
  });
  test('gpu request falls back to the CPU without WebGPU and says why', async () => {
    const runtime = await openRuntime('gpu');
    const info = runtime.info();
    expect(info.backend).toBe('wasm-simd');
    expect(info.reason).toBe('WebGPU unavailable in this execution context');
    expect((await runtime.infer(bench.x[1], 'edited')).logits.length).toBe(3);
    runtime.dispose();
  });
  test('a custom head requires W4 and applies the patch', async () => {
    await expect(openRuntime('wasm', undefined, 'fp32', [])).rejects.toThrow('Invalid custom W4 head');
    const runtime = await openRuntime('wasm', undefined, 'w4', TRUST.edited);
    const reference = await openRuntime('wasm');
    expect((await runtime.infer(bench.x[2], 'custom')).logits).toEqual(
      (await reference.infer(bench.x[2], 'edited')).logits,
    );
    runtime.dispose();
    reference.dispose();
  });
  test('percentile uses the nearest rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });
});

test('the head-projection reference of the shipped edit matches the PyTorch edited logits', async () => {
  const projected = await revisionReference(TRUST.edited, bench.x.length);
  for (const [i, scores] of projected.entries())
    for (let j = 0; j < 3; j++) expect(Math.abs(scores[j] - bench.logits[i][j])).toBeLessThan(0.001);
});
