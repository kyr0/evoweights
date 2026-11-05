/** Game rules exercised against the actual shipped WASM and generated IWAD. */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createArena, type Arena, type ArenaState } from '../../src/engine/arena.ts';

const assetRoot = new URL('../../public/engine/', import.meta.url);
const game = await createArena({
  seed: 9000,
  readAsset: async (name) => new Uint8Array(await readFile(new URL(name, assetRoot))),
});

/** A transparent diagnostic controller; no neural inference or hidden state. */
function approach(game: Arena, state: ArenaState): ArenaState {
  const threat = state.threat;
  const action = threat.visible ? (Math.abs(threat.x) > 0.1 ? (threat.x < 0 ? 0 : 1) : 2) : 1;
  return game.step(action, false, state.ammo === 0 && threat.visible && Math.abs(threat.x) < 0.4);
}

describe('HuggingDOOM honey, hugs and hearts', () => {
  test('starts with the original 26 rounds, five hearts and the existing policy ABI', () => {
    const state = game.reset(9000);
    expect(game.ruleset()).toBe('huggingdoom-v1');
    expect(state.ammo).toBe(26);
    expect(state.features[9]).toBe(26);
    expect(state.health).toBe(100);
    expect(state.picnic.hearts).toBe(5);
    expect(state.picnic.bearsFed + state.picnic.bearsBefriended + state.picnic.timesBitten).toBe(0);
    expect(state.features).toHaveLength(14);
    expect(game.frame()).toHaveLength(320 * 200 * 4);
  });

  test('ammo budget, model input and spending match the original engine across resets', async () => {
    const original = await createArena({
      seed: 9000,
      readAsset: async (name) =>
        new Uint8Array(await readFile(new URL('../fixtures/legacy-engine/' + name, import.meta.url))),
    });
    for (const seed of [9000, 9123, 9347]) {
      let state = game.reset(seed);
      let baseline = original.reset(seed);
      expect(baseline.ammo).toBe(26);
      for (let i = 0; i < 16; i++) {
        expect(state.ammo).toBe(baseline.ammo);
        expect(state.features[9]).toBe(baseline.features[9]);
        expect(state.telemetry.shots).toBe(baseline.telemetry.shots);
        state = game.step(2);
        baseline = original.step(2);
      }
      expect(state.ammo).toBeLessThan(26);
    }
  });

  test('a honey hit seats the bear and removes it from the threat sensors', () => {
    let state = game.reset(9000);
    let fedId = 0;
    for (let i = 0; i < 500 && !state.done && !fedId; i++) {
      state = approach(game, state);
      fedId = state.events.shots.find((event) => event.hit)?.targetId ?? 0;
    }
    expect(fedId).toBeGreaterThan(0);
    expect(state.picnic.bearsFed).toBe(1);
    expect(state.picnic.bearsBefriended).toBe(0);
    expect(state.picnic.peacefulBears).toBe(1);
    expect(state.kills).toBe(1); // Compatibility field is total bears made peaceful.
    for (let i = 0; i < 50 && !state.done; i++) {
      expect(state.actors.some((actor) => actor.id === fedId)).toBe(false);
      expect(state.picnic.peacefulBears).toBeGreaterThanOrEqual(1);
      state = approach(game, state);
    }
  });

  test('honey is finite; empty hands unfold and a close hug costs no ammunition', () => {
    let state = game.reset(9000);
    let unfolded = false;
    for (let i = 0; i < 1500 && !state.done && !state.picnic.hugging; i++) {
      state = approach(game, state);
      unfolded ||= state.picnic.unfolding;
    }
    expect(unfolded).toBe(true);
    expect(state.ammo).toBe(0);
    expect(state.telemetry.shots).toBe(26);
    expect(state.weapon).toBe('fist');
    expect(state.picnic.hugging).toBe(true);
    expect(state.picnic.bearsBefriended).toBe(1);
    expect(state.events.punches.some((event) => event.hit)).toBe(true);
    const health = state.health;
    const hugged = state.picnic.bearsBefriended;
    const hugPose = state.pose;
    for (let i = 0; i < 10; i++) {
      state = game.step(2);
      expect(state.health).toBe(health);
      expect(state.ammo).toBe(0);
      expect(state.picnic.bearsBefriended).toBe(hugged);
      expect(state.events.damage).toBe(0);
      expect(state.pose).toEqual(hugPose);
    }
    expect(state.picnic.peacefulBears).toBe(state.picnic.bearsFed + state.picnic.bearsBefriended);
  });

  test('each bite costs exactly one heart; neighbours respect the grace period', () => {
    let state = game.reset(9000);
    let bites = 0;
    let lastBite = -100;
    for (let i = 0; i < 1500 && !state.picnic.ending; i++) {
      state = game.step(3);
      if (state.picnic.timesBitten > bites) {
        expect(state.events.damage).toBe(20);
        expect(state.tic - lastBite).toBeGreaterThanOrEqual(24);
        bites++;
        lastBite = state.tic;
        expect(state.picnic.timesBitten).toBe(bites);
        expect(state.picnic.hearts).toBe(5 - bites);
        expect(state.health).toBe(100 - 20 * bites);
        expect(state.picnic.dizzy).toBe(true);
      }
    }
    expect(bites).toBe(5);
    expect(state.done).toBe(false);
    expect(state.picnic.ending).toBe(true);
    expect(state.health).toBe(0);
    const lastFrame = createHash('sha256').update(game.frame()).digest('hex');
    const endingTic = state.tic;
    const activeTics = state.picnic.activeTics;
    while (!state.done && state.tic - endingTic < 100) {
      state = game.step(2, false, true);
      expect(state.picnic.timesBitten).toBe(5);
      expect(state.events.damage).toBe(0);
      expect(state.picnic.activeTics).toBe(activeTics);
    }
    expect(state.done).toBe(true);
    expect(state.tic - endingTic).toBe(70);
    expect(state.picnic.finaleProgress).toBe(1);
    expect(createHash('sha256').update(game.frame()).digest('hex')).not.toBe(lastFrame);
    expect(game.step(2).picnic).toEqual(state.picnic);
  });

  test('a bite flashes red and fades without turning the camera', () => {
    let state = game.reset(9000);
    const yaw = state.pose.yawDeg;
    // The stationary view's top-left pixel is unobstructed sky in this seed.
    const sky = [...game.frame().slice(0, 3)];
    while (!state.picnic.timesBitten && !state.done) state = game.step(3);
    expect(state.picnic.timesBitten).toBe(1);
    const flash = game.frame();
    expect(flash[0]).toBeGreaterThan(sky[0]);
    expect(flash[1]).toBeLessThan(sky[1]);
    expect(flash[2]).toBeLessThan(sky[2]);
    expect(state.pose.yawDeg).toBe(yaw);
    for (let i = 0; i < 11; i++) {
      state = game.step(3);
      expect(state.pose.yawDeg).toBe(yaw);
      expect(state.picnic.timesBitten).toBe(1);
    }
    expect([...game.frame().slice(0, 3)]).toEqual(sky);
  });

  test('the new rules replay deterministically', () => {
    function replay() {
      let state = game.reset(9123);
      while (!state.done) state = approach(game, state);
      return {
        picnic: state.picnic,
        features: [...state.features],
        telemetry: state.telemetry,
        frame: createHash('sha256').update(game.frame()).digest('hex'),
        tic: state.tic,
      };
    }
    expect(replay()).toEqual(replay());
  });
});
