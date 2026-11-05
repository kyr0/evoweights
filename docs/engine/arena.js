/**
 * Host adapter for the PureDOOM arena WASM (source: `source/engine/source/arena.c`, see the corresponding source download).
 * Field semantics of the state are documented in `source/engine/README.md`.
 */
import { siteUrl } from '../shared/site.js';
/** Episode cap of every published result: one minute at 35 tics per second. */
export const PUBLISHED_LIMIT_TICS = 2100;
/** Changes to the task invalidate historical engine fitness comparisons. */
export const HUGGINGDOOM_RULESET = 'huggingdoom-v1';
const WIDTH = 320;
const HEIGHT = 200;
async function gunzipIfNeeded(bytes) {
    if (bytes[0] !== 31 || bytes[1] !== 139)
        return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function createArena({ assetBase = siteUrl('engine/'), seed = 9000, readAsset, limitTics = PUBLISHED_LIMIT_TICS, } = {}) {
    let limit = Math.max(0, limitTics | 0);
    const read = readAsset ??
        (async (name) => {
            const response = await fetch(new URL(name, assetBase));
            if (!response.ok)
                throw new Error(`Failed to load ${name}: ${response.status}`);
            return new Uint8Array(await response.arrayBuffer());
        });
    const [module, wad] = await Promise.all([
        read('arena.wasm').then((bytes) => WebAssembly.compile(bytes)),
        read('arena.wad.gz').then(gunzipIfNeeded),
    ]);
    let e;
    function reset(nextSeed = seed) {
        let diagnostic = '';
        e = new WebAssembly.Instance(module, {
            host: {
                log(addr) {
                    const mem = new Uint8Array(e.memory.buffer);
                    let end = addr;
                    while (mem[end] && end - addr < 4096)
                        end++;
                    const s = new TextDecoder().decode(mem.subarray(addr, end)).trim();
                    if (s)
                        diagnostic = s;
                },
                exit(code) {
                    throw new Error(`Doom core exited (${code}): ${diagnostic}`);
                },
            },
        }).exports;
        const ptr = e.arena_wad(wad.length);
        new Uint8Array(e.memory.buffer, ptr, wad.length).set(wad);
        e.arena_set_limit?.(limit);
        e.arena_start(nextSeed >>> 0);
        return state();
    }
    const configurable = () => typeof e.arena_set_limit === 'function';
    const ruleset = () => (e.arena_picnic ? HUGGINGDOOM_RULESET : 'doom-legacy');
    const currentLimit = () => (configurable() ? e.arena_limit() : PUBLISHED_LIMIT_TICS);
    function setLimit(tics) {
        limit = Math.max(0, tics | 0);
        e.arena_set_limit?.(limit);
        return currentLimit();
    }
    function floats(ptr, length) {
        return new Float32Array(e.memory.buffer, ptr, length);
    }
    function state() {
        const features = floats(e.arena_features(), 14).slice();
        const t = floats(e.arena_sensors(), 12);
        const m = floats(e.arena_telemetry(), 12);
        const v = floats(e.arena_visible(), 35);
        const yaws = floats(e.arena_visible_yaw(), 5);
        const c = floats(e.arena_combat(), 12);
        const a = floats(e.arena_attacks(), 12);
        const d = floats(e.arena_damages(), 2);
        const p = e.arena_picnic ? floats(e.arena_picnic(), 11) : null;
        const picnic = p
            ? {
                bearsFed: p[0],
                bearsBefriended: p[1],
                timesBitten: p[2],
                hearts: p[3],
                hugging: !!p[4],
                ending: !!p[5],
                unfolding: !!p[6],
                peacefulBears: p[7],
                finaleProgress: Math.max(0, Math.min(1, p[8])),
                dizzy: !!p[9],
                activeTics: p[10],
            }
            : {
                bearsFed: 0,
                bearsBefriended: 0,
                timesBitten: 0,
                hearts: Math.ceil(features[10] / 20),
                hugging: false,
                ending: false,
                unfolding: false,
                peacefulBears: 0,
                finaleProgress: 0,
                dizzy: false,
                activeTics: e.arena_tic(),
            };
        const threat = {
            visible: !!t[0],
            x: t[1],
            distance: t[2],
            closing: t[3],
            aligned: !!t[4],
            backClearance: t[5],
            id: t[6],
            visibleCount: t[7],
        };
        const pose = { x: t[8], y: t[9], yawDeg: t[10] };
        const actors = [];
        for (let i = 0; i < v.length; i += 7) {
            if (v[i] === 0)
                continue;
            const worldX = v[i + 1], worldY = v[i + 2], x = v[i + 3];
            const bearingDeg = ((Math.atan2(worldY - pose.y, worldX - pose.x) * 180) / Math.PI + 360) % 360;
            const relativeYawDeg = ((bearingDeg - pose.yawDeg + 540) % 360) - 180;
            const yawDeg = yaws[i / 7] % 360;
            const facingErrorDeg = ((bearingDeg + 180 - yawDeg + 540) % 360) - 180;
            actors.push({
                id: v[i],
                worldX,
                worldY,
                x,
                distance: v[i + 4],
                closing: v[i + 5],
                aligned: !!v[i + 6],
                bearingDeg,
                relativeYawDeg,
                screenBearingDeg: (Math.atan(x) * 180) / Math.PI,
                yawDeg,
                facingErrorDeg,
                facingCos: Math.cos((facingErrorDeg * Math.PI) / 180),
            });
        }
        actors.sort((left, right) => left.distance - right.distance || left.id - right.id);
        const shots = [], punches = [];
        for (let i = 0; i < c[6]; i++) {
            const event = { tic: a[3 * i], targetId: a[3 * i + 2], hit: a[3 * i + 2] !== 0 };
            (a[3 * i + 1] === 1 ? shots : punches).push(event);
        }
        const events = {
            healthBefore: c[3],
            healthAfter: c[4],
            damage: c[5],
            damageBySubtic: [d[0], d[1]],
            shots,
            punches,
        };
        const telemetry = {
            retreatSteps: m[0],
            retreatDisplacement: m[1],
            shots: m[2],
            nearestAlignedShots: m[3],
            multiShots: m[4],
            multiNearestAlignedShots: m[5],
            travelDistance: m[6],
            nearestTargetKills: m[7],
            hits: m[8],
            nearestHits: m[9],
            multiHits: m[10],
            multiNearestHits: m[11],
            punches: c[7],
            punchHits: c[8],
            punchMisses: c[7] - c[8],
            damageTaken: c[9],
            forwardSteps: c[10],
            forwardDisplacement: c[11],
        };
        return {
            picnic,
            features,
            threat,
            telemetry,
            pose,
            actors,
            weapon: c[0] === 1 ? 'pistol' : c[0] === 0 ? 'fist' : 'other',
            weaponId: c[0],
            weaponSwitching: !!c[1],
            weaponReady: !!c[2],
            events,
            x: t[8],
            y: t[9],
            angle: t[10],
            kills: e.arena_kills(),
            ammo: features[9],
            health: features[10],
            tic: e.arena_tic(),
            done: !!e.arena_done(),
            limit: currentLimit(),
        };
    }
    function step(action, backward = false, forward = false) {
        if (!Number.isInteger(action) || action < 0 || action > 3)
            throw new RangeError('Action must be LEFT=0, RIGHT=1, FIRE=2 or HOLD=3');
        if (typeof backward !== 'boolean')
            throw new TypeError('backward must be boolean');
        if (typeof forward !== 'boolean')
            throw new TypeError('forward must be boolean');
        if (forward && backward)
            throw new RangeError('Forward and backward are mutually exclusive');
        e.arena_step(action, backward ? 1 : 0, forward ? 1 : 0);
        return state();
    }
    function frame() {
        return new Uint8ClampedArray(e.memory.buffer, e.arena_frame(), WIDTH * HEIGHT * 4);
    }
    reset(seed);
    return {
        width: WIDTH,
        height: HEIGHT,
        reset,
        step,
        frame,
        state,
        setLimit,
        limit: currentLimit,
        configurable,
        ruleset,
    };
}
