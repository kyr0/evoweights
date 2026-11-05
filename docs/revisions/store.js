import { sha256 } from '../shared/sha256.js';
import { packUrl, siteUrl } from '../shared/site.js';
import { revisionDiff, diffFileName, nativeDiff, controllerDiff } from './diff.js';
import { makeHeadPatch } from './patch-codec.js';
import { TRUST } from './trust.js';
const MAGIC = new TextEncoder().encode('AGMDNP08');
const FORMAT = 'agm.browser-weights/1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_HEADER = 8 * 1024 * 1024;
const copy = (x) => structuredClone(x);
const hashPattern = /^[0-9a-f]{64}$/;
/** Which field of each readout holds its signed codes; every other field must equal the shipped template. */
const targets = { graft: 'codes', combat: 'codes', facing: 'code' };
function fail(message, code = 'INVALID_WEIGHTS') {
    return Object.assign(new Error(message), { code });
}
function requireThat(condition, message) {
    if (!condition)
        throw fail(message);
}
function canonical(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        const object = value;
        return ('{' +
            Object.keys(object)
                .sort()
                .map((k) => JSON.stringify(k) + ':' + canonical(object[k]))
                .join(',') +
            '}');
    }
    return JSON.stringify(value);
}
function strictKeys(obj, keys) {
    requireThat(obj &&
        typeof obj === 'object' &&
        !Array.isArray(obj) &&
        Object.keys(obj).length === keys.length &&
        keys.every((k) => Object.hasOwn(obj, k)), 'Unexpected fields in revision metadata.');
}
function checkCodes(candidate, reference) {
    if (Array.isArray(reference)) {
        requireThat(Array.isArray(candidate) && candidate.length === reference.length, 'Invalid controller matrix shape.');
        return Array.from(reference, (row, i) => checkCodes(candidate[i], row));
    }
    requireThat(Number.isInteger(candidate) && candidate >= -7 && candidate <= 7, 'Invalid signed controller parameter.');
    return candidate;
}
function checkController(value) {
    strictKeys(value, Object.keys(targets));
    const output = {};
    for (const [key, weights] of Object.entries(targets)) {
        const template = TRUST.controller[key], src = value[key];
        strictKeys(src, Object.keys(template));
        for (const field of Object.keys(template)) {
            if (field !== weights)
                requireThat(canonical(src[field]) === canonical(template[field]), 'Incompatible ' + key + ' ' + field + '.');
        }
        output[key] = { ...copy(template), [weights]: checkCodes(src[weights], template[weights]) };
    }
    return output;
}
function normalize({ precision, parentId, ops, controller, }) {
    requireThat(Object.hasOwn(TRUST.bases, precision), 'Unsupported model precision.');
    requireThat(Array.isArray(ops) && ops.length <= 3072, 'Invalid action-head operation count.');
    const manifestSHA256 = TRUST.bases[precision].sha256;
    if (precision === 'fp32') {
        requireThat(parentId === null && ops.length === 0 && controller === null, 'The shipped FP32 model has no editable coordinates.');
        return { precision, parentId, manifestSHA256, ops: [], controller: null };
    }
    requireThat(typeof parentId === 'string' && hashPattern.test(parentId), 'Invalid parent revision ID.');
    const sorted = ops.length
        ? makeHeadPatch(ops, 'Revision validation', 'Reconstruct the complete W4 readout', TRUST.head).ops.map((op) => op.slice(1))
        : [];
    sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { precision, parentId, manifestSHA256, ops: sorted, controller: checkController(controller) };
}
function digestDescriptor(d) {
    return sha256(encoder.encode(canonical({ schema: FORMAT, ...d })));
}
/** Content address of a revision: SHA-256 of its canonical, validated recipe. */
export async function revisionId(recipe) {
    return digestDescriptor(normalize(recipe));
}
function safeName(name) {
    requireThat(typeof name === 'string' &&
        name.trim().length > 0 &&
        name.length <= 96 &&
        // Escapes, never literal characters: VERIFIED: a literal bidi control is invisible in review, and the
        // .vae/VERIFY.py rule source.no-invisible-controls rejects one in any *.ts file.
        // oxlint-disable-next-line no-control-regex -- control and bidi characters are exactly what this rejects
        !/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name), 'Invalid revision display name.');
    return name.trim();
}
async function record(recipe, kind, name) {
    const d = normalize(recipe);
    return { id: await digestDescriptor(d), kind, name: safeName(name), ...d };
}
let defaults;
const zeroed = (v) => (Array.isArray(v) ? v.map(zeroed) : 0);
/** The shipped readout scaffolding with every signed code at zero: transforms stay, none of Astra 6's readout values remain. */
export function neutralController() {
    const c = copy(TRUST.controller);
    for (const [key, field] of Object.entries(targets))
        c[key][field] = zeroed(c[key][field]);
    return c;
}
/** Shipped children of the neutral sensor weights, loaded from the site data and pinned by their revision IDs (a missing or altered
 * file leaves the model out instead of failing the store): the browser EvoWeights lineages for survival (R3) and kills (R4) from
 * experiments/v11/edno-neutral-browser, and the independent Opus 5.5 edit from experiments/v12/independent-edit. */
