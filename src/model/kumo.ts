/**
 * One-query Kumo Small policy with exact frozen support KV and signed W4 matrices
 * dequantized for FP32 SIMD compute. Safe to call infer repeatedly within one worker.
 */
import { packUrl, siteUrl } from '../shared/site.ts';
import { loadModelChunk, verifyModelChunk, type VerifiedModelChunk } from './asset-cache.ts';

const HEAD = 'icl_block.head.2.weight';
const MATH_IMPORTS = { math: { sin: Math.sin, cos: Math.cos, exp: Math.exp, tanh: Math.tanh } };

/** One W4 action-head edit: output row (0 LEFT, 1 RIGHT, 2 FIRE), input channel, expected old code, new code. */
export type HeadOp = [row: number, column: number, oldCode: number, newCode: number];
export type Precision = 'w4' | 'fp32';
/** Head rows to run: base W4, the shipped edit, base W4 with FIRE bias offset, a custom patch, or the FP32 original. */
export type HeadVariant = 'w4' | 'edited' | 'bias' | 'custom' | 'fp32';

export interface CoreDecision {
  logits: number[];
  action: number;
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

export type AssetBytes = Blob | ArrayBuffer | Uint8Array;
/** Supplies verified model data (manifest, packs) from a local snapshot; `null` falls back to the network. */
export type ReadModelAsset = (name: string) => AssetBytes | null | undefined | Promise<AssetBytes | null | undefined>;

export interface ManifestChunk {
  path: string;
  bytes: number;
  rawBytes: number;
  sha256: string;
  rawSha256: string;
}

export interface TensorEntry {
  name: string;
  type?: 'f32' | 'q4';
  start: number;
  count: number;
  width: number;
  fileOffset: number;
}

export interface ModelManifest {
  format: number;
  precision?: string;
  encoding?: string;
  floatCount: number;
  rawBytes: number;
  chunks: ManifestChunk[];
  tensors: TensorEntry[];
  edit: HeadOp[];
  biasOffset: number;
  actions: string[];
  features: string[];
}

/** The policy WASM interface the loader needs; the threaded runtime supplies a subset without the GPU boundary. */
export interface KumoExports {
  memory: WebAssembly.Memory;
  data_ptr(): number;
  data_size(): number;
  input_ptr(): number;
  logits_ptr(): number;
  infer(): void;
  state_ptr?: () => number;
  hidden_ptr?: () => number;
  encode_for_gpu?: () => void;
  finish_for_gpu?: () => void;
}

/** An externally owned WASM instance (shared-memory threads, or a caller that reads `hidden_ptr` itself). */
export interface KumoRuntime {
  instantiate(): Promise<KumoExports>;
  dispose(): void;
}

/** Split CPU/GPU execution: the CPU encodes the query state, the GPU runs the blocks, the CPU decodes the readout. */
export interface GpuBridge {
  weights: Float32Array;
  tensors: TensorEntry[];
  validateVariant(variant: HeadVariant): void;
  encode(features: ArrayLike<number>): Float32Array;
  decode(values: Float32Array, variant: HeadVariant): CoreDecision;
}

export interface KumoPolicy {
  precision: Precision;
  defaultVariant: HeadVariant;
  actions: readonly string[];
  features: readonly string[];
  infer(features: ArrayLike<number>, variant?: HeadVariant): CoreDecision;
  gpuBridge(): GpuBridge;
  setHeadPatch(edits: HeadOp[]): void;
  clearHeadPatch(): void;
  dispose(): void;
}

export interface KumoOptions {
  /** Directory of the manifests and `policy-simd.wasm`; the packs they name load from `packUrl` (Hugging Face). */
  baseURL?: URL | string;
  onProgress?: (progress: LoadProgress) => void;
  signal?: AbortSignal;
  runtime?: KumoRuntime | null;
  precision?: Precision;
  readAsset?: ReadModelAsset;
}

function half(value: number): number {
  const sign = value & 0x8000 ? -1 : 1;
  const exp = (value >>> 10) & 31;
  const mantissa = value & 1023;
  if (exp === 0) return sign * mantissa * 2 ** -24;
  if (exp === 31) return sign * (mantissa ? NaN : Infinity);
  return sign * (1 + mantissa / 1024) * 2 ** (exp - 15);
}

async function checked(url: URL, signal?: AbortSignal): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    // VERIFIED: packs come from huggingface.co (src/shared/site.ts) and a failed fetch rejects with a bare TypeError
    // ("Failed to fetch"); naming the URL makes a blocked or offline download recognisable.
    throw new Error(`Could not download model asset ${url.href}`, { cause: e });
  }
  if (!r.ok) throw new Error(`Model asset ${url.href} returned HTTP ${r.status}`);
  return r;
}

