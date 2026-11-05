/** Missing comparison baselines must be measurable, including the unmodified FP32 policy. */
import { expect, test } from 'bun:test';
import { REFERENCE, validReference, type ReferenceRecord } from '../../src/revisions/reference.ts';
import { openRevisionStore } from '../../src/revisions/store.ts';
import { moduleUrl, siteUrl } from '../../src/shared/site.ts';
import type { TrainingReply } from '../../src/workers/training-worker.ts';

test('the real reference worker measures FP32 and W4 on the same fixed games', async () => {
  const store = await openRevisionStore();
  const items = [store.builtins.original, store.builtins.neutral];
  store.close();
  const shipped = (await Bun.file(siteUrl('data/huggingdoom-reference-v1.json')).json()) as {
    protocol: string;
    revisions: Record<string, ReferenceRecord>;
  };
  expect(shipped.protocol).toBe(REFERENCE.protocol);
  const worker = new Worker(moduleUrl('workers/training-worker'), { type: 'module' });
  const measured = new Map<string, ReferenceRecord>();
  try {
    const games = await new Promise<number>((resolve, reject) => {
      worker.onerror = reject;
      worker.onmessage = ({ data: m }: MessageEvent<TrainingReply>) => {
        if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'reference-result' && m.id) measured.set(m.id, m.record);
        else if (m.type === 'stopped') resolve(m.games);
      };
      worker.postMessage({
        type: 'reference',
        lanes: 2,
        items: items.map((r) => ({ id: r.id, precision: r.precision, ops: r.ops, tactical: r.controller })),
      });
    });
    expect(games).toBe(REFERENCE.count * items.length);
    expect(measured.size).toBe(items.length);
    for (const item of items) {
      const record = measured.get(item.id)!;
      expect(validReference(record)).toBe(true);
      expect(record.tics).toEqual(shipped.revisions[item.id].tics);
      expect(record.kills).toEqual(shipped.revisions[item.id].kills);
    }
    expect(measured.get(items[0].id)?.tics).not.toEqual(measured.get(items[1].id)?.tics);
  } finally {
    worker.terminate();
  }
}, 120000);
