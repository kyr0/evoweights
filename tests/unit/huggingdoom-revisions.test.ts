/** Game evidence cannot cross rulesets; portable model identity can. */
import { expect, test } from 'bun:test';
import { REFERENCE, referenceGain, referenceRecord, validReference } from '../../src/revisions/reference.ts';
import {
  evaluationStorageKey,
  isCurrentEvaluation,
  openRevisionStore,
  OPUS_EDIT_ID,
  revisionId,
  SURVIVOR_ID,
  TERMINATOR_ID,
} from '../../src/revisions/store.ts';
import { siteUrl } from '../../src/shared/site.ts';
import { HUGGINGDOOM_RULESET } from '../../src/engine/arena.ts';

test('the shipped DOOM score table cannot be accepted as HuggingDOOM measurements', async () => {
  const historical = (await Bun.file(siteUrl('data/reference-v1.json')).json()) as {
    protocol: string;
    revisions: Record<string, { hash: string; tics: number[]; kills: number[] }>;
  };
  expect(historical.protocol).not.toBe(REFERENCE.protocol);
  expect(Object.keys(historical.revisions).length).toBeGreaterThan(0);
  for (const record of Object.values(historical.revisions)) {
    const old = { ...record, protocol: historical.protocol };
    expect(validReference(old)).toBe(false);
    expect(referenceGain(old, old)).toBeNull();
  }
});

test('new reference measurements compare only within the HuggingDOOM protocol', () => {
  const games = Array.from({ length: REFERENCE.count }, () => ({ tics: 100, kills: 2, limit: REFERENCE.horizon * 2 }));
  const base = referenceRecord(games, 'base-model');
  const child = referenceRecord(
    games.map((game) => ({ ...game, tics: 150, kills: 3 })),
    'child-model',
  );
  expect(base.protocol).toBe('huggingdoom-v1.reference/1');
  expect(REFERENCE.cacheKey).not.toBe('agm-arena-reference-v1');
  expect(referenceGain(child, base)?.factor).toBe(1.5);
  expect(referenceGain(child, base)?.kills?.factor).toBe(1.5);
  expect(referenceGain(child, { ...base, protocol: 'agm.dnp.reference/1' })).toBeNull();
  expect(referenceGain({ ...child, protocol: 'another-game.reference/1' }, base)).toBeNull();
});

test('old untagged and foreign-rule receipts cannot supply current-game evidence', () => {
  const receipt = { status: 'promoted', validation: { gain: 2 } };
  expect(isCurrentEvaluation({ id: 'model-id', receipt })).toBe(false);
  expect(isCurrentEvaluation({ id: 'model-id', ruleset: 'doom-v1', receipt })).toBe(false);
  expect(isCurrentEvaluation({ id: 'model-id', ruleset: REFERENCE.ruleset, receipt })).toBe(true);
  expect(isCurrentEvaluation(null)).toBe(false);
  expect(evaluationStorageKey('model-id')).not.toBe('model-id');
  expect(evaluationStorageKey('model-id')).toBe('huggingdoom-v1:model-id');
  expect(evaluationStorageKey('run-id')).not.toBe(evaluationStorageKey('model-id'));
});

test('all shipped learned weights keep their pre-theme content addresses', async () => {
  const store = await openRevisionStore();
  try {
    expect(store.builtins.survivor?.id).toBe(SURVIVOR_ID);
    expect(store.builtins.terminator?.id).toBe(TERMINATOR_ID);
    expect(store.builtins.opus?.id).toBe(OPUS_EDIT_ID);
    for (const record of Object.values(store.builtins)) {
      if (record) expect(await revisionId(record)).toBe(record.id);
    }
  } finally {
    store.close();
  }
});

test('stored evidence names the ruleset the arena reports', () => {
  // reference.ts keeps its own copy of the string; drift would tag evidence with a ruleset live training never checks.
  expect(REFERENCE.ruleset).toBe(HUGGINGDOOM_RULESET);
});
