/** Small, portable description of what one revision changed: native head codes and controller codes versus its parent. */
import type { HeadOp } from '../model/kumo.ts';
import type { Controller } from '../tactical/types.ts';
import type { RevisionRecord } from './store.ts';
import { TRUST } from './trust.ts';

export const DIFF_FORMAT = 'agm.dnp.revision-diff/1';

/** Which field of each readout holds its signed codes. */
const targets = { graft: 'codes', combat: 'codes', facing: 'code' } as const;

export type SlotPath = [matrix: keyof Controller, row?: number, column?: number];

export interface ControllerSlot {
  path: SlotPath;
  value: number;
}

export interface ControllerChange {
  path: SlotPath;
  before: number | null;
  after: number;
}

export interface NativeChange {
  row: number;
  col: number;
  base: number;
  before: number;
  after: number;
}

export interface RevisionDiff {
  format: typeof DIFF_FORMAT;
  exportedAt: string;
  id: string;
  name: string;
  kind: string;
  precision: string;
  parentId: string | null;
  parentName: string | null;
  baseManifestSHA256: string;
  head: {
    tensor: string;
    baseFingerprint: string;
    opsRelativeToW4Base: HeadOp[];
    changesVsParent: NativeChange[] | null;
    changesVsShipped: NativeChange[] | null;
  } | null;
  controller: {
    codes: Controller | null;
    changesVsParent: ControllerChange[] | null;
    changesVsShipped: ControllerChange[] | null;
  } | null;
  receipt: unknown;
}

/** Every signed code of a controller with its path: `[matrix, row, column]`, or `[facing]` for the single facing code. */
export function controllerSlots(controller: Controller | null | undefined): ControllerSlot[] {
  const out: ControllerSlot[] = [];
  if (!controller) return out;
  for (const [key, field] of Object.entries(targets) as [keyof Controller, string][]) {
    const v = (controller[key] as unknown as Record<string, unknown> | undefined)?.[field];
    if (Array.isArray(v))
      v.forEach((row: number[], r) => row.forEach((code, c) => out.push({ path: [key, r, c], value: code })));
    else if (Number.isInteger(v)) out.push({ path: [key], value: v as number });
  }
  return out;
}

export function controllerDiff(
  from: Controller | null | undefined,
  to: Controller | null | undefined,
): ControllerChange[] {
  const before = new Map(controllerSlots(from).map((s) => [s.path.join('.'), s.value]));
  return controllerSlots(to)
    .filter((s) => before.get(s.path.join('.')) !== s.value)
    .map((s) => ({ path: s.path, before: before.get(s.path.join('.')) ?? null, after: s.value }));
}

export function nativeDiff(fromOps: HeadOp[] | null | undefined, toOps: HeadOp[] | null | undefined): NativeChange[] {
  const base = (i: number) => TRUST.head.codes[i];
  const a = new Map((fromOps || []).map((op) => [op[0] * 1024 + op[1], op[3]])),
    b = new Map((toOps || []).map((op) => [op[0] * 1024 + op[1], op[3]]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort((x, y) => x - y)
    .filter((i) => (a.get(i) ?? base(i)) !== (b.get(i) ?? base(i)))
    .map((i) => ({
      row: i >>> 10,
      col: i % 1024,
      base: base(i),
      before: a.get(i) ?? base(i),
      after: b.get(i) ?? base(i),
    }));
}

export function revisionDiff(
  record: RevisionRecord,
  parent: RevisionRecord | null | undefined,
  { receipt = null, shipped = null }: { receipt?: unknown; shipped?: RevisionRecord | null } = {},
): RevisionDiff {
  const w4 = record.precision === 'w4';
  const againstShipped = shipped && shipped.id !== record.id ? shipped : null;
  return {
    format: DIFF_FORMAT,
    exportedAt: new Date().toISOString(),
    id: record.id,
    name: record.name,
    kind: record.kind,
    precision: record.precision,
    parentId: record.parentId,
    parentName: parent?.name ?? null,
    baseManifestSHA256: record.manifestSHA256,
    head: w4
      ? {
          tensor: TRUST.head.tensor,
          baseFingerprint: TRUST.head.fingerprint,
          opsRelativeToW4Base: record.ops,
          changesVsParent: parent ? nativeDiff(parent.ops, record.ops) : null,
          changesVsShipped: againstShipped ? nativeDiff(againstShipped.ops, record.ops) : null,
        }
      : null,
    controller: w4
      ? {
          codes: record.controller,
          changesVsParent: parent ? controllerDiff(parent.controller, record.controller) : null,
          changesVsShipped: againstShipped ? controllerDiff(againstShipped.controller, record.controller) : null,
        }
      : null,
    receipt,
  };
}

export function diffFileName(record: Pick<RevisionRecord, 'name' | 'id'>): string {
  return (
    'agm-diff-' +
    String(record.name || 'revision')
      .replace(/[^\p{L}\p{N}-]+/gu, '-')
      .slice(0, 40) +
    '-' +
    String(record.id).slice(-8) +
    '.json'
  );
}
