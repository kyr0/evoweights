/** Parallel mirrored signed-code evolution on the complete released live policy (protocol 6).
 * Survival-first scalar utility, several antithetic pairs per generation, lane-parallel games.
 * Every game is a deterministic function of (recipe, seed, horizon); lanes only change wall-clock time. */
import { createArena, HUGGINGDOOM_RULESET } from '../engine/arena.js';
import { createKumoPolicy, } from '../model/kumo.js';
import { buildW4Controller } from '../policy/decision-policy.js';
import { TRUST } from '../revisions/trust.js';
import { sha256 } from '../shared/sha256.js';
import { siteUrl } from '../shared/site.js';
import { abortError } from '../shared/worker-scope.js';
/** Utility weights in seconds-of-survival equivalents. Survival dominates; kills and ammo discipline break ties.
 * Protocol 3 adds bullets spent per kill, health-drop events per minute of game time, kills per minute and the share of decisions with an enemy in sight. */
export const UTILITY = Object.freeze({
    survivalSecond: 1,
    health: 0.08,
    kill: 0.4,
    hit: 0.04,
    miss: -0.04,
    blindDamage: -0.03,
    reactionTic: -0.01,
    exposureDecision: -0.005,
    ammoPerKill: -0.5,
    healthDropPerMinute: -0.1,
    killPerMinute: 0.02,
    sightFraction: 3,
});
/** Caps keep the rate terms bounded: at most 10 s for ammo per kill, 3 s for health drops per minute, 1.8 s for kills per minute.
 * The arena pistol holds 26 bullets that every game spends, so ammo per kill rewards kills per bullet; typical games sit near 1. */
export const RATES = Object.freeze({
    ammoPerKillCap: 20,
    healthDropsPerMinuteCap: 30,
    killsPerMinuteCap: 90,
    ticsPerMinute: 2100,
});
/** Kills-first weights: one kill is worth eight seconds of survival; the gates then compare kill counts instead of survival tics. */
export const UTILITY_KILLS = Object.freeze({
    survivalSecond: 0.25,
    health: 0.04,
    kill: 2,
    hit: 0.06,
    miss: -0.04,
    blindDamage: -0.02,
    reactionTic: -0.005,
    exposureDecision: -0.002,
    ammoPerKill: -0.5,
    healthDropPerMinute: -0.05,
    killPerMinute: 0.1,
    sightFraction: 3,
});
/** Training priority chosen in the UI: the utility weights and the primary metric of every gate (`tics` or `kills`). */
export const PRIORITIES = Object.freeze({
    survival: Object.freeze({ utility: UTILITY, primary: 'tics' }),
    kills: Object.freeze({ utility: UTILITY_KILLS, primary: 'kills' }),
});
/** Reaction clock: damage taken without a visible enemy within closeRange starts a timer that stops when one appears. */
export const REACTION = Object.freeze({ closeRange: 240, capTics: 70 });
/** Exposure: a visible enemy inside biteRange whose facing is within facingDeg of the player. */
export const EXPOSURE = Object.freeze({ biteRange: 108, facingDeg: 32 });
/** Episode-length curriculum: validation episodes start at one minute (2,100 tics); once more than half of a generation's full
 * episodes survive to the cap, the next generation plays one minute longer. Needs an engine build with arena_set_limit. */
export const CURRICULUM = Object.freeze({
    minuteTics: 2100,
    minuteDecisions: 1050,
    startMinutes: 1,
    maxMinutes: 10,
    majority: 0.5,
});
/** Protocol 5 learning. `credit`: every mirrored pair's utility difference is credited to the codes it moved (the mirrored-ES gradient
 * estimate), together with the measured contribution of each promoted change; each generation adds one mirrored pair that steps the
 * best-credited codes in their credited direction. `attribution`: every promotion is explained by playing the winner without each change
 * group (knock-out) and the parent with only that group (knock-in) on the validation seeds. */
