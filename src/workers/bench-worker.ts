/** Inference benchmark: times one backend on fixed observations and checks its logits against the PyTorch reference. */
import { modelFor, type PolicyRevision } from '../policy/decision-policy.ts';
import { revisionReference } from '../policy/revision-benchmark.ts';
import { openRuntime, percentile, type BackendInfo, type Runtime } from '../policy/runtime.ts';
import { siteUrl } from '../shared/site.ts';
import { workerScope } from '../shared/worker-scope.ts';

export interface BenchRequest {
  policy: string;
  backend: string;
  revision?: PolicyRevision;
  revisionId?: string;
}

export type BenchResult = BackendInfo & {
  type: 'result';
  request: string;
  policy: string;
  warmup: number;
  samples: number;
  p50: number | null;
  p95: number | null;
  referenceKind: 'pytorch' | 'pytorch-projected';
  matched: number;
  maxError: number;
  passed: boolean;
  isolated: boolean;
  cores: number;
  ua: string;
};

export type BenchReply =
  { type: 'progress'; completed: number; total: number } | BenchResult | { type: 'error'; message: string };

interface BenchFixtures {
  x: number[][];
  warmup: number;
  logits: number[][];
}

/** Agreement bound with the reference logits. */
const MAX_ERROR = 0.001;

const post = (message: BenchReply) => workerScope.postMessage(message);
const json = async <T>(path: string): Promise<T> => (await fetch(siteUrl(path))).json() as Promise<T>;

workerScope.onmessage = async ({ data }: MessageEvent<BenchRequest>) => {
  let runtime: Runtime | undefined;
  try {
    const base = await json<BenchFixtures>('assets/bench-fixtures.json');
    const { precision, head } = modelFor(data.policy, data.revision);
    const { x, warmup } = base;
    const referenceKind = data.revision ? 'pytorch-projected' : 'pytorch';
    const logits = data.revision
      ? await revisionReference(data.revision.ops, x.length)
      : precision === 'fp32'
        ? (await json<{ logits: number[][] }>('assets/bench-fp32.json')).logits
        : base.logits;
    runtime = await openRuntime(data.backend, undefined, precision, data.revision?.ops, data.revisionId);
    const initial = runtime.info(),
      times: number[] = [];
    let matched = 0,
      maxError = 0;
    for (let i = 0; i < x.length; i++) {
      const t = performance.now(),
        a = await runtime.infer(x[i], head),
        elapsed = performance.now() - t;
      const ref = logits[i];
      if (i >= warmup) {
        times.push(elapsed);
        matched += Number(a.action === ref.indexOf(Math.max(...ref)));
        maxError = Math.max(maxError, ...a.logits.map((v, j) => Math.abs(v - ref[j])));
      }
      if (i % 8 === 7) post({ type: 'progress', completed: i + 1, total: x.length });
    }
    const info = runtime.info();
    if (initial.backend !== info.backend || initial.reason !== info.reason)
      throw new Error('Backend changed during measurement. Run again on the available backend.');
    post({
      type: 'result',
      request: data.backend,
      policy: data.policy,
      ...info,
      warmup,
      samples: times.length,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      referenceKind,
      matched,
      maxError,
      passed: matched === times.length && maxError < MAX_ERROR,
      isolated: globalThis.crossOriginIsolated,
      cores: navigator.hardwareConcurrency,
      ua: navigator.userAgent,
    });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    runtime?.dispose();
  }
};
