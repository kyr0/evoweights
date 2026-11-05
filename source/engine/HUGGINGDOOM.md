# HuggingDOOM engine rules

VERIFIED: `source/arena.c` and the assertions in
`../../tests/unit/huggingdoom-engine.test.ts` define the `huggingdoom-v1` task.
The renderer and movement remain PureDOOM; the encounter rules and artwork are
new. Archived DOOM fitness scores do not describe this task.

| Rule | Behavior |
|---|---|
| Honey | 26 honeycombs per episode, matching the original engine's ammunition budget. The existing ranged targeting spends one per throw; one hit feeds one bear. There are no refills. |
| Hugs | Empty honey selects the existing melee slot. The textured arms reach inward, squeeze and release. A successful close hit befriends one bear, stops the player's drift, reserves 24 game tics for the hug, and costs no honey. |
| Waiting | Nearby bears pause their chase during a hug. All incoming bites are ignored until the hug completes. |
| Hearts | Five hearts. Each accepted bite removes exactly 20 of the 100 compatibility health units. A 24-tic grace period prevents simultaneous bites from consuming several hearts. |
| Bite feedback | A bite flashes the screen red through Doom's fading damage palette. It never moves the camera or runs the original player-damage, blood, pain, or death code. The compatibility field `dizzy` still marks the 18-tic recovery period. |
| Picnic | Fed and befriended bears remain seated, nonblocking and untargetable. A circular pool retains the latest 256 bears; removing the oldest bounds memory and rendering work. |
| Flowers | Eighty nonblocking ornaments use fixed placement without consuming gameplay randomness. Hug hearts nudge nearby flowers away. |
| Finale | On the fifth bite, active and retained peaceful bears gather harmlessly in a semicircle and staggered rows for 70 game tics. The centre bear finds the emergency honey. The player stays upright; the final frame remains available after `done`. |

VERIFIED: Feeding uses the engine's existing instantaneous ranged targeting;
the visible honey throw is presentation. The melee slot uses the original
close-range collision test. Neither mechanic damages a bear: the hit callback
changes it directly into a peaceful actor before the original damage routine
can run.

## Compatibility and scoring

VERIFIED: The 14 policy inputs, four action IDs and `pistol`/`fist` weapon names
retain their existing ABI. `FIRE` means throw honey while available and hug
afterward. `kills` is the compatibility alias for
`bearsFed + bearsBefriended`; it is not a user-facing score label.

VERIFIED: `ArenaState.picnic` contains `bearsFed`, `bearsBefriended`,
`timesBitten`, `hearts`, `hugging`, `ending`, `unfolding`, `peacefulBears`,
`finaleProgress`, `dizzy` and `activeTics`. Use `activeTics` for fitness and
survival summaries: it freezes at the last bite and excludes the harmless
finale. `tic` continues advancing for animation. On an old binary without
`arena_picnic`, the adapter supplies neutral picnic counters and keeps
`activeTics === tic`; it does not invent historical HuggingDOOM results.

VERIFIED: the finale can run past `limitTics`. With `limitTics: 240`, seed 9000 and the WAIT action, an episode
ended at tic 308 with `activeTics` 238 (probe on 2026-11-05). UNKNOWN: whether that overrun is intended.

VERIFIED: Peaceful bears have no threat-mask pixels or actor observations.
Their sprites can still obscure a live bear, just as an opaque decorative
sprite does. The live target pool retains five slots and the existing 90-tic
replacement delay. Seeds and action sequences remain deterministic.

## Sprite contract

| SARG frame | State |
|---|---|
| A–D | Waddling |
| E–F | Lip-licking bite preparation |
| G | Cartoon chomp |
| H | Impatient wait |
| I | Wide-eyed honey catch, first eight tics |
| J–K | Peaceful honey picnic, stable no-bib/bib variants |
| L | Reciprocal hug, first 24 tics |
| M–N | Peaceful friendship and hearts |
| O | The finale's emergency-honey discovery |

VERIFIED: `COLUA0` is the flower sprite. The instrumenter raises the visible
sprite limit to 512 for the retained picnic and flowers. It injects narrowly
matched hooks into a generated header; `PureDOOM.h` remains the unmodified
vendored source. Missing or duplicated hook locations fail the build.

## Build and check

From the repository root, with Zig through the wrappers in `source/toolchain/` (any clang and wasm-ld with a wasm32
backend also work; `zig-wasm-ld` adds the `--strip-all` the shipped binary was linked with):

```sh
CLANG=$PWD/source/toolchain/zig-cc WASM_LD=$PWD/source/toolchain/zig-wasm-ld sh source/engine/source/build.sh
cp source/engine/dist/arena.wasm public/engine/arena.wasm
bun test tests/unit/huggingdoom-engine.test.ts
```

VERIFIED: The generated HuggingDOOM WAD must be present in `public/engine/`.
The old WAD lacks `COLUA0`. `build.sh audit` additionally exports the offline
bite research hooks. The audit does not change the public build's observation interface.

VERIFIED: the offline audit `source/engine/source/test_bites.ts` predates the one-heart and grace rules and fails
against them (2026-11-05, its reach assertion at line 70): a bite ignored during the grace or hug window records no
damage while the bear is still in reach. UNKNOWN: whether its records reconcile once that assertion is updated.
