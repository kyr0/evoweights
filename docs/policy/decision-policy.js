import { siteUrl } from '../shared/site.js';
import { createCombatController } from '../tactical/combat-approach.js';
import { createFacingGuard } from '../tactical/facing-guard.js';
import { tacticalDecision } from '../tactical/tactical.js';
export function modelFor(policy, revision) {
    if (revision) {
        if (policy !== 'dnp' || !Array.isArray(revision.ops) || !revision.tactical)
            throw new Error('Expected a compatible W4 model revision');
        return { precision: 'w4', head: 'custom' };
    }
    if (policy === 'original')
        return { precision: 'fp32', head: 'fp32' };
    if (policy === 'dnp')
        return { precision: 'w4', head: 'edited' };
    throw new RangeError('Unknown live decision policy');
}
async function fetchRecipe(name) {
    const response = await fetch(siteUrl('tactical/' + name));
    if (!response.ok)
        throw new Error('Could not load ' + name);
    return response.json();
}
export async function createDecisionPolicy(policy, readRecipe = fetchRecipe, revision) {
    const model = modelFor(policy, revision);
    if (policy === 'original') {
        return {
            ...model,
            reset() { },
            decide(_state, core) {
                return { ...core, forward: false, backward: false };
            },
        };
    }
    if (revision)
        return buildW4Controller(revision.tactical);
    const [graft, combat, facing] = await Promise.all(['graft.json', 'combat-weights.json', 'facing-weights.json'].map(readRecipe));
    return buildW4Controller({ graft, combat, facing }, model.head);
}
export function buildW4Controller({ graft, combat: weights, facing }, head = 'custom') {
    const combat = createCombatController(weights), guard = createFacingGuard(facing);
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
