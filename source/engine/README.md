# Browser Doom arena

Visitors run an actual software-rendered DOOM engine and an independently stepped Kumo policy. The engine is PureDOOM revision `355cfbd16fac119718879239336ee2ea408886bd` compiled to WASM; its only host imports are logging and exit. Freedoom art and the generated convex arena ship in a gzipped IWAD. The core is silent.

## Interface

```js
import { createArena } from './dist/arena.mjs';
const arena = await createArena({assetBase: new URL('./dist/', import.meta.url), seed: 9000});
const current = arena.state();   // 14 floats, plus kills/ammo/health/tic/done
const next = arena.step(2, true, false); // FIRE + backward for up to two game tics
const pixels = arena.frame();    // 320 × 200 × 4 Uint8ClampedArray, opaque RGBA
arena.reset(9001);               // fresh instance with the same compiled code and WAD
arena.setLimit(0);               // episode cap in tics: 2100 (default, one minute) reproduces published results, 0 removes it
```

`createArena({limitTics})` sets the cap before the first start; `state().limit` and `arena.limit()` report it and `arena.configurable()` is false on binaries built before the `arena_set_limit` export existed. The 2026-11-03 binary was built from this source with zig 0.17.0 (`zig cc --target=wasm32-freestanding`, `zig wasm-ld --strip-all`, the flags of `build.sh`); archived protocol-1, -2 and -3 winners replay identically on it.

The same interface works in a worker. `frame()` returns a view of WASM memory; copy it before transferring an image. On each action the game advances, actual pistol and monster code runs, a new frame renders, and a new observation is computed. The deterministic loop advances game time even when neural inference runs more slowly than real time.

## Relationship to the benchmark

Both original tasks start the player at the center, with 26 rounds, five one-hit melee enemies, nine horizontal monster-occupancy fractions, left/right/fire actions, two tics per action, and a 2100-tic horizon. This port renders a vanilla-format 16-sided room at 320×200 using Freedoom textures. A fixed seed sets a reproducible initial rotation and respawns. Killed opponents respawn after 90 tics. All five are Doom pinky demons. Standard Doom pistol, AI, collision, health, and weapon-fallback behavior apply.

The native test runs ViZDoom/ZDoom’s UDMF and ACS scenario with mixed chainsaw marines and demons, a different renderer, AI and timing. Its scores and seed numbers are not interchangeable with this browser arena. The site can show native recordings separately.

The WASM renderer marks the opaque, clipped vertical sprite runs for living monsters. Nearer objects and the player weapon overwrite occluded pixels. The model receives those coverage fractions, player ammo and health, and a three-bit previous action, in native feature order. This is engine-assisted perception rather than inference from screen RGB.

## v0.3 observations and movement

`arena.step(action, backward=false)` supplies independent pistol/turn and backward controls through the native Doom ticcmd. Backward uses the standard walking impulse −25. The original three action IDs, 14-dimensional policy input, two-tic step, renderer output and initial conditions stay available. The optional movement lets a player leave the start position, collide with walls and monsters, and turn or fire while retreating.

`state.threat` describes the nearest **visible living** opponent, chosen by horizontal world distance. The software renderer marks each opaque sprite pixel with its current opponent slot. Walls, occluding sprites and the player weapon remove obscured pixels. Only slots with at least one surviving visible pixel can provide bearing or range. Each spawn gets a new positive ID, including respawns in the same slot.

| Field | Measurement |
|---|---|
| `visible`, `visibleCount`, `id` | Any live opponent visible, number visible, selected spawn identifier |
| `x` | Mean horizontal screen coordinate of the selected opponent’s visible pixels, normalized to −1 left and +1 right |
| `distance` | Horizontal center-to-center range to that visible opponent, in Doom map units |
| `closing` | Reduction in range divided by elapsed game tics for the identical visible spawn in consecutive observations. Positive means closing. On first sight, after disappearance, or after reset, the estimate starts at zero. It includes player motion. |
| `aligned` | A visible pixel of the selected opponent intersects screen-center columns 156–164 inclusive at width 320. This horizontal alignment is a proxy for a possible shot. |
| `backClearance` | Distances to blocking planes of the known convex map, clipped by the player's square collision footprint. Minimum nonnegative travel before the rearward ray reaches a wall. This map-geometry sensor excludes unobserved opponent positions. |

No visible target yields zero range, closing, x and ID; `visible` and `aligned` are false. Wall clearance remains available. `state.x`, `state.y` (map units) and `state.angle` (degrees) are debugging/measurement fields separate from the policy features.

