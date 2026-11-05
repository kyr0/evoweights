/** Inference benchmark: times one backend on fixed observations and checks its logits against the PyTorch reference. */
import { modelFor } from '../policy/decision-policy.js';
import { revisionReference } from '../policy/revision-benchmark.js';
import { openRuntime, percentile } from '../policy/runtime.js';
import { siteUrl } from '../shared/site.js';
import { workerScope } from '../shared/worker-scope.js';
/** Agreement bound with the reference logits. */
const MAX_ERROR = 0.001;
const post = (message) => workerScope.postMessage(message);
const json = async (path) => (await fetch(siteUrl(path))).json();
workerScope.onmessage = async ({ data }) => {
    let runtime;
    try {
        const base = await json('assets/bench-fixtures.json');
        const { precision, head } = modelFor(data.policy, data.revision);
        const { x, warmup } = base;
        const referenceKind = data.revision ? 'pytorch-projected' : 'pytorch';
        const logits = data.revision
            ? await revisionReference(data.revision.ops, x.length)
            : precision === 'fp32'
                ? (await json('assets/bench-fp32.json')).logits
                : base.logits;
        runtime = await openRuntime(data.backend, undefined, precision, data.revision?.ops, data.revisionId);
        const initial = runtime.info(), times = [];
        let matched = 0, maxError = 0;
        for (let i = 0; i < x.length; i++) {
            const t = performance.now(), a = await runtime.infer(x[i], head), elapsed = performance.now() - t;
            const ref = logits[i];
            if (i >= warmup) {
                times.push(elapsed);
                matched += Number(a.action === ref.indexOf(Math.max(...ref)));
                maxError = Math.max(maxError, ...a.logits.map((v, j) => Math.abs(v - ref[j])));
            }
            if (i % 8 === 7)
                post({ type: 'progress', completed: i + 1, total: x.length });
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
    }
    catch (e) {
        post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    finally {
        runtime?.dispose();
    }
};
