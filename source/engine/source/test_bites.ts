/**
 * Offline bite audit (not part of `make test`): build the hooked binary with `source/engine/source/build.sh audit` first,
 * then run `bun source/engine/source/test_bites.ts`. Compares the public arena step by step with the separately compiled
 * bite-hook WASM and reconciles every observed health loss by subtic. Never load this module in the site.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createArena } from '../../../src/engine/arena.ts';

interface AuditExports {
  memory: WebAssembly.Memory;
  arena_wad(length: number): number;
  arena_start(seed: number): void;
  arena_step(action: number, backward: number, forward: number): void;
  arena_tic(): number;
  arena_kills(): number;
  arena_features(): number;
  arena_bite_count(): number;
  arena_bites(): number;
}

const engine = new URL('../../../public/engine/', import.meta.url);
const arena = await createArena({ seed: 9000 });
const wad = gunzipSync(await readFile(new URL('arena.wad.gz', engine)));
const module = await WebAssembly.compile(await readFile(new URL('../build/bite-audit.wasm', import.meta.url)));
function auditArena(seed: number): AuditExports {
  const e = new WebAssembly.Instance(module, {
    host: {
      log() {},
      exit(code: number) {
        throw new Error('Doom exit ' + code);
      },
    },
  }).exports as unknown as AuditExports;
  new Uint8Array(e.memory.buffer, e.arena_wad(wad.length), wad.length).set(wad);
  e.arena_start(seed);
  return e;
}
const counts = { steps: 0, damage: 0, resolvedBites: 0, hits: 0, misses: 0, sourcesHiddenAtStartOfPreviousDecision: 0 };
const examples: Record<string, unknown> = {},
  windupDurations = new Set<number>();
for (let seed = 9000; seed < 9012; seed++) {
  const e = auditArena(seed);
  let state = arena.reset(seed);
  while (!state.done && state.tic < 700) {
    const t = state.threat,
      mode = seed % 4;
    const aim =
      mode === 0 ? 3 : mode === 1 ? 0 : mode === 2 && t.aligned ? 2 : t.visible && !t.aligned ? (t.x < 0 ? 0 : 1) : 3;
    const back = mode >= 2 && t.visible && t.distance < (mode === 2 ? 200 : 70) && t.backClearance > 22;
    const forward = mode === 1 && state.tic % 100 < 50;
    const previous = state;
    state = arena.step(aim, back, forward);
    e.arena_step(aim, back ? 1 : 0, forward ? 1 : 0);
    counts.steps++;
    assert.equal(e.arena_tic(), state.tic);
    assert.deepEqual(Array.from(new Float32Array(e.memory.buffer, e.arena_features(), 14)), Array.from(state.features));
    assert.equal(e.arena_kills(), state.kills);
    const n = e.arena_bite_count();
    const rows = new Float32Array(e.memory.buffer, e.arena_bites(), n * 6);
    const healthLoss = [0, 0];
    for (let i = 0; i < rows.length; i += 6) {
      const [actorId, start, tic, startRange, strikeRange, damage] = rows.subarray(i, i + 6);
      const wasVisible = previous.actors.some((actor) => actor.id === actorId);
      assert.ok(actorId > 0 && tic > previous.tic && tic <= state.tic);
      assert.ok(startRange < 60);
      assert.equal(tic - start, 16);
      if (damage > 0) assert.ok(strikeRange < 60 && damage <= 40);
      else assert.ok(strikeRange >= 60, 'Every miss on this open map should have moved beyond reach');
      healthLoss[tic - previous.tic - 1] += damage;
      counts.resolvedBites++;
      counts.damage += damage;
      counts[damage > 0 ? 'hits' : 'misses']++;
      if (!wasVisible && damage > 0) counts.sourcesHiddenAtStartOfPreviousDecision++;
      windupDurations.add(tic - start);
      examples[damage > 0 ? 'hit' : 'miss'] ??= { seed, actorId, start, tic, startRange, strikeRange, damage, wasVisible };
    }
    assert.deepEqual(healthLoss, state.events.damageBySubtic);
  }
}
assert.ok(counts.hits > 0 && counts.misses > 0);
assert.ok(counts.sourcesHiddenAtStartOfPreviousDecision > 0);
console.log(
  JSON.stringify(
    {
      counts,
      windupTics: [...windupDurations],
      examples,
      scope:
        'Twelve fixed scripted diagnostic seeds; compare visible demo against separately compiled bite-hook WASM on each step. Damage is actual health removed, capped at remaining health; range is P_AproxDistance. No diagnostic exports or attacker IDs in public damage observations.',
    },
    null,
    2,
  ),
);
