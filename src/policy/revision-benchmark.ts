// W4 classifier edits affect only its final linear readout, whose input is identical across revisions.
// These fixed observations check numerical inference equivalence, not game performance. They remain valid
// after a theme/rules change; game-score references are isolated by revisions/reference.ts instead.
import type { HeadOp } from '../model/kumo.ts';
import { makeHeadPatch, type ReleasedHead } from '../revisions/patch-codec.ts';
import { siteUrl } from '../shared/site.ts';

/** Per observation: three native logits followed by the 1024 head inputs, as little-endian FP32. */
const STRIDE = 1027;

/** Native final scores of `count` benchmark observations with the head edits `ops` applied. */
export async function revisionReference(ops: HeadOp[], count: number): Promise<number[][]> {
  const [response, headResponse] = await Promise.all([
    fetch(siteUrl('assets/bench-revision-reference.f32')),
    fetch(siteUrl('data/practice-head.json')),
  ]);
  if (!response.ok || !headResponse.ok) throw new Error('Revision benchmark reference unavailable');
  const head = (await headResponse.json()) as ReleasedHead;
  if (ops.length) makeHeadPatch(ops, 'Benchmark revision.', 'Reconstruct native final scores.', head);
  const fixture = new DataView(await response.arrayBuffer());
  if (fixture.byteLength !== count * STRIDE * 4) throw new Error('Unexpected native benchmark fixture size');
  const deltas = ops.map(([row, col, old, next]) => [row, col, (next - old) * head.scales[row * 16 + (col >>> 6)]]);
  return Array.from({ length: count }, (_, i) => {
    const offset = i * STRIDE * 4,
      read = (j: number) => fixture.getFloat32(offset + 4 * j, true);
    const scores = [read(0), read(1), read(2)];
    for (const [row, col, delta] of deltas) scores[row] += read(3 + col) * delta;
    return scores;
  });
}
