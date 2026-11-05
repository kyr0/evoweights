/**
 * Engine contract tests against the shipped arena.wasm and WAD (ported from the engine release's test.mjs, test_v3.mjs,
 * test_v4.mjs and test_v5.mjs; their measured outputs are recorded in source/engine/source/verified*.json).
 * Scripted diagnostic policies only, no neural policy.
 */
import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createArena, type ArenaState } from '../../src/engine/arena.ts';
import { siteUrl } from '../../src/shared/site.ts';

// Archived protocol tests run the exact original binary and WAD; picnic rules have separate tests.
const arena = await createArena({
  seed: 9000,
  readAsset: async (name) =>
    new Uint8Array(await Bun.file(new URL('../fixtures/legacy-engine/' + name, import.meta.url)).arrayBuffer()),
});
const hash = (bytes: Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');
const norm = (deg: number) => ((deg + 540) % 360) - 180;
const close = (x: number, y: number, eps = 0.0002) => assert.ok(Math.abs(x - y) <= eps, `${x} != ${y}`);

describe('v0.2 replay and observations', () => {
  test('initial frame and state', () => {
    arena.reset(9000);
    expect(arena.frame().length).toBe(320 * 200 * 4);
    expect(arena.state().ammo).toBe(26);
    expect(arena.state().health).toBe(100);
    expect(arena.state().features.length).toBe(14);
  });

  test('same seed and actions replay identically; actions and seeds diverge', () => {
    arena.reset(9000);
    const start = hash(arena.frame());
    function rollout(seed: number, actions: number[]) {
      arena.reset(seed);
      for (const act of actions) arena.step(act);
      const s = arena.state();
      return {
        tic: s.tic,
        kills: s.kills,
        ammo: s.ammo,
        health: s.health,
        frame: hash(arena.frame()),
        features: [...s.features],
      };
    }
    const actions = Array.from({ length: 64 }, (_, i) => (i % 4 === 0 ? 2 : 1));
    const first = rollout(9000, actions),
      repeat = rollout(9000, actions);
    assert.deepEqual(first, repeat);
    const mirrored = rollout(
      9000,
      actions.map((i) => (i === 1 ? 0 : i)),
    );
    assert.notEqual(first.frame, mirrored.frame);
    assert.notDeepEqual(first.features.slice(0, 9), mirrored.features.slice(0, 9));
    assert.equal(first.tic, 128);
    assert.equal(first.features[12], 1);
    assert.equal(first.features[11], 0);
    assert.ok(first.ammo < 26 && first.ammo >= 0);
    arena.reset(9231);
    assert.notEqual(hash(arena.frame()), start);
    arena.reset(9000);
    assert.equal(hash(arena.frame()), start);
  });

  test('a heuristic episode terminates with kills and bounded region features', () => {
    let s = arena.reset(9000),
      steps = 0;
    while (!s.done && steps++ < 1100) {
      const f = s.features;
      const left = f.slice(0, 4).reduce((a, b) => a + b, 0),
        right = f.slice(5, 9).reduce((a, b) => a + b, 0);
      s = arena.step(f[4] > 0.001 ? 2 : left > right ? 0 : 1);
      assert.ok(s.features.slice(0, 9).every((x) => Number.isFinite(x) && x >= 0 && x <= 1));
    }
    assert.ok(s.done);
    assert.ok(s.kills > 0);
  });
});

describe('v0.3 movement and threat sensor', () => {
  test('retreat moves the player and keeps firing', () => {
    const initial = arena.reset(9000).threat;
    assert.ok(initial.visible && initial.distance > 500 && initial.backClearance > 600);
    assert.equal(initial.closing, 0);
    function first16(back: boolean) {
      arena.reset(9000);
      for (let i = 0; i < 8; i++) arena.step(2, back);
      const s = arena.state();
      return {
        x: s.x,
        y: s.y,
        angle: s.angle,
        ammo: s.ammo,
        health: s.health,
        retreatDisplacement: s.telemetry.retreatDisplacement,
      };
    }
    const frozen = first16(false),
      retreat = first16(true);
    assert.equal(frozen.x, 0);
    assert.equal(frozen.y, 0);
    assert.ok(retreat.x < -30 && Math.abs(retreat.y) < 1);
    assert.ok(retreat.ammo < 26 && frozen.ammo === retreat.ammo);
    assert.deepEqual(retreat, first16(true));
    const tasks: Record<string, { angle: number; displacement: number; shots: number }> = {};
    for (const [i, n] of ['left', 'right', 'fire'].entries()) {
      arena.reset(9000);
      for (let j = 0; j < 12; j++) arena.step(i, true);
      const s = arena.state();
      assert.ok(s.telemetry.retreatDisplacement > 10);
      tasks[n] = { angle: s.angle, displacement: s.telemetry.retreatDisplacement, shots: s.telemetry.shots };
    }
    assert.notEqual(tasks.left.angle, tasks.right.angle);
    assert.equal(tasks.left.shots, 0);
    assert.equal(tasks.right.shots, 0);
    assert.ok(tasks.fire.shots > 0);
  });

  test('threat identity, closing speed and hit telemetry', () => {
    let multi = 0,
      adverse = 0,
      checkedClosing = 0;
    const targets = new Set<number>();
    for (let seed = 9000; seed < 9003; seed++) {
      arena.reset(seed);
      let previous: ArenaState | null = null;
      for (let j = 0; j < 1000 && !arena.state().done; j++) {
        const s = arena.state(),
          t = s.threat;
        assert.equal(
          t.visible,
          s.features.slice(0, 9).some((x) => x > 0),
        );
        assert.ok(t.x >= -1 && t.x <= 1 && t.backClearance >= 0);
        if (t.visible) {
          assert.ok(t.id > 0 && t.distance > 0);
          targets.add(t.id);
          if (previous && previous.threat.id === t.id) {
            assert.ok(Math.abs(t.closing - (previous.threat.distance - t.distance) / (s.tic - previous.tic)) < 0.001);
            checkedClosing++;
          }
        } else {
          assert.equal(t.id, 0);
          assert.equal(t.closing, 0);
          assert.equal(t.aligned, false);
        }
        if (t.visibleCount >= 2) multi++;
        if (t.closing < 0) adverse++;
        previous = s;
        arena.step(
          t.aligned ? 2 : t.x < 0 ? 0 : 1,
          seed === 9000 || (t.visible && t.distance < 208 && t.backClearance > 24),
        );
      }
    }
    assert.ok(targets.size > 5 && multi > 0 && adverse > 0 && checkedClosing > 0);
    const t = arena.state().telemetry;
    assert.ok(t.hits > 0 && t.nearestHits > 0 && t.multiHits > 0);
    assert.ok(
      t.shots >= t.hits && t.hits >= t.nearestHits && t.multiShots >= t.multiHits && t.multiHits >= t.multiNearestHits,
    );
  });
});

describe('visible actors, motion and combat events', () => {
  function checkPose(s: ArenaState): void {
    assert.deepEqual(s.pose, { x: s.x, y: s.y, yawDeg: s.angle });
    assert.equal(s.actors.length, s.threat.visibleCount);
    assert.equal(
      s.actors.length > 0,
      s.features.slice(0, 9).some((x) => x > 0),
    );
    if (s.actors.length) assert.equal(s.actors[0].id, s.threat.id);
    let nearest = -1;
    const ids = new Set<number>();
    for (const t of s.actors) {
      assert.ok(t.id > 0 && !ids.has(t.id));
      ids.add(t.id);
      assert.ok(t.distance >= nearest);
      nearest = t.distance;
      close(Math.hypot(t.worldX - s.x, t.worldY - s.y), t.distance);
      close(norm((Math.atan2(t.worldY - s.y, t.worldX - s.x) * 180) / Math.PI - t.bearingDeg), 0);
      close(norm(t.bearingDeg - s.angle), t.relativeYawDeg);
      close((Math.atan(t.x) * 180) / Math.PI, t.screenBearingDeg);
      assert.ok(t.x >= -1 && t.x <= 1);
    }
  }

  test('forward, backward, idle and turning commands', () => {
    function movement(action: number, back = false, forward = false) {
      arena.reset(9000);
      let s = arena.state();
      for (let i = 0; i < 8; i++) s = arena.step(action, back, forward);
      return { x: s.x, y: s.y, yaw: s.angle, prev: [...s.features].slice(11), shots: s.telemetry.shots };
    }
    const forward = movement(3, false, true),
      back = movement(3, true),
      idle = movement(3),
      left = movement(0),
      right = movement(1);
    assert.ok(forward.x > 60 && back.x < -60);
    assert.equal(idle.x, 0);
    assert.equal(idle.y, 0);
    assert.equal(idle.yaw, 0);
    assert.equal(idle.shots, 0);
    assert.deepEqual(forward.prev, [0, 0, 0]);
    assert.ok(norm(left.yaw) > 0 && norm(right.yaw) < 0);
    assert.throws(() => arena.step(3, true, true));
  });

  test('per-decision events reconcile with health, ammo and telemetry', () => {
    const totals: Record<string, number> = {
      observations: 0,
      pistolEvents: 0,
      shotsHit: 0,
      punchEvents: 0,
      punchHits: 0,
      punchMisses: 0,
      laggedAttacks: 0,
      firstSubticEvents: 0,
      secondSubticEvents: 0,
      damage: 0,
      fistStates: 0,
      weaponSwitching: 0,
    };
    for (const seed of [9000, 9001, 9002]) {
      let s = arena.reset(seed),
        shots = 0,
        hits = 0,
        punches = 0,
        punchHits = 0,
        damage = 0;
      for (let j = 0; !s.done && j < 1051; j++) {
        const t = s.threat;
        const aim = t.aligned ? 2 : t.x < 0 ? 0 : 1;
        // The pistol phase uses the v0.3 diagnostic; sparse attacks after the weapon change exercise misses and delayed swings.
        const action = s.weapon === 'fist' && j % 10 < 5 ? 2 : aim;
        const previous = s;
        s = arena.step(action, seed === 9000 || (t.visible && t.distance < 208 && t.backClearance > 24));
        checkPose(s);
        const e = s.events;
        assert.equal(e.healthBefore, previous.health);
        assert.equal(e.healthAfter, s.health);
        assert.equal(e.damage, e.damageBySubtic[0] + e.damageBySubtic[1]);
        assert.equal(e.damage, e.healthBefore - e.healthAfter);
        assert.equal(e.shots.length, previous.ammo - s.ammo);
        assert.ok(['pistol', 'fist'].includes(s.weapon));
        if (s.weaponReady) assert.ok(!s.weaponSwitching && s.health > 0 && (s.weapon === 'fist' || s.ammo > 0));
        for (const events of [e.shots, e.punches]) {
          for (const ev of events) {
            assert.ok(ev.tic > previous.tic && ev.tic <= s.tic);
            assert.equal(ev.hit, ev.targetId > 0);
            if (ev.tic === previous.tic + 1) totals.firstSubticEvents++;
            else totals.secondSubticEvents++;
            if (action !== 2) totals.laggedAttacks++;
          }
        }
        shots += e.shots.length;
        hits += e.shots.filter((x) => x.hit).length;
        punches += e.punches.length;
        punchHits += e.punches.filter((x) => x.hit).length;
        damage += e.damage;
        totals.observations++;
        totals.fistStates += Number(s.weapon === 'fist');
        totals.weaponSwitching += Number(s.weaponSwitching);
      }
      assert.ok(s.done);
      assert.equal(s.telemetry.shots, shots);
      assert.equal(s.telemetry.hits, hits);
      assert.equal(s.telemetry.punches, punches);
      assert.equal(s.telemetry.punchHits, punchHits);
      assert.equal(s.telemetry.punchMisses, punches - punchHits);
      assert.equal(s.telemetry.damageTaken, damage);
      totals.pistolEvents += shots;
      totals.shotsHit += hits;
      totals.punchEvents += punches;
      totals.punchHits += punchHits;
      totals.punchMisses += punches - punchHits;
      totals.damage += damage;
    }
    for (const [k, v] of Object.entries(totals)) assert.ok(v > 0, `Missing ${k}`);
  });
});

describe('v0.5 visible enemy facing', () => {
  test('the public binary exports no bite-audit hooks', async () => {
    const bytes = await (await fetch(siteUrl('engine/arena.wasm'))).arrayBuffer();
    const wasm = await WebAssembly.compile(bytes);
    assert.ok(WebAssembly.Module.exports(wasm).every((x) => !x.name.includes('bite')));
  });

  test('facing fields match an independent dot and cross product', () => {
    const initial = arena.reset(9000).actors[0];
    assert.equal(initial.id, 3);
    assert.equal(initial.yawDeg, 135);
    assert.ok(Math.abs(initial.facingErrorDeg - 29.9918329111199) < 1e-6);
    const counts = { empty: 0, lookingTowardButOffCrosshair: 0, onCrosshairButLookingAside: 0 };
    let longestFacingRun = 0,
      absenceThenReappearance = false;
    for (const seed of [9000, 9001, 9002, 9003, 9004, 9005]) {
      let state = arena.reset(seed);
      const runs = new Map<number, number>(),
        lastSeen = new Map<number, number>();
      while (!state.done && state.tic < 550) {
        assert.equal(state.actors.length, state.threat.visibleCount);
        const hasVisiblePixels = state.features.slice(0, 9).some((value) => value > 0);
        assert.equal(state.actors.length > 0, hasVisiblePixels);
        if (!hasVisiblePixels) counts.empty++;
        const visibleIds = new Set<number>();
        for (const actor of state.actors) {
          assert.ok(!visibleIds.has(actor.id));
          visibleIds.add(actor.id);
          const dx = state.x - actor.worldX,
            dy = state.y - actor.worldY;
          const yaw = (actor.yawDeg * Math.PI) / 180,
            distance = Math.hypot(dx, dy);
          assert.ok(actor.yawDeg >= 0 && actor.yawDeg < 360);
          assert.ok(actor.facingErrorDeg >= -180 && actor.facingErrorDeg < 180);
          const dot = (dx * Math.cos(yaw) + dy * Math.sin(yaw)) / distance;
          const cross = (dy * Math.cos(yaw) - dx * Math.sin(yaw)) / distance;
          assert.ok(Math.abs(dot - actor.facingCos) < 1e-10);
          assert.ok(Math.abs(cross - Math.sin((actor.facingErrorDeg * Math.PI) / 180)) < 1e-10);
          if (Math.abs(actor.facingErrorDeg) < 10 && !actor.aligned) counts.lookingTowardButOffCrosshair++;
          if (Math.abs(actor.facingErrorDeg) > 25 && actor.aligned) counts.onCrosshairButLookingAside++;
          const seen = lastSeen.get(actor.id);
          if (seen !== undefined && seen < state.tic - 2) absenceThenReappearance = true;
          lastSeen.set(actor.id, state.tic);
          if (Math.abs(actor.facingErrorDeg) <= 15 && distance > 110 && !state.events.damage) {
            const start = runs.get(actor.id) ?? state.tic;
            runs.set(actor.id, start);
            longestFacingRun = Math.max(longestFacingRun, state.tic - start);
          } else runs.delete(actor.id);
        }
        for (const id of runs.keys()) if (!visibleIds.has(id)) runs.delete(id);
        const t = state.threat;
        // Turn on two seeds to observe disappearing and reappearing lives.
        const aim = seed % 3 === 0 ? 3 : seed % 3 === 1 ? 0 : t.visible && !t.aligned ? (t.x < 0 ? 0 : 1) : 3;
        const back = seed % 3 === 2 && t.visible && t.distance < 180;
        state = arena.step(aim, back);
      }
    }
    assert.ok(counts.empty > 0 && absenceThenReappearance);
    assert.ok(counts.lookingTowardButOffCrosshair > 0 && counts.onCrosshairButLookingAside > 0);
    assert.ok(longestFacingRun >= 22, 'No at-distance continuous facing counterexample');
  });
});

describe('episode cap', () => {
  test('setLimit caps the episode and 0 removes the cap', () => {
    assert.ok(arena.configurable());
    assert.equal(arena.setLimit(40), 40);
    let s = arena.reset(9000);
    while (!s.done) s = arena.step(3);
    assert.equal(s.tic, 40);
    assert.equal(arena.setLimit(0), 0);
    s = arena.reset(9000);
    for (let i = 0; i < 30; i++) s = arena.step(3);
    assert.ok(!s.done || s.health <= 0);
    arena.setLimit(2100);
  });
  test('step rejects invalid commands', () => {
    assert.throws(() => arena.step(4), RangeError);
    assert.throws(() => arena.step(1.5), RangeError);
  });
});
