/** The compiled gang owns eight private scratch records. Each lane gets a disjoint 64 KiB stack. */
export const MAX_CPU_THREADS = 8;

/** The part of the threaded policy WASM's exports that lane stack placement needs. */
export interface LaneStackExports {
  memory: WebAssembly.Memory;
  __stack_low: WebAssembly.Global;
  __stack_high: WebAssembly.Global;
  max_lanes(): number;
  lane_stack_bytes(): number;
}

export function cpuThreadLimit(reported: number | undefined = globalThis.navigator?.hardwareConcurrency): number {
  const usable = Number.isSafeInteger(reported) && (reported as number) > 0 ? (reported as number) : 1;
  return Math.max(1, Math.min(MAX_CPU_THREADS, usable));
}

export function stackRegion(api: LaneStackExports, lane: number, threads: number): { bottom: number; top: number } {
  if (
    !Number.isInteger(threads) ||
    threads < 1 ||
    threads > MAX_CPU_THREADS ||
    threads > api.max_lanes() ||
    !Number.isInteger(lane) ||
    lane < 0 ||
    lane >= threads
  )
    throw new RangeError('Unsupported WASM lane geometry');
  const low = api.__stack_low.value as number,
    high = api.__stack_high.value as number,
    slot = api.lane_stack_bytes();
  if (
    !Number.isInteger(slot) ||
    slot < 65536 ||
    high > api.memory.buffer.byteLength ||
    high - slot * threads < low ||
    high % 16 ||
    slot % 16
  )
    throw new Error('WASM lane stacks do not fit the linked stack allocation');
  return { bottom: high - slot * (lane + 1), top: high - slot * lane };
}
