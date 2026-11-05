/** Content-addressed local revision history and portable browser inference weights. */
import type { HeadOp, ModelManifest, Precision } from '../model/kumo.ts';
import { loadModelChunk } from '../model/asset-cache.ts';
import { sha256 } from '../shared/sha256.ts';
import { packUrl, siteUrl } from '../shared/site.ts';
import type { Controller } from '../tactical/types.ts';
import { revisionDiff, diffFileName, nativeDiff, controllerDiff, type RevisionDiff } from './diff.ts';
import { makeHeadPatch } from './patch-codec.ts';
import { REFERENCE } from './reference.ts';
import { TRUST } from './trust.ts';

const MAGIC = new TextEncoder().encode('AGMDNP08');
const FORMAT = 'agm.browser-weights/1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_HEADER = 8 * 1024 * 1024;
const copy = <T>(x: T): T => structuredClone(x);
const hashPattern = /^[0-9a-f]{64}$/;

/** Model IDs stay portable; simulation evidence is keyed by game rules as well as model/run ID. */
export function evaluationStorageKey(id: string): string {
  return REFERENCE.ruleset + ':' + id;
}

/** Untagged DOOM-era entries and other environments never supply current-game scores or training credit. */
export function isCurrentEvaluation(value: unknown): value is { ruleset: string } {
  return !!value && typeof value === 'object' && 'ruleset' in value && value.ruleset === REFERENCE.ruleset;
}

function markEvaluation<T extends Record<string, unknown>>(value: T): T & { ruleset: string } {
  requireThat(value.ruleset === undefined || isCurrentEvaluation(value), 'Evidence belongs to another game ruleset.');
  return { ...copy(value), ruleset: REFERENCE.ruleset };
}
/** Which field of each readout holds its signed codes; every other field must equal the shipped template. */
const targets = { graft: 'codes', combat: 'codes', facing: 'code' } as const;

export type RevisionKind = 'original' | 'shipped' | 'base' | 'learned';

/** What a revision ID is computed from. */
export interface RevisionRecipe {
  precision: Precision;
  parentId: string | null;
  ops: HeadOp[];
  controller: Controller | null;
}

export interface RevisionRecord extends RevisionRecipe {
  id: string;
  kind: RevisionKind;
  name: string;
  manifestSHA256: string;
}

export interface Builtins {
  original: RevisionRecord;
  shipped: RevisionRecord;
  neutral: RevisionRecord;
  survivor?: RevisionRecord;
  terminator?: RevisionRecord;
  opus?: RevisionRecord;
}

/** The model basis a revision runs on: its verified manifest and packed chunks. */
interface StoredBase {
  precision: Precision;
  manifestBlob: Blob;
  chunks: Blob[];
}

export interface WeightSnapshot {
  tip: RevisionRecord;
  lineage: RevisionRecord[];
  manifest: ModelManifest;
  manifestBlob: Blob;
  chunks: Blob[];
}

export interface ChildRequest {
  parentId: string;
  ops: HeadOp[];
  controller: Controller | null;
  name?: string;
  receipt?: unknown;
}

/** One learning run as logged by the revisions panel; the store only requires its `runId`. */
export interface TrainingRun {
  runId: string;
  [field: string]: unknown;
}

export type StoreError = Error & { code: string };

export type ModelAssetReader = (name: string) => Blob | null;

export interface RevisionStore {
  builtins: Builtins;
  persistent: boolean;
  get(id: string): Promise<RevisionRecord>;
  latest(): Promise<RevisionRecord>;
  list(): Promise<RevisionRecord[]>;
  promote(request: ChildRequest): Promise<RevisionRecord>;
  keep(request: ChildRequest): Promise<RevisionRecord>;
  adopt(id: string, options?: { expectedLatestId?: string }): Promise<RevisionRecord>;
  receipt(id: string): Promise<unknown>;
  saveRun(run: TrainingRun): Promise<boolean>;
  runs(): Promise<TrainingRun[]>;
  remove(id: string): Promise<{ removed: string[]; latestId: string }>;
  exportWeights(id: string): Promise<Blob>;
  importWeights(file: Blob, options?: { promote?: boolean; expectedLatestId?: string }): Promise<RevisionRecord>;
  modelAssets(id: string): Promise<ModelAssetReader | undefined>;
  diff(
    record: RevisionRecord,
    parent: RevisionRecord | null | undefined,
    options?: { receipt?: unknown; shipped?: RevisionRecord | null },
  ): RevisionDiff;
  diffFileName: typeof diffFileName;
  nativeDiff: typeof nativeDiff;
  controllerDiff: typeof controllerDiff;
  close(): void;
}

