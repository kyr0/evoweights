/** One evaluation lane: a private W4 Kumo plus PureDOOM arena that plays assigned games to completion. */
import type { AssetBytes } from '../model/kumo.ts';
import {
  openLiveES,
  type GameJob,
  type GameResult,
  type LiveES,
  type LiveMessage,
  type TrainingCounts,
  type TrainingFrame,
} from '../training/live-es.ts';
import { createYield, workerScope } from '../shared/worker-scope.ts';

export type LaneRequest =
  | { type: 'init'; lane: number; assets?: Map<string, AssetBytes> }
  | { type: 'watch'; watch: boolean }
  | { type: 'play'; id: number; job: GameJob };

export type LaneReply =
  | { type: 'ready'; lane: number }
  | { type: 'tick'; lane: number; step: number; role?: string; seed?: number }
  | {
      type: 'result';
      id: number;
      lane: number;
      result: GameResult;
      hidden: ArrayBuffer | null;
      counts: Partial<TrainingCounts>;
    }
  | TrainingFrame
  | { type: 'error'; id?: number; lane: number; message: string };

let ctx: LiveES | null = null,
  watch = false,
  busy = false,
  lane = 0;
const yieldTask = createYield();
const reply = (message: LaneReply, transfer: Transferable[] = []) => workerScope.postMessage(message, transfer);
const emit = (m: LiveMessage, transfer: Transferable[] = []) => {
  if (m.type === 'progress') {
    reply({ type: 'tick', lane, step: (m.step as number) ?? 0, role: m.role as string, seed: m.seed as number });
    return;
  }
  workerScope.postMessage(m, transfer);
};

async function play(id: number, j: GameJob, live: LiveES): Promise<void> {
  const before = { ...live.counts };
  const result = await live.game(j.recipe, j.seed, j.horizon, j.round, j.phase, j.role, { hidden: !!j.hidden });
  const hidden = j.hidden ? live.lastHidden() : null,
    after = live.counts;
  const counts = {
    games: after.games - before.games,
    decisions: after.decisions - before.decisions,
    cacheHits: after.cacheHits - before.cacheHits,
    backboneCalls: after.backboneCalls - before.backboneCalls,
    readoutCalls: after.readoutCalls - before.readoutCalls,
  };
  const buffer = hidden ? (hidden.buffer as ArrayBuffer) : null;
  reply({ type: 'result', id, lane, result, hidden: buffer, counts }, buffer ? [buffer] : []);
}

workerScope.onmessage = async ({ data }: MessageEvent<LaneRequest>) => {
  const m = data;
  try {
    if (m.type === 'init') {
      lane = m.lane | 0;
      ctx = await openLiveES({ assets: m.assets, emit, watch: () => watch, stop: () => false, yieldTask, lane });
      reply({ type: 'ready', lane });
      return;
    }
    if (m.type === 'watch') {
      watch = m.watch === true;
      return;
    }
    if (m.type !== 'play') return;
    if (!ctx || busy) throw new Error('Lane ' + lane + ' is not ready for a game');
    busy = true;
    try {
      await play(m.id, m.job, ctx);
    } finally {
      busy = false;
    }
  } catch (e) {
    reply({
      type: 'error',
      id: (m as { id?: number })?.id,
      lane,
      message: (e instanceof Error && e.message) || String(e),
    });
  }
};
