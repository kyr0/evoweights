/** Live game worker: one arena, one inference runtime and one decision policy, stepped at the game's 17.5 Hz decision rate. */
import { createArena, type Arena, type ArenaState, type Threat, type Weapon } from '../engine/arena.ts';
import type { HeadOp } from '../model/kumo.ts';
import { createDecisionPolicy, modelFor, type DecisionPolicy, type PolicyRevision } from '../policy/decision-policy.ts';
import { openRuntime, percentile, type BackendInfo, type Runtime } from '../policy/runtime.ts';
import { workerScope } from '../shared/worker-scope.ts';
import type { PolicyDecision } from '../tactical/types.ts';

export interface HumanKeys {
  left: boolean;
  right: boolean;
  forward: boolean;
  backward: boolean;
  fire: boolean;
}

export type PlayRequest =
  | {
      type: 'init';
      seed: number;
      human?: boolean;
      variant?: string;
      policy?: string;
      backend: string;
      limitTics?: number;
      revision?: PolicyRevision & { ops: HeadOp[] };
      revisionId?: string;
    }
  | { type: 'control'; keys: Partial<HumanKeys> }
  | { type: 'human'; on: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reset'; seed: number };

export type LiveDecision = PolicyDecision & { human?: boolean; weapon?: Weapon };

export interface FramePacket {
  type: 'frame';
  rgba: ArrayBuffer;
  width: number;
  height: number;
  seed: number;
  n: number;
  tic: number;
  health: number;
  ammo: number;
  kills: number;
  picnic: ArenaState['picnic'];
  done: boolean;
  decision: LiveDecision | null;
  inferenceMs: number;
  weapon: Weapon;
  damage: number;
  variant: string | undefined;
  regions: number[];
  threat: Threat;
  backSteps: number;
  flips: number;
  inferenceP50: number | null;
  inferenceP95: number | null;
  perfN: number;
  backend: BackendInfo;
}

export type PlayReply =
  | FramePacket
  | { type: 'loading'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'end' }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'error'; message: string };

/** Two game tics per decision at 35 tics per second. */
const DECISION_MS = 2000 / 35;

let arena: Arena | null = null,
  runtime: Runtime | null = null,
  policy: DecisionPolicy | null = null,
  variant: string | undefined,
  seed = 9000;
let paused = true,
  finished = false,
  busy = false,
  timer: ReturnType<typeof setTimeout> | null = null,
  epoch = 0,
  n = 0;
let perfSamples: number[] = [],
  lastMotion: number | null = null,
  flips = 0,
  backSteps = 0;