function fail(message: string, code = 'INVALID_WEIGHTS'): StoreError {
  return Object.assign(new Error(message), { code });
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw fail(message);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(object[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
function strictKeys(obj: unknown, keys: readonly string[]): asserts obj is Record<string, unknown> {
  requireThat(
    obj &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      Object.keys(obj).length === keys.length &&
      keys.every((k) => Object.hasOwn(obj, k)),
    'Unexpected fields in revision metadata.',
  );
}
function checkCodes(candidate: unknown, reference: unknown): unknown {
  if (Array.isArray(reference)) {
    requireThat(Array.isArray(candidate) && candidate.length === reference.length, 'Invalid controller matrix shape.');
    return Array.from(reference, (row, i) => checkCodes(candidate[i], row));
  }
  requireThat(
    Number.isInteger(candidate) && (candidate as number) >= -7 && (candidate as number) <= 7,
    'Invalid signed controller parameter.',
  );
  return candidate;
}
function checkController(value: unknown): Controller {
  strictKeys(value, Object.keys(targets));
  const output: Record<string, unknown> = {};
  for (const [key, weights] of Object.entries(targets) as [keyof Controller, string][]) {
    const template = TRUST.controller[key] as unknown as Record<string, unknown>,
      src = value[key];
    strictKeys(src, Object.keys(template));
    for (const field of Object.keys(template)) {
      if (field !== weights)
        requireThat(canonical(src[field]) === canonical(template[field]), 'Incompatible ' + key + ' ' + field + '.');
    }
    output[key] = { ...copy(template), [weights]: checkCodes(src[weights], template[weights]) };
  }
  return output as unknown as Controller;
}
function normalize({
  precision,
  parentId,
  ops,
  controller,
}: RevisionRecipe): RevisionRecipe & { manifestSHA256: string } {
  requireThat(Object.hasOwn(TRUST.bases, precision), 'Unsupported model precision.');
  requireThat(Array.isArray(ops) && ops.length <= 3072, 'Invalid action-head operation count.');
  const manifestSHA256 = TRUST.bases[precision].sha256;
  if (precision === 'fp32') {
    requireThat(
      parentId === null && ops.length === 0 && controller === null,
      'The shipped FP32 model has no editable coordinates.',
    );
    return { precision, parentId, manifestSHA256, ops: [], controller: null };
  }
  requireThat(typeof parentId === 'string' && hashPattern.test(parentId), 'Invalid parent revision ID.');
  const sorted = ops.length
    ? makeHeadPatch(ops, 'Revision validation', 'Reconstruct the complete W4 readout', TRUST.head).ops.map(
        (op) => op.slice(1) as HeadOp,
      )
    : [];
  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { precision, parentId, manifestSHA256, ops: sorted, controller: checkController(controller) };
}
function digestDescriptor(d: RevisionRecipe & { manifestSHA256: string }): Promise<string> {
  return sha256(encoder.encode(canonical({ schema: FORMAT, ...d })));
}
/** Content address of a revision: SHA-256 of its canonical, validated recipe. */
export async function revisionId(recipe: RevisionRecipe): Promise<string> {
  return digestDescriptor(normalize(recipe));
}
function safeName(name: unknown): string {
  requireThat(
    typeof name === 'string' &&
      name.trim().length > 0 &&
      name.length <= 96 &&
      // Escapes, never literal characters: VERIFIED: a literal bidi control is invisible in review, and the
      // .vae/VERIFY.py rule source.no-invisible-controls rejects one in any *.ts file.
      // oxlint-disable-next-line no-control-regex -- control and bidi characters are exactly what this rejects
      !/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name),
    'Invalid revision display name.',
  );
  return name.trim();
}
async function record(recipe: RevisionRecipe, kind: RevisionKind, name: unknown): Promise<RevisionRecord> {
  const d = normalize(recipe);
  return { id: await digestDescriptor(d), kind, name: safeName(name), ...d };
}
let defaults: Promise<Builtins> | undefined;
const zeroed = (v: unknown): unknown => (Array.isArray(v) ? v.map(zeroed) : 0);
/** The shipped readout scaffolding with every signed code at zero: transforms stay, none of Astra 6's readout values remain. */
export function neutralController(): Controller {
  const c = copy(TRUST.controller) as unknown as Record<string, Record<string, unknown>>;
  for (const [key, field] of Object.entries(targets)) c[key][field] = zeroed(c[key][field]);
  return c as unknown as Controller;
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
] as const;
async function releaseRevision(base: RevisionRecord, file: string, pinned: string): Promise<RevisionRecord | null> {
  try {
    const res = await fetch(siteUrl('data/' + file));
    if (!res.ok) return null;
    const d = (await res.json()) as { ops: HeadOp[]; controller: Controller; name: string };
    const r = await record(
      { precision: 'w4', parentId: base.id, ops: d.ops, controller: d.controller },
      'learned',
      d.name,
    );
    return r.id === pinned ? r : null;
  } catch {
    return null;
  }
}
function builtins(): Promise<Builtins> {
  defaults ??= (async () => {
    const original = await record(
      { precision: 'fp32', parentId: null, ops: [], controller: null },
      'original',
      'Original FP32',
    );
    const shipped = await record(
      { precision: 'w4', parentId: original.id, ops: TRUST.edited, controller: TRUST.controller },
      'shipped',
      'Astra 6 Weight-Space Programming',
    );
    const neutral = await record(
      { precision: 'w4', parentId: original.id, ops: [], controller: neutralController() },
      'base',
      '4-bit base · neutral sensor weights',
    );
    const more = await Promise.all(NEUTRAL_RELEASES.map(([, file, id]) => releaseRevision(neutral, file, id)));
    const extra = Object.fromEntries(
      NEUTRAL_RELEASES.map(([key], i) => [key, more[i]] as const).filter(([, r]) => r),
    ) as Partial<Builtins>;
    return { original, shipped, neutral, ...extra };
  })();
  return defaults;
}
export const W4_BASE_KINDS = Object.freeze(['shipped', 'base']);
function effectiveHead(tip: RevisionRecord): Uint8Array {
  if (tip.precision === 'fp32') return new Uint8Array();
  const codes = Int8Array.from(TRUST.head.codes);
  for (const [r, c, , next] of tip.ops) codes[r * 1024 + c] = next;
  return new Uint8Array(codes.buffer);
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function assertBundleSize(size: number): void {
  requireThat(
    Number.isSafeInteger(size) &&
      size > 12 &&
      size <= 12 + MAX_HEADER + TRUST.bases.fp32.length + TRUST.bases.fp32.rawBytes + 3072,
    'Weight file exceeds supported limits or is truncated.',
  );
}
function checkedJSON(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw fail('Invalid UTF-8 JSON metadata.');
  }
}
async function verifiedManifest(bytes: Uint8Array, precision: Precision): Promise<ModelManifest> {
  const base = TRUST.bases[precision];
  requireThat(
    bytes.length === base.length && (await sha256(bytes)) === base.sha256,
    'Model manifest differs from the trusted release.',
  );
  return checkedJSON(bytes) as ModelManifest;
}
const blobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** Verify an entire snapshot without changing stored state. Chunks are validated one at a time. */
export async function readWeightSnapshot(file: Blob): Promise<WeightSnapshot> {
  requireThat(file instanceof Blob, 'A binary weight file is required.');
  assertBundleSize(file.size);
  const prefix = await blobBytes(file.slice(0, 12));
  requireThat(sameBytes(prefix.subarray(0, 8), MAGIC), 'Wrong weight file signature.');
  const length = new DataView(prefix.buffer).getUint32(8, true);
  requireThat(length > 0 && length <= MAX_HEADER && 12 + length < file.size, 'Invalid weight header length.');
  const h = checkedJSON(await blobBytes(file.slice(12, 12 + length)));
  strictKeys(h, ['format', 'precision', 'tip', 'ancestry', 'baseManifestSHA256', 'rawChunks']);
  requireThat(
    h.format === FORMAT && Object.hasOwn(TRUST.bases, h.precision as string),
    'Unsupported weight format or precision.',
  );
  const precision = h.precision as Precision;
  const base = TRUST.bases[precision];
  const rawChunks = h.rawChunks as number[];
  requireThat(h.baseManifestSHA256 === base.sha256 && Array.isArray(rawChunks), 'Wrong model basis or chunk encoding.');
  requireThat(
    rawChunks.length <= 12 &&
      rawChunks.every((n, i) => Number.isInteger(n) && n >= 0 && (i === 0 || rawChunks[i - 1] < n)),
    'Invalid raw-chunk indices.',
  );
  const ancestry = h.ancestry as unknown[];
  requireThat(
    Array.isArray(ancestry) && ancestry.length > 0 && ancestry.length <= 4096,
    'Invalid revision ancestry length.',
  );
  const b = await builtins(),
    lineage: RevisionRecord[] = [],
    roots = new Map([b.shipped, b.neutral].map((x) => [x.id, x]));
  for (const [i, entry] of ancestry.entries()) {
    strictKeys(entry, ['id', 'kind', 'name', 'precision', 'parentId', 'manifestSHA256', 'ops', 'controller']);
    const expectedKind: RevisionKind =
      i === 0 ? 'original' : i === 1 ? (roots.get(entry.id as string)?.kind ?? 'shipped') : 'learned';
    requireThat(
      entry.kind === expectedKind &&
        entry.parentId === (i === 0 ? null : lineage[i - 1].id) &&
        entry.precision === (i === 0 ? 'fp32' : 'w4'),
      'Broken or unsupported revision ancestry.',
    );
    const checked = await record(entry as unknown as RevisionRecipe, expectedKind, entry.name);
    requireThat(
      entry.id === checked.id && entry.manifestSHA256 === checked.manifestSHA256,
      'Revision ID or layout mismatch.',
    );
    if (i === 0) requireThat(checked.id === b.original.id, 'Unknown built-in revision.');
    if (i === 1)
      requireThat(
        roots.has(checked.id) && roots.get(checked.id)?.name === checked.name,
        'Unknown built-in 4-bit base.',
      );
    if (i >= 2)
      requireThat(
        canonical(checked.ops) !== canonical(lineage[i - 1].ops) ||
          canonical(checked.controller) !== canonical(lineage[i - 1].controller),
        'Learned revision has no changed weights.',
      );
    lineage.push(checked);
  }
  const tip = lineage[lineage.length - 1];
  requireThat(tip.id === h.tip && tip.precision === precision, 'Unmatched snapshot tip.');
  let pos = 12 + length;
  const manifestBlob = file.slice(pos, pos + base.length);
  pos += base.length;
  const manifest = await verifiedManifest(await blobBytes(manifestBlob), tip.precision);
  requireThat(
    rawChunks.every((n) => n < manifest.chunks.length),
    'Invalid raw-chunk index.',
  );
  const raw = new Set(rawChunks);
  const sizes = manifest.chunks.map((item, i) => (raw.has(i) ? item.rawBytes : item.bytes));
  requireThat(
    file.size === pos + sizes.reduce((a, s) => a + s, 0) + (tip.precision === 'w4' ? 3072 : 0),
    'Wrong model payload length.',
  );
  const chunks: Blob[] = [];
  for (const [i, item] of manifest.chunks.entries()) {
    const part = file.slice(pos, pos + sizes[i]);
    pos += sizes[i];
    requireThat(
      (await sha256(await blobBytes(part))) === (raw.has(i) ? item.rawSha256 : item.sha256),
      'Corrupt packed weight chunk ' + item.path + '.',
    );
    chunks.push(part);
  }
  const materialized = await blobBytes(file.slice(pos));
  requireThat(sameBytes(materialized, effectiveHead(tip)), 'Materialized head differs from signed edits.');
  return { tip, lineage, manifest, manifestBlob, chunks };
}

/* Keep CAS reads and writes in one IDB readwrite transaction. Never await hashing or
 * network I/O inside an open transaction; IDB would be entitled to auto-commit. */
function transaction<T = void>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  execute: (tx: IDBTransaction, done: (value: T) => void, abort: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let answer: T, error: unknown;
    const done = (x: T) => {
      answer = x;
    };
    const abort = (e: unknown) => {
      error = e;
      tx.abort();
    };
    tx.oncomplete = () => resolve(answer);
    tx.onabort = () => reject(error || tx.error || fail('IndexedDB transaction aborted.', 'STORAGE'));
    try {
      execute(tx, done, abort);
    } catch (e) {
      abort(e);
    }
  });
}
async function openDB(name: string): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return null;
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
        if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n, { keyPath });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onblocked = () => reject(fail('Close older tabs to open revision storage.', 'STORAGE_BLOCKED'));
  });
}
function read<T>(db: IDBDatabase, store: string, id: string): Promise<T | undefined> {
  return transaction<T | undefined>(db, [store], 'readonly', (tx, done) => {
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => done(req.result as T | undefined);
  });
}
function appendUnique(store: IDBObjectStore, rec: RevisionRecord): void {
  const req = store.getKey(rec.id);
  req.onsuccess = () => {
    if (req.result === undefined) store.add(rec);
  };
}
function cas(tx: IDBTransaction, parent: string | undefined, tip: string, abort: (error: unknown) => void): void {
  const state = tx.objectStore('state'),
    got = state.get('latest');
  got.onsuccess = () => {
    if (got.result?.id !== parent) {
      abort(fail('Another tab or import changed the latest revision.', 'STALE_PARENT'));
      return;
    }
    state.put({ key: 'latest', id: tip });
  };
}
async function seed(db: IDBDatabase, b: Builtins): Promise<void> {
  await transaction(db, ['records', 'state'], 'readwrite', (tx) => {
    const records = tx.objectStore('records');
    appendUnique(records, b.original);
    appendUnique(records, b.shipped);
    const s = tx.objectStore('state'),
      got = s.get('latest');
    got.onsuccess = () => {
      if (!got.result) s.add({ key: 'latest', id: b.shipped.id });
    };
  });
}
async function chunkEncoding(
  blob: Blob | null | undefined,
  item: ModelManifest['chunks'][number],
): Promise<'gzip' | 'raw'> {
  requireThat(
    blob?.size === item.bytes || blob?.size === item.rawBytes,
    'Invalid weight chunk length for ' + item.path + '.',
  );
  const digest = await sha256(await blobBytes(blob));
  if (blob.size === item.bytes && digest === item.sha256) return 'gzip';
  if (blob.size === item.rawBytes && digest === item.rawSha256) return 'raw';
  throw fail('Invalid weight chunk digest for ' + item.path + '.');
}
async function networkBase(precision: Precision, baseURL: URL, packBaseURL: URL | undefined): Promise<StoredBase> {
  const trust = TRUST.bases[precision];
  async function fetchBlob(url: URL): Promise<Blob> {
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) throw fail('Could not load model asset ' + url.href + '.', 'ASSET_UNAVAILABLE');
    return response.blob();
  }
  const manifestBlob = await fetchBlob(new URL(trust.file, baseURL));
  requireThat(manifestBlob.size === trust.length, 'Unexpected model manifest length.');
  const manifest = await verifiedManifest(await blobBytes(manifestBlob), precision);
  const chunks: Blob[] = [];
  for (const item of manifest.chunks) {
    const { bytes } = await loadModelChunk(packUrl(precision, item.path, packBaseURL), item);
    chunks.push(new Blob([bytes]));
  }
  return { precision, manifestBlob, chunks };
}
function headerFor(tip: RevisionRecord, lineage: RevisionRecord[], rawChunks: number[]): Uint8Array {
  const header = encoder.encode(
    JSON.stringify({
      format: FORMAT,
      precision: tip.precision,
      tip: tip.id,
      ancestry: lineage,
      baseManifestSHA256: tip.manifestSHA256,
      rawChunks,
    }),
  );
  requireThat(header.length <= MAX_HEADER && lineage.length <= 4096, 'Ancestry exceeds portable snapshot limits.');
  return header;
}
async function writeSnapshot(
  tip: RevisionRecord,
  lineage: RevisionRecord[],
  base: Pick<StoredBase, 'manifestBlob' | 'chunks'>,
): Promise<Blob> {
  const manifest = await verifiedManifest(await blobBytes(base.manifestBlob), tip.precision);
  requireThat(base.chunks.length === manifest.chunks.length, 'Incomplete stored weight set.');
  const rawChunks: number[] = [];
  for (const [i, item] of manifest.chunks.entries())
    if ((await chunkEncoding(base.chunks[i], item)) === 'raw') rawChunks.push(i);
  const header = headerFor(tip, lineage, rawChunks);
  const prefix = new Uint8Array(12);
  prefix.set(MAGIC);
  new DataView(prefix.buffer).setUint32(8, header.length, true);
  return new Blob(
    [
      prefix,
      header as Uint8Array<ArrayBuffer>,
      base.manifestBlob,
      ...base.chunks,
      effectiveHead(tip) as Uint8Array<ArrayBuffer>,
    ],
    { type: 'application/octet-stream' },
  );
}

