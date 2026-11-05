/** Inference backends behind one facade. Every facade resolves after a completed decision, including GPU readback. */
import { createKumoPolicy, } from '../model/kumo.js';
const message = (e) => (e instanceof Error ? e.message : String(e));
function cpuRuntime(p, reason) {
    return {
        ref: p,
        infer: (x, v) => p.infer(x, v),
        info: () => ({ backend: 'wasm-simd', threads: 1, reason }),
        dispose: () => p.dispose(),
    };
}
async function loadBackend(request, onProgress, precision, readAsset) {
    if (/^cpu[2-8]$/.test(request)) {
        try {
            const { createThreadedKumoPolicy } = await import('../model/threaded.js');
            const p = await createThreadedKumoPolicy({
                threads: Number(request.slice(-1)),
                onProgress,
                precision,
                readAsset,
            });
            return {
                ref: p,
                infer: (x, v) => p.infer(x, v),
                info: () => ({ backend: p.backend, threads: p.threads, reason: p.reason || null }),
                dispose: () => p.dispose(),
            };
        }
        catch (e) {
            const p = await createKumoPolicy({ onProgress, precision, readAsset });
            return cpuRuntime(p, 'CPU pool unavailable: ' + message(e));
        }
    }
    const p = await createKumoPolicy({ onProgress, precision, readAsset });
    if (request === 'gpu') {
        try {
            const { createKumoWebGPU } = await import('../model/webgpu.js');
            const g = await createKumoWebGPU({ reference: p });
            return {
                ref: p,
                infer: (x, v) => g.infer(x, v),
                info: () => g.info(),
                dispose: () => {
                    g.dispose();
                    p.dispose();
                },
            };
        }
        catch (e) {
            return cpuRuntime(p, 'WebGPU unavailable: ' + message(e));
        }
    }
    return cpuRuntime(p, null);
}
export async function openRuntime(request = 'wasm', onProgress, precision = 'w4', headOps, revisionId) {
    if (headOps !== undefined && (precision !== 'w4' || !Array.isArray(headOps)))
        throw new Error('Invalid custom W4 head');
    let readAsset;
    if (revisionId) {
        const { getImportedModelAssets } = await import('../revisions/store.js');
        readAsset = await getImportedModelAssets(revisionId);
    }
    const backend = await loadBackend(request, onProgress, precision, readAsset);
    try {
        if (headOps !== undefined)
            backend.ref.setHeadPatch(headOps);
        return backend;
    }
    catch (error) {
        backend.dispose();
        throw error;
    }
}
/** The q-quantile by the nearest-rank method, or null for no values. */
export function percentile(values, q) {
    if (!values.length)
        return null;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil(s.length * q) - 1)];
}