function makePatch(edits: HeadOp[], original: Float32Array, quant: Int8Array, scales: Float32Array): Float32Array {
  if (!Array.isArray(edits)) throw new TypeError('Expected [row, column, old, new] edits');
  const weights = original.slice();
  const seen = new Set<number>();
  for (const e of edits) {
    if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isInteger)) throw new Error('Invalid edit fields');
    const [r, c, old, next] = e,
      i = r * 1024 + c;
    if (
      r < 0 ||
      r >= 3 ||
      c < 0 ||
      c >= 1024 ||
      next < -7 ||
      next > 7 ||
      old === next ||
      quant[i] !== old ||
      seen.has(i)
    )
      throw new Error('Invalid head patch or baseline code mismatch');
    seen.add(i);
    weights[i] = next * scales[Math.floor(i / 64)];
  }
  return weights;
}

/** Decode a verified gzip asset, including hosts that transparently gunzip the response. */
async function loadChunks(
  manifest: ModelManifest,
  asset: (item: ManifestChunk) => Promise<VerifiedModelChunk>,
  onProgress: ((progress: LoadProgress) => void) | undefined,
  consume: (decoded: Uint8Array, offset: number) => void,
): Promise<void> {
  let offset = 0,
    loaded = 0;
  const total = manifest.chunks.reduce((a, c) => a + c.bytes, 0);
  onProgress?.({ loaded, total });
  for (const c of manifest.chunks) {
    const { bytes, encoding } = await asset(c);
    let decoded: Uint8Array;
    if (encoding === 'gzip') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      decoded = new Uint8Array(await new Response(stream).arrayBuffer());
    } else decoded = bytes;
    if (decoded.length !== c.rawBytes || offset + decoded.length > manifest.rawBytes)
      throw new Error('Incorrect decompressed chunk length: ' + c.path);
    consume(decoded, offset);
    offset += decoded.length;
    loaded += c.bytes;
    onProgress?.({ loaded, total });
  }
  if (offset !== manifest.rawBytes) throw new Error('Incomplete policy assets');
}

/** Interleave four byte planes (all byte 0s, then all byte 1s, ...) back into little-endian FP32 words. */
function writeBytePlanes(destination: Uint8Array, planes: Uint8Array, offset: number): void {
  if (planes.length % 4 || offset % 4) throw new Error('Unaligned FP32 byte planes');
  const n = planes.length / 4;
  for (let i = 0, j = offset; i < n; i++, j += 4) {
    destination[j] = planes[i];
    destination[j + 1] = planes[n + i];
    destination[j + 2] = planes[2 * n + i];
    destination[j + 3] = planes[3 * n + i];
  }
}

interface W4Head {
  offset: number;
  original: Float32Array;
  codes: Int8Array;
  scales: Float32Array;
}

