/** One signed-W4 readout over visible geometry features. Kumo's original three logits form the residual path.
 * BACKWARD is a separate binary logit, independently combined with LEFT, RIGHT, or FIRE.
 * Output codes and input transforms are an explicit inspectable artifact.
 */
import type { ArenaState } from '../engine/arena.ts';
import type { CoreDecision } from '../model/kumo.ts';
import type { GraftWeights, PolicyDecision } from './types.ts';

const sat = (x: number) => Math.max(0, Math.min(1, x));

export function tacticalDecision(state: ArenaState, core: CoreDecision, graft: GraftWeights): PolicyDecision {
  const t = state.threat,
    k = graft.transform;
  if (!t || graft.format !== 'agm.dnp.tactical-graft/1')
    throw new Error('Missing v3 threat observations or invalid graft');
  const v = Number(t.visible),
    blind = 1 - v,
    aligned = v * Number(t.aligned);
  const near = v * sat((k.maxDistance - t.distance) / k.closeWidth);
  const left = v * sat(-t.x / k.angleScale),
    right = v * sat(t.x / k.angleScale);
  const fine = v * sat(1 - Math.abs(t.x) / k.fineWidth);
  const f = [
    1,
    v,
    blind,
    blind * state.features[11],
    blind * state.features[12],
    left,
    right,
    aligned,
    near * aligned,
    near,
    v * sat(t.closing / k.closingScale),
    sat((k.rearStop + k.rearMargin - t.backClearance) / k.rearMargin),
    fine,
  ];
  const z = graft.codes.map(
    (row, r) => row.reduce((s, w, i) => s + w * f[i], 0) * graft.scales[r] + (r < 3 ? core.logits[r] : 0),
  );
  const logits = z.slice(0, 3),
    action = logits.indexOf(Math.max(...logits));
  return { logits, action, backward: z[3] > 0, backwardLogit: z[3], coreLogits: core.logits };
}
