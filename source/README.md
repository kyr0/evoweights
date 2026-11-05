# Source code of the WebAssembly binaries

| Binary | Source | Build | Check |
|---|---|---|---|
| `public/engine/arena.wasm` (HuggingDOOM game engine) | `engine/source/arena.c`, PureDOOM revision 355cfbd (`engine/source/PureDOOM.h`, GPL v2) | `engine/source/build.sh` | SHA-256 of `engine/dist/arena.wasm` equals `../public/engine/arena.wasm` |
| `public/model/policy-simd.wasm` (Kumo inference, single thread) | `model/src/kumo.c`, `model/src/layout.h` | `model/build_simd.sh` | `bun source/model/check.ts` |
| `public/model/policy-threads.wasm` (Kumo inference, shared-memory threads) | `model/src/kumo-threads.c`, `model/src/layout.h` | `model/build_threads.sh` | `bun source/model/check.ts` |

VERIFIED: `engine/source/arena.c` and `instrument.py` contain the HuggingDOOM rules and PureDOOM hooks. The TypeScript host adapter is `../src/engine/arena.ts`. `engine/source/PureDOOM.h` retains upstream revision `355cfbd16fac119718879239336ee2ea408886bd`; its GPL v2 notice and the Freedoom asset notice remain in `engine/source/LICENSE-*.txt`. Model notices are in `../public/model/licenses/`.

VERIFIED: `python3 scripts/package-engine-source.py` from the repository root refreshes `public/engine/huggingdoom-engine-source.zip` from the current engine, compiler and texture inputs.

The archived `verified*.json` and original engine description record the earlier DOOM environment. They do not verify HuggingDOOM gameplay or rendering. Current behavior is documented in [engine/HUGGINGDOOM.md](engine/HUGGINGDOOM.md) and exercised by the HuggingDOOM tests.

## Build

Use clang and wasm-ld with a wasm32 backend, or Zig through the included wrappers. These commands rebuild the engine and copy its result into the site's source assets; `make build` then refreshes the deployable site:

```sh
cd source
CLANG=$PWD/toolchain/zig-cc WASM_LD=$PWD/toolchain/zig-wasm-ld sh engine/source/build.sh   # → engine/dist/arena.wasm
cp engine/dist/arena.wasm ../public/engine/arena.wasm
cd ..
make build
```

## Historical DOOM rebuild check of 2026-11-05 (zig 0.17.0, Node.js, macOS)

These records predate HuggingDOOM.

- **Engine:** the rebuilt `arena.wasm` was byte-identical to the shipped file (SHA-256 `69f96741…11e7ced`).
- **Model:** the shipped policy binaries were built with LLVM 23 from Emscripten, so a zig build differs in bytes. The Node.js script `model/check.mjs`, which `model/check.ts` ports to Bun with the same comparison, ran both builds through the shipped runtime and model packs on 616 reference observations × 3 head variants: all 5,544 logits matched bit for bit, for the SIMD and the 4-thread build.

## Textures and sounds

VERIFIED: the release retains its generated source atlases; rebuilding the WAD does not call an image model. From the repository root:

```sh
uv run --with Pillow==13.0.0 python scripts/build-huggingdoom-assets.py
python3 scripts/generate-picnic-sounds.py
make build
```

The first command reads the bundled legacy IWAD fixture, replaces the gameplay art and writes `public/engine/arena.wad.gz` plus derived PNGs and a manifest. The second writes nine deterministic PCM WAVs and their manifest. [Asset provenance](../public/assets/huggingdoom/PROVENANCE.md) lists the sources and retained notices.

## Model binary rebuilds

The model code is unchanged by the theme. Its original build commands remain:

```sh
cd source
WASM_CC=$PWD/toolchain/zig-cc sh model/build_simd.sh
WASM_CC=$PWD/toolchain/zig-cc bash model/build_threads.sh
cd ..
bun source/model/check.ts
```

## Model packs

`model/export.py` (4-bit packs, `model-*.pack`) and `model/export_original.py` (FP32 packs, `original-*.pack`) produced the weight files from the NVIDIA Kumo-Tabular Small checkpoint and the experiment's support set. They need that checkpoint, PyTorch and NumPy, which this folder does not contain; the packs are checked by SHA-256 against `../public/model/manifest.json` and `../public/model/original-manifest.json` when the page loads them. The packs are published on Hugging Face (Model packs in [`../README.md`](../README.md)); `make models` downloads the local copies in `../.cache/model/` that `model/check.ts` and the tests read.
