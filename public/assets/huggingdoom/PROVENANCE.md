# HuggingDOOM asset provenance

VERIFIED: the three source atlases were created for this release with built-in image generation from the requested yellow-bear meadow concept. The PNGs are retained so compilation can be repeated without regenerating artwork. These are newly generated game assets, not screenshots or extracted DOOM/Hugging Face artwork.

UNKNOWN: the image generator's model, provider and output terms are not recorded; `PROMPTS.json` names only `built-in image_gen`.

| Source atlas | Layout | Content |
|---|---|---|
| `bear-atlas.png` | 4 × 4, row-major A–P | Waddling, lip-licking, cartoon chomp, impatient wait, honey catch, picnic eating, reciprocal hug, peaceful hearts and emergency-honey poses |
| `meadow-atlas.png` | 2 × 2 | Grass, hedge, sky and meadow vista |
| `props-atlas.png` | 2 × 2 | Honey thrower, soft arms, flowers and honeycomb |

VERIFIED: `scripts/build-huggingdoom-assets.py` slices the atlases, emits derived PNGs, builds a shared 256-color palette and compiles classic DOOM sprite patches and flats into `public/engine/arena.wad.gz`. It suppresses original live-game blood, impact and muzzle-flash imagery. `manifest.json` records the ruleset, frame mapping and SHA-256 digests of PNGs and the WAD. This conversion script does not synthesize images.

VERIFIED: `bear-no-bib-source.png` is a generated edit of the seated honey bear with only its bib removed. Stable per-bear selection uses the no-bib and bib poses; bibs do not flash on and off during eating.

## Sounds

VERIFIED: `scripts/generate-picnic-sounds.py` creates the following original effects using deterministic oscillators, envelopes and seeded noise. It uses Python's standard library and no sampled recording or external sound library.

| File | Cue |
|---|---|
| `sounds/plop.wav` | Honey toss/contact |
| `sounds/empty-click.wav` | Empty honey thrower |
| `sounds/unfold.wav` | Arms unfold |
| `sounds/eating.wav` | Happy eating |
| `sounds/mmmrrraww.wav` | Contented vocal-like bear sound |
| `sounds/hug.wav` | Hug feedback |
| `sounds/chomp.wav` | Cartoon bite |
| `sounds/dizzy.wav` | Stars and embarrassment |
| `sounds/finale.wav` | Emergency-honey gathering |

VERIFIED: all nine files are mono, 16-bit PCM WAV at 44,100 Hz. `sounds/manifest.json` records durations and digests. "Mmmrrraww" is synthesis, not recorded speech, voice cloning or a TTS output.

## Music

`src/app/picnic-audio.ts` plays `gamemusic/gamemusic_huggingdoom.mp3` (133 s, looped as background music while a game runs) and `gamemusic/ouch_1.mp3` to `ouch_5.mp3` (1.3 s bite reactions, one chosen at random).

VERIFIED: the ID3 metadata of all six files names Logic Pro 11.2.2 as the encoding software. UNKNOWN: their author and licence are not recorded here.

## Retained third-party material

VERIFIED: the WAD compiler starts from `tests/fixtures/legacy-engine/arena.wad.gz` and retains support lumps needed by the engine. Remaining Freedoom material retains the notice in `source/engine/source/LICENSE-Freedoom.txt`. PureDOOM's source and GPL v2 notice remain in `source/engine/source/PureDOOM.h` and `LICENSE-PureDOOM.txt`.

The Hugging Face reference is an unofficial homage, not a claim of affiliation. The repository's existing licensing metadata remains unchanged; this provenance record does not replace its licenses or grant a new blanket license over third-party material.
