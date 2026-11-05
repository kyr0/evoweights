import { openLiveES, } from '../training/live-es.js';
import { createYield, workerScope } from '../shared/worker-scope.js';
let ctx = null, watch = false, busy = false, lane = 0;
const yieldTask = createYield();
const reply = (message, transfer = []) => workerScope.postMessage(message, transfer);
const emit = (m, transfer = []) => {
    if (m.type === 'progress') {
        reply({ type: 'tick', lane, step: m.step ?? 0, role: m.role, seed: m.seed });
        return;
    }
    workerScope.postMessage(m, transfer);
};
async function play(id, j, live) {
    const before = { ...live.counts };
    const result = await live.game(j.recipe, j.seed, j.horizon, j.round, j.phase, j.role, { hidden: !!j.hidden });
    const hidden = j.hidden ? live.lastHidden() : null, after = live.counts;
    const counts = {
        games: after.games - before.games,
        decisions: after.decisions - before.decisions,
        cacheHits: after.cacheHits - before.cacheHits,
        backboneCalls: after.backboneCalls - before.backboneCalls,
        readoutCalls: after.readoutCalls - before.readoutCalls,
    };
    const buffer = hidden ? hidden.buffer : null;
    reply({ type: 'result', id, lane, result, hidden: buffer, counts }, buffer ? [buffer] : []);
}
workerScope.onmessage = async ({ data }) => {
    const m = data;
    try {
        if (m.type === 'init') {
            lane = m.lane | 0;
            ctx = await openLiveES({ assets: m.assets, emit, watch: () => watch, stop: () => false, yieldTask, lane });
            reply({ type: 'ready', lane });
            return;
        }
        if (m.type === 'watch') {
            watch = m.watch === true;
            return;
        }
        if (m.type !== 'play')
            return;
        if (!ctx || busy)
            throw new Error('Lane ' + lane + ' is not ready for a game');
        busy = true;
        try {
            await play(m.id, m.job, ctx);
        }
        finally {
            busy = false;
        }
    }
    catch (e) {
        reply({
            type: 'error',
            id: m?.id,
            lane,
            message: (e instanceof Error && e.message) || String(e),
        });
    }
};
