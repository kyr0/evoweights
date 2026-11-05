# EvoWeights · HuggingDOOM: Honey & Hugs

VERIFIED: v0.2.0 replaces the live DOOM arena with HuggingDOOM: a bright meadow, hungry yellow bears, 26 honeycombs and five hearts. Honey feeds bears at a distance; unlimited hugs require close contact. Peaceful bears sit down for a picnic. The game, Kumo inference, CPU weight evolution and revision history run in the browser.

## Play the included build

From the extracted project directory:

```sh
python3 scripts/serve-preview.py
```

Open `http://localhost:8080/`, then choose **Play yourself**. This serves the included `docs/` build with cross-origin isolation headers; no Bun installation or model download is needed for human play. Use A/D or the left/right arrow keys to turn, W/S or the up/down arrow keys to walk, and hold Space, Alt or Ctrl to toss honey or hug. Touch controls and a sound toggle are included. Music loops during play and pauses with the game; bites play a random ouch clip. The sound toggle mutes both music and effects.

VERIFIED: choosing an AI or starting training downloads missing model packs from the pinned Hugging Face origin and caches verified copies in the browser for later sessions. The supplied model revisions remain usable, but learned the original DOOM task: their archived scores are not HuggingDOOM scores. New evaluation evidence uses ruleset `huggingdoom-v1`.

VERIFIED: the six built-in models include fresh HuggingDOOM results from 48 fixed games each. New models play the same reference games after validation. The completion dialog, model cards and inheritance tree use these results for survival comparisons and Survival/Hugs bars. Rank orders every measured model by survival; equal totals share a rank.

See [HuggingDOOM engine rules](source/engine/HUGGINGDOOM.md) for mechanics and asset rebuilds. The name is an unofficial homage to Hugging Face; this is an independent EvoWeights project.

## Commands

| Command | What it does |
|---|---|
| `python3 scripts/serve-preview.py` | serves the included `docs/` without rebuilding or fetching models |
| `make setup` | `bun install --frozen-lockfile`, the Playwright Chromium and the model packs (`make models`) |
| `make models` | downloads the model packs from Hugging Face into `.cache/model/` and checks each against its manifest; makes no request when verified copies exist |
| `make build` | compiles `src/` and copies `public/` into `docs/`, the folder GitHub Pages deploys |
| `make start` / `make stop` | builds, then serves `docs/` on `http://localhost:8080/` with the cross-origin isolation headers (logs in `var/log/`) |
| `make test` | unit and integration tests against the shipped WASM, the local pack copy and real workers (`bun test`) |
| `make coverage` | the same with line coverage |
| `make lint` | `tsc` for `src/` and for tests and scripts, `oxlint`, `prettier --check` |
| `make e2e` | builds and drives every page section in Chromium; the report goes to `output/` |
| `make verify` | lint, test, coverage and e2e |

Rebuilding the WASM binaries from source is described in [`source/README.md`](source/README.md).

## Layout

| Path | Contents |
|---|---|
| `src/` | TypeScript sources and the page (`index.html`, `styles/`); compiled 1:1 into `docs/` |
| `public/` | static files copied verbatim: model manifests and licenses, WASM binaries, the arena WAD, controller weights, data, images, `_headers` |
| `source/` | sources and build scripts of the WASM binaries and the model export |
| `tests/unit/` | `bun test` suites; `tests/e2e/` Playwright specs |
| `scripts/` | site build and servers, pinned-model downloader, atlas-to-WAD compiler and deterministic sound generator |
| `public/assets/huggingdoom/` | generated source atlases, derived PNG textures, sounds, manifests and provenance |

Inside `src/`: `app/` page UI (main thread), `workers/` every dedicated worker entry point, `engine/` the arena host adapter, `model/` Kumo inference backends, `tactical/` the signed-code controllers, `policy/` the runtime facade and live decision policies, `revisions/` revision identity, storage and the snapshot format, `training/` the evaluation engine, lane pool and the EDNO optimizer, `shared/` site URLs, SHA-256 and worker helpers.

## Model packs

The model weights are not in this repository. Six 4-bit packs (20.3 MB) and twelve FP32 packs (79.1 MB) live in the Hugging Face repository [`kyr0/evoweights-evolutionary-weight-space-fine-tuning`](https://huggingface.co/kyr0/evoweights-evolutionary-weight-space-fine-tuning) under `base/4bit/` and `base/fp32/`. The site downloads them on demand from a pinned commit (`MODEL_PACK_URL` in `src/shared/site.ts`): the 4-bit packs when AI play, the benchmark or training first needs a 4-bit model, and the FP32 packs only for the original model. The manifests that name and hash the packs stay in `public/model/`.

Publishing new packs takes three steps: upload them to the Hugging Face repository, update the manifests in `public/model/` and the digests in `src/revisions/trust.ts`, then point `MODEL_PACK_URL` at the new commit.

VERIFIED: play, benchmarks, training and weight exports share a browser cache of verified packs. Reloading the page or switching between models with the same base reuses those bytes. Cache keys include the source URL and manifest hashes; damaged entries are fetched again. Browsers can clear stored data, and storage restrictions or a full cache cause the loader to use a verified download without saving it. Site modules, manifests and WASM still load from the site origin.

## Deployment

`docs/` is the built site and is committed: GitHub Pages serves it with source "Deploy from a branch", folder `/docs`. Run `make build` and commit `docs/` together with the source change that produced it. Any other static host can serve the same folder.

Shared-memory CPU threads need cross-origin isolation. Hosts that apply `_headers` (Netlify, Cloudflare Pages) get it from that file; elsewhere (GitHub Pages) the page registers `cpu-isolation.js`, a service worker that adds the headers, and reloads once when more than one CPU thread is requested. The thread selector (`#vcpus` in `src/index.html`) is hidden, so the page requests one thread and does not register the service worker.

## Release baseline and evidence

VERIFIED: this update builds on commit `d217d3dbc87f08c8edd4ab3973fe263e0ff87d3a`, the repository's initial commit; `git diff d217d3d` shows the change. `public/engine/huggingdoom-engine-source.zip` (`scripts/package-engine-source.py`) holds the engine source, its build toolchain wrappers, the asset scripts, the source atlases and the legacy engine fixtures. Model packs remain external; `make models` downloads verified local copies for development and testing.

The historical DOOM findings in the research sections and archived JSON remain historical evidence. Rendering, finite honey, fixed-cost bites, hug timing and persistent picnic guests change the environment. Fresh HuggingDOOM measurements are required before claiming a transferred model improved.
