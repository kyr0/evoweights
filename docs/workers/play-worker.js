/** Live game worker: one arena, one inference runtime and one decision policy, stepped at the game's 17.5 Hz decision rate. */
import { createArena } from '../engine/arena.js';
import { createDecisionPolicy, modelFor } from '../policy/decision-policy.js';
import { openRuntime, percentile } from '../policy/runtime.js';
import { workerScope } from '../shared/worker-scope.js';
/** Two game tics per decision at 35 tics per second. */
const DECISION_MS = 2000 / 35;
let arena = null, runtime = null, policy = null, variant, seed = 9000;
let paused = true, finished = false, busy = false, timer = null, epoch = 0, n = 0;
let perfSamples = [], lastMotion = null, flips = 0, backSteps = 0;
// Human play: the page streams key states; FIRE wins over turning, forward over backward.
let human = false;
const keys = { left: false, right: false, forward: false, backward: false, fire: false };
const humanDecision = () => ({
    action: keys.fire ? 2 : keys.left ? 0 : keys.right ? 1 : 3,
    logits: [],
    forward: keys.forward && !keys.backward,
    backward: keys.backward && !keys.forward,
    mode: 'human',
    human: true,
});
const post = (message, transfer = []) => workerScope.postMessage(message, transfer);
const errorText = (e) => (e instanceof Error ? e.message : String(e));
function stop() {
    paused = true;
    epoch++;
    if (timer)
        clearTimeout(timer);
    timer = null;
}
function schedule(ms = 0) {
    if (timer)
        clearTimeout(timer);
    timer = null;
    if (!paused && !finished && !busy)
        timer = setTimeout(tick, ms);
}
function reset(game, value, initial = false) {
    stop();
    policy?.reset();
    seed = value >>> 0;
    n = 0;
    flips = 0;
    backSteps = 0;
    lastMotion = null;
    perfSamples = [];
    finished = false;
    const s = initial ? game.state() : game.reset(seed);
    packet(game, s, null, 0);
}
function packet(game, s, decision, ms) {
    const rgba = game.frame().slice();
    post({
        type: 'frame',
        rgba: rgba.buffer,
        width: game.width,
        height: game.height,
        seed,
        n,
        tic: s.tic,
        health: s.health,
        ammo: s.ammo,
        kills: s.kills,
        done: s.done,
        decision,
        inferenceMs: ms,
        weapon: s.weapon,
        damage: s.events.damage,
        variant,
        regions: Array.from(s.features.slice(0, 9)),
        threat: s.threat,
        backSteps,
        flips,
        inferenceP50: percentile(perfSamples, 0.5),
        inferenceP95: percentile(perfSamples, 0.95),
        perfN: perfSamples.length,
        backend: runtime.info(),
    }, [rgba.buffer]);
}
async function tick() {
    if (paused || finished || busy || !arena || !runtime || !policy)
        return;
    busy = true;
    const version = epoch, t0 = performance.now();
    let delay = 0;
    try {
        const s = arena.state(), start = performance.now();
        let result, dt = 0;
        if (human)
            result = humanDecision();
        else {
            const core = await runtime.infer(s.features, policy.head);
            if (version !== epoch || paused)
                return;
            result = policy.decide(s, core);
            dt = performance.now() - start;
        }
        if (n >= 12 && !human) {
            perfSamples.push(dt);
            if (perfSamples.length > 128)
                perfSamples.shift();
        }
        if (lastMotion !== null && lastMotion < 2 && result.action < 2 && lastMotion !== result.action)
            flips++;
        lastMotion = result.action;
        backSteps += Number(!!result.backward);
        const next = arena.step(result.action, !!result.backward, !!result.forward);
        n++;
        packet(arena, next, { ...result, weapon: s.weapon }, dt);
        if (next.done) {
            finished = true;
            stop();
            post({ type: 'end' });
            return;
        }
        delay = Math.max(0, DECISION_MS - (performance.now() - t0));
    }
    catch (e) {
        stop();
        post({ type: 'error', message: errorText(e) });
    }
    finally {
        busy = false;
        schedule(delay);
    }
}
function run() {
    if (!arena || !runtime || finished)
        return;
    paused = false;
    schedule();
}
workerScope.onmessage = async ({ data: m }) => {
    try {
        if (m.type === 'init') {
            seed = m.seed >>> 0;
            human = !!m.human;
            variant = m.variant ?? m.policy;
            const choice = variant;
            const { precision } = modelFor(choice, m.revision);
            [arena, runtime, policy] = await Promise.all([
                createArena({ seed, limitTics: Number.isFinite(m.limitTics) ? m.limitTics : 0 }),
                openRuntime(m.backend, ({ loaded, total }) => post({ type: 'loading', loaded, total }), precision, m.revision?.ops, m.revisionId),
                createDecisionPolicy(choice, undefined, m.revision),
            ]);
            reset(arena, seed, true);
            post({ type: 'ready' });
            run();
            return;
        }
        if (!arena || !runtime)
            return;
        if (m.type === 'control') {
            Object.assign(keys, m.keys);
            return;
        }
        if (m.type === 'human') {
            human = !!m.on;
            for (const k of Object.keys(keys))
                keys[k] = false;
            return;
        }
        if (m.type === 'pause') {
            stop();
            post({ type: 'paused' });
        }
        if (m.type === 'resume') {
            run();
            post({ type: 'resumed' });
        }
        if (m.type === 'reset') {
            reset(arena, m.seed);
            post({ type: 'resumed' });
            run();
        }
    }
    catch (e) {
        stop();
        post({ type: 'error', message: errorText(e) });
    }
};