export const LEARNING = Object.freeze({ credit: true, attribution: true });
export const ATTRIBUTION = Object.freeze({ maxGroups: 12 });
/** Paired statistics of per-seed differences: mean, standard deviation, standard error and t (99 when every difference is equal and positive). */
export function pairedStats(d) {
    const n = d.length, mean = n ? d.reduce((a, b) => a + b, 0) / n : 0, sd = n > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0, se = n ? sd / Math.sqrt(n) : 0;
    return { n, mean, sd, se, t: se > 0 ? mean / se : mean > 0 ? 99 : mean < 0 ? -99 : 0 };
}
const codeOK = (v) => Number.isInteger(v) && v >= -7 && v <= 7;
const stable = (v) => Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]))
        : v;
const digest = (v) => sha256(new TextEncoder().encode(JSON.stringify(stable(v))));
export const recipeHash = (r) => digest({ ops: r.ops, tactical: r.tactical });
/** Mulberry32: a deterministic uniform [0, 1) stream. */
export function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function boundedInt(n, lo, hi, label) {
    if (!Number.isInteger(n) || n < lo || n > hi)
        throw new RangeError(label + ' out of bounds');
    return n;
}
export function streamSeed(master, index, validation) {
    // A permutation modulo 2^28. Use low-order even/odd separation, not bits ignored by Doom's RNG.
    boundedInt(index, 0, 0xfffffff, 'seed index');
    return ((Math.imul((master + index) & 0xfffffff, 0x45d9f3b) >>> 0) & 0xfffffff) * 2 + Number(validation);
}
export function readSlot(tactical, path) {
    return path.length === 1 ? tactical.facing.code : tactical[path[0]].codes[path[1]][path[2]];
}
export function writeSlot(tactical, path, value) {
    if (path.length === 1)
        tactical.facing.code = value;
    else
        tactical[path[0]].codes[path[1]][path[2]] = value;
}
/** The 119 signed controller codes: 4 × 13 graft, 6 × 11 combat and the facing-guard code. */
export const SLOTS = [
    ...Array.from({ length: 52 }, (_, i) => ['graft', Math.floor(i / 13), i % 13]),
    ...Array.from({ length: 66 }, (_, i) => ['combat', Math.floor(i / 11), i % 11]),
    ['facing'],
];
function validateTactical(tactical, stock) {
    const restore = structuredClone(tactical);
    for (const path of SLOTS) {
        if (!codeOK(readSlot(restore, path)))
            throw new RangeError('Invalid signed controller slot ' + path.join('.'));
        writeSlot(restore, path, readSlot(stock, path));
    }
    if (JSON.stringify(stable(restore)) !== JSON.stringify(stable(stock)))
        throw new Error('Only the 119 native controller codes may vary');
}
function validateOps(input, head) {
    if (!Array.isArray(input) || input.length > 3072)
        throw new Error('Expected up to 3072 native codes');
    const seen = new Set();
    return input
        .map((op) => {
        if (!Array.isArray(op) || op.length !== 4)
            throw new Error('Invalid native operation');
        const [r, j, old, next] = op, i = r * 1024 + j;
        if (!Number.isInteger(r) ||
            r < 0 ||
            r > 2 ||
            !Number.isInteger(j) ||
            j < 0 ||
            j > 1023 ||
            head.codes[i] !== old ||
            !codeOK(next) ||
            old === next ||
            seen.has(i))
            throw new Error('Invalid native coordinate ' + i);
        seen.add(i);
        return [...op];
    })
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
/** Validate a parent record (or the shipped composite) into an immutable-base-relative recipe. */
export function normalizeRecipe(parent, head = TRUST.head, stock = TRUST.controller) {
    if (parent && (parent.precision === 'fp32' || !Array.isArray(parent.ops) || !(parent.tactical || parent.controller)))
        throw new Error('Live evolution requires a complete W4 parent, including its native edit table and controller');
    const ops = validateOps(parent?.ops ?? TRUST.edited, head);
    const tactical = structuredClone(parent?.tactical ?? parent?.controller ?? stock);
    validateTactical(tactical, stock);
    return { ops, tactical };
}
/** Set native code `i` to `n` in an edit map keyed by `row * 1024 + column`; the base code removes the edit. */
export function updateHead(map, head, i, n) {
    if (n === head.codes[i])
        map.delete(i);
    else
        map.set(i, [i >>> 10, i % 1024, head.codes[i], n]);
}
const byOps = (a, b) => a[0] - b[0] || a[1] - b[1];
const codeAt = (ops, head) => {
    const m = new Map(ops.map((op) => [op[0] * 1024 + op[1], op[3]]));
    return (i) => m.get(i) ?? head.codes[i];
};
/** Every code that differs between two recipes, grouped for attribution: each controller slot alone and native codes per output row
 * and 64-column scale group. Above `maxGroups`, native groups merge per row and then controller slots per matrix. */
export function changeGroups(from, to, head = TRUST.head, maxGroups = ATTRIBUTION.maxGroups) {
    const a = codeAt(from.ops, head), b = codeAt(to.ops, head), native = new Map();
    for (const i of [...new Set([...from.ops, ...to.ops].map((op) => op[0] * 1024 + op[1]))].sort((x, y) => x - y)) {
        const x = a(i), y = b(i);
        if (x === y)
            continue;
        const key = (i >>> 10) * 16 + ((i % 1024) >>> 6);
        let group = native.get(key);
        if (!group)
            native.set(key, (group = { kind: 'native', row: i >>> 10, coords: [], slots: [] }));
        group.coords.push([i, x, y]);
    }
    const controller = [];
    SLOTS.forEach((path, s) => {
        const x = readSlot(from.tactical, path), y = readSlot(to.tactical, path);
        if (x !== y)
            controller.push({ kind: 'controller', matrix: path[0], coords: [], slots: [[s, x, y]] });
    });
    let nativeGroups = [...native.values()], controllerGroups = controller;
    const merge = (list, key) => {
        const out = new Map();
        for (const g of list) {
            const k = g[key];
            let merged = out.get(k);
            if (!merged)
                out.set(k, (merged = { ...g, coords: [], slots: [] }));
            merged.coords.push(...g.coords);
            merged.slots.push(...g.slots);
        }
        return [...out.values()];
    };
    if (nativeGroups.length + controllerGroups.length > maxGroups)
        nativeGroups = merge(nativeGroups, 'row');
    if (nativeGroups.length + controllerGroups.length > maxGroups)
        controllerGroups = merge(controllerGroups, 'matrix');
    return [...controllerGroups, ...nativeGroups].map((g, id) => ({
        id,
        ...g,
        size: g.coords.length + g.slots.length,
        ...(g.coords.length
            ? { columns: [g.coords[0][0] % 1024, g.coords[g.coords.length - 1][0] % 1024] }
            : {}),
    }));
}
/** Set one change group to its `after` (knock-in) or `before` (knock-out) codes. */
export function applyGroup(recipe, group, direction, head = TRUST.head) {
    const m = new Map(recipe.ops.map((op) => [op[0] * 1024 + op[1], op])), tactical = structuredClone(recipe.tactical);
    for (const [i, x, y] of group.coords)
        updateHead(m, head, i, direction === 'after' ? y : x);
    for (const [s, x, y] of group.slots)
        writeSlot(tactical, SLOTS[s], direction === 'after' ? y : x);
    return { ops: [...m.values()].sort(byOps), tactical };
}
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
const totals = (rs, w) => ({
    survival: sum(rs, (r) => r.tics),
    kills: sum(rs, (r) => r.kills),
    utility: sum(rs, (r) => utility(r, w)),
});
const deltaOf = (a, b) => ({
    survival: a.survival - b.survival,
    kills: a.kills - b.kills,
    utility: a.utility - b.utility,
});
const r3 = (x) => Math.round(x * 1000) / 1000;
function perSeed(better, worse, w) {
    let up = 0, down = 0;
    const du = [], dt = [];
    better.forEach((r, i) => {
        const d = utility(r, w) - utility(worse[i], w);
        du.push(d);
        dt.push(r.tics - worse[i].tics);
        if (d > 0)
            up++;
        else if (d < 0)
            down++;
    });
    // Standard errors of the summed differences (n·SE of the mean); |t| ≥ 2 marks a contribution that stands out from seed noise.
    const u = pairedStats(du), s = pairedStats(dt);
    return {
        better: up,
        worse: down,
        same: better.length - up - down,
        seUtility: r3(u.se * u.n),
        seSurvival: r3(s.se * s.n),
        t: r3(u.t),
    };
}
/** Which change caused the improvement? Knock-out: the child without one group (its contribution in context). Knock-in: the parent with
 * only that group (its effect alone). Both on the same seeds and horizon; `interaction` is the gain that no single group explains alone. */
export async function attributeChange({ play, parent, child, seeds, horizon, head = TRUST.head, w = UTILITY, parentResults, childResults, round = 0, maxGroups = ATTRIBUTION.maxGroups, }) {
    const groups = changeGroups(parent, child, head, maxGroups), jobs = [];
    const job = (recipe, seed, role, group) => ({
        recipe,
        seed,
        horizon,
        round,
        phase: 'attribution',
        role,
        group,
    });
    if (!parentResults)
        for (const s of seeds)
            jobs.push(job(parent, s, 'parent', -1));
    if (!childResults)
        for (const s of seeds)
            jobs.push(job(child, s, 'child', -1));
    if (groups.length > 1)
        for (const g of groups) {
            const out = applyGroup(child, g, 'before', head), only = applyGroup(parent, g, 'after', head);
            for (const s of seeds) {
                jobs.push(job(out, s, 'knock-out', g.id));
                jobs.push(job(only, s, 'knock-in', g.id));
            }
        }
    const played = jobs.length ? await play(jobs) : [], results = (role, group) => jobs
        .map((j, i) => (j.role === role && j.group === group ? played[i].result : null))
        .filter((r) => !!r);
    const before = parentResults ?? results('parent', -1), after = childResults ?? results('child', -1);
    const P = totals(before, w), C = totals(after, w);
    const rows = groups.map((g) => {
        const out = groups.length > 1 ? results('knock-out', g.id) : before, only = groups.length > 1 ? results('knock-in', g.id) : after;
        return {
            ...g,
            knockOut: { ...deltaOf(C, totals(out, w)), ...perSeed(after, out, w) },
            knockIn: { ...deltaOf(totals(only, w), P), ...perSeed(only, before, w) },
        };
    });
    const gain = deltaOf(C, P), alone = rows.reduce((a, r) => a + r.knockIn.utility, 0), needed = rows.reduce((a, r) => a + r.knockOut.utility, 0);
    return {
        seeds,
        horizon,
        games: jobs.length,
        parent: P,
        child: C,
        gain,
        sumKnockIn: alone,
        sumKnockOut: needed,
        interaction: gain.utility - alone,
        groups: rows,
    };
}
export function promotion(search, validation) {
    return (search.noRegression &&
        search.strict &&
        validation.length === 2 &&
        validation.every((x) => x.noRegression) &&
        validation.some((x) => x.strict));
}
/* Protocol 2 scoring. */
/** Scalar utility of one game. Older receipts replay with their archived weights, whose missing rate terms count as zero. */
export function utility(r, w = UTILITY) {
    return ((w.survivalSecond * r.tics) / 35 +
        w.health * Math.max(0, r.health) +
        w.kill * r.kills +
        w.hit * r.hits +
        w.miss * r.misses +
        w.blindDamage * (r.blindDamage ?? 0) +
        w.reactionTic * (r.reactionMean ?? 0) +
        w.exposureDecision * (r.exposureDecisions ?? 0) +
        (w.ammoPerKill ?? 0) * Math.min(RATES.ammoPerKillCap, r.ammoPerKill ?? 0) +
        (w.healthDropPerMinute ?? 0) * Math.min(RATES.healthDropsPerMinuteCap, r.healthDropsPerMinute ?? 0) +
        (w.killPerMinute ?? 0) * Math.min(RATES.killsPerMinuteCap, r.killsPerMinute ?? 0) +
        (w.sightFraction ?? 0) * (r.sightFraction ?? 0));
}
export function promoted(search, validation, lineage) {
    return !!search?.eligible && !!validation?.passed && (lineage === undefined || !!lineage.passed);
}
/** Curriculum step: more than half of the generation's complete episodes survived to the cap, and every game ran on a build that honours the cap. */
export function curriculumStep(minutes, games) {
    const complete = games.filter((g) => g.terminal), capped = complete.filter((g) => g.health > 0 && g.tics >= minutes * CURRICULUM.minuteTics);
    const honoured = complete.every((g) => (g.limit ?? CURRICULUM.minuteTics) >= minutes * CURRICULUM.minuteTics);
    const next = honoured && complete.length && capped.length > CURRICULUM.majority * complete.length
        ? Math.min(CURRICULUM.maxMinutes, minutes + 1)
        : minutes;
    return { minutes, complete: complete.length, capped: capped.length, honoured, nextMinutes: next };
}
export async function openLiveES({ root = siteUrl(''), emit = () => { }, watch = () => false, stop = () => false, yieldTask = async () => { }, readAsset, assets, lane = 0, } = {}) {
    const modelBase = new URL('model/', root), engineBase = new URL('engine/', root);
    const head = TRUST.head, stock = TRUST.controller;
    const provide = async (name) => {
        const held = assets?.get(name);
        if (held != null)
            return held;
        return (await readAsset?.(name)) ?? null;
    };
    const bytes = async (base, name) => {
        const held = await provide(name);
        if (held != null)
            return held instanceof Uint8Array ? held : new Uint8Array(held instanceof Blob ? await held.arrayBuffer() : held);
        const resp = await fetch(new URL(name, base));
        if (!resp.ok)
            throw new Error('Could not load ' + name);
        return new Uint8Array(await resp.arrayBuffer());
    };
    // A private SIMD instance whose `hidden_ptr` the readout cache reads directly.
    let api = null;
    const runtime = {
        dispose() {
            api = null;
        },
        instantiate: async () => {
            const instance = await WebAssembly.instantiate((await bytes(modelBase, 'policy-simd.wasm')), {
                math: { sin: Math.sin, cos: Math.cos, exp: Math.exp, tanh: Math.tanh },
            });
            api = instance.instance.exports;
            return api;
        },
    };
    const [policy, arena] = await Promise.all([
        createKumoPolicy({ baseURL: modelBase, runtime, precision: 'w4', readAsset: provide }),
        createArena({ assetBase: engineBase, seed: 0, readAsset: (name) => bytes(engineBase, name) }),
    ]);
    if (arena.ruleset() !== HUGGINGDOOM_RULESET)
        throw new Error('HuggingDOOM engine required; refresh cached game assets before training.');
    const instance = api;
    if (!instance)
        throw new Error('Policy WASM did not instantiate');
    const bridge = policy.gpuBridge(), h = new Float32Array(instance.memory.buffer, instance.hidden_ptr(), 1024), cache = new Map(), maxEntries = 8192;
    const counts = {
        games: 0,
        decisions: 0,
        cacheHits: 0,
        backboneCalls: 0,
        readoutCalls: 0,
        promotions: 0,
    }, cacheKey = (f) => String.fromCharCode(...new Uint16Array(f.buffer, f.byteOffset, 28));
    const headIds = new WeakMap();
    let nextHeadId = 0, active = -1, sampleHidden = null, hiddenMean = null, lastFrame = -Infinity, lastProgress = -Infinity;
    function setHead(ops) {
        let id = headIds.get(ops);
        if (id === undefined) {
            id = ++nextHeadId;
            headIds.set(ops, id);
        }
        if (id !== active) {
            policy.setHeadPatch(ops);
            active = id;
        }
        return id;
    }
    /** The backbone output depends only on the features, so it is cached; a head change only reruns the readout. */
    function coreFor(f, headKey) {
        const key = cacheKey(f);
        let entry = cache.get(key);
        if (!entry) {
            const core = policy.infer(f, 'custom');
            counts.backboneCalls++;
            entry = { h: h.slice(), core, headKey };
            if (cache.size >= maxEntries)
                cache.delete(cache.keys().next().value);
            cache.set(key, entry);
        }
        else {
            counts.cacheHits++;
            cache.delete(key);
            cache.set(key, entry);
            if (entry.headKey !== headKey) {
                entry.core = bridge.decode(entry.h, 'custom');
                entry.headKey = headKey;
                counts.readoutCalls++;
            }
        }
        sampleHidden = entry.h;
        return entry.core;
    }
    const record = (round, phase, message, other = {}) => emit({ type: 'progress', round, phase, message, lane, ...counts, ...other });
    const minFacingCos = Math.cos((EXPOSURE.facingDeg * Math.PI) / 180);
    function checkStop() {
        if (stop())
            throw abortError();
    }
    const normalized = (parent) => normalizeRecipe(parent, head, stock);
    /** One deterministic game. Survival observers: unseen-threat damage and the damage-to-visible-threat reaction clock. */
    async function game(recipe, seed, horizon, round, phase, role, { hidden = false } = {}) {
        checkStop();
        const headKey = setHead(recipe.ops);
        const controller = buildW4Controller(recipe.tactical, 'custom');
        controller.reset();
        // The engine cap follows the horizon: one minute for search games, the curriculum's minutes for complete episodes.
        arena.setLimit(Math.max(CURRICULUM.minuteTics, 2 * horizon));
        let state = arena.reset(seed), n = 0, capture = 2166136261, melee = 0, blindDamage = 0, reactions = 0, reactionTics = 0, pendingSince = -1, closeVisibleDecisions = 0, exposureDecisions = 0, healthDrops = 0, visibleDecisions = 0;
        const hiddenSum = hidden ? new Float64Array(1024) : null;
        hiddenMean = null;
        while (n < horizon && !state.done && !state.picnic?.ending) {
            const core = coreFor(state.features, headKey);
            if (hiddenSum && sampleHidden)
                for (let i = 0; i < 1024; i++)
                    hiddenSum[i] += sampleHidden[i];
            const d = controller.decide(state, core);
            const command = d.action | (+!!d.backward << 2) | (+!!d.forward << 3);
            capture = Math.imul(capture ^ command, 16777619) >>> 0;
            melee += Number(state.weapon === 'fist');
            const sawClose = state.threat.visible && state.threat.distance <= REACTION.closeRange;
            closeVisibleDecisions += Number(sawClose);
            visibleDecisions += Number(!!state.threat.visible);
            if (sawClose && state.actors.some((a) => a.distance <= EXPOSURE.biteRange && a.facingCos >= minFacingCos))
                exposureDecisions++;
            state = arena.step(d.action, !!d.backward, !!d.forward);
            n++;
            counts.decisions++;
            const close = state.threat.visible && state.threat.distance <= REACTION.closeRange;
            if (pendingSince >= 0) {
                if (close) {
                    reactionTics += state.tic - pendingSince;
                    pendingSince = -1;
                }
                else if (state.tic - pendingSince >= REACTION.capTics) {
                    reactionTics += REACTION.capTics;
                    pendingSince = -1;
                }
            }
            const damage = state.events.damage;
            if (damage > 0) {
                healthDrops++;
                if (!sawClose)
                    blindDamage += damage;
                if (!close && pendingSince < 0) {
                    reactions++;
                    pendingSince = state.tic;
                }
            }
            const now = performance.now();
            if (watch() && now - lastFrame >= 125) {
                const pixels = arena.frame().slice().buffer;
                const frame = {
                    type: 'frame',
                    pixels,
                    width: arena.width,
                    height: arena.height,
                    round,
                    phase,
                    role,
                    seed,
                    lane,
                    decisions: counts.decisions,
                    step: n,
                    horizon,
                    health: state.health,
                    ammo: state.ammo,
                    kills: state.kills,
                    tic: state.tic,
                    weapon: state.weapon,
                    picnic: state.picnic,
                };
                emit(frame, [pixels]);
                lastFrame = now;
            }
            if (now - lastProgress >= 500) {
                record(round, phase, 'Playing ' + role + ' on seed ' + seed, {
                    role,
                    seed,
                    step: n,
                    horizon,
                    kills: state.kills,
                    health: state.health,
                });
                lastProgress = now;
            }
            if (n % 8 === 0) {
                await yieldTask();
                checkStop();
            }
        }
        // The emergency-honey finale is presentation, not additional survival or policy experience.
        const activeTics = state.picnic?.activeTics ?? state.tic;
        if (pendingSince >= 0)
            reactionTics += Math.min(REACTION.capTics, activeTics - pendingSince);
        if (hiddenSum) {
            hiddenMean = new Float32Array(1024);
            for (let i = 0; i < 1024; i++)
                hiddenMean[i] = hiddenSum[i] / Math.max(1, n);
        }
        const t = state.telemetry;
        counts.games++;
        // Rate observers: the pistol spends one bullet per shot; a health drop is a decision step in which damage landed.
        const minutes = Math.max(1, activeTics) / RATES.ticsPerMinute;
        return {
            role,
            seed,
            horizon,
            decisions: n,
            terminal: state.done || !!state.picnic?.ending,
            tics: activeTics,
            limit: state.limit ?? CURRICULUM.minuteTics,
            kills: state.kills,
            health: state.health,
            hits: t.hits + t.punchHits,
            misses: t.shots - t.hits + t.punchMisses,
            shots: t.shots,
            bulletHits: t.hits,
            punches: t.punches,
            punchHits: t.punchHits,
            meleeDecisions: melee,
            damageTaken: t.damageTaken,
            blindDamage,
            reactions,
            reactionTics,
            reactionMean: reactions ? reactionTics / reactions : 0,
            closeVisibleDecisions,
            exposureDecisions,
            ammoSpent: t.shots,
            ammoPerKill: t.shots / Math.max(1, state.kills),
            healthDrops,
            healthDropsPerMinute: healthDrops / minutes,
            killsPerMinute: state.kills / minutes,
            visibleDecisions,
            sightFraction: visibleDecisions / Math.max(1, n),
            retreatSteps: t.retreatSteps,
            forwardSteps: t.forwardSteps,
            travelDistance: t.travelDistance,
            commandFNV32: capture.toString(16).padStart(8, '0'),
        };
    }
    const lastHidden = () => hiddenMean;
    function validateCache(row, ops) {
        const key = setHead(ops), a = coreFor(row, key), b = policy.infer(row, 'custom');
        if (!a.logits.every((v, i) => Object.is(v, b.logits[i])) || a.action !== b.action)
            throw new Error('Cached readout failed full-inference parity');
        return b;
    }
    const localRunner = {
        get lanes() {
            return 1;
        },
        async play(jobs) {
            const out = [];
            for (const j of jobs) {
                const result = await game(j.recipe, j.seed, j.horizon, j.round, j.phase, j.role, { hidden: !!j.hidden });
                out.push({ result, hidden: j.hidden ? lastHidden() : null });
            }
            return out;
        },
    };
    return {
        normalized,
        validateCache,
        game,
        lastHidden,
        localRunner,
        counts,
        dispose: () => {
            cache.clear();
            policy.dispose();
        },
    };
}