export const SURVIVOR_ID = '35cee4df42e2fbde0aac21008cf0e870b016218003a59e91cb7ff772f8a618f1';
export const TERMINATOR_ID = '4155d4d47c55fee231ca021b15fe4b1a347858642b5409b19292eba7ad0647aa';
export const OPUS_EDIT_ID = '872fc5e5a5c106fd04032024d1efa292f1b6aa00ab5e7f185743180cf871476f';
const NEUTRAL_RELEASES = [
    ['survivor', 'evoweights-survivor.json', SURVIVOR_ID],
    ['terminator', 'evoweights-terminator.json', TERMINATOR_ID],
    ['opus', 'opus-independent-edit.json', OPUS_EDIT_ID],
];
async function releaseRevision(base, file, pinned) {
    try {
        const res = await fetch(siteUrl('data/' + file));
        if (!res.ok)
            return null;
        const d = (await res.json());
        const r = await record({ precision: 'w4', parentId: base.id, ops: d.ops, controller: d.controller }, 'learned', d.name);
        return r.id === pinned ? r : null;
    }
    catch {
        return null;
    }
}
function builtins() {
    defaults ??= (async () => {
        const original = await record({ precision: 'fp32', parentId: null, ops: [], controller: null }, 'original', 'Original FP32');
        const shipped = await record({ precision: 'w4', parentId: original.id, ops: TRUST.edited, controller: TRUST.controller }, 'shipped', 'Shipped DNP 4-bit');
        const neutral = await record({ precision: 'w4', parentId: original.id, ops: [], controller: neutralController() }, 'base', '4-bit base · neutral sensor weights');
        const more = await Promise.all(NEUTRAL_RELEASES.map(([, file, id]) => releaseRevision(neutral, file, id)));
        const extra = Object.fromEntries(NEUTRAL_RELEASES.map(([key], i) => [key, more[i]]).filter(([, r]) => r));
        return { original, shipped, neutral, ...extra };
    })();
    return defaults;
}
export const W4_BASE_KINDS = Object.freeze(['shipped', 'base']);
function effectiveHead(tip) {
    if (tip.precision === 'fp32')
        return new Uint8Array();
    const codes = Int8Array.from(TRUST.head.codes);
    for (const [r, c, , next] of tip.ops)
        codes[r * 1024 + c] = next;
    return new Uint8Array(codes.buffer);
}
function sameBytes(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}
function assertBundleSize(size) {
    requireThat(Number.isSafeInteger(size) &&
        size > 12 &&
        size <= 12 + MAX_HEADER + TRUST.bases.fp32.length + TRUST.bases.fp32.rawBytes + 3072, 'Weight file exceeds supported limits or is truncated.');
}
function checkedJSON(bytes) {
    try {
        return JSON.parse(decoder.decode(bytes));
    }
    catch {
        throw fail('Invalid UTF-8 JSON metadata.');
    }
}
async function verifiedManifest(bytes, precision) {
    const base = TRUST.bases[precision];
    requireThat(bytes.length === base.length && (await sha256(bytes)) === base.sha256, 'Model manifest differs from the trusted release.');
    return checkedJSON(bytes);
}
const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
/** Verify an entire snapshot without changing stored state. Chunks are validated one at a time. */
export async function readWeightSnapshot(file) {
    requireThat(file instanceof Blob, 'A binary weight file is required.');
    assertBundleSize(file.size);
    const prefix = await blobBytes(file.slice(0, 12));
    requireThat(sameBytes(prefix.subarray(0, 8), MAGIC), 'Wrong weight file signature.');
    const length = new DataView(prefix.buffer).getUint32(8, true);
    requireThat(length > 0 && length <= MAX_HEADER && 12 + length < file.size, 'Invalid weight header length.');
    const h = checkedJSON(await blobBytes(file.slice(12, 12 + length)));
    strictKeys(h, ['format', 'precision', 'tip', 'ancestry', 'baseManifestSHA256', 'rawChunks']);
    requireThat(h.format === FORMAT && Object.hasOwn(TRUST.bases, h.precision), 'Unsupported weight format or precision.');
    const precision = h.precision;
    const base = TRUST.bases[precision];
    const rawChunks = h.rawChunks;
    requireThat(h.baseManifestSHA256 === base.sha256 && Array.isArray(rawChunks), 'Wrong model basis or chunk encoding.');
    requireThat(rawChunks.length <= 12 &&
        rawChunks.every((n, i) => Number.isInteger(n) && n >= 0 && (i === 0 || rawChunks[i - 1] < n)), 'Invalid raw-chunk indices.');
    const ancestry = h.ancestry;
    requireThat(Array.isArray(ancestry) && ancestry.length > 0 && ancestry.length <= 4096, 'Invalid revision ancestry length.');
    const b = await builtins(), lineage = [], roots = new Map([b.shipped, b.neutral].map((x) => [x.id, x]));
    for (const [i, entry] of ancestry.entries()) {
        strictKeys(entry, ['id', 'kind', 'name', 'precision', 'parentId', 'manifestSHA256', 'ops', 'controller']);
        const expectedKind = i === 0 ? 'original' : i === 1 ? (roots.get(entry.id)?.kind ?? 'shipped') : 'learned';
        requireThat(entry.kind === expectedKind &&
            entry.parentId === (i === 0 ? null : lineage[i - 1].id) &&
            entry.precision === (i === 0 ? 'fp32' : 'w4'), 'Broken or unsupported revision ancestry.');
        const checked = await record(entry, expectedKind, entry.name);
        requireThat(entry.id === checked.id && entry.manifestSHA256 === checked.manifestSHA256, 'Revision ID or layout mismatch.');
        if (i === 0)
            requireThat(checked.id === b.original.id, 'Unknown built-in revision.');
        if (i === 1)
            requireThat(roots.has(checked.id) && roots.get(checked.id)?.name === checked.name, 'Unknown built-in 4-bit base.');
        if (i >= 2)
            requireThat(canonical(checked.ops) !== canonical(lineage[i - 1].ops) ||
                canonical(checked.controller) !== canonical(lineage[i - 1].controller), 'Learned revision has no changed weights.');
        lineage.push(checked);
    }
    const tip = lineage[lineage.length - 1];
    requireThat(tip.id === h.tip && tip.precision === precision, 'Unmatched snapshot tip.');
    let pos = 12 + length;
    const manifestBlob = file.slice(pos, pos + base.length);
    pos += base.length;
    const manifest = await verifiedManifest(await blobBytes(manifestBlob), tip.precision);
    requireThat(rawChunks.every((n) => n < manifest.chunks.length), 'Invalid raw-chunk index.');
    const raw = new Set(rawChunks);
    const sizes = manifest.chunks.map((item, i) => (raw.has(i) ? item.rawBytes : item.bytes));
    requireThat(file.size === pos + sizes.reduce((a, s) => a + s, 0) + (tip.precision === 'w4' ? 3072 : 0), 'Wrong model payload length.');
    const chunks = [];
    for (const [i, item] of manifest.chunks.entries()) {
        const part = file.slice(pos, pos + sizes[i]);
        pos += sizes[i];
        requireThat((await sha256(await blobBytes(part))) === (raw.has(i) ? item.rawSha256 : item.sha256), 'Corrupt packed weight chunk ' + item.path + '.');
        chunks.push(part);
    }
    const materialized = await blobBytes(file.slice(pos));
    requireThat(sameBytes(materialized, effectiveHead(tip)), 'Materialized head differs from signed edits.');
    return { tip, lineage, manifest, manifestBlob, chunks };
}
/* Keep CAS reads and writes in one IDB readwrite transaction. Never await hashing or
 * network I/O inside an open transaction; IDB would be entitled to auto-commit. */