// Human play: the page streams key states; FIRE wins over turning, forward over backward.
let human = false;
const keys: HumanKeys = { left: false, right: false, forward: false, backward: false, fire: false };
const humanDecision = (): LiveDecision => ({
  action: keys.fire ? 2 : keys.left ? 0 : keys.right ? 1 : 3,
  logits: [],
  forward: keys.forward && !keys.backward,
  backward: keys.backward && !keys.forward,
  mode: 'human',
  human: true,
});
const post = (message: PlayReply, transfer: Transferable[] = []) => workerScope.postMessage(message, transfer);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function stop(): void {
  paused = true;
  epoch++;
  if (timer) clearTimeout(timer);
  timer = null;
}
function schedule(ms = 0): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!paused && !finished && !busy) timer = setTimeout(tick, ms);
}
function reset(game: Arena, value: number, initial = false): void {
  stop();
  policy?.reset();
  seed = value >>> 0;
  n = 0;
  flips = 0;
  backSteps = 0;
  lastMotion = null;
  perfSamples = [];
  finished = false;
  const s = initial ? game.state() : game.reset(seed);
  packet(game, s, null, 0);
}
function packet(game: Arena, s: ArenaState, decision: LiveDecision | null, ms: number): void {
  const rgba = game.frame().slice();
  post(
    {
      type: 'frame',
      rgba: rgba.buffer,
      width: game.width,
      height: game.height,
      seed,
      n,
      tic: s.tic,
      health: s.health,
      ammo: s.ammo,
      kills: s.kills,
      picnic: s.picnic,
      done: s.done,
      decision,
      inferenceMs: ms,
      weapon: s.weapon,
      damage: s.events.damage,
      variant,
      regions: Array.from(s.features.slice(0, 9)),
      threat: s.threat,
      backSteps,
      flips,
      inferenceP50: percentile(perfSamples, 0.5),
      inferenceP95: percentile(perfSamples, 0.95),
      perfN: perfSamples.length,
      backend: human ? { backend: 'human', reason: null } : (runtime?.info() ?? { backend: 'human', reason: null }),
    },
    [rgba.buffer],
  );
}
async function tick(): Promise<void> {
  if (paused || finished || busy || !arena || (!human && (!runtime || !policy))) return;
  busy = true;
  const version = epoch,
    t0 = performance.now();
  let delay = 0;
  try {
    const s = arena.state(),
      start = performance.now();
    let result: LiveDecision,
      dt = 0;
    if (human) result = humanDecision();
    else {
      const core = await runtime!.infer(s.features, policy!.head);
      if (version !== epoch || paused) return;
      result = policy!.decide(s, core);
      dt = performance.now() - start;
    }
    if (n >= 12 && !human) {
      perfSamples.push(dt);
      if (perfSamples.length > 128) perfSamples.shift();
    }
    if (lastMotion !== null && lastMotion < 2 && result.action < 2 && lastMotion !== result.action) flips++;
    lastMotion = result.action;
    backSteps += Number(!!result.backward);
    const next = arena.step(result.action, !!result.backward, !!result.forward);
    n++;
    packet(arena, next, { ...result, weapon: s.weapon }, dt);
    if (next.done) {
      finished = true;
      stop();
      post({ type: 'end' });
      return;
    }
    delay = Math.max(0, DECISION_MS - (performance.now() - t0));
  } catch (e) {
    stop();
    post({ type: 'error', message: errorText(e) });
  } finally {
    busy = false;
    schedule(delay);
  }
}
function run(): void {
  if (!arena || (!human && (!runtime || !policy)) || finished) return;
  paused = false;
  schedule();
}

let aiConfig: Extract<PlayRequest, { type: 'init' }> | null = null;
async function prepareAI(): Promise<void> {
  if (runtime && policy) return;
  if (!aiConfig) throw new Error('No model selected');
  const m = aiConfig;
  const choice = (m.variant ?? m.policy ?? 'dnp') as string;
  const { precision } = modelFor(choice, m.revision);
  [runtime, policy] = await Promise.all([
    openRuntime(
      m.backend,
      ({ loaded, total }) => post({ type: 'loading', loaded, total }),
      precision,
      m.revision?.ops,
      m.revisionId,
    ),
    createDecisionPolicy(choice, undefined, m.revision),
  ]);
}

workerScope.onmessage = async ({ data: m }: MessageEvent<PlayRequest>) => {
  try {
    if (m.type === 'init') {
      seed = m.seed >>> 0;
      human = !!m.human;
      variant = m.variant ?? m.policy;
      aiConfig = m;
      if (human) arena = await createArena({ seed, limitTics: Number.isFinite(m.limitTics) ? m.limitTics : 0 });
      else
        [arena] = await Promise.all([
          createArena({ seed, limitTics: Number.isFinite(m.limitTics) ? m.limitTics : 0 }),
          prepareAI(),
        ]);
      reset(arena, seed, true);
      post({ type: 'ready' });
      run();
      return;
    }
    if (!arena) return;
    if (m.type === 'control') {
      Object.assign(keys, m.keys);
      return;
    }
    if (m.type === 'human') {
      if (!m.on && (!runtime || !policy)) {
        stop();
        await prepareAI();
        post({ type: 'ready' });
      }
      human = !!m.on;
      run();
      for (const k of Object.keys(keys) as (keyof HumanKeys)[]) keys[k] = false;
      return;
    }
    if (m.type === 'pause') {
      stop();
      post({ type: 'paused' });
    }
    if (m.type === 'resume') {
      run();
      post({ type: 'resumed' });
    }
    if (m.type === 'reset') {
      reset(arena, m.seed);
      post({ type: 'resumed' });
      run();
    }
  } catch (e) {
    stop();
    post({ type: 'error', message: errorText(e) });
  }
};
