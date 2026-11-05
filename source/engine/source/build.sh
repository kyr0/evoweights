#!/usr/bin/env sh
# Run in the browser-engine-asset directory; point CLANG and WASM_LD to LLVM 23 or equivalent.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
case "${1:-public}" in
    public)  build_dir=build; output=dist/arena.wasm; audit_define=; set -- ;;
    audit)   build_dir=build/bite-audit; output=build/bite-audit.wasm; audit_define=-DAGM_BITE_AUDIT
             set -- --export=arena_bite_count --export=arena_bites ;;
    *)       echo "usage: build.sh [public|audit]" >&2; exit 2 ;;
esac
mkdir -p "$build_dir" dist
python3 source/instrument.py source/PureDOOM.h "$build_dir"/PureDOOM-instrumented.h
: "${CLANG:=clang}" "${WASM_LD:=wasm-ld}"
"$CLANG" --target=wasm32-unknown-unknown -O2 -ffreestanding -fno-builtin -fwrapv -ffunction-sections -fdata-sections -Wno-everything "${audit_define:--UAGM_BITE_AUDIT}" -I"$build_dir" -c source/arena.c -o "$build_dir"/arena.o
"$WASM_LD" --no-entry --allow-undefined --gc-sections --export-memory --initial-memory=50331648 --max-memory=50331648 -z stack-size=1048576 --export=arena_wad --export=arena_start --export=arena_done --export=arena_step --export=arena_visible --export=arena_visible_yaw --export=arena_combat --export=arena_attacks --export=arena_damages --export=arena_sensors --export=arena_telemetry --export=arena_frame --export=arena_features --export=arena_kills --export=arena_tic --export=arena_set_limit --export=arena_limit "$@" "$build_dir"/arena.o -o "$output"