function transaction(db, stores, mode, execute) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let answer, error;
        const done = (x) => {
            answer = x;
        };
        const abort = (e) => {
            error = e;
            tx.abort();
        };
        tx.oncomplete = () => resolve(answer);
        tx.onabort = () => reject(error || tx.error || fail('IndexedDB transaction aborted.', 'STORAGE'));
        try {
            execute(tx, done, abort);
        }
        catch (e) {
            abort(e);
        }
    });
}
async function openDB(name) {
    if (!globalThis.indexedDB)
        return null;
    return new Promise((resolve, reject) => {
        // Version 3 adds the training-run log (`runs`): one entry per learning run, kept when revisions are deleted.
        const req = indexedDB.open(name, 3);
        req.onupgradeneeded = () => {
            for (const [n, keyPath] of [
                ['records', 'id'],
                ['state', 'key'],
                ['bases', 'precision'],
                ['receipts', 'id'],
                ['runs', 'id'],
            ])
                if (!req.result.objectStoreNames.contains(n))
                    req.result.createObjectStore(n, { keyPath });
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onblocked = () => reject(fail('Close older tabs to open revision storage.', 'STORAGE_BLOCKED'));
    });
}
function read(db, store, id) {
    return transaction(db, [store], 'readonly', (tx, done) => {
        const req = tx.objectStore(store).get(id);
        req.onsuccess = () => done(req.result);
    });
}
function appendUnique(store, rec) {
    const req = store.getKey(rec.id);
    req.onsuccess = () => {
        if (req.result === undefined)
            store.add(rec);
    };
}
function cas(tx, parent, tip, abort) {
    const state = tx.objectStore('state'), got = state.get('latest');
    got.onsuccess = () => {
        if (got.result?.id !== parent) {
            abort(fail('Another tab or import changed the latest revision.', 'STALE_PARENT'));
            return;
        }
        state.put({ key: 'latest', id: tip });
    };
}
async function seed(db, b) {
    await transaction(db, ['records', 'state'], 'readwrite', (tx) => {
        const records = tx.objectStore('records');
        appendUnique(records, b.original);
        appendUnique(records, b.shipped);
        const s = tx.objectStore('state'), got = s.get('latest');
        got.onsuccess = () => {
            if (!got.result)
                s.add({ key: 'latest', id: b.shipped.id });
        };
    });
}
async function chunkEncoding(blob, item) {
    requireThat(blob?.size === item.bytes || blob?.size === item.rawBytes, 'Invalid weight chunk length for ' + item.path + '.');
    const digest = await sha256(await blobBytes(blob));
    if (blob.size === item.bytes && digest === item.sha256)
        return 'gzip';
    if (blob.size === item.rawBytes && digest === item.rawSha256)
        return 'raw';
    throw fail('Invalid weight chunk digest for ' + item.path + '.');
}
async function networkBase(precision, baseURL, packBaseURL) {
    const trust = TRUST.bases[precision];
    async function fetchBlob(url) {
        const response = await fetch(url).catch(() => null);
        if (!response?.ok)
            throw fail('Could not load model asset ' + url.href + '.', 'ASSET_UNAVAILABLE');
        return response.blob();
    }
    const manifestBlob = await fetchBlob(new URL(trust.file, baseURL));
    requireThat(manifestBlob.size === trust.length, 'Unexpected model manifest length.');
    const manifest = await verifiedManifest(await blobBytes(manifestBlob), precision);
    const chunks = [];
    for (const item of manifest.chunks) {
        const blob = await fetchBlob(packUrl(precision, item.path, packBaseURL));
        await chunkEncoding(blob, item);
        chunks.push(blob);
    }
    return { precision, manifestBlob, chunks };
}
function headerFor(tip, lineage, rawChunks) {
    const header = encoder.encode(JSON.stringify({
        format: FORMAT,
        precision: tip.precision,
        tip: tip.id,
        ancestry: lineage,
        baseManifestSHA256: tip.manifestSHA256,
        rawChunks,
    }));
    requireThat(header.length <= MAX_HEADER && lineage.length <= 4096, 'Ancestry exceeds portable snapshot limits.');
    return header;
}
async function writeSnapshot(tip, lineage, base) {
    const manifest = await verifiedManifest(await blobBytes(base.manifestBlob), tip.precision);
    requireThat(base.chunks.length === manifest.chunks.length, 'Incomplete stored weight set.');
    const rawChunks = [];
    for (const [i, item] of manifest.chunks.entries())
        if ((await chunkEncoding(base.chunks[i], item)) === 'raw')
            rawChunks.push(i);
    const header = headerFor(tip, lineage, rawChunks);
    const prefix = new Uint8Array(12);
    prefix.set(MAGIC);
    new DataView(prefix.buffer).setUint32(8, header.length, true);
    return new Blob([
        prefix,
        header,
        base.manifestBlob,
        ...base.chunks,
        effectiveHead(tip),
    ], { type: 'application/octet-stream' });
}
export async function openRevisionStore({ baseURL = siteUrl('model/'), packBaseURL, dbName = 'agm-dnp-revisions-v1', } = {}) {
    const b = await builtins();
    let db = null;
    try {
        db = await openDB(dbName);
        if (db)
            await seed(db, b);
    }
    catch (e) {
        db?.close();
        if (e.code === 'STORAGE_BLOCKED')
            throw e;
        db = null;
    }
    const resident = new Map();
    const origin = new URL(baseURL);
    if (globalThis.location && ['https:', 'http:'].includes(location.protocol))
        requireThat(origin.origin === location.origin, 'Model assets must use the same origin.');
    function writable() {
        if (!db)
            throw fail('Persistent revision storage is unavailable.', 'PERSISTENCE_UNAVAILABLE');
        return db;
    }
    // The two W4 bases are virtual roots: readable and exportable at any time, persisted once adopted or imported.
    const builtin = (id) => Object.values(b).find((x) => x?.id === id);
    // A built-in revision below a virtual base needs its built-in ancestors stored with it.
    const builtinChain = (r) => {
        const out = [];
        for (let x = r; x && builtin(x.id) && x.kind !== 'original'; x = builtin(x.parentId))
            out.push(x);
        return out;
    };
    // A stored built-in revision shows its current name.
    const shown = (r) => ({ ...r, name: builtin(r.id)?.name ?? r.name });
    async function get(id) {
        const r = (db ? await read(db, 'records', id) : undefined) ?? builtin(id);
        if (!r)
            throw fail('Unknown revision ID.', 'UNKNOWN_REVISION');
        return copy(shown(r));
    }
    async function latest() {
        if (!db)
            return copy(b.shipped);
        const state = await read(db, 'state', 'latest');
        return get(state.id);
    }
    async function list() {
        if (!db)
            return copy([b.original, b.shipped]);
        const rows = await transaction(db, ['records'], 'readonly', (tx, done) => {
            const req = tx.objectStore('records').getAll();
            req.onsuccess = () => done(req.result);
        });
        // Graph depth orders parents before children, independent of racing branch imports.
        const depth = new Map([[b.original.id, 0]]), byId = new Map(rows.map((r) => [r.id, r]));
        function level(r) {
            if (!depth.has(r.id))
                depth.set(r.id, 1 + level(byId.get(r.parentId)));
            return depth.get(r.id);
        }
        return rows.sort((a, c) => level(a) - level(c) || a.id.localeCompare(c.id)).map(shown);
    }
    async function lineageFor(tip) {
        const lineage = [tip];
        for (let r = tip; r.parentId;) {
            r = await get(r.parentId);
            lineage.push(r);
        }
        return lineage.reverse();
    }
    async function storeReceipt(database, id, receipt) {
        await transaction(database, ['receipts'], 'readwrite', (tx) => tx.objectStore('receipts').put({ id, receipt: structuredClone(receipt) }));
    }
    async function promote({ parentId, ops, controller, name = 'Learned 4-bit', receipt = null }) {
        const database = writable();
        const parent = await get(parentId);
        requireThat(parent.precision === 'w4', 'New training parents must be 4-bit.');
        const r = await record({ parentId, precision: 'w4', ops, controller }, 'learned', name);
        requireThat(canonical(r.ops) !== canonical(parent.ops) || canonical(r.controller) !== canonical(parent.controller), 'Winner has no changed weights.');
        headerFor(r, [...(await lineageFor(parent)), r], Array.from({ length: 12 }, (_, i) => i));
        await transaction(database, ['records', 'state'], 'readwrite', (tx, _, abort) => {
            cas(tx, parentId, r.id, abort);
            const records = tx.objectStore('records');
            for (const x of builtinChain(parent))
                appendUnique(records, x);
            appendUnique(records, r);
        });
        if (receipt) {
            try {
                await storeReceipt(database, r.id, receipt);
            }
            catch {
                /* Receipts are advisory; the revision itself is already saved. */
            }
        }
        return get(r.id);
    }
    /** Store a learned child without moving the training tip (an unconfirmed final-round candidate). */
    async function keep({ parentId, ops, controller, name = 'Learned 4-bit', receipt = null }) {
        const database = writable();
        const parent = await get(parentId);
        requireThat(parent.precision === 'w4', 'Kept children need a 4-bit parent.');
        const r = await record({ parentId, precision: 'w4', ops, controller }, 'learned', name);
        requireThat(canonical(r.ops) !== canonical(parent.ops) || canonical(r.controller) !== canonical(parent.controller), 'Candidate has no changed weights.');
        headerFor(r, [...(await lineageFor(parent)), r], Array.from({ length: 12 }, (_, i) => i));
        await transaction(database, ['records'], 'readwrite', (tx) => {
            const records = tx.objectStore('records');
            for (const x of builtinChain(parent))
                appendUnique(records, x);
            appendUnique(records, r);
        });
        if (receipt) {
            try {
                await storeReceipt(database, r.id, receipt);
            }
            catch {
                /* Receipts are advisory. */
            }
        }
        return get(r.id);
    }
    /** Training-run log: the complete record of one learning run (settings, environment, code fingerprint, every generation). */
    async function saveRun(run) {
        if (!db)
            return false;
        requireThat(typeof run?.runId === 'string' && run.runId.length > 0, 'A training run needs an ID.');
        await transaction(db, ['runs'], 'readwrite', (tx) => tx.objectStore('runs').put({ id: run.runId, run: structuredClone(run) }));
        return true;
    }
    async function runs() {
        if (!db)
            return [];
        return transaction(db, ['runs'], 'readonly', (tx, done) => {
            const req = tx.objectStore('runs').getAll();
            req.onsuccess = () => done(req.result.map((x) => x.run));
        });
    }
    /** The training receipt stored with a promoted revision, if this browser produced it. */
    async function receipt(id) {
        if (!db)
            return null;
        try {
            return (await read(db, 'receipts', id))?.receipt ?? null;
        }
        catch {
            return null;
        }
    }
    async function adopt(id, { expectedLatestId } = {}) {
        const database = writable();
        const r = await get(id);
        requireThat(r.precision === 'w4' && hashPattern.test(expectedLatestId), 'Adoption requires a 4-bit model and the current tip ID.');
        await transaction(database, ['records', 'state'], 'readwrite', (tx, _, abort) => {
            cas(tx, expectedLatestId, id, abort);
            for (const x of builtinChain(r))
                appendUnique(tx.objectStore('records'), x);
        });
        return r;
    }
    /** Delete a persisted revision together with every descendant and their receipts, in one transaction.
     * The original FP32 model and the shipped composite cannot be deleted; a deleted W4 base reappears as its virtual root.
     * When the latest revision is among the deleted ones, the latest pointer moves to the deleted branch's parent (W4) or the shipped composite. */
    async function remove(id) {
        const database = writable();
        requireThat(typeof id === 'string' && hashPattern.test(id), 'Invalid revision ID.');
        requireThat(id !== b.original.id && id !== b.shipped.id, 'The original and the shipped revisions cannot be deleted.');
        return transaction(database, ['records', 'state', 'receipts'], 'readwrite', (tx, done, abort) => {
            const records = tx.objectStore('records'), all = records.getAll();
            all.onsuccess = () => {
                const rows = all.result, byId = new Map(rows.map((r) => [r.id, r])), root = byId.get(id);
                if (!root) {
                    abort(fail('Only stored revisions can be deleted.', 'UNKNOWN_REVISION'));
                    return;
                }
                const doomed = [id], seen = new Set(doomed);
                for (let i = 0; i < doomed.length; i++)
                    for (const r of rows)
                        if (r.parentId === doomed[i] && !seen.has(r.id)) {
                            seen.add(r.id);
                            doomed.push(r.id);
                        }
                if (seen.has(b.original.id) || seen.has(b.shipped.id)) {
                    abort(fail('The original and the shipped revisions cannot be deleted.'));
                    return;
                }
                const state = tx.objectStore('state'), got = state.get('latest');
                got.onsuccess = () => {
                    let latestId = got.result?.id;
                    if (seen.has(latestId)) {
                        const parent = byId.get(root.parentId) ?? builtin(root.parentId);
                        latestId = parent?.precision === 'w4' ? parent.id : b.shipped.id;
                        state.put({ key: 'latest', id: latestId });
                    }
                    const receipts = tx.objectStore('receipts');
                    for (const d of doomed) {
                        records.delete(d);
                        receipts.delete(d);
                    }
                    done({ removed: doomed, latestId });
                };
            };
        });
    }
    async function storedBase(precision) {
        return db ? read(db, 'bases', precision) : resident.get(precision);
    }
    async function exportWeights(id) {
        const tip = await get(id), lineage = await lineageFor(tip);
        const precision = tip.precision;
        let base = await storedBase(precision);
        if (!base) {
            const fetched = await networkBase(precision, origin, packBaseURL);
            base = fetched;
            if (db) {
                try {
                    await transaction(db, ['bases'], 'readwrite', (tx) => tx.objectStore('bases').put(fetched));
                }
                catch {
                    /* Export still works when the cache is full. */
                }
            }
            else
                resident.set(precision, fetched);
        }
        return writeSnapshot(tip, lineage, base);
    }
    async function modelAssets(id) {
        const { precision } = await get(id);
        const base = await storedBase(precision);
        if (!base)
            return undefined;
        const manifest = await verifiedManifest(await blobBytes(base.manifestBlob), precision);
        const files = new Map(manifest.chunks.map((c, i) => [c.path, base.chunks[i]]));
        files.set(TRUST.bases[precision].file, base.manifestBlob);
        return (name) => files.get(name) ?? null;
    }
    async function importWeights(file, { promote: move = false, expectedLatestId } = {}) {
        const database = writable();
        const { tip, lineage, manifestBlob, chunks } = await readWeightSnapshot(file);
        if (move)
            requireThat(tip.precision === 'w4' && tip.parentId === expectedLatestId, 'Import promotion requires a direct child of the selected tip.');
        await transaction(database, ['records', 'state', 'bases'], 'readwrite', (tx, _, abort) => {
            if (move)
                cas(tx, expectedLatestId, tip.id, abort);
            const rec = tx.objectStore('records');
            for (const r of lineage)
                appendUnique(rec, r);
            const base = tx.objectStore('bases'), got = base.getKey(tip.precision);
            got.onsuccess = () => {
                if (got.result === undefined)
                    base.add({ precision: tip.precision, manifestBlob, chunks });
            };
        });
        return get(tip.id);
    }
    return {
        builtins: copy(b),
        persistent: !!db,
        get,
        latest,
        list,
        promote,
        keep,
        adopt,
        receipt,
        saveRun,
        runs,
        remove,
        exportWeights,
        importWeights,
        modelAssets,
        diff: (r, parent, options) => revisionDiff(r, parent, options),
        diffFileName,
        nativeDiff,
        controllerDiff,
        close() {
            db?.close();
            resident.clear();
        },
    };
}
/** Return a context-local readAsset hook; no functions need to cross postMessage. */
export async function getImportedModelAssets(id, options) {
    const store = await openRevisionStore(options);
    try {
        return await store.modelAssets(id);
    }
    finally {
        store.close();
    }
}
/** Build a portable child from already portable W4 weights, without mutating browser storage. */
export async function extendWeightSnapshot(parentFile, { parentId, ops, controller, name = 'Learned 4-bit' }) {
    const { tip: parent, lineage, manifestBlob, chunks } = await readWeightSnapshot(parentFile);
    requireThat(parent.precision === 'w4' && parent.id === parentId, 'The supplied 4-bit snapshot must match the declared parent.');
    const child = await record({ precision: 'w4', parentId, ops, controller }, 'learned', name);
    requireThat(canonical(parent.ops) !== canonical(child.ops) || canonical(parent.controller) !== canonical(child.controller), 'A portable child must change at least one effective weight.');
    return writeSnapshot(child, [...lineage, child], { manifestBlob, chunks });
}
