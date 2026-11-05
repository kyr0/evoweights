/** Fixed reference set for the total gain ("Total") of the revision tree.
 *
 * Every W4 revision plays the same 48 games: stream master 0, indices 0xC000000 + k (validation parity). The space is
 * disjoint from EDNO directions (0x1000000), protocol-6 validation (0x4000000), EDNO validation (0x6000000), race (0x7000000),
 * held-out evaluation (0x8000000), crossing (0x9000000), explanation (0xA000000) and the scan tools (0xB000000, 0xB100000).
 * Because all revisions share these seeds, totals chain exactly: total(child) = total(parent) × reference step(child). Promotion
 * receipts keep their own validation seeds; their steps are selection evidence and are not used here.
 * Horizon: ten minutes, the curriculum maximum. At one minute 19 of 48 games of EDNO W4 · R1 hit the cap, which compresses the totals
 * of strong lines; a game costs only as long as it survives, so the long horizon adds no cost for weak revisions.
 * This module has no imports so the page can use the arithmetic without loading the engine. */
export const REFERENCE = Object.freeze({
    protocol: 'agm.dnp.reference/1',
    master: 0,
    index: 0xc000000,
    count: 48,
    horizon: 10500,
});
export function referenceRecord(results, hash) {
    if (!Array.isArray(results) || results.length !== REFERENCE.count)
        throw new Error('Reference measurement needs ' + REFERENCE.count + ' games');
    if (results.some((r) => (r.limit ?? 0) < REFERENCE.horizon * 2))
        throw new Error('The engine build does not honour the ten-minute reference horizon');
    return { protocol: REFERENCE.protocol, hash, tics: results.map((r) => r.tics), kills: results.map((r) => r.kills) };
}
export function validReference(x) {
    const r = x;
    return (!!r &&
        r.protocol === REFERENCE.protocol &&
        [r.tics, r.kills].every((a) => Array.isArray(a) && a.length === REFERENCE.count && a.every((v) => Number.isFinite(v) && v >= 0)));
}
/** Ratio of sums of `b` over `a` on the shared seeds with a delta-method standard error (paired per seed). */
export function ratioOfSums(a, b) {
    const n = a.length;
    if (n !== b.length || n < 2)
        return null;
    const A = a.reduce((s, x) => s + x, 0), B = b.reduce((s, x) => s + x, 0);
    if (!(A > 0))
        return null;
    const factor = B / A, meanA = A / n, ss = b.reduce((s, x, i) => s + (x - factor * a[i]) ** 2, 0);
    return { factor, se: Math.sqrt(ss / (n * (n - 1))) / meanA, n };
}
/** Survival and kills of a revision against a reference revision (its lineage root or its parent). */
export function referenceGain(child, base) {
    if (!validReference(child) || !validReference(base))
        return null;
    const survival = ratioOfSums(base.tics, child.tics);
    if (!survival)
        return null;
    return {
        factor: survival.factor,
        se: survival.se,
        seeds: survival.n,
        kills: ratioOfSums(base.kills, child.kills),
        better: child.tics.filter((x, i) => x > base.tics[i]).length,
        worse: child.tics.filter((x, i) => x < base.tics[i]).length,
    };
}
