#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
"${WASM_CC:-clang}" --target=wasm32 -std=c11 -O3 -msimd128 -matomics -mbulk-memory -nostdlib \
  -Wl,--no-entry,--strip-all,--import-memory,--shared-memory,--export-memory -Wl,--initial-memory=100663296,--max-memory=100663296,-z,stack-size=1048576 \
  -Wl,--export=__stack_pointer,--export=__stack_low,--export=__stack_high,--export=max_lanes,--export=lane_stack_bytes,--export=lane_stat,--export=data_ptr,--export=data_size,--export=input_ptr,--export=logits_ptr \
  -Wl,--export=infer_main,--export=run_lane,--export=ticket_ptr src/kumo-threads.c -o build/policy-threads.wasm
