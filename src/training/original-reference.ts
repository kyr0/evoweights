/** Measure the unmodified FP32 policy on the same games used for W4 reference scores. */
import { createArena, HUGGINGDOOM_RULESET } from '../engine/arena.ts';
import { createKumoPolicy } from '../model/kumo.ts';
import { createDecisionPolicy } from '../policy/decision-policy.ts';
import { REFERENCE, referenceRecord, type ReferenceRecord } from '../revisions/reference.ts';
import { abortError } from '../shared/worker-scope.ts';
import { streamSeed } from './live-es.ts';

export async function measureOriginalReference(
  id: string,
  {
    stop = () => false,
    yieldTask = async () => {},
    progress = () => {},
  }: {
    stop?: () => boolean;
    yieldTask?: () => Promise<void>;
    progress?: (games: number, decisions: number) => void;
  } = {},
): Promise<ReferenceRecord> {
  const model = await createKumoPolicy({ precision: 'fp32' });
  try {
    const arena = await createArena({ seed: 0 });
    if (arena.ruleset() !== HUGGINGDOOM_RULESET) throw new Error('HuggingDOOM engine required for reference scores.');
    const policy = await createDecisionPolicy('original');
    const results: { tics: number; kills: number; limit: number }[] = [];
    let decisions = 0;
    for (let k = 0; k < REFERENCE.count; k++) {
      if (stop()) throw abortError();
      arena.setLimit(REFERENCE.horizon * 2);
      let state = arena.reset(streamSeed(REFERENCE.master, REFERENCE.index + k, true));
      policy.reset();
      for (let n = 0; n < REFERENCE.horizon && !state.done && !state.picnic?.ending; n++) {
        const action = policy.decide(state, model.infer(state.features, 'fp32'));
        state = arena.step(action.action, !!action.backward, !!action.forward);
        decisions++;
        if (n % 32 === 0) {
          await yieldTask();
          if (stop()) throw abortError();
        }
      }
      results.push({ tics: state.picnic?.activeTics ?? state.tic, kills: state.kills, limit: state.limit });
      progress(results.length, decisions);
    }
    return referenceRecord(results, id);
  } finally {
    model.dispose();
  }
}
