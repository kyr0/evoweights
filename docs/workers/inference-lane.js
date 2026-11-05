/** Dedicated helper lane of the threaded policy. All weights remain in its coordinator's shared WASM memory. */
import { stackRegion } from '../model/cpu-limits.js';
import { workerScope } from '../shared/worker-scope.js';
const send = (message) => workerScope.postMessage(message);
async function start({ module, memory, lane, threads }) {
    try {
        const instance = await WebAssembly.instantiate(module, {
            env: { memory },
            math: { exp: Math.exp, tanh: Math.tanh, sin: Math.sin, cos: Math.cos },
        });
        const api = instance.exports;
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
            if (ticket < 0)
                break;
            last = ticket;
            api.run_lane(lane, threads);
        }
    }
    catch (e) {
        send({ error: e instanceof Error ? e.message : String(e) });
    }
}
workerScope.onmessage = (event) => void start(event.data);
