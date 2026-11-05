export const workerScope = globalThis;
/** Yield to the event loop so queued messages (stop, watch) are handled between game steps. */
export function createYield() {
    const channel = new MessageChannel();
    let resume = null;
    channel.port1.onmessage = () => {
        const fn = resume;
        resume = null;
        fn?.();
    };
    const host = globalThis;
    return () => {
        if (host.scheduler?.yield)
            return host.scheduler.yield();
        const immediate = host.setImmediate;
        if (typeof immediate === 'function')
            return new Promise((resolve) => immediate(() => resolve()));
        return new Promise((resolve) => {
            resume = resolve;
            channel.port2.postMessage(0);
        });
    };
}
/** The error both training workers use to end a run on request; callers tell it apart by `name`. */
export function abortError() {
    return Object.assign(new Error('Training stopped'), { name: 'AbortError' });
}
