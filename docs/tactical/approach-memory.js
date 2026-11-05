/** Recently observed range closure is evidence about relative motion. It can include
 * player movement; it supplies a bounded ranking bonus, never hidden position or identity.
 */
export const APPROACH = Object.freeze({ evidenceTics: 24, maxBonus: 24, fullSpeed: 6, fullProximity: 120 });
export function recordApproach(previous, actor, tic) {
    const speed = Number.isFinite(actor.closing) ? actor.closing : 0;
    return {
        observedClosing: speed,
        closingTic: speed > 0 ? tic : (previous?.closingTic ?? null),
        closingDistance: speed > 0 ? actor.distance : (previous?.closingDistance ?? null),
        closingSpeed: speed > 0 ? speed : (previous?.closingSpeed ?? 0),
    };
}
export function approachBonus(track, tic, maxDistance) {
    if (track.closingTic == null || track.observedClosing < 0)
        return 0;
    // closingDistance is set together with closingTic; `?? 0` only satisfies the type.
    const closingDistance = track.closingDistance ?? 0;
    const age = tic - track.closingTic;
    if (age < 0 || age >= APPROACH.evidenceTics || closingDistance >= maxDistance)
        return 0;
    const freshness = 1 - age / APPROACH.evidenceTics;
    const speed = Math.min(1, track.closingSpeed / APPROACH.fullSpeed);
    const proximity = Math.min(1, (maxDistance - closingDistance) / (maxDistance - APPROACH.fullProximity));
    return APPROACH.maxBonus * freshness * speed * proximity;
}
/** Sort remembered candidates by distance and age, then again with the approach bonus; reports the order without it. */
export function rankRemembered(candidates, tic, maxDistance) {
    const base = (a) => a.distance + 0.7 * a.age;
    candidates.sort((a, b) => base(a) - base(b) || a.id - b.id);
    const firstWithoutApproach = candidates[0]?.id ?? 0;
    for (const candidate of candidates)
        candidate.approachBonus = approachBonus(candidate, tic, maxDistance);
    const ranked = (a) => base(a) - (a.approachBonus ?? 0);
    candidates.sort((a, b) => ranked(a) - ranked(b) || a.id - b.id);
    return { firstWithoutApproach, candidateCount: candidates.length };
}
