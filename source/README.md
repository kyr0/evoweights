# Source code of the WebAssembly binaries

| Binary | Source | Build | Check |
|---|---|---|---|
| `public/engine/arena.wasm` (DOOM game engine) | `engine/source/arena.c`, PureDOOM revision 355cfbd (`engine/source/PureDOOM.h`, GPL v2) | `engine/source/build.sh` | SHA-256 of `engine/dist/arena.wasm` equals `../public/engine/arena.wasm` |
| `public/model/policy-simd.wasm` (Kumo inference, single thread) | `model/src/kumo.c`, `model/src/layout.h` | `model/build_simd.sh` | `bun source/model/check.ts` |
| `public/model/policy-threads.wasm` (Kumo inference, shared-memory threads) | `model/src/kumo-threads.c`, `model/src/layout.h` | `model/build_threads.sh` | `bun source/model/check.ts` |

`../public/engine/doom-engine-source.zip` is the archived 2026-11-03 engine release (C source, build scripts, its JavaScript host adapter `dist/arena.mjs` and Node tests). `engine/source/` holds the same C source and build scripts; in this repository the host adapter is `../src/engine/arena.ts` and the release's Node tests are ported to `../tests/unit/engine.test.ts`, except the audit-build comparison `engine/source/test_bites.ts`. `engine/README.md` is the release's interface description; its licenses are in `engine/source/LICENSE-*.txt`. The model licenses are in `../public/model/licenses/`.

## Build

Any clang/wasm-ld with a wasm32 backend works. Apple's clang has none; with zig (tested 0.17.0, Homebrew) use the wrappers in `toolchain/`:

```sh
cd source
CLANG=$PWD/toolchain/zig-cc WASM_LD=$PWD/toolchain/zig-wasm-ld sh engine/source/build.sh   # → engine/dist/arena.wasm
WASM_CC=$PWD/toolchain/zig-cc sh model/build_simd.sh                                       # → model/build/policy-simd.wasm
WASM_CC=$PWD/toolchain/zig-cc bash model/build_threads.sh                                  # → model/build/policy-threads.wasm
shasum -a 256 engine/dist/arena.wasm ../public/engine/arena.wasm
cd .. && bun source/model/check.ts                                                          # Bun 1.4+
```

## Rebuild check of 2026-11-05 (zig 0.17.0, Node.js, macOS)

- **Engine:** the rebuilt `arena.wasm` was byte-identical to the shipped file (SHA-256 `69f96741…11e7ced`).
- **Model:** the shipped policy binaries were built with LLVM 23 from Emscripten, so a zig build differs in bytes. The Node.js script `model/check.mjs`, which `model/check.ts` ports to Bun with the same comparison, ran both builds through the shipped runtime and model packs on 616 reference observations × 3 head variants: all 5,544 logits matched bit for bit, for the SIMD and the 4-thread build.

## Model packs

`model/export.py` (4-bit packs, `model-*.pack`) and `model/export_original.py` (FP32 packs, `original-*.pack`) produced the weight files from the NVIDIA Kumo-Tabular Small checkpoint and the experiment's support set. They need that checkpoint, PyTorch and NumPy, which this folder does not contain; the packs are checked by SHA-256 against `../public/model/manifest.json` and `../public/model/original-manifest.json` when the page loads them. The packs are published on Hugging Face (Model packs in [`../README.md`](../README.md)); `make models` downloads the local copies in `../.cache/model/` that `model/check.ts` and the tests read.
