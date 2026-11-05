/** The compiled gang owns eight private scratch records. Each lane gets a disjoint 64 KiB stack. */
export const MAX_CPU_THREADS = 8;
export function cpuThreadLimit(reported = globalThis.navigator?.hardwareConcurrency) {
    const usable = Number.isSafeInteger(reported) && reported > 0 ? reported : 1;
    return Math.max(1, Math.min(MAX_CPU_THREADS, usable));
}
export function stackRegion(api, lane, threads) {
    if (!Number.isInteger(threads) ||
        threads < 1 ||
        threads > MAX_CPU_THREADS ||
        threads > api.max_lanes() ||
        !Number.isInteger(lane) ||
        lane < 0 ||
        lane >= threads)
        throw new RangeError('Unsupported WASM lane geometry');
    const low = api.__stack_low.value, high = api.__stack_high.value, slot = api.lane_stack_bytes();
    if (!Number.isInteger(slot) ||
        slot < 65536 ||
        high > api.memory.buffer.byteLength ||
        high - slot * threads < low ||
        high % 16 ||
        slot % 16)
        throw new Error('WASM lane stacks do not fit the linked stack allocation');
    return { bottom: high - slot * (lane + 1), top: high - slot * lane };
}
