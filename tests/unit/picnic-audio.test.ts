import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  OUCH_SOUNDS,
  PICNIC_SOUNDS,
  ouchVariant,
  picnicSoundsBetween,
  type PicnicAudioState,
} from '../../src/app/picnic-audio.ts';

const state = (tic: number, change: Partial<PicnicAudioState> = {}): PicnicAudioState => ({
  tic,
  ammo: 26,
  health: 100,
  picnic: {
    bearsFed: 0,
    bearsBefriended: 0,
    timesBitten: 0,
    hearts: 5,
    hugging: false,
    ending: false,
    unfolding: false,
  },
  ...change,
});

test('first, repeated and reset snapshots do not replay old sound events', () => {
  const current = state(80, { ammo: 0, health: 40 });
  expect(picnicSoundsBetween(undefined, current)).toEqual([]);
  expect(picnicSoundsBetween(current, current)).toEqual([]);
  expect(picnicSoundsBetween(current, state(0))).toEqual([]);
});

test('the last honey produces one plop, empty click and unfold, even with both depletion signals', () => {
  const before = state(12, { ammo: 1 });
  const current = state(14, { ammo: 0, picnic: { ...before.picnic!, unfolding: true } });
  expect(picnicSoundsBetween(before, current)).toEqual(['plop', 'empty-click', 'unfold']);
  expect(picnicSoundsBetween(current, { ...current, tic: 16 })).toEqual([]);
});

test('a skipped frame coalesces repeated events and includes each observed interaction', () => {
  const before = state(30);
  const current = state(48, {
    ammo: 6,
    health: 60,
    picnic: {
      ...before.picnic!,
      bearsFed: 2,
      bearsBefriended: 1,
      timesBitten: 2,
      hearts: 3,
    },
  });
  expect(picnicSoundsBetween(before, current)).toEqual(['plop', 'eating', 'hug', 'mmmrrraww', 'ouch']);
});

test('every supplied ouch variant is selected by its equal random interval', () => {
  for (let i = 0; i < OUCH_SOUNDS.length; i++) {
    expect(ouchVariant(i / OUCH_SOUNDS.length)).toBe(OUCH_SOUNDS[i]);
    expect(ouchVariant((i + 0.999) / OUCH_SOUNDS.length)).toBe(OUCH_SOUNDS[i]);
  }
});

test('the emergency honey reveal sounds once and a missing picnic packet remains safe', () => {
  const before = state(100);
  const ended = state(102, { picnic: { ...before.picnic!, ending: true } });
  expect(picnicSoundsBetween(before, ended)).toEqual(['finale']);
  expect(picnicSoundsBetween(ended, { ...ended, tic: 104 })).toEqual([]);
  expect(picnicSoundsBetween(state(0, { picnic: undefined }), state(2))).toEqual([]);
});

test('all shipped sounds are real bounded PCM waveforms matching their integrity manifest', () => {
  const directory = join(import.meta.dir, '../../public/assets/huggingdoom/sounds');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
    sounds: { file: string; seconds: number; sha256: string }[];
  };
  for (const name of PICNIC_SOUNDS) expect(manifest.sounds.some((sound) => sound.file === `${name}.wav`)).toBe(true);
  for (const sound of manifest.sounds) {
    const bytes = readFileSync(join(directory, sound.file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sound.sha256);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
    expect(bytes.readUInt16LE(20)).toBe(1); // PCM
    expect(bytes.readUInt16LE(22)).toBe(1); // Mono
    expect(bytes.readUInt32LE(24)).toBe(44100);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(bytes.toString('ascii', 36, 40)).toBe('data');
    expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
    expect((bytes.length - 44) / 2 / 44100).toBeCloseTo(sound.seconds, 4);
    let peak = 0;
    for (let offset = 44; offset < bytes.length; offset += 2)
      peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
    expect(peak).toBeGreaterThan(1000);
    expect(peak).toBeLessThanOrEqual(10486); // 0.32 full scale, one integer of rounding tolerance.
    expect(bytes.readInt16LE(44)).toBe(0);
    expect(Math.abs(bytes.readInt16LE(bytes.length - 2))).toBeLessThan(16);
  }
});