/** Dequantize every tensor of a W4 pack into `array`; returns the action head's codes and scales for later patches. */
function loadW4Tensors(manifest: ModelManifest, raw: Uint8Array, array: Float32Array): W4Head {
  const view = new DataView(raw.buffer);
  let head: Omit<W4Head, 'original'> | null = null,
    original: Float32Array | null = null;
  for (const t of manifest.tensors) {
    if (t.type === 'f32') {
      const byteStart = t.fileOffset;
      if ((byteStart & 3) === 0) array.set(new Float32Array(raw.buffer, byteStart, t.count), t.start);
      else for (let i = 0; i < t.count; i++) array[t.start + i] = view.getFloat32(byteStart + 4 * i, true);
      continue;
    }
    if (t.type !== 'q4') throw new Error('Unsupported tensor encoding');
    const groups = Math.ceil(t.width / 64),
      rows = t.count / t.width,
      n = groups * rows;
    const q0 = t.fileOffset + 2 * n;
    const scales = new Float32Array(n);
    for (let i = 0; i < n; i++) scales[i] = half(view.getUint16(t.fileOffset + 2 * i, true));
    const codes = t.name === HEAD ? new Int8Array(t.count) : null;
    if (codes) head = { offset: t.start, codes, scales };
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < t.width; c++) {
        const k = r * t.width + c,
          g = r * groups + (c >>> 6),
          octet = raw[q0 + 32 * g + ((c & 63) >>> 1)];
        const nibble = c & 1 ? octet >>> 4 : octet & 15;
        const signed = nibble < 8 ? nibble : nibble - 16;
        array[t.start + k] = signed * scales[g];
        if (codes) codes[k] = signed;
      }
    if (codes) original = array.slice(t.start, t.start + t.count);
  }
  if (!head || !original || original.length !== 3072) throw new Error('Missing three action rows');
  return { ...head, original };
}

function unsupportedManifest(manifest: ModelManifest, fp32: boolean): boolean {
  if (!fp32) return manifest.format !== 1;
  return (
    manifest.format !== 2 ||
    manifest.precision !== 'fp32' ||
    manifest.encoding !== 'f32le-byteplanes-gzip' ||
    manifest.rawBytes !== manifest.floatCount * 4
  );
}

