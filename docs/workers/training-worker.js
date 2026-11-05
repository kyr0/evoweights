import { REFERENCE, referenceRecord } from '../revisions/reference.js';
import { revisionId, getImportedModelAssets } from '../revisions/store.js';
import { abortError, createYield, workerScope } from '../shared/worker-scope.js';
import { moduleUrl, packUrl, siteUrl } from '../shared/site.js';
import { runEDNO, EDNO } from '../training/edno.js';
import { createLanePool } from '../training/lane-pool.js';
import { openLiveES, recipeHash, normalizeRecipe, attributeChange, streamSeed, PRIORITIES, } from '../training/live-es.js';
/** Fixed explanation seeds, disjoint from search, validation and held-out evaluation seeds. */
export const EXPLAIN_SEEDS = Object.freeze(Array.from({ length: 24 }, (_, k) => streamSeed(0, 0xa000000 + k, true)));
let busy = false, watch = false, stop = false, finish = false, pool = null;
const yieldTask = createYield();
const emit = (value, transfer = []) => workerScope.postMessage(value, transfer);
const message = (e) => (e instanceof Error && e.message) || String(e);
/** Fetch every model and engine asset once; lanes receive copies instead of re-downloading. */
async function prefetchAssets(readAsset) {
    const modelBase = siteUrl('model/'), engineBase = siteUrl('engine/');
    const get = async (base, name) => {
        const held = await readAsset?.(name);
        if (held)
            return held instanceof Blob ? await held.arrayBuffer() : held;
        const url = new URL(name, base);
        const r = await fetch(url).catch((e) => {
            throw new Error('Could not download ' + url.href, { cause: e });
        });
        if (!r.ok)
            throw new Error('Could not load ' + url.href + ' (' + r.status + ')');
        return r.arrayBuffer();
    };
    const assets = new Map();
    const manifestBytes = await get(modelBase, 'manifest.json');
    assets.set('manifest.json', manifestBytes);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    for (const c of manifest.chunks)
        assets.set(c.path, await get(packUrl('w4', ''), c.path));
    assets.set('policy-simd.wasm', await get(modelBase, 'policy-simd.wasm'));
    assets.set('arena.wasm', await get(engineBase, 'arena.wasm'));
    assets.set('arena.wad.gz', await get(engineBase, 'arena.wad.gz'));
    return assets;
}
/** Mirror live counters (pool or in-process engine) onto the reported `counts` object. */
function mirrorCounts(counts, source, keys) {
    for (const k of keys)
        Object.defineProperty(counts, k, { get: () => source[k], set() { }, enumerable: true });
}
async function run(data) {
    const requested = Math.max(1, Math.min(64, Math.floor(Number(data.lanes) || 1)));
    const counts = {
        games: 0,
        decisions: 0,
        cacheHits: 0,
        backboneCalls: 0,
        readoutCalls: 0,
        promotions: 0,
    };
    const started = performance.now();
    let ctx = null, plan = { pairs: EDNO.directions, method: 'edno' }, phase = 'loading', status = '', round = 0, clock;
    const rateWindow = [];
    const liveDecisions = () => counts.decisions + (pool?.liveDecisions() || 0);
    function progress(extra = {}) {
        const now = performance.now(), decisions = liveDecisions();
        rateWindow.push([now, decisions]);
        while (rateWindow.length > 1 && now - rateWindow[0][0] > 2500)
            rateWindow.shift();
        const span = now - rateWindow[0][0], rate = span > 200 ? ((decisions - rateWindow[0][1]) * 1000) / span : 0;
        emit({
            type: 'progress',
            round,
            phase,
            message: status,
            ...counts,
            decisions,
            lanes: pool ? pool.runner.lanes : ctx ? 1 : 0,
            busyLanes: pool ? pool.busyLanes() : ctx && phase !== 'loading' ? 1 : 0,
            requestedLanes: requested,
            plan,
            rate,
            elapsed: (now - started) / 1000,
            ...extra,
        });
    }
    const record = (r, p, m, extra = {}) => {
        round = r;
        phase = p;
        status = m;
        progress(extra);
    };
    try {
        record(0, 'loading', 'Opening 4-bit Kumo and the live PureDOOM arena on ' + requested + ' CPU core' + (requested > 1 ? 's' : ''));
        const assetId = data.type === 'attribute' ? data.child?.id : data.type === 'reference' ? data.items?.[0]?.id : data.parent?.id;
        const readAsset = assetId ? await getImportedModelAssets(assetId) : undefined;
        const recipe = normalizeRecipe(data.parent), hash = await recipeHash(recipe);
        const start = { recipe, hash, id: data.parent?.id ?? hash };
        let runner = null;
        if (requested > 1 && typeof Worker === 'function') {
            try {
                const assets = await prefetchAssets(readAsset);
                const lanes = createLanePool({
                    spawn: () => new Worker(moduleUrl('workers/training-lane'), { type: 'module' }),
                    lanes: requested,
                    init: { assets },
                    emit,
                    onTick: () => { },
                });
                pool = lanes;
                await lanes.open();
                if (stop)
                    throw abortError();
                runner = lanes.runner;
                lanes.watch(watch);
                mirrorCounts(counts, lanes.counts, Object.keys(lanes.counts));
                if (lanes.runner.lanes < requested)
                    record(0, 'loading', lanes.runner.lanes + ' of ' + requested + ' CPU cores started; continuing with the available cores');
            }
            catch (e) {
                if (e.name === 'AbortError')
                    throw e;
                pool?.dispose();
                pool = null;
                record(0, 'loading', 'Core workers unavailable (' + message(e) + '); continuing on one in-process worker');
            }
        }
        if (!runner) {
            const local = await openLiveES({
                readAsset,
                emit: (m, transfer) => {
                    if (m.type === 'progress') {
                        if (m.step !== undefined)
                            progress({ step: m.step, role: m.role, seed: m.seed });
                    }
                    else
                        emit(m, transfer ?? [m.pixels]);
                },
                watch: () => watch,
                stop: () => stop,
                yieldTask,
            });
            ctx = local;
            runner = local.localRunner;
            mirrorCounts(counts, local.counts, ['games', 'decisions', 'cacheHits', 'backboneCalls', 'readoutCalls']);
        }
        const edno = data.type === 'start' && data.learning?.method === 'edno';
        plan =
            data.type === 'reference'
                ? { pairs: 0, method: 'reference' }
                : data.type === 'attribute'
                    ? { pairs: 0, method: 'attribute' }
                    : { pairs: EDNO.directions, method: 'edno' };
        clock = setInterval(() => progress(), 500);
        const play = runner;
        if (data.type === 'attribute') {
            const chosen = PRIORITIES[data.priority] ?? PRIORITIES.survival, child = normalizeRecipe(data.child);
            const seeds = Array.isArray(data.seeds) && data.seeds.every((s) => Number.isInteger(s) && s >= 0)
                ? data.seeds
                : [...EXPLAIN_SEEDS];
            let total = 0;
            const result = await attributeChange({
                parent: recipe,
                child,
                seeds,
                horizon: 1050,
                w: chosen.utility,
                play: (jobs) => {
                    total = jobs.length;
                    record(0, 'attribution', jobs.length + ' knock-out and knock-in games on ' + seeds.length + ' fixed seeds', {
                        total,
                    });
                    return play.play(jobs);
                },
            });
            emit({
                type: 'attribution',
                result,
                parentId: data.parent?.id ?? null,
                childId: data.child?.id ?? null,
                priority: data.priority === 'kills' ? 'kills' : 'survival',
                total,
            });
            return;
        }
        const checkStop = () => {
            if (stop)
                throw abortError();
        };
        const priority = data.priority === 'kills' ? 'kills' : 'survival';
        if (data.type === 'reference') {
            // Up to four revisions per batch keep every lane busy; each batch reports its results before the next starts.
            const items = Array.isArray(data.items) ? data.items : [], seeds = Array.from({ length: REFERENCE.count }, (_, k) => streamSeed(REFERENCE.master, REFERENCE.index + k, true));
            for (let i = 0; i < items.length; i += 4) {
                const batch = await Promise.all(items.slice(i, i + 4).map(async (x) => {
                    const r = normalizeRecipe(x);
                    return { id: x.id, recipe: r, hash: await recipeHash(r) };
                }));
                record(0, 'reference', 'Reference seeds · model ' +
                    (i + 1) +
                    (batch.length > 1 ? '–' + (i + batch.length) : '') +
                    ' of ' +
                    items.length, { total: items.length * seeds.length });
                checkStop();
                const got = (await play.play(batch.flatMap((x) => seeds.map((seed) => ({
                    recipe: x.recipe,
                    seed,
                    horizon: REFERENCE.horizon,
                    round: 0,
                    phase: 'reference',
                    role: 'reference',
                }))))).map((o) => o.result);
                checkStop();
                batch.forEach((x, j) => emit({
                    type: 'reference-result',
                    id: x.id,
                    record: referenceRecord(got.slice(j * seeds.length, (j + 1) * seeds.length), x.hash),
                }));
            }
            return;
        }
        if (!edno || !data.learning)
            throw new Error('Only EvoWeights training runs are supported.');
        const learning = data.learning;
        await runEDNO({
            runner: play,
            start,
            searchSeed: data.searchSeed,
            revisionId,
            emit,
            counts,
            record,
            yieldTask,
            checkStop,
            lineage: Array.isArray(data.lineage) ? data.lineage : undefined,
            priority,
            mode: learning.mode && Object.hasOwn(EDNO.modes, learning.mode) ? learning.mode : 'auto',
            selection: learning.selection && EDNO.selections.includes(learning.selection)
                ? learning.selection
                : 'race',
            ties: learning.ties === true,
            attribution: learning.attribution !== false,
            shouldFinish: () => finish,
            onRound: async (r) => r.status === 'promoted',
        });
    }
    catch (e) {
        if (e.name !== 'AbortError')
            emit({ type: 'error', message: message(e) });
    }
    finally {
        clearInterval(clock);
        emit({
            type: 'stopped',
            ...counts,
            decisions: counts.decisions,
            lanes: pool ? pool.runner.lanes : ctx ? 1 : 0,
            plan,
        });
        pool?.dispose();
        pool = null;
        ctx?.dispose();
        busy = false;
    }
}
workerScope.onmessage = ({ data }) => {
    if (data.type === 'watch') {
        watch = data.watch === true;
        pool?.watch(watch);
        return;
    }
    if (data.type === 'stop') {
        stop = true;
        pool?.dispose();
        return;
    }
    // EDNO: end after the running batch and play the final round of the kept candidates.
    if (data.type === 'finish') {
        finish = true;
        return;
    }
    if (!['start', 'attribute', 'reference'].includes(data.type) || busy)
        return;
    busy = true;
    stop = false;
    finish = false;
    watch = data.watch === true;
    void run(data);
};
