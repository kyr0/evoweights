/** Revision identity, the portable weight snapshot format, patch documents, diffs and reference arithmetic. */
import { afterAll, describe, expect, test } from 'bun:test';
import type { HeadOp } from '../../src/model/kumo.ts';
import { controllerDiff, controllerSlots, diffFileName, nativeDiff } from '../../src/revisions/diff.ts';
import {
  BASE_FINGERPRINT,
  makeHeadPatch,
  parseHeadPatch,
  probeHead,
  type ReleasedHead,
} from '../../src/revisions/patch-codec.ts';
import {
  ratioOfSums,
  rankReferences,
  REFERENCE,
  referenceGain,
  referenceRecord,
  validReference,
} from '../../src/revisions/reference.ts';
import {
  extendWeightSnapshot,
  neutralController,
  OPUS_EDIT_ID,
  openRevisionStore,
  readWeightSnapshot,
  revisionId,
  SURVIVOR_ID,
  TERMINATOR_ID,
} from '../../src/revisions/store.ts';
import { TRUST } from '../../src/revisions/trust.ts';
import { siteUrl } from '../../src/shared/site.ts';
import { packDir, servePublic } from './static-server.ts';

const head = (await Bun.file(siteUrl('data/practice-head.json')).json()) as ReleasedHead;
const flip = (row: number, col: number): HeadOp => {
  const old = TRUST.head.codes[row * 1024 + col];
  return [row, col, old, old === 7 ? 6 : old + 1];
};