/** Load the original FP32 specialization or the DNP W4 specialization into a dedicated instance. */
export async function createKumoPolicy({
  baseURL = siteUrl('model/'),
  onProgress,
  signal,
  runtime,
  precision = 'w4',
  readAsset,
}: KumoOptions = {}): Promise<KumoPolicy> {
  if (precision !== 'w4' && precision !== 'fp32') throw new RangeError('Unsupported model precision');
  const fp32 = precision === 'fp32',
    defaultVariant: HeadVariant = fp32 ? 'fp32' : 'edited';
  const resolved = new URL(baseURL, siteUrl('model/'));
  if (!resolved.pathname.endsWith('/')) resolved.pathname += '/';
  const url = (name: string) => new URL(name, resolved);
  // Snapshots can supply validated data blobs. Executable modules always use the trusted loader.
  async function asset(name: string, location: URL = url(name)): Promise<Response> {
    signal?.throwIfAborted();
    const blob = await readAsset?.(name);
    signal?.throwIfAborted();
    return blob == null ? checked(location, signal) : new Response(blob as BodyInit);
  }
  const pack = async (item: ManifestChunk): Promise<VerifiedModelChunk> => {
    signal?.throwIfAborted();
    const held = await readAsset?.(item.path);
    signal?.throwIfAborted();
    return held == null
      ? loadModelChunk(packUrl(precision, item.path), item, signal)
      : verifyModelChunk(new Uint8Array(await new Response(held as BodyInit).arrayBuffer()), item);
  };
  const [manifest, wasm] = await Promise.all([
    asset(fp32 ? 'original-manifest.json' : 'manifest.json').then((r) => r.json() as Promise<ModelManifest>),
    runtime ? null : checked(url('policy-simd.wasm'), signal).then((r) => r.arrayBuffer()),
  ]);
  if (unsupportedManifest(manifest, fp32)) throw new Error('Unsupported model assets for ' + precision);
  const api: KumoExports = runtime
    ? await runtime.instantiate()
    : ((await WebAssembly.instantiate(wasm as ArrayBuffer, MATH_IMPORTS)).instance.exports as unknown as KumoExports);
  if (manifest.floatCount !== api.data_size()) throw new Error('WASM and tensor layout differ');
  const array = new Float32Array(api.memory.buffer, api.data_ptr(), manifest.floatCount);
  let head: W4Head | null = null,
    edited: Float32Array | null = null;
  if (fp32) {
    const destination = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    await loadChunks(manifest, pack, onProgress, (planes, offset) => writeBytePlanes(destination, planes, offset));
  } else {
    const raw = new Uint8Array(manifest.rawBytes);
    await loadChunks(manifest, pack, onProgress, (chunk, offset) => raw.set(chunk, offset));
    head = loadW4Tensors(manifest, raw, array);
    edited = makePatch(manifest.edit, head.original, head.codes, head.scales);
  }
  let custom: Float32Array | null = null,
    selected: HeadVariant | null = 'w4';
  // Views into WASM memory; dispose() drops them with the instance so the (up to 94 MB) memory can be collected.
  let instance: { api: KumoExports; array: Float32Array; input: Float32Array; output: Float32Array } | null = {
    api,
    array,
    input: new Float32Array(api.memory.buffer, api.input_ptr(), 14),
    output: new Float32Array(api.memory.buffer, api.logits_ptr(), 3),
  };

  function live(): NonNullable<typeof instance> {
    if (!instance) throw new Error('Policy was disposed');
    return instance;
  }
  function loadFeatures(features: ArrayLike<number>): void {
    const { input } = live();
    if (features.length !== 14) throw new RangeError('Kumo expects exactly 14 features');
    for (let i = 0; i < 14; i++) if (!Number.isFinite(features[i])) throw new Error('Non-finite feature');
    input.set(features);
  }
  function choose(variant: HeadVariant): void {
    const { array } = live();
    if (!head || !edited) {
      if (variant !== 'fp32') throw new Error('The original FP32 model only accepts its unedited fp32 variant');
      return;
    }
    if (!['w4', 'edited', 'bias', 'custom'].includes(variant)) throw new Error('Unknown policy: ' + variant);
    if (variant === 'custom' && custom === null) throw new Error('Custom patch is unset');
    const rows = variant === 'bias' ? 'w4' : variant;
    if (selected !== rows) {
      array.set(rows === 'w4' ? head.original : rows === 'edited' ? edited : (custom as Float32Array), head.offset);
      selected = rows;
    }
  }
  function read(variant: HeadVariant): CoreDecision {
    const logits = Array.from(live().output);
    if (variant === 'bias') logits[2] = Math.fround(logits[2] - manifest.biasOffset);
    let action = 0;
    for (let i = 1; i < 3; i++) if (logits[i] > logits[action]) action = i;
    return { logits, action };
  }
  return {
    precision,
    defaultVariant,
    actions: Object.freeze([...manifest.actions]),
    features: Object.freeze([...manifest.features]),
    infer(features, variant = defaultVariant) {
      loadFeatures(features);
      choose(variant);
      live().api.infer();
      return read(variant);
    },
    gpuBridge() {
      const gpu = instance?.api;
      if (!gpu?.encode_for_gpu || !gpu.finish_for_gpu || !gpu.state_ptr || !gpu.hidden_ptr)
        throw new Error('This CPU runtime has no WebGPU boundary');
      const { encode_for_gpu: encodeForGpu, finish_for_gpu: finishForGpu } = gpu;
      const state = new Float32Array(gpu.memory.buffer, gpu.state_ptr(), 512);
      const hidden = new Float32Array(gpu.memory.buffer, gpu.hidden_ptr(), 1024);
      return {
        weights: live().array,
        tensors: manifest.tensors,
        validateVariant(variant) {
          choose(variant);
        },
        encode(features) {
          loadFeatures(features);
          encodeForGpu();
          return state;
        },
        decode(values, variant) {
          choose(variant);
          hidden.set(values);
          finishForGpu();
          return read(variant);
        },
      };
    },
    setHeadPatch(edits) {
      live();
      if (!head) throw new Error('The original FP32 model does not accept W4 edits');
      custom = makePatch(edits, head.original, head.codes, head.scales);
      if (selected === 'custom') selected = null;
    },
    clearHeadPatch() {
      custom = null;
      if (selected === 'custom') selected = null;
    },
    dispose() {
      runtime?.dispose();
      instance = null;
      custom = null;
    },
  };
}