// Retain the model database so existing learned weights remain available. Evidence is separately scoped below.
export async function openRevisionStore({
  baseURL = siteUrl('model/'),
  packBaseURL,
  dbName = 'agm-dnp-revisions-v1',
}: {
  /** Same-origin directory of the model manifests. */
  baseURL?: URL;
  /** Root the packs are downloaded from (default Hugging Face); each is verified against its manifest digest. */
  packBaseURL?: URL;
  dbName?: string;
} = {}): Promise<RevisionStore> {
  const b = await builtins();
  let db: IDBDatabase | null = null;
  try {
    db = await openDB(dbName);
    if (db) await seed(db, b);
  } catch (e) {
    db?.close();
    if ((e as StoreError).code === 'STORAGE_BLOCKED') throw e;
    db = null;
  }
  const resident = new Map<Precision, StoredBase>();
  const origin = new URL(baseURL);
  if (globalThis.location && ['https:', 'http:'].includes(location.protocol))
    requireThat(origin.origin === location.origin, 'Model assets must use the same origin.');
  function writable(): IDBDatabase {
    if (!db) throw fail('Persistent revision storage is unavailable.', 'PERSISTENCE_UNAVAILABLE');
    return db;
  }
  // The two W4 bases are virtual roots: readable and exportable at any time, persisted once adopted or imported.
  const builtin = (id: string | null | undefined) =>
    Object.values(b).find((x) => x?.id === id) as RevisionRecord | undefined;
  // A built-in revision below a virtual base needs its built-in ancestors stored with it.
  const builtinChain = (r: RevisionRecord) => {
    const out: RevisionRecord[] = [];
    for (let x: RevisionRecord | undefined = r; x && builtin(x.id) && x.kind !== 'original'; x = builtin(x.parentId))
      out.push(x);
    return out;
  };
  // A stored built-in revision shows its current name.
  const shown = (r: RevisionRecord): RevisionRecord => ({ ...r, name: builtin(r.id)?.name ?? r.name });
  async function get(id: string): Promise<RevisionRecord> {
    const r = (db ? await read<RevisionRecord>(db, 'records', id) : undefined) ?? builtin(id);
    if (!r) throw fail('Unknown revision ID.', 'UNKNOWN_REVISION');
    return copy(shown(r));
  }
  async function latest(): Promise<RevisionRecord> {
    if (!db) return copy(b.shipped);
    const state = await read<{ id: string }>(db, 'state', 'latest');
    return get((state as { id: string }).id);
  }
  async function list(): Promise<RevisionRecord[]> {
    if (!db) return copy([b.original, b.shipped]);
    const rows = await transaction<RevisionRecord[]>(db, ['records'], 'readonly', (tx, done) => {
      const req = tx.objectStore('records').getAll();
      req.onsuccess = () => done(req.result as RevisionRecord[]);
    });
    // Graph depth orders parents before children, independent of racing branch imports.
    const depth = new Map([[b.original.id, 0]]),
      byId = new Map(rows.map((r) => [r.id, r]));
    function level(r: RevisionRecord): number {
      if (!depth.has(r.id)) depth.set(r.id, 1 + level(byId.get(r.parentId as string) as RevisionRecord));
      return depth.get(r.id) as number;
    }
    return rows.sort((a, c) => level(a) - level(c) || a.id.localeCompare(c.id)).map(shown);
  }
  async function lineageFor(tip: RevisionRecord): Promise<RevisionRecord[]> {
    const lineage = [tip];
    for (let r = tip; r.parentId;) {
      r = await get(r.parentId);
      lineage.push(r);
    }
    return lineage.reverse();
  }
  async function storeReceipt(database: IDBDatabase, id: string, receipt: unknown): Promise<void> {
    const marked =
      receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? markEvaluation(receipt as Record<string, unknown>)
        : copy(receipt);
    await transaction(database, ['receipts'], 'readwrite', (tx) =>
      tx.objectStore('receipts').put({ id: evaluationStorageKey(id), ruleset: REFERENCE.ruleset, receipt: marked }),
    );
  }
  async function promote({ parentId, ops, controller, name = 'Learned 4-bit', receipt = null }: ChildRequest) {
    const database = writable();
    const parent = await get(parentId);
    requireThat(parent.precision === 'w4', 'New training parents must be 4-bit.');
    const r = await record({ parentId, precision: 'w4', ops, controller }, 'learned', name);
    requireThat(
      canonical(r.ops) !== canonical(parent.ops) || canonical(r.controller) !== canonical(parent.controller),
      'Winner has no changed weights.',
    );
    headerFor(
      r,
      [...(await lineageFor(parent)), r],
      Array.from({ length: 12 }, (_, i) => i),
    );
    await transaction(database, ['records', 'state'], 'readwrite', (tx, _, abort) => {
      cas(tx, parentId, r.id, abort);
      const records = tx.objectStore('records');
      for (const x of builtinChain(parent)) appendUnique(records, x);
      appendUnique(records, r);
    });
    if (receipt) {
      try {
        await storeReceipt(database, r.id, receipt);
      } catch {
        /* Receipts are advisory; the revision itself is already saved. */
      }
    }
    return get(r.id);
  }
  /** Store a learned child without moving the training tip (an unconfirmed final-round candidate). */
  async function keep({ parentId, ops, controller, name = 'Learned 4-bit', receipt = null }: ChildRequest) {
    const database = writable();
    const parent = await get(parentId);
    requireThat(parent.precision === 'w4', 'Kept children need a 4-bit parent.');
    const r = await record({ parentId, precision: 'w4', ops, controller }, 'learned', name);
    requireThat(
      canonical(r.ops) !== canonical(parent.ops) || canonical(r.controller) !== canonical(parent.controller),
      'Candidate has no changed weights.',
    );
    headerFor(
      r,
      [...(await lineageFor(parent)), r],
      Array.from({ length: 12 }, (_, i) => i),
    );
    await transaction(database, ['records'], 'readwrite', (tx) => {
      const records = tx.objectStore('records');
      for (const x of builtinChain(parent)) appendUnique(records, x);
      appendUnique(records, r);
    });
    if (receipt) {
      try {
        await storeReceipt(database, r.id, receipt);
      } catch {
        /* Receipts are advisory. */
      }
    }
    return get(r.id);
  }
  /** Training-run log: the complete record of one learning run (settings, environment, code fingerprint, every generation). */
  async function saveRun(run: TrainingRun): Promise<boolean> {
    if (!db) return false;
    requireThat(typeof run?.runId === 'string' && run.runId.length > 0, 'A training run needs an ID.');
    const marked = markEvaluation(run);
    await transaction(db, ['runs'], 'readwrite', (tx) =>
      tx.objectStore('runs').put({ id: evaluationStorageKey(run.runId), ruleset: REFERENCE.ruleset, run: marked }),
    );
    return true;
  }
  async function runs(): Promise<TrainingRun[]> {
    if (!db) return [];
    return transaction<TrainingRun[]>(db, ['runs'], 'readonly', (tx, done) => {
      const req = tx.objectStore('runs').getAll();
      req.onsuccess = () => done((req.result as { run: TrainingRun }[]).filter(isCurrentEvaluation).map((x) => x.run));
    });
  }
  /** Current-game evidence only. Old DOOM receipts remain stored but cannot seed scores or training credit. */
  async function receipt(id: string): Promise<unknown> {
    if (!db) return null;
    try {
      const stored = await read<{ ruleset: string; receipt: unknown }>(db, 'receipts', evaluationStorageKey(id));
      return isCurrentEvaluation(stored) ? stored.receipt : null;
    } catch {
      return null;
    }
  }
  async function adopt(id: string, { expectedLatestId }: { expectedLatestId?: string } = {}) {
    const database = writable();
    const r = await get(id);
    requireThat(
      r.precision === 'w4' && hashPattern.test(expectedLatestId as string),
      'Adoption requires a 4-bit model and the current tip ID.',
    );
    await transaction(database, ['records', 'state'], 'readwrite', (tx, _, abort) => {
      cas(tx, expectedLatestId, id, abort);
      for (const x of builtinChain(r)) appendUnique(tx.objectStore('records'), x);
    });
    return r;
  }
  /** Delete a persisted revision together with every descendant and their receipts, in one transaction.
   * The original FP32 model and the shipped composite cannot be deleted; a deleted W4 base reappears as its virtual root.
   * When the latest revision is among the deleted ones, the latest pointer moves to the deleted branch's parent (W4) or the shipped composite. */
  async function remove(id: string): Promise<{ removed: string[]; latestId: string }> {
    const database = writable();
    requireThat(typeof id === 'string' && hashPattern.test(id), 'Invalid revision ID.');
    requireThat(
      id !== b.original.id && id !== b.shipped.id,
      'The original and the shipped revisions cannot be deleted.',
    );
    return transaction<{ removed: string[]; latestId: string }>(
      database,
      ['records', 'state', 'receipts'],
      'readwrite',
      (tx, done, abort) => {
        const records = tx.objectStore('records'),
          all = records.getAll();
        all.onsuccess = () => {
          const rows = all.result as RevisionRecord[],
            byId = new Map(rows.map((r) => [r.id, r])),
            root = byId.get(id);
          if (!root) {
            abort(fail('Only stored revisions can be deleted.', 'UNKNOWN_REVISION'));
            return;
          }
          const doomed = [id],
            seen = new Set(doomed);
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
          const state = tx.objectStore('state'),
            got = state.get('latest');
          got.onsuccess = () => {
            let latestId = got.result?.id as string;
            if (seen.has(latestId)) {
              const parent = byId.get(root.parentId as string) ?? builtin(root.parentId);
              latestId = parent?.precision === 'w4' ? parent.id : b.shipped.id;
              state.put({ key: 'latest', id: latestId });
            }
            const receipts = tx.objectStore('receipts');
            for (const d of doomed) {
              records.delete(d);
              receipts.delete(evaluationStorageKey(d));
              receipts.delete(d); // Also remove the historical receipt when its model is explicitly deleted.
            }
            done({ removed: doomed, latestId });
          };
        };
      },
    );
  }
  async function storedBase(precision: Precision): Promise<StoredBase | undefined> {
    return db ? read<StoredBase>(db, 'bases', precision) : resident.get(precision);
  }
  async function exportWeights(id: string): Promise<Blob> {
    const tip = await get(id),
      lineage = await lineageFor(tip);
    const precision = tip.precision;
    let base = await storedBase(precision);
    if (!base) {
      const fetched = await networkBase(precision, origin, packBaseURL);
      base = fetched;
      if (db) {
        try {
          await transaction(db, ['bases'], 'readwrite', (tx) => tx.objectStore('bases').put(fetched));
        } catch {
          /* Export still works when the cache is full. */
        }
      } else resident.set(precision, fetched);
    }
    return writeSnapshot(tip, lineage, base);
  }
  async function modelAssets(id: string): Promise<ModelAssetReader | undefined> {
    const { precision } = await get(id);
    const base = await storedBase(precision);
    if (!base) return undefined;
    const manifest = await verifiedManifest(await blobBytes(base.manifestBlob), precision);
    const files = new Map(manifest.chunks.map((c, i) => [c.path, base.chunks[i]]));
    files.set(TRUST.bases[precision].file, base.manifestBlob);
    return (name) => files.get(name) ?? null;
  }
  async function importWeights(
    file: Blob,
    { promote: move = false, expectedLatestId }: { promote?: boolean; expectedLatestId?: string } = {},
  ): Promise<RevisionRecord> {
    const database = writable();
    const { tip, lineage, manifestBlob, chunks } = await readWeightSnapshot(file);
    if (move)
      requireThat(
        tip.precision === 'w4' && tip.parentId === expectedLatestId,
        'Import promotion requires a direct child of the selected tip.',
      );
    await transaction(database, ['records', 'state', 'bases'], 'readwrite', (tx, _, abort) => {
      if (move) cas(tx, expectedLatestId, tip.id, abort);
      const rec = tx.objectStore('records');
      for (const r of lineage) appendUnique(rec, r);
      const base = tx.objectStore('bases'),
        got = base.getKey(tip.precision);
      got.onsuccess = () => {
        if (got.result === undefined) base.add({ precision: tip.precision, manifestBlob, chunks });
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
export async function getImportedModelAssets(
  id: string,
  options?: Parameters<typeof openRevisionStore>[0],
): Promise<ModelAssetReader | undefined> {
  const store = await openRevisionStore(options);
  try {
    return await store.modelAssets(id);
  } finally {
    store.close();
  }
}

/** Build a portable child from already portable W4 weights, without mutating browser storage. */
export async function extendWeightSnapshot(
  parentFile: Blob,
  { parentId, ops, controller, name = 'Learned 4-bit' }: ChildRequest,
): Promise<Blob> {
  const { tip: parent, lineage, manifestBlob, chunks } = await readWeightSnapshot(parentFile);
  requireThat(
    parent.precision === 'w4' && parent.id === parentId,
    'The supplied 4-bit snapshot must match the declared parent.',
  );
  const child = await record({ precision: 'w4', parentId, ops, controller }, 'learned', name);
  requireThat(
    canonical(parent.ops) !== canonical(child.ops) || canonical(parent.controller) !== canonical(child.controller),
    'A portable child must change at least one effective weight.',
  );
  return writeSnapshot(child, [...lineage, child], { manifestBlob, chunks });
}
