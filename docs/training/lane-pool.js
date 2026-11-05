/** Work queue over evaluation lanes. Results are independent of lane assignment; only wall-clock time changes. */
import { abortError } from '../shared/worker-scope.js';
export function createLanePool({ spawn, lanes, init, emit = () => { }, onTick = () => { }, startTimeoutMs = 120000, }) {
    const ports = [], queue = [], pending = new Map();
    const counts = { games: 0, decisions: 0, cacheHits: 0, backboneCalls: 0, readoutCalls: 0 };
    let nextId = 1, watching = false, spotlight = -1, disposed = false;
    const failures = [];
    function startLane(index) {
        return new Promise((resolve, reject) => {
            let port;
            try {
                port = spawn(index);
            }
            catch (e) {
                reject(e);
                return;
            }
            const lane = { index, port, busy: null, live: 0, dead: false };
            const timer = setTimeout(() => {
                lane.dead = true;
                port.terminate();
                reject(new Error('Lane ' + index + ' did not start within ' + Math.round(startTimeoutMs / 1000) + ' s'));
            }, startTimeoutMs);
            port.onmessage = ({ data: m }) => {
                if (m.type === 'ready') {
                    clearTimeout(timer);
                    resolve(lane);
                    return;
                }
                if (m.type === 'result') {
                    const item = pending.get(m.id);
                    pending.delete(m.id);
                    lane.busy = null;
                    lane.live = 0;
                    for (const k of Object.keys(counts))
                        counts[k] += m.counts?.[k] || 0;
                    item?.resolve({ result: m.result, hidden: m.hidden ? new Float32Array(m.hidden) : null });
                    pump();
                    return;
                }
                if (m.type === 'frame') {
                    emit(m, [m.pixels]);
                    return;
                }
                if (m.type === 'tick') {
                    lane.live = m.step || 0;
                    onTick();
                    return;
                }
                if (m.type === 'error') {
                    const error = new Error(m.message || 'Lane ' + index + ' failed');
                    if (!lane.busy && pending.size === 0 && timer) {
                        clearTimeout(timer);
                        reject(error);
                    }
                    fail(lane, error);
                }
            };
            port.onerror = (e) => {
                clearTimeout(timer);
                const error = new Error(e?.message || 'Lane ' + index + ' crashed');
                reject(error);
                fail(lane, error);
            };
            port.postMessage({ type: 'init', lane: index, ...init });
        });
    }
    function fail(lane, error) {
        lane.dead = true;
        failures.push(error);
        if (lane.busy) {
            const item = pending.get(lane.busy);
            pending.delete(lane.busy);
            lane.busy = null;
            item?.reject(error);
        }
        try {
            lane.port.terminate();
        }
        catch {
            /* already gone */
        }
        if (!ports.some((l) => !l.dead)) {
            for (const [id, item] of pending) {
                pending.delete(id);
                item.reject(error);
            }
            queue.length = 0;
        }
        pump();
    }
    function pump() {
        while (queue.length) {
            const lane = ports.find((l) => !l.busy && !l.dead);
            if (!lane)
                break;
            const item = queue.shift();
            lane.busy = item.id;
            lane.port.postMessage({ type: 'play', id: item.id, job: item.job });
        }
        updateSpotlight();
    }
    /** Stream frames from exactly one busy lane while the page watches. */
    function updateSpotlight() {
        if (!watching)
            return;
        const current = ports.find((l) => l.index === spotlight);
        if (current?.busy && !current.dead)
            return;
        const next = ports.find((l) => l.busy && !l.dead);
        if (!next)
            return;
        if (current && !current.dead)
            current.port.postMessage({ type: 'watch', watch: false });
        spotlight = next.index;
        next.port.postMessage({ type: 'watch', watch: true });
    }
    async function open() {
        const settled = await Promise.allSettled(Array.from({ length: lanes }, (_, i) => startLane(i)));
        for (const s of settled)
            if (s.status === 'fulfilled')
                ports.push(s.value);
            else
                failures.push(s.reason);
        if (!ports.length)
            throw failures[0] || new Error('No CPU core started for evaluation');
        return pool;
    }
    const runner = {
        get lanes() {
            return ports.filter((l) => !l.dead).length;
        },
        play(jobs) {
            if (disposed)
                return Promise.reject(abortError());
            const all = jobs.map((job) => new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject });
                queue.push({ id, job });
            }));
            pump();
            return Promise.all(all);
        },
    };
    const pool = {
        open,
        runner,
        counts,
        get failures() {
            return failures.slice();
        },
        liveDecisions() {
            return ports.reduce((s, l) => s + (l.busy ? l.live : 0), 0);
        },
        busyLanes() {
            return ports.filter((l) => l.busy && !l.dead).length;
        },
        watch(flag) {
            watching = flag === true;
            if (!watching) {
                const current = ports.find((l) => l.index === spotlight);
                if (current && !current.dead)
                    current.port.postMessage({ type: 'watch', watch: false });
                spotlight = -1;
                return;
            }
            updateSpotlight();
        },
        dispose() {
            disposed = true;
            queue.length = 0;
            for (const [id, item] of pending) {
                pending.delete(id);
                item.reject(abortError());
            }
            for (const l of ports) {
                l.dead = true;
                try {
                    l.port.terminate();
                }
                catch {
                    /* already gone */
                }
            }
        },
    };
    return pool;
}
