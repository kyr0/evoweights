/** Live decision policies: the original FP32 model's raw logits, or the W4 model with its signed-code controller. */
import type { ArenaState } from '../engine/arena.ts';
import type { CoreDecision, HeadOp, HeadVariant, Precision } from '../model/kumo.ts';
import { siteUrl } from '../shared/site.ts';
import { createCombatController } from '../tactical/combat-approach.ts';
import { createFacingGuard } from '../tactical/facing-guard.ts';
import { tacticalDecision } from '../tactical/tactical.ts';
import type { Controller, PolicyDecision } from '../tactical/types.ts';

/** The two shipped live models: the edited W4 DNP model and the original FP32 weights. */
export type PolicyName = 'dnp' | 'original';

/** A W4 revision to play instead of the shipped head: native head edits plus its controller codes. */
export interface PolicyRevision {
  ops: HeadOp[];
  tactical: Controller;
}

export interface ModelChoice {
  precision: Precision;
  head: HeadVariant;
}

export interface DecisionPolicy extends ModelChoice {
  reset(): void;
  decide(state: ArenaState, core: CoreDecision): PolicyDecision;
}

export function modelFor(policy: string, revision?: PolicyRevision | null): ModelChoice {
  if (revision) {
    if (policy !== 'dnp' || !Array.isArray(revision.ops) || !revision.tactical)
      throw new Error('Expected a compatible W4 model revision');
    return { precision: 'w4', head: 'custom' };
  }
  if (policy === 'original') return { precision: 'fp32', head: 'fp32' };
  if (policy === 'dnp') return { precision: 'w4', head: 'edited' };
  throw new RangeError('Unknown live decision policy');
}

async function fetchRecipe(name: string): Promise<unknown> {
  const response = await fetch(siteUrl('tactical/' + name));
  if (!response.ok) throw new Error('Could not load ' + name);
  return response.json();
}

export async function createDecisionPolicy(
  policy: string,
  readRecipe: (name: string) => Promise<unknown> = fetchRecipe,
  revision?: PolicyRevision | null,
): Promise<DecisionPolicy> {
  const model = modelFor(policy, revision);
  if (policy === 'original') {
    return {
      ...model,
      reset() {},
      decide(_state, core) {
        return { ...core, forward: false, backward: false };
      },
    };
  }
  if (revision) return buildW4Controller(revision.tactical);
  const [graft, combat, facing] = await Promise.all(
    ['graft.json', 'combat-weights.json', 'facing-weights.json'].map(readRecipe),
  );
  return buildW4Controller({ graft, combat, facing } as Controller, model.head);
}

export function buildW4Controller(
  { graft, combat: weights, facing }: Controller,
  head: HeadVariant = 'custom',
): DecisionPolicy {
  const combat = createCombatController(weights),
    guard = createFacingGuard(facing);
  return {
    precision: 'w4',
    head,
    reset() {
      combat.reset();
      guard.reset();
    },
    decide(state, core) {
      const base = tacticalDecision(state, core, graft);
      return guard.decide(state, combat.decide(state, base));
    },
  };
}
