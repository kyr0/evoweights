# EvoWeights

A static web page where a 4-bit Kumo Small model plays a WebAssembly DOOM arena in the visitor's browser, and where visitors evolve the model's signed 4-bit weights on their own CPU (EvoWeights, evolutionary weight-space fine-tuning). Everything runs client-side: inference (WASM SIMD, shared-memory threads or WebGPU), the game engine, training and the revision history (IndexedDB).

## Commands

| Command | What it does |
|---|---|
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
| `scripts/` | `build.ts`, the local static server `serve.ts` and `fetch-models.ts` (behind `make models`) |

Inside `src/`: `app/` page UI (main thread), `workers/` every dedicated worker entry point, `engine/` the arena host adapter, `model/` Kumo inference backends, `tactical/` the signed-code controllers, `policy/` the runtime facade and live decision policies, `revisions/` revision identity, storage and the snapshot format, `training/` the evaluation engine, lane pool and the EDNO optimizer, `shared/` site URLs, SHA-256 and worker helpers.

## Model packs

The model weights are not in this repository. Six 4-bit packs (20.3 MB) and twelve FP32 packs (79.1 MB) live in the Hugging Face repository [`kyr0/evoweights-evolutionary-weight-space-fine-tuning`](https://huggingface.co/kyr0/evoweights-evolutionary-weight-space-fine-tuning) under `base/4bit/` and `base/fp32/`. The site downloads them on demand from a pinned commit (`MODEL_PACK_URL` in `src/shared/site.ts`): the 4-bit packs when live play, the benchmark or training first needs a 4-bit model, and the FP32 packs only for the original model. The manifests that name and hash the packs stay in `public/model/`.

Publishing new packs takes three steps: upload them to the Hugging Face repository, update the manifests in `public/model/` and the digests in `src/revisions/trust.ts`, then point `MODEL_PACK_URL` at the new commit.

## Deployment

`docs/` is the built site and is committed: GitHub Pages serves it with source "Deploy from a branch", folder `/docs`. Run `make build` and commit `docs/` together with the source change that produced it. Any other static host can serve the same folder.

Shared-memory CPU threads need cross-origin isolation. Hosts that apply `_headers` (Netlify, Cloudflare Pages) get it from that file; elsewhere (GitHub Pages) the page registers `cpu-isolation.js`, a service worker that adds the headers, and reloads once when more than one CPU thread is requested. The thread selector (`#vcpus` in `src/index.html`) is hidden, so the page requests one thread and does not register the service worker.
