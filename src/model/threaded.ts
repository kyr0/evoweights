/**
 * Real within-pass threaded Kumo. Call from a dedicated Worker (or `bun`), not the UI thread.
 *
 * One Web Worker path serves browsers, `bun test` and `source/model/check.ts`, instead of a separate `node:worker_threads`
 * branch. VERIFIED: Bun runs module Workers with a shared `WebAssembly.Memory` and a transferred `WebAssembly.Module`
 * (`tests/unit/model.test.ts` checks 4 lanes bit-identical to one). The WASM comes from `baseURL`, so `check.ts` can run a
 * rebuilt binary through the same runtime.
 */
import { cpuThreadLimit, MAX_CPU_THREADS, stackRegion, type LaneStackExports } from './cpu-limits.ts';
import { createKumoPolicy, type KumoExports, type KumoOptions, type KumoPolicy, type KumoRuntime } from './kumo.ts';
import { moduleUrl, siteUrl } from '../shared/site.ts';
import type { LaneReply, LaneStart } from '../workers/inference-lane.ts';

export { cpuThreadLimit, MAX_CPU_THREADS } from './cpu-limits.ts';

export interface LaneDiagnostics {
  lane: number;
  bottom: number;
  top: number;
  passes: number;
  encoderRows: number;
}

export interface ThreadedKumoPolicy extends KumoPolicy {
  backend: 'wasm-simd-threaded' | 'wasm-simd';
  threads: number;
  requestedThreads: number;
  threadLimit: number;
  /** Why fewer lanes than requested run, or null. */
  reason: string | null;
  laneDiagnostics(): LaneDiagnostics[];
}

export interface ThreadedKumoOptions extends Omit<KumoOptions, 'runtime'> {
  threads?: number;
}

interface ThreadedExports extends LaneStackExports, Omit<KumoExports, 'infer'> {
  __stack_pointer: WebAssembly.Global;
  ticket_ptr(): number;
  infer_main(threads: number): void;
  lane_stat(lane: number, field: number): number;
}

interface ThreadedRuntime extends KumoRuntime {
  diagnostics(): LaneDiagnostics[];
}

/** Why threads cannot run in this context, or null. Browsers report `crossOriginIsolated`; server runtimes leave it undefined. */
export function threadingUnavailable(): string | null {
  if (typeof window !== 'undefined') return 'Threaded inference requires a dedicated Worker';
  if (globalThis.crossOriginIsolated === false) return 'Origin is not cross-origin isolated';
  if (typeof Worker === 'undefined') return 'Nested workers are unavailable';
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics.wait !== 'function')
    return 'Shared memory or Atomics.wait is unavailable';
  return null;
}

function startLane(workers: Worker[], start: LaneStart, onFailure: (error: Error) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(moduleUrl('workers/inference-lane'), { type: 'module' });
    workers.push(worker);
    const timeout = setTimeout(() => reject(new Error('CPU helper startup timed out')), 10000);
    worker.onmessage = (event: MessageEvent<LaneReply>) => {
      clearTimeout(timeout);
      if (event.data.ready) resolve();
      else if (event.data.error) {
        const error = new Error(event.data.error);
        onFailure(error);
        reject(error);
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      const error = new Error(event.message || 'CPU helper failed');
      onFailure(error);
      reject(error);
    };
    worker.postMessage(start);
  });
}

async function makeRuntime(threads: number, baseURL: URL, signal?: AbortSignal): Promise<ThreadedRuntime> {
  const workers: Worker[] = [];
  let memory: WebAssembly.Memory | null = null,
    api: ThreadedExports | null = null,
    error: unknown = null;
  const shutdown = () => {
    if (api && memory) {
      const cell = new Int32Array(memory.buffer, api.ticket_ptr(), 1);
      Atomics.store(cell, 0, -1);
      Atomics.notify(cell, 0);
    }
    for (const w of workers) w.terminate();
    workers.length = 0;
  };
  try {
    const response = await fetch(new URL('policy-threads.wasm', baseURL), { signal });
    if (!response.ok) throw new Error('Threaded WASM HTTP ' + response.status);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    const shared = new WebAssembly.Memory({ initial: 1536, maximum: 1536, shared: true });
    memory = shared;
    const instance = await WebAssembly.instantiate(module, {
      env: { memory: shared },
      math: { sin: Math.sin, cos: Math.cos, exp: Math.exp, tanh: Math.tanh },
    });
    const exports = instance.exports as unknown as ThreadedExports;
    api = exports;
    exports.__stack_pointer.value = stackRegion(exports, 0, threads).top;
    await Promise.all(
      Array.from({ length: threads - 1 }, (_, i) =>
        startLane(workers, { module, memory: shared, lane: i + 1, threads }, (e) => (error = e)),
      ),
    );
    return {
      instantiate: async () => ({
        memory: shared,
        data_ptr: exports.data_ptr,
        data_size: exports.data_size,
        input_ptr: exports.input_ptr,
        logits_ptr: exports.logits_ptr,
        infer: () => {
          if (error) throw error;
          try {
            exports.infer_main(threads);
          } catch (e) {
            shutdown();
            error = e;
            throw e;
          }
        },
      }),
      diagnostics: () =>
        Array.from({ length: threads }, (_, lane) => ({
          lane,
          ...stackRegion(exports, lane, threads),
          passes: exports.lane_stat(lane, 0) >>> 0,
          encoderRows: exports.lane_stat(lane, 1),
        })),
      dispose: shutdown,
    };
  } catch (e) {
    shutdown();
    throw e;
  }
}

export async function createThreadedKumoPolicy({
  threads = 2,
  baseURL,
  onProgress,
  signal,
  ...options
}: ThreadedKumoOptions = {}): Promise<ThreadedKumoPolicy> {
  if (!Number.isInteger(threads) || threads < 1 || threads > MAX_CPU_THREADS)
    throw new RangeError('CPU thread count must be an integer from 1 through ' + MAX_CPU_THREADS);
  const requestedThreads = threads,
    threadLimit = cpuThreadLimit();
  threads = Math.min(threads, threadLimit);
  const capReason =
    threads < requestedThreads ? `Device limit reduced ${requestedThreads} requested lanes to ${threads}` : null;
  const modelBase = new URL(baseURL ?? siteUrl('model/'), siteUrl('model/'));
  let reason = threads === 1 ? null : threadingUnavailable(),
    runtime: ThreadedRuntime | null = null;
  if (threads > 1 && !reason) {
    try {
      runtime = await makeRuntime(threads, modelBase, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      reason = 'Could not initialize shared WASM workers: ' + (e instanceof Error ? e.message : String(e));
    }
  }
  try {
    const policy = await createKumoPolicy({ baseURL: modelBase, onProgress, signal, runtime, ...options });
    const active = runtime;
    return Object.assign(policy, {
      backend: active ? ('wasm-simd-threaded' as const) : ('wasm-simd' as const),
      threads: active ? threads : 1,
      requestedThreads,
      threadLimit,
      reason: reason || capReason,
      laneDiagnostics: () => active?.diagnostics() ?? [],
    });
  } catch (e) {
    runtime?.dispose();
    throw e;
  }
}
