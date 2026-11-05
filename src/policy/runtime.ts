/** Inference backends behind one facade. Every facade resolves after a completed decision, including GPU readback. */
import {
  createKumoPolicy,
  type CoreDecision,
  type HeadOp,
  type HeadVariant,
  type KumoPolicy,
  type LoadProgress,
  type Precision,
  type ReadModelAsset,
} from '../model/kumo.ts';
import type { WebGpuInfo } from '../model/webgpu.ts';

/** `wasm` (one SIMD thread), `cpu2` … `cpu8` (shared-memory lanes) or `gpu` (WebGPU hybrid). */
export type BackendRequest = string;

export interface BackendInfo extends Partial<Omit<WebGpuInfo, 'backend' | 'reason'>> {
  backend: string;
  threads?: number;
  reason: string | null;
}

export interface Runtime {
  ref: KumoPolicy;
  infer(features: ArrayLike<number>, variant?: HeadVariant): CoreDecision | Promise<CoreDecision>;
  info(): BackendInfo;
  dispose(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function cpuRuntime(p: KumoPolicy, reason: string | null): Runtime {
  return {
    ref: p,
    infer: (x, v) => p.infer(x, v),
    info: () => ({ backend: 'wasm-simd', threads: 1, reason }),
    dispose: () => p.dispose(),
  };
}

async function loadBackend(
  request: BackendRequest,
  onProgress: ((progress: LoadProgress) => void) | undefined,
  precision: Precision,
  readAsset: ReadModelAsset | undefined,
): Promise<Runtime> {
  if (/^cpu[2-8]$/.test(request)) {
    try {
      const { createThreadedKumoPolicy } = await import('../model/threaded.ts');
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
    } catch (e) {
      const p = await createKumoPolicy({ onProgress, precision, readAsset });
      return cpuRuntime(p, 'CPU pool unavailable: ' + message(e));
    }
  }
  const p = await createKumoPolicy({ onProgress, precision, readAsset });
  if (request === 'gpu') {
    try {
      const { createKumoWebGPU } = await import('../model/webgpu.ts');
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
    } catch (e) {
      return cpuRuntime(p, 'WebGPU unavailable: ' + message(e));
    }
  }
  return cpuRuntime(p, null);
}

export async function openRuntime(
  request: BackendRequest = 'wasm',
  onProgress?: (progress: LoadProgress) => void,
  precision: Precision = 'w4',
  headOps?: HeadOp[],
  revisionId?: string,
): Promise<Runtime> {
  if (headOps !== undefined && (precision !== 'w4' || !Array.isArray(headOps)))
    throw new Error('Invalid custom W4 head');
  let readAsset: ReadModelAsset | undefined;
  if (revisionId) {
    const { getImportedModelAssets } = await import('../revisions/store.ts');
    readAsset = await getImportedModelAssets(revisionId);
  }
  const backend = await loadBackend(request, onProgress, precision, readAsset);
  try {
    if (headOps !== undefined) backend.ref.setHeadPatch(headOps);
    return backend;
  } catch (error) {
    backend.dispose();
    throw error;
  }
}

/** The q-quantile by the nearest-rank method, or null for no values. */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * q) - 1)];
}