`state.telemetry` contains cumulative episode counters. `retreatSteps` counts decisions requesting backward and `retreatDisplacement` sums actual horizontal displacement over those decisions; Doom inertia may continue after releasing the button. `travelDistance` includes all decisions. `shots` uses actual clip ammo spent. `nearestAlignedShots` counts rounds spent on a decision that began with the nearest monster aligned. `multiShots` and `multiNearestAlignedShots` restrict to decisions beginning with at least two visible monsters. `hits`, `nearestHits`, `multiHits`, and `multiNearestHits` count rounds that genuinely struck a living enemy, using the engine's hitscan damage callback. Their nearest and multi conditions refer to the pre-decision sensor state. Doom can switch to fists after exhausting ammo, so gameplay kills and bullet hits are distinct. `nearestTargetKills` counts deaths of the pre-decision nearest actor during that decision and can include non-bullet deaths.

The v0.3 test checks physical displacement, simultaneous firing/turning and retreat, target-id continuity, measured closing speed, geometry gating, distance signs, and counters. The original v0.2 seeded replay/initial framebuffer hashes are unchanged with no backward input. See `source/verified-v3.json` and `source/verified.json`. `source/native_probe.py` separately tests adding the MOVE_BACKWARD button to the original ViZDoom WAD. It is replayable with the pilot’s headless SDL environment and ViZDoom 1.3.0. On seed 9000 in 16 tics, fire + backward displaced 69.45335 map units and fired a round, whereas FIRE alone displaced zero and also fired a round.

## v0.4 visible actors, motion and combat events

The original `state.angle` / `state.x` / `state.y` still report the player's world pose. `state.pose={x,y,yawDeg}` is the named equivalent. World yaw uses degrees modulo 360, +map X is 0°, positive rotation turns left. `state.actors` lists only *living* monsters with pixels left after rendering and occlusion, sorted by increasing horizontal world distance and then ID. Each actor provides its life ID, horizontal `worldX/worldY`, range `distance`, `closing`, `aligned`, and visible centroid `x`, with the same semantics as the v0.3 threat sensor. `bearingDeg` is the absolute world bearing of the actor's center. `relativeYawDeg` is the shortest signed world rotation to its center (left positive, range [-180,180)). `screenBearingDeg` is the projected visible-mask centroid, right positive, computed from `atan(x)` for this 90° horizontal field of view. Partial occlusion can offset this centroid from the actor center. A hidden actor yields no current observation record or position. Scalar health-loss events reveal no attacker identity, bearing, position or omniscient marker.

`arena.step(action, backward=false, forward=false)` accepts 0 LEFT, 1 RIGHT, 2 FIRE, 3 HOLD. HOLD applies no turn or attack button. After HOLD all three frozen previous-action flags equal zero, which is also the start-frame encoding. Forward and backward use ±25 Doom walking impulse, may accompany any aim action, and cannot both be true. Nonmoving commands can retain engine momentum. `telemetry.forwardSteps` and `forwardDisplacement` mirror the retreat counters.

`state.weapon` is the player's actually selected weapon (`pistol` or `fist` on this map). `weaponId` equals the Doom enum, 1 or 0. `weaponSwitching` includes pending changes, lowering, and raising. `weaponReady` is specifically the resting attack-ready psprite with usable ammo, a live player, and no weapon change underway. A false value is possible just after spawn while the pistol rises, after a shot, or during refire/windup. The browser map supplies a fist as a fallback; the native ViZDoom scenario's cleared inventory is a separate benchmark.

Read `state.events` **after** each action. `healthBefore`, `healthAfter`, `damage` and `damageBySubtic` give the observed local health loss during the last executed one- or two-tic decision. The second subtic's damage defaults to zero if death or timeout ends the decision early. `shots` and `punches` list actual weapon attack callbacks, with `{tic,hit,targetId}` on both misses (`targetId=0`) and hits (matched life ID). The counter timestamps the end of the actual 35 Hz tic. A held FIRE button can be cooling down and produce zero attacks. An earlier attack can resolve during a later TURN/HOLD decision. Subsequent calls to `state()`, including after termination, return the previous step's same events. Use the game tic as the cursor to avoid double-counting. `telemetry.punches/punchHits/punchMisses/damageTaken` aggregate these events. Source `test_v4.mjs` verifies geometry, locomotion, switch state, both subtic positions, counters, delayed attacks and melee hits/misses. See `source/verified-v4.json` for measured engine-only checks.

## v0.5 visible enemy facing

