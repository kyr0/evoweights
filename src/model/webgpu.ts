/**
 * Kumo hybrid FP32 compute: WASM runs 4 row/column stages and editable readout.
 * GPU runs all 12 cached in-context blocks, final normalization and 512→1024 head.
 * The end-to-end promise includes GPU queue submission and synchronized 4 KiB readback.
 */
import type { CoreDecision, GpuBridge, HeadVariant, KumoPolicy, TensorEntry } from './kumo.ts';

// Float offsets of the regions in the one-query scratch buffer.
const STATE = 0,
  NORM = 512,
  Q = 1024,
  SCALED = 1536,
  ATT = 2048,
  MLP = 2560,
  SCORES = 3584,
  FLOATS = 4352;
const WORKGROUP_NAMES = ['normalize', 'matrix', 'qk', 'softmax96', 'weighted'] as const;
type Entry = (typeof WORKGROUP_NAMES)[number];
/** Self-check observations; each must reproduce the CPU logits within 0.003 and the same action. */
const CHECKS = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 100, 0, 0, 0],
  [0, 0, 0, 0, 0.004166666883975267, 0.003703703638166189, 0, 0, 0, 25, 100, 0, 0, 1],
  [0.01, 0.05, 0.12, 0.07, 0.01, 0.002, 0, 0, 0, 18, 70, 1, 0, 0],
  [0, 0, 0, 0.2, 0.3, 0.25, 0, 0, 0, 3, 20, 0, 1, 0],
];

interface Dispatch {
  entry: Entry;
  x: number;
  y: number;
  params: number[];
}

export interface AdapterSummary {
  vendor: string;
  architecture: string;
  description: string;
  isFallbackAdapter: boolean | null;
}

export interface GpuTiming {
  cpuEncoder: number;
  gpuSubmitReadback: number;
  cpuReadout: number;
  total: number;
}

export interface WebGpuInfo {
  backend: 'webgpu-hybrid' | 'wasm-simd';
  reason: string | null;
  adapter: AdapterSummary | null;
  selfTest: { matched: number; n: number; maxAbs: number } | null;
  lastTimingMs: GpuTiming | null;
  dispatches: number;
}

export interface KumoWebGPU {
  info(): WebGpuInfo;
  infer(input: ArrayLike<number>, variant?: HeadVariant): Promise<CoreDecision>;
  dispose(): void;
}

export interface KumoWebGPUOptions {
  /** The CPU policy that encodes, decodes and serves as fallback. */
  reference: KumoPolicy;
  onFallback?: (reason: string) => void;
  gpu?: GPU;
  shaderURL?: URL;
}

function floatBits(x: number): number {
  return new Uint32Array(Float32Array.of(x).buffer)[0];
}

function program(tensors: TensorEntry[]): Dispatch[] {
  const table = new Map(tensors.map((t) => [t.name, t.start]));
  function at(n: string): number {
    const start = table.get(n);
    if (start === undefined) throw new Error('Missing Kumo tensor ' + n);
    return start;
  }
  const ops: Dispatch[] = [];
  function go(entry: Entry, x: number, y: number, ...params: number[]): void {
    ops.push({ entry, x, y, params });
  }
  function norm(input: number, out: number, length: number, count: number, weight: number, scale: number, eps: number) {
    go('normalize', count, 1, input, out, length, weight, scale, floatBits(eps));
  }
  function mm(prefix: string, input: number, out: number, n: number, m: number, mode = 0, residual = 0) {
    go('matrix', m / 4, 1, input, out, n, m, at(prefix + '.weight'), at(prefix + '.bias'), mode, residual);
  }
  for (let i = 0; i < 12; i++) {
    const l = 'icl_block.layers.' + i;
    norm(STATE, NORM, 512, 1, at(l + '.query_norm.weight'), 0, 2 ** -23);
    mm(l + '.attn.qkv_lin', NORM, Q, 512, 512);
    norm(Q, SCALED, 64, 8, 0, at(l + '#query_scale'), 1e-6);
    go('qk', 24, 8, SCALED, at(l + '#keys'), SCORES);
    go('softmax96', 8, 1, SCORES);
    go('weighted', 8, 1, SCORES, at(l + '#values'), ATT);
    mm(l + '.attn.out_lin', ATT, STATE, 512, 512, 2, STATE);
    norm(STATE, NORM, 512, 1, at(l + '.mlp.0.weight'), 0, 2 ** -23);
    mm(l + '.mlp.1', NORM, MLP, 512, 1024, 1);
    mm(l + '.mlp.3', MLP, STATE, 1024, 512, 2, STATE);
  }
  norm(STATE, NORM, 512, 1, at('icl_block.norm.weight'), 0, 2 ** -23);
  mm('icl_block.head.0', NORM, MLP, 512, 1024, 1);
  return ops;
}