describe('revision store without IndexedDB', async () => {
  const server = servePublic(),
    packs = servePublic(packDir);
  const store = await openRevisionStore({ baseURL: new URL('model/', server.url), packBaseURL: packs.url });
  afterAll(() => {
    server.stop();
    packs.stop();
  });

  test('built-in releases load with their pinned content addresses', () => {
    expect(store.persistent).toBe(false);
    expect(store.builtins.survivor?.id).toBe(SURVIVOR_ID);
    expect(store.builtins.terminator?.id).toBe(TERMINATOR_ID);
    expect(store.builtins.opus?.id).toBe(OPUS_EDIT_ID);
    expect(store.builtins.original.precision).toBe('fp32');
    expect(store.builtins.shipped.parentId).toBe(store.builtins.original.id);
  });

  test('a revision ID ignores op order and depends on every code', async () => {
    const { shipped } = store.builtins;
    const recipe = {
      precision: 'w4' as const,
      parentId: shipped.parentId,
      ops: shipped.ops,
      controller: shipped.controller,
    };
    expect(await revisionId({ ...recipe, ops: [...shipped.ops].reverse() })).toBe(shipped.id);
    const controller = structuredClone(shipped.controller!);
    controller.facing.code = controller.facing.code === 7 ? 6 : controller.facing.code + 1;
    expect(await revisionId({ ...recipe, controller })).not.toBe(shipped.id);
  });

  test('revision validation rejects foreign fields and out-of-range codes', async () => {
    const { shipped } = store.builtins;
    const recipe = {
      precision: 'w4' as const,
      parentId: shipped.parentId,
      ops: shipped.ops,
      controller: shipped.controller,
    };
    const wide = structuredClone(shipped.controller!);
    wide.combat.codes[0][0] = 8;
    await expect(revisionId({ ...recipe, controller: wide })).rejects.toThrow('Invalid signed controller parameter.');
    const changed = structuredClone(shipped.controller!);
    changed.combat.reach += 1;
    await expect(revisionId({ ...recipe, controller: changed })).rejects.toThrow('Incompatible combat reach.');
    await expect(revisionId({ ...recipe, parentId: 'x' })).rejects.toThrow('Invalid parent revision ID.');
  });

  test('the neutral controller keeps the transforms and zeroes every code', () => {
    const neutral = neutralController();
    expect(controllerSlots(neutral).every((s) => s.value === 0)).toBe(true);
    expect(neutral.combat.reach).toBe(TRUST.controller.combat.reach);
  });

  test('an exported snapshot verifies and a child extends it', async () => {
    const snapshot = await store.exportWeights(store.builtins.shipped.id);
    const read = await readWeightSnapshot(snapshot);
    expect(read.tip.id).toBe(store.builtins.shipped.id);
    expect(read.lineage.map((r) => r.kind)).toEqual(['original', 'shipped']);
    const ops = [...TRUST.edited.filter((op) => op[1] !== 0 || op[0] !== 2), flip(0, 3)];
    const child = await extendWeightSnapshot(snapshot, {
      parentId: read.tip.id,
      ops,
      controller: TRUST.controller,
      name: 'Test child',
    });
    const extended = await readWeightSnapshot(child);
    expect(extended.lineage.length).toBe(3);
    expect(extended.tip.parentId).toBe(read.tip.id);
    await expect(
      extendWeightSnapshot(snapshot, { parentId: read.tip.id, ops: TRUST.edited, controller: TRUST.controller }),
    ).rejects.toThrow('must change at least one effective weight');
  }, 30000);

  test('a corrupted snapshot is rejected', async () => {
    const bytes = new Uint8Array(await (await store.exportWeights(store.builtins.shipped.id)).arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    await expect(readWeightSnapshot(new Blob([bytes]))).rejects.toThrow('Materialized head differs from signed edits.');
    await expect(readWeightSnapshot(new Blob([bytes.slice(0, 11)]))).rejects.toThrow('truncated');
  }, 30000);

  test('display names reject markup, control and bidirectional-override characters', async () => {
    const snapshot = await store.exportWeights(store.builtins.shipped.id);
    const child = (name: string) =>
      extendWeightSnapshot(snapshot, {
        parentId: store.builtins.shipped.id,
        ops: [flip(0, 3)],
        controller: TRUST.controller,
        name,
      });
    for (const name of ['a\u202eb', 'a\u2066b', 'a<b', 'a\u0007b', ' ', 'x'.repeat(97)])
      await expect(child(name)).rejects.toThrow('Invalid revision display name.');
    expect((await readWeightSnapshot(await child('  R3 · ok  '))).tip.name).toBe('R3 · ok');
  }, 30000);

  test('writes need persistent storage', async () => {
    await expect(store.promote({ parentId: store.builtins.shipped.id, ops: [], controller: null })).rejects.toThrow(
      'Persistent revision storage is unavailable.',
    );
  });
});

describe('native patch documents', () => {
  test('make and parse round-trip', () => {
    const ops = [flip(2, 7), flip(0, 1)];
    const patch = makeHeadPatch(ops, 'Hypothesis.', 'Prediction.', head);
    expect(patch.base_sha256).toBe(BASE_FINGERPRINT);
    expect(parseHeadPatch(JSON.stringify(patch), head).ops).toEqual(ops);
  });
  test('stale and duplicate edits are rejected', () => {
    const op = flip(1, 9);
    expect(() => makeHeadPatch([[1, 9, op[3], op[2]]], 'h', 'p', head)).toThrow('Stale expected code');
    expect(() => makeHeadPatch([op, op], 'h', 'p', head)).toThrow('Duplicate edit');
    expect(() => makeHeadPatch([op], ' ', 'p', head)).toThrow('A nonempty hypothesis is required.');
  });
  test('probeHead adds (new − old) × scale × activation to the edited row only', () => {
    const op = flip(2, 70);
    const record = {
      fingerprint: BASE_FINGERPRINT,
      baselineLogits: [0.5, -1, 2],
      hidden: Array.from({ length: 1024 }, (_, i) => i / 1024),
    };
    const probe = probeHead([op], head, record);
    expect(probe.delta[0]).toBe(0);
    expect(probe.delta[2]).toBeCloseTo((op[3] - op[2]) * head.scales[2 * 16 + 1] * (70 / 1024), 12);
    expect(probe.baselineAction).toBe(2);
  });
});

describe('diffs', () => {
  test('nativeDiff reports codes that differ relative to the base', () => {
    const a = [flip(0, 1)],
      b = [flip(0, 1), flip(1, 2)];
    expect(nativeDiff(a, b)).toEqual([{ row: 1, col: 2, base: b[1][2], before: b[1][2], after: b[1][3] }]);
    expect(nativeDiff(a, a)).toEqual([]);
  });
  test('controllerDiff lists changed slots with paths', () => {
    const to = structuredClone(TRUST.controller) as typeof TRUST.controller;
    to.graft.codes[1][2] += to.graft.codes[1][2] === 7 ? -1 : 1;
    expect(controllerDiff(TRUST.controller, to).map((c) => c.path)).toEqual([['graft', 1, 2]]);
    expect(controllerSlots(TRUST.controller).length).toBe(119);
  });
  test('diffFileName is filesystem safe', () => {
    expect(diffFileName({ name: 'R3 · <x>/y', id: 'abcdef0123456789' })).toBe('agm-diff-R3-x-y-23456789.json');
  });
});

describe('reference set arithmetic', () => {
  test('rankings include every measured model, start at one without FP32, and share survival ties', () => {
    const score = (tics: number, kills = 1) => ({
      protocol: REFERENCE.protocol,
      hash: 'measured',
      tics: Array(48).fill(tics),
      kills: Array(48).fill(kills),
    });
    const child = score(300);
    expect(rankReferences([['child', child]])).toEqual([{ id: 'child', rank: 1, tics: 14400, kills: 48 }]);
    const ranked = rankReferences([
      ['original', score(100)],
      ['child', child],
      ['sibling', score(300, 2)],
      ['other-line', score(200)],
      ['historical', { ...score(1000), protocol: 'agm.dnp.reference/1' }],
    ]);
    expect(ranked.map(({ id, rank }) => [id, rank])).toEqual([
      ['child', 1],
      ['sibling', 1],
      ['other-line', 3],
      ['original', 4],
    ]);
  });
  test('ratioOfSums and referenceGain', () => {
    expect(ratioOfSums([1, 1], [2, 2])).toEqual({ factor: 2, se: 0, n: 2 });
    expect(ratioOfSums([0, 0], [1, 1])).toBeNull();
    const base = { protocol: REFERENCE.protocol, hash: 'b', tics: Array(48).fill(100), kills: Array(48).fill(2) };
    const child = { ...base, hash: 'c', tics: base.tics.map((t, i) => (i < 24 ? t * 2 : t)) };
    const gain = referenceGain(child, base)!;
    expect(gain.factor).toBe(1.5);
    expect(gain.better).toBe(24);
    expect(gain.worse).toBe(0);
    expect(referenceGain({ ...child, tics: [1] }, base)).toBeNull();
  });
  test('referenceRecord requires 48 games on a ten-minute-capable engine', () => {
    const games = Array.from({ length: 48 }, () => ({ tics: 5, kills: 1, limit: REFERENCE.horizon * 2 }));
    expect(validReference(referenceRecord(games, 'h'))).toBe(true);
    expect(() => referenceRecord(games.slice(1), 'h')).toThrow();
    expect(() =>
      referenceRecord(
        games.map((g) => ({ ...g, limit: 2100 })),
        'h',
      ),
    ).toThrow('ten-minute');
  });
});
