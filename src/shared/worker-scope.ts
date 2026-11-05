/**
 * The dedicated-worker global, typed without the WebWorker lib, which conflicts with the DOM lib the rest of `src/` uses.
 * VERIFIED: TypeScript 7.0.2 with `--lib es2024,dom,webworker` reports 452 duplicate-declaration errors. A second tsconfig
 * for the workers would split one module graph that page and workers share (`model/`, `training/`, `shared/`).
 * Worker entry points import this instead of touching `self`.
 */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export const workerScope = globalThis as unknown as WorkerScope;

/** Yield to the event loop so queued messages (stop, watch) are handled between game steps. */
export function createYield(): () => Promise<void> {
  const channel = new MessageChannel();
  let resume: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const fn = resume;
    resume = null;
    fn?.();
  };
  const host = globalThis as {
    scheduler?: { yield?: () => Promise<void> };
    setImmediate?: (callback: () => void) => void;
  };
  return () => {
    if (host.scheduler?.yield) return host.scheduler.yield();
    const immediate = host.setImmediate;
    if (typeof immediate === 'function') return new Promise((resolve) => immediate(() => resolve()));
    return new Promise((resolve) => {
      resume = resolve;
      channel.port2.postMessage(0);
    });
  };
}

/** The error both training workers use to end a run on request; callers tell it apart by `name`. */
export function abortError(): Error {
  return Object.assign(new Error('Training stopped'), { name: 'AbortError' });
}
