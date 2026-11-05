/** Dedicated helper lane of the threaded policy. All weights remain in its coordinator's shared WASM memory. */
import { stackRegion, type LaneStackExports } from '../model/cpu-limits.ts';
import { workerScope } from '../shared/worker-scope.ts';

export interface LaneStart {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  lane: number;
  threads: number;
}

export type LaneReply = { ready: true; error?: undefined } | { ready?: undefined; error: string };

interface LaneExports extends LaneStackExports {
  __stack_pointer: WebAssembly.Global;
  ticket_ptr(): number;
  run_lane(lane: number, threads: number): void;
}

const send = (message: LaneReply) => workerScope.postMessage(message);

async function start({ module, memory, lane, threads }: LaneStart): Promise<void> {
  try {
    const instance = await WebAssembly.instantiate(module, {
      env: { memory },
      math: { exp: Math.exp, tanh: Math.tanh, sin: Math.sin, cos: Math.cos },
    });
    const api = instance.exports as unknown as LaneExports;
    api.__stack_pointer.value = stackRegion(api, lane, threads).top;
    const signal = new Int32Array(memory.buffer, api.ticket_ptr(), 1);
    let last = Atomics.load(signal, 0);
    send({ ready: true });
    for (;;) {
      const ticket = Atomics.load(signal, 0);
      if (ticket === last) {
        Atomics.wait(signal, 0, last);
        continue;
      }
      if (ticket < 0) break;
      last = ticket;
      api.run_lane(lane, threads);
    }
  } catch (e) {
    send({ error: e instanceof Error ? e.message : String(e) });
  }
}

workerScope.onmessage = (event) => void start(event.data as LaneStart);
