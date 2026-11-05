/**
 * One-query Kumo Small policy with exact frozen support KV and signed W4 matrices
 * dequantized for FP32 SIMD compute. Safe to call infer repeatedly within one worker.
 */
import { packUrl, siteUrl } from '../shared/site.js';
import { loadModelChunk, verifyModelChunk } from './asset-cache.js';
const HEAD = 'icl_block.head.2.weight';
const MATH_IMPORTS = { math: { sin: Math.sin, cos: Math.cos, exp: Math.exp, tanh: Math.tanh } };
function half(value) {
    const sign = value & 0x8000 ? -1 : 1;
    const exp = (value >>> 10) & 31;
    const mantissa = value & 1023;
    if (exp === 0)
        return sign * mantissa * 2 ** -24;
    if (exp === 31)
        return sign * (mantissa ? NaN : Infinity);
    return sign * (1 + mantissa / 1024) * 2 ** (exp - 15);
}
async function checked(url, signal) {
    let r;
    try {
        r = await fetch(url, { signal });
    }
    catch (e) {
        if (signal?.aborted)
            throw e;
        // VERIFIED: packs come from huggingface.co (src/shared/site.ts) and a failed fetch rejects with a bare TypeError
        // ("Failed to fetch"); naming the URL makes a blocked or offline download recognisable.
        throw new Error(`Could not download model asset ${url.href}`, { cause: e });
    }
    if (!r.ok)
        throw new Error(`Model asset ${url.href} returned HTTP ${r.status}`);
    return r;
}
function makePatch(edits, original, quant, scales) {
    if (!Array.isArray(edits))
        throw new TypeError('Expected [row, column, old, new] edits');
    const weights = original.slice();
    const seen = new Set();
    for (const e of edits) {
        if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isInteger))
            throw new Error('Invalid edit fields');
        const [r, c, old, next] = e, i = r * 1024 + c;
        if (r < 0 ||
            r >= 3 ||
            c < 0 ||
            c >= 1024 ||
            next < -7 ||
            next > 7 ||
            old === next ||
            quant[i] !== old ||
            seen.has(i))
            throw new Error('Invalid head patch or baseline code mismatch');
        seen.add(i);
        weights[i] = next * scales[Math.floor(i / 64)];
    }
    return weights;
}
/** Decode a verified gzip asset, including hosts that transparently gunzip the response. */
async function loadChunks(manifest, asset, onProgress, consume) {
    let offset = 0, loaded = 0;
    const total = manifest.chunks.reduce((a, c) => a + c.bytes, 0);
    onProgress?.({ loaded, total });
    for (const c of manifest.chunks) {
        const { bytes, encoding } = await asset(c);
        let decoded;
        if (encoding === 'gzip') {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            decoded = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        else
            decoded = bytes;
        if (decoded.length !== c.rawBytes || offset + decoded.length > manifest.rawBytes)
            throw new Error('Incorrect decompressed chunk length: ' + c.path);
        consume(decoded, offset);
        offset += decoded.length;
        loaded += c.bytes;
        onProgress?.({ loaded, total });
    }
    if (offset !== manifest.rawBytes)
        throw new Error('Incomplete policy assets');
}
/** Interleave four byte planes (all byte 0s, then all byte 1s, ...) back into little-endian FP32 words. */
function writeBytePlanes(destination, planes, offset) {
    if (planes.length % 4 || offset % 4)
        throw new Error('Unaligned FP32 byte planes');
    const n = planes.length / 4;
    for (let i = 0, j = offset; i < n; i++, j += 4) {
        destination[j] = planes[i];
        destination[j + 1] = planes[n + i];
        destination[j + 2] = planes[2 * n + i];
        destination[j + 3] = planes[3 * n + i];
    }
}
/** Dequantize every tensor of a W4 pack into `array`; returns the action head's codes and scales for later patches. */
function loadW4Tensors(manifest, raw, array) {
    const view = new DataView(raw.buffer);
    let head = null, original = null;
    for (const t of manifest.tensors) {
        if (t.type === 'f32') {
            const byteStart = t.fileOffset;
            if ((byteStart & 3) === 0)
                array.set(new Float32Array(raw.buffer, byteStart, t.count), t.start);
            else
                for (let i = 0; i < t.count; i++)
                    array[t.start + i] = view.getFloat32(byteStart + 4 * i, true);
            continue;
        }
        if (t.type !== 'q4')
            throw new Error('Unsupported tensor encoding');
        const groups = Math.ceil(t.width / 64), rows = t.count / t.width, n = groups * rows;
        const q0 = t.fileOffset + 2 * n;
        const scales = new Float32Array(n);
        for (let i = 0; i < n; i++)
            scales[i] = half(view.getUint16(t.fileOffset + 2 * i, true));
        const codes = t.name === HEAD ? new Int8Array(t.count) : null;
        if (codes)
            head = { offset: t.start, codes, scales };
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < t.width; c++) {
                const k = r * t.width + c, g = r * groups + (c >>> 6), octet = raw[q0 + 32 * g + ((c & 63) >>> 1)];
                const nibble = c & 1 ? octet >>> 4 : octet & 15;
                const signed = nibble < 8 ? nibble : nibble - 16;
                array[t.start + k] = signed * scales[g];
                if (codes)
                    codes[k] = signed;
            }
        if (codes)
            original = array.slice(t.start, t.start + t.count);
    }
    if (!head || !original || original.length !== 3072)
        throw new Error('Missing three action rows');
    return { ...head, original };
}
function unsupportedManifest(manifest, fp32) {
    if (!fp32)
        return manifest.format !== 1;
    return (manifest.format !== 2 ||
        manifest.precision !== 'fp32' ||
        manifest.encoding !== 'f32le-byteplanes-gzip' ||
        manifest.rawBytes !== manifest.floatCount * 4);
}
/** Load the original FP32 specialization or the DNP W4 specialization into a dedicated instance. */
export async function createKumoPolicy({ baseURL = siteUrl('model/'), onProgress, signal, runtime, precision = 'w4', readAsset, } = {}) {
    if (precision !== 'w4' && precision !== 'fp32')
        throw new RangeError('Unsupported model precision');
    const fp32 = precision === 'fp32', defaultVariant = fp32 ? 'fp32' : 'edited';
    const resolved = new URL(baseURL, siteUrl('model/'));
    if (!resolved.pathname.endsWith('/'))
        resolved.pathname += '/';
    const url = (name) => new URL(name, resolved);
    // Snapshots can supply validated data blobs. Executable modules always use the trusted loader.
    async function asset(name, location = url(name)) {
        signal?.throwIfAborted();
        const blob = await readAsset?.(name);
        signal?.throwIfAborted();
        return blob == null ? checked(location, signal) : new Response(blob);
    }
    const pack = async (item) => {
        signal?.throwIfAborted();
        const held = await readAsset?.(item.path);
        signal?.throwIfAborted();
        return held == null
            ? loadModelChunk(packUrl(precision, item.path), item, signal)
            : verifyModelChunk(new Uint8Array(await new Response(held).arrayBuffer()), item);
    };
    const [manifest, wasm] = await Promise.all([
        asset(fp32 ? 'original-manifest.json' : 'manifest.json').then((r) => r.json()),
        runtime ? null : checked(url('policy-simd.wasm'), signal).then((r) => r.arrayBuffer()),
    ]);
    if (unsupportedManifest(manifest, fp32))
        throw new Error('Unsupported model assets for ' + precision);
    const api = runtime
        ? await runtime.instantiate()
        : (await WebAssembly.instantiate(wasm, MATH_IMPORTS)).instance.exports;
    if (manifest.floatCount !== api.data_size())
        throw new Error('WASM and tensor layout differ');
    const array = new Float32Array(api.memory.buffer, api.data_ptr(), manifest.floatCount);
    let head = null, edited = null;
    if (fp32) {
        const destination = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        await loadChunks(manifest, pack, onProgress, (planes, offset) => writeBytePlanes(destination, planes, offset));
    }
    else {
        const raw = new Uint8Array(manifest.rawBytes);
        await loadChunks(manifest, pack, onProgress, (chunk, offset) => raw.set(chunk, offset));
        head = loadW4Tensors(manifest, raw, array);
        edited = makePatch(manifest.edit, head.original, head.codes, head.scales);
    }
    let custom = null, selected = 'w4';
    // Views into WASM memory; dispose() drops them with the instance so the (up to 94 MB) memory can be collected.
    let instance = {
        api,
        array,
        input: new Float32Array(api.memory.buffer, api.input_ptr(), 14),
        output: new Float32Array(api.memory.buffer, api.logits_ptr(), 3),
    };
    function live() {
        if (!instance)
            throw new Error('Policy was disposed');
        return instance;
    }
    function loadFeatures(features) {
        const { input } = live();
        if (features.length !== 14)
            throw new RangeError('Kumo expects exactly 14 features');
        for (let i = 0; i < 14; i++)
            if (!Number.isFinite(features[i]))
                throw new Error('Non-finite feature');
        input.set(features);
    }
    function choose(variant) {
        const { array } = live();
        if (!head || !edited) {
            if (variant !== 'fp32')
                throw new Error('The original FP32 model only accepts its unedited fp32 variant');
            return;
        }
        if (!['w4', 'edited', 'bias', 'custom'].includes(variant))
            throw new Error('Unknown policy: ' + variant);
        if (variant === 'custom' && custom === null)
            throw new Error('Custom patch is unset');
        const rows = variant === 'bias' ? 'w4' : variant;
        if (selected !== rows) {
            array.set(rows === 'w4' ? head.original : rows === 'edited' ? edited : custom, head.offset);
            selected = rows;
        }
    }
    function read(variant) {
        const logits = Array.from(live().output);
        if (variant === 'bias')
            logits[2] = Math.fround(logits[2] - manifest.biasOffset);
        let action = 0;
        for (let i = 1; i < 3; i++)
            if (logits[i] > logits[action])
                action = i;
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
            if (!head)
                throw new Error('The original FP32 model does not accept W4 edits');
            custom = makePatch(edits, head.original, head.codes, head.scales);
            if (selected === 'custom')
                selected = null;
        },
        clearHeadPatch() {
            custom = null;
            if (selected === 'custom')
                selected = null;
        },
        dispose() {
            runtime?.dispose();
            instance = null;
            custom = null;
        },
    };
}