/** Everything a ready GPU path needs; built once by `initialize`. */
interface Pipeline {
  device: GPUDevice;
  bridge: GpuBridge;
  scratch: GPUBuffer;
  staging: GPUBuffer;
  pipelines: Map<Entry, GPUComputePipeline>;
  group: GPUBindGroup;
  ops: Dispatch[];
  stride: number;
}

export async function createKumoWebGPU({
  reference,
  onFallback,
  gpu = globalThis.navigator?.gpu,
  shaderURL = new URL('./kumo-icl.wgsl', import.meta.url),
}: KumoWebGPUOptions): Promise<KumoWebGPU> {
  if (typeof reference?.infer !== 'function') throw new TypeError('An initialized Kumo policy is required');
  let device: GPUDevice | null = null,
    pipeline: Pipeline | null = null,
    disposed = false,
    adapterInfo: AdapterSummary | null = null,
    reason: string | null = null,
    selfTest: WebGpuInfo['selfTest'] = null,
    lastTimingMs: GpuTiming | null = null,
    dispatches = 0;
  const resources: GPUBuffer[] = [];

  function release(): void {
    const d = device;
    device = null;
    pipeline = null;
    for (const r of resources.splice(0)) r.destroy();
    d?.destroy();
  }
  function fallback(message: string): void {
    if (disposed || reason !== null) return;
    reason = String(message);
    release();
    onFallback?.(reason);
  }
  function buffer(gpuDevice: GPUDevice, desc: GPUBufferDescriptor): GPUBuffer {
    const b = gpuDevice.createBuffer(desc);
    resources.push(b);
    return b;
  }

  async function execute(p: Pipeline, features: ArrayLike<number>, variant: HeadVariant): Promise<CoreDecision> {
    const begin = performance.now();
    const initial = p.bridge.encode(features);
    const encoded = performance.now();
    p.device.queue.writeBuffer(p.scratch, 0, initial as Float32Array<ArrayBuffer>);
    const cmd = p.device.createCommandEncoder({ label: 'Kumo complete ICL inference' });
    const pass = cmd.beginComputePass();
    let previous: Entry | null = null;
    for (const [i, op] of p.ops.entries()) {
      if (previous !== op.entry) {
        pass.setPipeline(p.pipelines.get(op.entry) as GPUComputePipeline);
        previous = op.entry;
      }
      pass.setBindGroup(0, p.group, [i * p.stride]);
      pass.dispatchWorkgroups(op.x, op.y);
    }
    pass.end();
    cmd.copyBufferToBuffer(p.scratch, MLP * 4, p.staging, 0, 4096);
    p.device.queue.submit([cmd.finish()]);
    await p.staging.mapAsync(GPUMapMode.READ);
    try {
      const mapped = performance.now();
      const answer = p.bridge.decode(new Float32Array(p.staging.getMappedRange()), variant);
      const end = performance.now();
      lastTimingMs = {
        cpuEncoder: encoded - begin,
        gpuSubmitReadback: mapped - encoded,
        cpuReadout: end - mapped,
        total: end - begin,
      };
      return answer;
    } finally {
      p.staging.unmap();
    }
  }

  async function initialize(): Promise<Pipeline> {
    if (!gpu) throw new Error('WebGPU unavailable in this execution context');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const details = (adapter.info ?? {}) as Partial<GPUAdapterInfo>;
    const legacyFallback = (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter;
    adapterInfo = {
      vendor: details.vendor ?? '',
      architecture: details.architecture ?? '',
      description: details.description ?? '',
      isFallbackAdapter: details.isFallbackAdapter ?? legacyFallback ?? null,
    };
    const bridge = reference.gpuBridge();
    const bytes = bridge.weights.byteLength;
    if (adapter.limits.maxStorageBufferBindingSize < bytes || adapter.limits.maxBufferSize < bytes)
      throw new Error('Adapter storage limit below ' + bytes + ' bytes');
    const gpuDevice = await adapter.requestDevice({ label: 'Kumo batch-one ICL' });
    device = gpuDevice;
    void gpuDevice.lost.then((loss) => {
      if (device) fallback('WebGPU device lost: ' + (loss.message || loss.reason));
    });
    gpuDevice.addEventListener('uncapturederror', (e) =>
      fallback('WebGPU validation failed: ' + (e as GPUUncapturedErrorEvent).error.message),
    );
    const resp = await fetch(shaderURL);
    if (!resp.ok) throw new Error('WGSL load failed: HTTP ' + resp.status);
    const module = gpuDevice.createShaderModule({ code: await resp.text(), label: 'Kumo ICL f32' });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((x) => x.type === 'error');
    if (errors.length) throw new Error(errors.map((x) => x.lineNum + ': ' + x.message).join('\n'));
    const bindLayout = gpuDevice.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 },
        },
      ],
    });
    const layout = gpuDevice.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const pipelines = new Map(
      await Promise.all(
        WORKGROUP_NAMES.map(
          async (entry) =>
            [
              entry,
              await gpuDevice.createComputePipelineAsync({
                layout,
                compute: { module, entryPoint: entry },
                label: 'Kumo ' + entry,
              }),
            ] as const,
        ),
      ),
    );
    const weights = buffer(gpuDevice, {
      size: bytes,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
      label: 'Frozen Kumo weights + support',
    });
    new Float32Array(weights.getMappedRange()).set(bridge.weights);
    weights.unmap();
    const scratch = buffer(gpuDevice, {
      size: FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      label: 'One-query scratch',
    });
    const staging = buffer(gpuDevice, {
      size: 4096,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: 'One-query hidden readback',
    });
    const ops = program(bridge.tensors);
    dispatches = ops.length;
    const stride = Math.max(gpuDevice.limits.minUniformBufferOffsetAlignment, 48);
    const args = buffer(gpuDevice, {
      size: stride * ops.length,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
      label: 'Kumo dispatch parameters',
    });
    const words = new Uint32Array(args.getMappedRange());
    ops.forEach((op, i) => words.set(op.params, (i * stride) / 4));
    args.unmap();
    const group = gpuDevice.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: weights } },
        { binding: 1, resource: { buffer: scratch } },
        { binding: 2, resource: { buffer: args, size: 48 } },
      ],
    });
    const ready: Pipeline = { device: gpuDevice, bridge, scratch, staging, pipelines, group, ops, stride };
    let maxAbs = 0,
      matched = 0;
    for (const [i, features] of CHECKS.entries()) {
      const variant: HeadVariant =
        reference.precision === 'fp32' ? 'fp32' : (['w4', 'edited', 'bias', 'edited'] as const)[i];
      const expected = reference.infer(features, variant),
        actual = await execute(ready, features, variant);
      const diff = Math.max(...actual.logits.map((v, j) => Math.abs(v - expected.logits[j])));
      maxAbs = Math.max(maxAbs, diff);
      if (Number.isFinite(diff) && diff <= 0.003 && actual.action === expected.action) matched++;
    }
    selfTest = { matched, n: CHECKS.length, maxAbs };
    if (matched !== CHECKS.length) throw new Error('WebGPU self-check failed: ' + JSON.stringify(selfTest));
    return ready;
  }

  try {
    const ready = await initialize();
    // VERIFIED: fallback() runs from device.lost and uncapturederror, which can fire while initialize() awaits the
    // self-check; publishing the pipeline only when no fallback happened keeps that decision instead of overwriting it.
    if (reason === null) pipeline = ready;
  } catch (e) {
    fallback(e instanceof Error ? e.message : String(e));
  }
  // GPU staging buffers are reused. Serialize public calls to maintain map/submit ordering.
  let serial: Promise<unknown> = Promise.resolve();
  return {
    info: () => ({
      backend: pipeline ? 'webgpu-hybrid' : 'wasm-simd',
      reason,
      adapter: adapterInfo,
      selfTest,
      lastTimingMs,
      dispatches,
    }),
    infer(input, variant = reference.defaultVariant || 'edited') {
      const features = Float32Array.from(input);
      const run = async (): Promise<CoreDecision> => {
        if (disposed) throw new Error('WebGPU backend disposed');
        const ready = pipeline;
        if (!ready) return reference.infer(features, variant);
        if (features.length !== 14 || !features.every(Number.isFinite))
          throw new RangeError('Kumo expects 14 finite features');
        ready.bridge.validateVariant(variant);
        try {
          return await execute(ready, features, variant);
        } catch (e) {
          fallback(e instanceof Error ? e.message : String(e));
          return reference.infer(features, variant);
        }
      };
      const result = serial.then(run);
      serial = result.catch(() => {});
      return result;
    },
    dispose() {
      disposed = true;
      release();
    },
  };
}
