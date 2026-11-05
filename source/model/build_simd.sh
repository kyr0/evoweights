#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"; mkdir -p build
: "${WASM_CC:=clang}"
"$WASM_CC" --target=wasm32 -std=c11 -msimd128 -mbulk-memory -O3 -nostdlib -Wl,--no-entry -Wl,--strip-all -Wl,--export-memory -Wl,--export=data_ptr -Wl,--export=data_size -Wl,--export=input_ptr -Wl,--export=logits_ptr -Wl,--export=infer -Wl,--export=encode_for_gpu -Wl,--export=finish_for_gpu -Wl,--export=state_ptr -Wl,--export=hidden_ptr src/kumo.c -o build/policy-simd.wasm
