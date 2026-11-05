# EvoWeights

> (R-)Evolutionary Weight-Space Fine-Tuning

EvoWeights combines AI-engineered weight-space programming with evolutionary weight-space fine-tuning of quantized model weights. Define a measurable goal. A frontier AI model helps prepare the model, task interface using weight-space programming, and evaluation criteria. EvoWeights then searches for better weight configurations through mutation and selection, without further LLM calls.

In this experiment, it adapts NVIDIA Kumo-Tabular Small by evolving selected output weights and sensor-controller weights while keeping the transformer backbone frozen. Candidates compete through simulated gameplay; new revisions are retained only after passing fresh-seed validation and lineage checks.

No backpropagation or GPU is required for browser training. The model uses 96 labelled examples as context; simulated gameplay supplies the optimization feedback.

Watch a 27M-parameter model adapt to a DOOM arena, live on your CPU.

## Play the included build

From the project directory:

```sh
python3 scripts/serve-preview.py
```

This serves the included `docs/` build with cross-origin isolation headers

Open `http://localhost:8080/`, then choose **Play yourself**, let one of the AI models play or train a new model on CPU. 

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

## Deployment

`docs/` is the built site and is committed: GitHub Pages serves it with source "Deploy from a branch", folder `/docs`. Run `make build` and commit `docs/` together with the source change that produced it. Any other static host can serve the same folder.

Shared-memory CPU threads need cross-origin isolation. Hosts that apply `_headers` (Netlify, Cloudflare Pages) get it from that file; elsewhere (GitHub Pages) the page registers `cpu-isolation.js`, a service worker that adds the headers, and reloads once when more than one CPU thread is requested. The thread selector (`#vcpus` in `src/index.html`) is hidden, so the page requests one thread and does not register the service worker.