Each visible living actor also exposes its own world `yawDeg`, in degrees counterclockwise from +X. `facingErrorDeg` is the shortest signed turn from the actor's yaw to the actor-to-player bearing, in [−180°, 180°). Positive means the actor would turn left. `facingCos` is its cosine. A value of +1 means facing the player, 0 side-on and −1 facing away. `aligned` still describes a different observation: whether the player’s screen-center strip intersects the visible actor. An enemy can face the player from the edge of the screen. All three facing fields require at least one living, unoccluded sprite pixel in the current render. The renderer exposes exact game yaw for visible actors; an RGB-only agent would have to estimate orientation from sprite poses. No hidden life IDs, windup flags, cooldowns, or strike attribution are added to the public observation.

### What produces damage on this map

This arena spawns five one-hit pinkies (`MT_SERGEANT`). They have a melee state and no missile state. At ordinary speed on medium difficulty, their chase code can enter the bite state when the player is in melee range and within direct sight. The first two attack states each face the target for eight tics. On entry to the third state, the demon faces its target again and checks range and line of sight. A successful bite rolls a multiple of four from 4 to 40. Actual health removed is capped by remaining health. The distance test is strict: Doom’s approximate center-to-center range, `max(abs(dx),abs(dy)) + min(abs(dx),abs(dy))/2` up to fixed-point rounding, must be below 60 units for a player of radius 16. The policy’s visible `distance` field uses Euclidean distance.

The 16 tics between attack initiation and the strike amount to about 457 ms of game time at 35 Hz. A living enemy can already be facing the player for seconds during pursuit. Moving out of range in the windup can avoid the bite. This rule is specific to these demons. Native ViZDoom’s mixed-opponent benchmark also contains chainsaw marines with their own attack sequence.

The source of the spawn is `spawn_opponent` in `source/arena.c`. In the vendored `source/PureDOOM.h` inspect `mobjinfo[MT_SERGEANT]`, `S_SARG_ATK1/2/3`, `P_SetMobjState`, `A_Chase`, `P_CheckMeleeRange`, `A_SargAttack` and `P_AproxDistance`. The same state sequence and strike recheck appear in the [upstream Doom state table](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/info.c) and [enemy logic](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/p_enemy.c).

### Reproducible sensor and timing checks

`source/test_v5.mjs` checks facing against an independent unit-vector dot and cross product, visible-only gating, and a same-ID sequence of visible observations. On seed 9003 an enemy faced within 15° at every two-tic sample from tic 10 to 116, stayed over 110 units away, and the player lost zero health. This is 3.03 seconds of game time. See `source/verified-v5.json`.

A separately compiled offline audit records the actual windup tic, strike tic, Doom ranges and damage by attacking spawn. The public binary doesn't contain its hooks or exports. `source/test_bites.mjs` runs the public and diagnostic builds together, checks exact agreement of their 14 inputs, game tics and kills, and reconciles all observed player health losses by subtic. On 12 fixed scripted runs, all 85 resolved bites took 16 tics. Of those, 59 landed and 26 missed. On seed 9001 a demon began its windup at 59.56 units and struck at 94.92 units, removing zero health. These samples characterize the engine under the named scripts. They do not measure the live policy. See `source/verified-bites.json`.

## Rebuild and verify

Use LLVM 23 clang and wasm-ld plus Python 3 and Node 22+.

```sh
CLANG=/path/to/clang WASM_LD=/path/to/wasm-ld ./source/build.sh
python source/make_wad.py /path/to/vizdoom/freedoom2.wad dist/arena.wad.gz
node source/test.mjs
node source/test_v3.mjs
node source/test_v4.mjs
node source/test_v5.mjs
# Optional offline attack audit, emitted under build/
CLANG=/path/to/clang WASM_LD=/path/to/wasm-ld ./source/build.sh audit
node source/test_bites.mjs
```

The input IWAD ships in PyPI `vizdoom==1.3.0`, with SHA-256 `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b`. Assets are served same-origin. The host uses native `DecompressionStream('gzip')` and WebAssembly. The verification compares deterministic replay, action-divergent state and framebuffer, seed divergence, ammo use, actual kills, terminal progression, and bounded numeric observations. See `source/verified.json`.

## Notices

- [PureDOOM](https://github.com/Daivuk/PureDOOM/tree/355cfbd16fac119718879239336ee2ea408886bd) includes a GPL v2 LICENSE. The original source header and upstream README retain id Software’s historical Doom Source Code License notices. Both upstream texts and the unmodified header are supplied. The host adapter and renderer instrumentation are distributed under GPL v2. The source of the compiled executable is included.
- [Freedoom](https://freedoom.github.io/) provides the artwork, sprites and audio lumps under its BSD license, reproduced in `source/LICENSE-Freedoom.txt`. No commercial DOOM WADs are included.
