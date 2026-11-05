/** The evaluation engine: deterministic games, the readout cache, change attribution and lane-parallel play. */
import { afterAll, describe, expect, test } from 'bun:test';
import type { HeadOp } from '../../src/model/kumo.ts';
import { TRUST } from '../../src/revisions/trust.ts';
import { moduleUrl } from '../../src/shared/site.ts';
import { createLanePool, type LanePort } from '../../src/training/lane-pool.ts';
import {
  applyGroup,
  attributeChange,
  changeGroups,
  curriculumStep,
  normalizeRecipe,
  openLiveES,
  pairedStats,
  readSlot,
  recipeHash,
  rng,
  SLOTS,
  streamSeed,
  utility,
  type GameJob,
  type Recipe,
} from '../../src/training/live-es.ts';

const shipped = normalizeRecipe(undefined);
/** The shipped recipe with one native code and one controller code moved by one step. */
function variant(): Recipe {
  const recipe = structuredClone(shipped);
  const i = 1 * 1024 + 300,
    old = TRUST.head.codes[i];
  recipe.ops = [
    ...recipe.ops.filter((op) => op[0] * 1024 + op[1] !== i),
    [1, 300, old, old === 7 ? 6 : old + 1] as HeadOp,
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const code = recipe.tactical.combat.codes[2][4];
  recipe.tactical.combat.codes[2][4] = code === 7 ? 6 : code + 1;
  return recipe;
}
const jobs = (recipe: Recipe, seeds: number[], horizon: number): GameJob[] =>
  seeds.map((seed) => ({ recipe, seed, horizon, round: 0, phase: 'test', role: 'test' }));

describe('pure helpers', () => {
  test('normalizeRecipe validates parents into base-relative recipes', () => {
    expect(shipped.ops.length).toBe(TRUST.edited.length);
    expect(shipped.tactical).toEqual(structuredClone(TRUST.controller));
    expect(() => normalizeRecipe({ precision: 'fp32', ops: [], controller: null })).toThrow('complete W4 parent');
    const wide = structuredClone(TRUST.controller);
    wide.graft.codes[0][0] = 9;
    expect(() => normalizeRecipe({ ops: [], controller: wide })).toThrow('Invalid signed controller slot graft.0.0');
    const foreign = structuredClone(TRUST.controller);
    foreign.combat.reach += 1;
    expect(() => normalizeRecipe({ ops: [], controller: foreign })).toThrow(
      'Only the 119 native controller codes may vary',
    );
  });
  test('SLOTS address all 119 controller codes', () => {
    expect(SLOTS.length).toBe(119);
    expect(readSlot(shipped.tactical, ['facing'])).toBe(TRUST.controller.facing.code);
  });
  test('streamSeed separates validation parity and rng is deterministic', () => {
    expect(streamSeed(0, 5, true) % 2).toBe(1);
    expect(streamSeed(0, 5, false) % 2).toBe(0);
    expect(() => streamSeed(0, 0x10000000, true)).toThrow(RangeError);
    const a = rng(7),
      b = rng(7);
    const draws = Array.from({ length: 5 }, () => a());
    expect(draws).toEqual(Array.from({ length: 5 }, () => b()));
    expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  test('pairedStats', () => {
    expect(pairedStats([2, 2, 2]).t).toBe(99);
    expect(pairedStats([1, 3])).toEqual({ n: 2, mean: 2, sd: Math.SQRT2, se: 1, t: 2 });
  });
  test('change groups knock in to the child and knock out to the parent', async () => {
    const child = variant();
    const groups = changeGroups(shipped, child);
    expect(groups.map((g) => g.kind).sort()).toEqual(['controller', 'native']);
    let rebuilt = shipped;
    for (const g of groups) rebuilt = applyGroup(rebuilt, g, 'after');
    expect(await recipeHash(rebuilt)).toBe(await recipeHash(child));
    let reverted = child;
    for (const g of groups) reverted = applyGroup(reverted, g, 'before');
    expect(await recipeHash(reverted)).toBe(await recipeHash(shipped));
  });
  test('curriculum steps up only when most complete episodes reach the cap', () => {
    const capped = { terminal: true, health: 10, tics: 2100, limit: 4200 };
    const died = { terminal: true, health: 0, tics: 900, limit: 4200 };
    expect(curriculumStep(1, [capped, capped, died]).nextMinutes).toBe(2);
    expect(curriculumStep(1, [capped, died]).nextMinutes).toBe(1);
    expect(curriculumStep(1, [capped, capped, { ...capped, limit: 2000 }]).honoured).toBe(false);
  });
});

describe('in-process evaluation', async () => {
  const live = await openLiveES();
  afterAll(() => live.dispose());

  test('a game is a deterministic function of recipe, seed and horizon', async () => {
    const a = await live.game(shipped, 4242, 300, 0, 'test', 'a');
    const b = await live.game(shipped, 4242, 300, 0, 'test', 'b');
    expect({ ...b, role: 'a' }).toEqual(a);
    expect(a.decisions).toBeLessThanOrEqual(300);
    expect(utility(a)).toBeCloseTo(utility(b), 12);
    const other = await live.game(shipped, 4243, 300, 0, 'test', 'a');
    expect(other.commandFNV32).not.toBe(a.commandFNV32);
  }, 30000);

  test('the cached readout equals full inference after a head change', async () => {
    const arena = await (await import('../../src/engine/arena.ts')).createArena({ seed: 77 });
    const features = arena.state().features;
    live.validateCache(features, shipped.ops);
    expect(live.validateCache(features, variant().ops).logits.length).toBe(3);
  });

  test('attribution accounts for every game and the total gain', async () => {
    const child = variant();
    const seeds = [streamSeed(0, 1, true), streamSeed(0, 2, true)];
    const result = await attributeChange({
      play: (j) => live.localRunner.play(j),
      parent: shipped,
      child,
      seeds,
      horizon: 120,
    });
    expect(result.groups.length).toBe(2);
    expect(result.games).toBe(seeds.length * 2 + result.groups.length * seeds.length * 2);
    expect(result.gain.utility).toBeCloseTo(result.child.utility - result.parent.utility, 9);
    expect(result.interaction).toBeCloseTo(result.gain.utility - result.sumKnockIn, 9);
  }, 60000);
});

test('lane-parallel results equal in-process results', async () => {
  const seeds = [11, 12, 13, 14];
  const work = [...jobs(shipped, seeds, 150), ...jobs(variant(), seeds, 150)];
  const local = await openLiveES();
  const expected = (await local.localRunner.play(work)).map((p) => p.result);
  local.dispose();
  const pool = createLanePool({
    spawn: () => new Worker(moduleUrl('workers/training-lane'), { type: 'module' }) as unknown as LanePort,
    lanes: 2,
    init: {},
  });
  await pool.open();
  expect(pool.runner.lanes).toBe(2);
  const played = (await pool.runner.play(work)).map((p) => p.result);
  expect(played).toEqual(expected);
  expect(pool.counts.games).toBe(work.length);
  pool.dispose();
  await expect(pool.runner.play(work)).rejects.toThrow('Training stopped');
}, 120000);
