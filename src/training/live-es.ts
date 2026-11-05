/** Parallel mirrored signed-code evolution on the complete released live policy (protocol 6).
 * Survival-first scalar utility, several antithetic pairs per generation, lane-parallel games.
 * Every game is a deterministic function of (recipe, seed, horizon); lanes only change wall-clock time. */
import { createArena, HUGGINGDOOM_RULESET, type ArenaState } from '../engine/arena.ts';
import {
  createKumoPolicy,
  type AssetBytes,
  type CoreDecision,
  type HeadOp,
  type KumoExports,
  type ReadModelAsset,
} from '../model/kumo.ts';
import { buildW4Controller } from '../policy/decision-policy.ts';
import type { ReleasedHead } from '../revisions/patch-codec.ts';
import { TRUST } from '../revisions/trust.ts';
import { sha256 } from '../shared/sha256.ts';
import { siteUrl } from '../shared/site.ts';
import { abortError } from '../shared/worker-scope.ts';
import type { Controller } from '../tactical/types.ts';

/** Utility weights in seconds-of-survival equivalents. Survival dominates; kills and ammo discipline break ties.
 * Protocol 3 adds bullets spent per kill, health-drop events per minute of game time, kills per minute and the share of decisions with an enemy in sight. */
export const UTILITY = Object.freeze({
  survivalSecond: 1,
  health: 0.08,
  kill: 0.4,
  hit: 0.04,
  miss: -0.04,
  blindDamage: -0.03,
  reactionTic: -0.01,
  exposureDecision: -0.005,
  ammoPerKill: -0.5,
  healthDropPerMinute: -0.1,
  killPerMinute: 0.02,
  sightFraction: 3,
});
/** Caps keep the rate terms bounded: at most 10 s for ammo per kill, 3 s for health drops per minute, 1.8 s for kills per minute.
 * The arena pistol holds 26 bullets that every game spends, so ammo per kill rewards kills per bullet; typical games sit near 1. */
export const RATES = Object.freeze({
  ammoPerKillCap: 20,
  healthDropsPerMinuteCap: 30,
  killsPerMinuteCap: 90,
  ticsPerMinute: 2100,
});
/** Kills-first weights: one kill is worth eight seconds of survival; the gates then compare kill counts instead of survival tics. */
export const UTILITY_KILLS = Object.freeze({
  survivalSecond: 0.25,
  health: 0.04,
  kill: 2,
  hit: 0.06,
  miss: -0.04,
  blindDamage: -0.02,
  reactionTic: -0.005,
  exposureDecision: -0.002,
  ammoPerKill: -0.5,
  healthDropPerMinute: -0.05,
  killPerMinute: 0.1,
  sightFraction: 3,
});

/** Utility weights; archived receipts may lack the protocol-3 rate terms, which then count as zero. */
export interface UtilityWeights {
  survivalSecond: number;
  health: number;
  kill: number;
  hit: number;
  miss: number;
  blindDamage: number;
  reactionTic: number;
  exposureDecision: number;
  ammoPerKill?: number;
  healthDropPerMinute?: number;
  killPerMinute?: number;
  sightFraction?: number;
}

export type PriorityName = 'survival' | 'kills';
/** The per-game metric a gate compares. */
export type Metric = 'tics' | 'kills';

/** Training priority chosen in the UI: the utility weights and the primary metric of every gate (`tics` or `kills`). */
export const PRIORITIES: Readonly<Record<PriorityName, Readonly<{ utility: UtilityWeights; primary: Metric }>>> =
  Object.freeze({
    survival: Object.freeze({ utility: UTILITY, primary: 'tics' }),
    kills: Object.freeze({ utility: UTILITY_KILLS, primary: 'kills' }),
  });
/** Reaction clock: damage taken without a visible enemy within closeRange starts a timer that stops when one appears. */
export const REACTION = Object.freeze({ closeRange: 240, capTics: 70 });
/** Exposure: a visible enemy inside biteRange whose facing is within facingDeg of the player. */
export const EXPOSURE = Object.freeze({ biteRange: 108, facingDeg: 32 });
/** Episode-length curriculum: validation episodes start at one minute (2,100 tics); once more than half of a generation's full
 * episodes survive to the cap, the next generation plays one minute longer. Needs an engine build with arena_set_limit. */
export const CURRICULUM = Object.freeze({
  minuteTics: 2100,
  minuteDecisions: 1050,
  startMinutes: 1,
  maxMinutes: 10,
  majority: 0.5,
});
/** Protocol 5 learning. `credit`: every mirrored pair's utility difference is credited to the codes it moved (the mirrored-ES gradient
 * estimate), together with the measured contribution of each promoted change; each generation adds one mirrored pair that steps the
 * best-credited codes in their credited direction. `attribution`: every promotion is explained by playing the winner without each change
 * group (knock-out) and the parent with only that group (knock-in) on the validation seeds. */
export const LEARNING = Object.freeze({ credit: true, attribution: true });
export const ATTRIBUTION = Object.freeze({ maxGroups: 12 });

/** A W4 policy relative to the immutable base: sorted native head edits plus the complete controller. */
export interface Recipe {
  ops: HeadOp[];
  tactical: Controller;
}

/** A record that can seed a recipe: a revision (`controller`) or an in-flight recipe (`tactical`). */
export interface RecipeSource {
  precision?: string;
  ops?: HeadOp[];
  tactical?: Controller | null;
  controller?: Controller | null;
}

/** Path of one signed controller code: `[matrix, row, column]`, or `['facing']`. */
export type SlotPath = readonly ['graft' | 'combat', number, number] | readonly ['facing'];

/** Outcome and observers of one deterministic game. */
export interface GameResult {
  role: string;
  seed: number;
  horizon: number;
  decisions: number;
  terminal: boolean;
  tics: number;
  limit: number;
  kills: number;
  health: number;
  hits: number;
  misses: number;
  shots: number;
  bulletHits: number;
  punches: number;
  punchHits: number;
  meleeDecisions: number;
  damageTaken: number;
  blindDamage: number;
  reactions: number;
  reactionTics: number;
  reactionMean: number;
  closeVisibleDecisions: number;
  exposureDecisions: number;
  ammoSpent: number;
  ammoPerKill: number;
  healthDrops: number;
  healthDropsPerMinute: number;
  killsPerMinute: number;
  visibleDecisions: number;
  sightFraction: number;
  retreatSteps: number;
  forwardSteps: number;
  travelDistance: number;
  /** FNV-1a over every issued command: two games with equal values made identical decisions. */
  commandFNV32: string;
}

/** The scoring fields `utility` reads; archived receipts may lack the protocol-3 observers. */
export type UtilityInput = Pick<GameResult, 'tics' | 'health' | 'kills' | 'hits' | 'misses'> &
  Partial<
    Pick<
      GameResult,
      | 'blindDamage'
      | 'reactionMean'
      | 'exposureDecisions'
      | 'ammoPerKill'
      | 'healthDropsPerMinute'
      | 'killsPerMinute'
      | 'sightFraction'
    >
  >;

/** One game to play: recipe, seed and horizon decide the result; the other fields label progress. */
export interface GameJob {
  recipe: Recipe;
  seed: number;
  horizon: number;
  round: number;
  phase: string;
  role: string;
  hidden?: boolean;
  group?: number;
}

export interface PlayedGame {
  result: GameResult;
  hidden: Float32Array | null;
}

/** Plays batches of games, in-process or over lane workers; results come back in job order. */
export interface GameRunner {
  readonly lanes: number;
  play(jobs: GameJob[]): Promise<PlayedGame[]>;
}

export interface TrainingCounts {
  games: number;
  decisions: number;
  cacheHits: number;
  backboneCalls: number;
  readoutCalls: number;
  promotions?: number;
}

/** A frame of the watched training game, posted at most every 125 ms. */
export type TrainingFrame = {
  type: 'frame';
  pixels: ArrayBuffer;
  width: number;
  height: number;
  round: number;
  phase: string;
  role: string;
  seed: number;
  lane: number;
  decisions: number;
  step: number;
  horizon: number;
  health: number;
  ammo: number;
  kills: number;
  tic: number;
  weapon: string;
  picnic?: ArenaState['picnic'];
};

/** Messages from the evaluation engine: progress records and, while watched, game frames. */
export type LiveMessage = { type: string; [field: string]: unknown };
export type Emit = (message: LiveMessage, transfer?: Transferable[]) => void;

/** Paired statistics of per-seed differences: mean, standard deviation, standard error and t (99 when every difference is equal and positive). */
export function pairedStats(d: number[]): { n: number; mean: number; sd: number; se: number; t: number } {
  const n = d.length,
    mean = n ? d.reduce((a, b) => a + b, 0) / n : 0,
    sd = n > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0,
    se = n ? sd / Math.sqrt(n) : 0;
  return { n, mean, sd, se, t: se > 0 ? mean / se : mean > 0 ? 99 : mean < 0 ? -99 : 0 };
}
const codeOK = (v: unknown) => Number.isInteger(v) && (v as number) >= -7 && (v as number) <= 7;
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : v;
const digest = (v: unknown) => sha256(new TextEncoder().encode(JSON.stringify(stable(v))));
export const recipeHash = (r: Recipe): Promise<string> => digest({ ops: r.ops, tactical: r.tactical });
/** Mulberry32: a deterministic uniform [0, 1) stream. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function boundedInt(n: number, lo: number, hi: number, label: string): number {
  if (!Number.isInteger(n) || n < lo || n > hi) throw new RangeError(label + ' out of bounds');
  return n;
}
export function streamSeed(master: number, index: number, validation: boolean): number {
  // A permutation modulo 2^28. Use low-order even/odd separation, not bits ignored by Doom's RNG.
  boundedInt(index, 0, 0xfffffff, 'seed index');
  return ((Math.imul((master + index) & 0xfffffff, 0x45d9f3b) >>> 0) & 0xfffffff) * 2 + Number(validation);
}
export function readSlot(tactical: Controller, path: SlotPath): number {
  return path.length === 1 ? tactical.facing.code : tactical[path[0]].codes[path[1]][path[2]];
}
export function writeSlot(tactical: Controller, path: SlotPath, value: number): void {
  if (path.length === 1) tactical.facing.code = value;
  else tactical[path[0]].codes[path[1]][path[2]] = value;
}
/** The 119 signed controller codes: 4 × 13 graft, 6 × 11 combat and the facing-guard code. */
export const SLOTS: readonly SlotPath[] = [
  ...Array.from({ length: 52 }, (_, i): SlotPath => ['graft', Math.floor(i / 13), i % 13]),
  ...Array.from({ length: 66 }, (_, i): SlotPath => ['combat', Math.floor(i / 11), i % 11]),
  ['facing'],
];
function validateTactical(tactical: Controller, stock: Controller): void {
  const restore = structuredClone(tactical);
  for (const path of SLOTS) {
    if (!codeOK(readSlot(restore, path))) throw new RangeError('Invalid signed controller slot ' + path.join('.'));
    writeSlot(restore, path, readSlot(stock, path));
  }
  if (JSON.stringify(stable(restore)) !== JSON.stringify(stable(stock)))
    throw new Error('Only the 119 native controller codes may vary');
}
function validateOps(input: unknown, head: ReleasedHead): HeadOp[] {
  if (!Array.isArray(input) || input.length > 3072) throw new Error('Expected up to 3072 native codes');
  const seen = new Set<number>();
  return input
    .map((op: unknown): HeadOp => {
      if (!Array.isArray(op) || op.length !== 4) throw new Error('Invalid native operation');
      const [r, j, old, next] = op as number[],
        i = r * 1024 + j;
      if (
        !Number.isInteger(r) ||
        r < 0 ||
        r > 2 ||
        !Number.isInteger(j) ||
        j < 0 ||
        j > 1023 ||
        head.codes[i] !== old ||
        !codeOK(next) ||
        old === next ||
        seen.has(i)
      )
        throw new Error('Invalid native coordinate ' + i);
      seen.add(i);
      return [...op] as HeadOp;
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
/** Validate a parent record (or the shipped composite) into an immutable-base-relative recipe. */
export function normalizeRecipe(
  parent: RecipeSource | null | undefined,
  head: ReleasedHead = TRUST.head,
  stock: Controller = TRUST.controller,
): Recipe {
  if (parent && (parent.precision === 'fp32' || !Array.isArray(parent.ops) || !(parent.tactical || parent.controller)))
    throw new Error('Live evolution requires a complete W4 parent, including its native edit table and controller');
  const ops = validateOps(parent?.ops ?? TRUST.edited, head);
  const tactical = structuredClone(parent?.tactical ?? parent?.controller ?? stock);
  validateTactical(tactical, stock);
  return { ops, tactical };
}
/** Set native code `i` to `n` in an edit map keyed by `row * 1024 + column`; the base code removes the edit. */
export function updateHead(map: Map<number, HeadOp>, head: ReleasedHead, i: number, n: number): void {
  if (n === head.codes[i]) map.delete(i);
  else map.set(i, [i >>> 10, i % 1024, head.codes[i], n]);
}
const byOps = (a: HeadOp, b: HeadOp) => a[0] - b[0] || a[1] - b[1];
const codeAt = (ops: HeadOp[], head: ReleasedHead) => {
  const m = new Map(ops.map((op) => [op[0] * 1024 + op[1], op[3]]));
  return (i: number) => m.get(i) ?? head.codes[i];
};

/** A set of codes that changed together; `coords` are native `[index, before, after]`, `slots` controller `[slot, before, after]`. */
export interface ChangeGroup {
  id: number;
  kind: 'native' | 'controller';
  row?: number;
  matrix?: string;
  coords: [number, number, number][];
  slots: [number, number, number][];
  size: number;
  columns?: [number, number];
}

/** Every code that differs between two recipes, grouped for attribution: each controller slot alone and native codes per output row
 * and 64-column scale group. Above `maxGroups`, native groups merge per row and then controller slots per matrix. */
export function changeGroups(
  from: Recipe,
  to: Recipe,
  head: ReleasedHead = TRUST.head,
  maxGroups: number = ATTRIBUTION.maxGroups,
): ChangeGroup[] {
  type Draft = Omit<ChangeGroup, 'id' | 'size' | 'columns'>;
  const a = codeAt(from.ops, head),
    b = codeAt(to.ops, head),
    native = new Map<number, Draft>();
  for (const i of [...new Set([...from.ops, ...to.ops].map((op) => op[0] * 1024 + op[1]))].sort((x, y) => x - y)) {
    const x = a(i),
      y = b(i);
    if (x === y) continue;
    const key = (i >>> 10) * 16 + ((i % 1024) >>> 6);
    let group = native.get(key);
    if (!group) native.set(key, (group = { kind: 'native', row: i >>> 10, coords: [], slots: [] }));
    group.coords.push([i, x, y]);
  }
  const controller: Draft[] = [];
  SLOTS.forEach((path, s) => {
    const x = readSlot(from.tactical, path),
      y = readSlot(to.tactical, path);
    if (x !== y) controller.push({ kind: 'controller', matrix: path[0], coords: [], slots: [[s, x, y]] });
  });
  let nativeGroups = [...native.values()],
    controllerGroups = controller;
  const merge = (list: Draft[], key: 'row' | 'matrix') => {
    const out = new Map<unknown, Draft>();
    for (const g of list) {
      const k = g[key];
      let merged = out.get(k);
      if (!merged) out.set(k, (merged = { ...g, coords: [], slots: [] }));
      merged.coords.push(...g.coords);
      merged.slots.push(...g.slots);
    }
    return [...out.values()];
  };
  if (nativeGroups.length + controllerGroups.length > maxGroups) nativeGroups = merge(nativeGroups, 'row');
  if (nativeGroups.length + controllerGroups.length > maxGroups) controllerGroups = merge(controllerGroups, 'matrix');
  return [...controllerGroups, ...nativeGroups].map((g, id) => ({
    id,
    ...g,
    size: g.coords.length + g.slots.length,
    ...(g.coords.length
      ? { columns: [g.coords[0][0] % 1024, g.coords[g.coords.length - 1][0] % 1024] as [number, number] }
      : {}),
  }));
}
/** Set one change group to its `after` (knock-in) or `before` (knock-out) codes. */
export function applyGroup(
  recipe: Recipe,
  group: Pick<ChangeGroup, 'coords' | 'slots'>,
  direction: 'before' | 'after',
  head: ReleasedHead = TRUST.head,
): Recipe {
  const m = new Map(recipe.ops.map((op) => [op[0] * 1024 + op[1], op])),
    tactical = structuredClone(recipe.tactical);
  for (const [i, x, y] of group.coords) updateHead(m, head, i, direction === 'after' ? y : x);
  for (const [s, x, y] of group.slots) writeSlot(tactical, SLOTS[s], direction === 'after' ? y : x);
  return { ops: [...m.values()].sort(byOps), tactical };
}

export interface Totals {
  survival: number;
  kills: number;
  utility: number;
}

const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);
const totals = (rs: UtilityInput[], w: UtilityWeights): Totals => ({
  survival: sum(rs, (r) => r.tics),
  kills: sum(rs, (r) => r.kills),
  utility: sum(rs, (r) => utility(r, w)),
});
const deltaOf = (a: Totals, b: Totals): Totals => ({
  survival: a.survival - b.survival,
  kills: a.kills - b.kills,
  utility: a.utility - b.utility,
});
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function perSeed(better: UtilityInput[], worse: UtilityInput[], w: UtilityWeights) {
  let up = 0,
    down = 0;
  const du: number[] = [],
    dt: number[] = [];
  better.forEach((r, i) => {
    const d = utility(r, w) - utility(worse[i], w);
    du.push(d);
    dt.push(r.tics - worse[i].tics);
    if (d > 0) up++;
    else if (d < 0) down++;
  });
  // Standard errors of the summed differences (n·SE of the mean); |t| ≥ 2 marks a contribution that stands out from seed noise.
  const u = pairedStats(du),
    s = pairedStats(dt);
  return {
    better: up,
    worse: down,
    same: better.length - up - down,
    seUtility: r3(u.se * u.n),
    seSurvival: r3(s.se * s.n),
    t: r3(u.t),
  };
}

export type SeedComparison = ReturnType<typeof perSeed>;

export interface AttributedGroup extends ChangeGroup {
  knockOut: Totals & SeedComparison;
  knockIn: Totals & SeedComparison;
}

export interface Attribution {
  seeds: number[];
  horizon: number;
  games: number;
  parent: Totals;
  child: Totals;
  gain: Totals;
  sumKnockIn: number;
  sumKnockOut: number;
  interaction: number;
  groups: AttributedGroup[];
}

export interface AttributionRequest {
  play: (jobs: GameJob[]) => Promise<PlayedGame[]>;
  parent: Recipe;
  child: Recipe;
  seeds: number[];
  horizon: number;
  head?: ReleasedHead;
  w?: UtilityWeights;
  parentResults?: GameResult[];
  childResults?: GameResult[];
  round?: number;
  maxGroups?: number;
}

/** Which change caused the improvement? Knock-out: the child without one group (its contribution in context). Knock-in: the parent with
 * only that group (its effect alone). Both on the same seeds and horizon; `interaction` is the gain that no single group explains alone. */
export async function attributeChange({
  play,
  parent,
  child,
  seeds,
  horizon,
  head = TRUST.head,
  w = UTILITY,
  parentResults,
  childResults,
  round = 0,
  maxGroups = ATTRIBUTION.maxGroups,
}: AttributionRequest): Promise<Attribution> {
  const groups = changeGroups(parent, child, head, maxGroups),
    jobs: GameJob[] = [];
  const job = (recipe: Recipe, seed: number, role: string, group: number): GameJob => ({
    recipe,
    seed,
    horizon,
    round,
    phase: 'attribution',
    role,
    group,
  });
  if (!parentResults) for (const s of seeds) jobs.push(job(parent, s, 'parent', -1));
  if (!childResults) for (const s of seeds) jobs.push(job(child, s, 'child', -1));
  if (groups.length > 1)
    for (const g of groups) {
      const out = applyGroup(child, g, 'before', head),
        only = applyGroup(parent, g, 'after', head);
      for (const s of seeds) {
        jobs.push(job(out, s, 'knock-out', g.id));
        jobs.push(job(only, s, 'knock-in', g.id));
      }
    }
  const played = jobs.length ? await play(jobs) : [],
    results = (role: string, group: number) =>
      jobs
        .map((j, i) => (j.role === role && j.group === group ? played[i].result : null))
        .filter((r): r is GameResult => !!r);
  const before = parentResults ?? results('parent', -1),
    after = childResults ?? results('child', -1);
  const P = totals(before, w),
    C = totals(after, w);
  const rows = groups.map((g) => {
    const out = groups.length > 1 ? results('knock-out', g.id) : before,
      only = groups.length > 1 ? results('knock-in', g.id) : after;
    return {
      ...g,
      knockOut: { ...deltaOf(C, totals(out, w)), ...perSeed(after, out, w) },
      knockIn: { ...deltaOf(totals(only, w), P), ...perSeed(only, before, w) },
    };
  });
  const gain = deltaOf(C, P),
    alone = rows.reduce((a, r) => a + r.knockIn.utility, 0),
    needed = rows.reduce((a, r) => a + r.knockOut.utility, 0);
  return {
    seeds,
    horizon,
    games: jobs.length,
    parent: P,
    child: C,
    gain,
    sumKnockIn: alone,
    sumKnockOut: needed,
    interaction: gain.utility - alone,
    groups: rows,
  };
}
export function promotion(
  search: { noRegression: boolean; strict: boolean },
  validation: { noRegression: boolean; strict: boolean }[],
): boolean {
  return (
    search.noRegression &&
    search.strict &&
    validation.length === 2 &&
    validation.every((x) => x.noRegression) &&
    validation.some((x) => x.strict)
  );
}
/* Protocol 2 scoring. */
/** Scalar utility of one game. Older receipts replay with their archived weights, whose missing rate terms count as zero. */
export function utility(r: UtilityInput, w: UtilityWeights = UTILITY): number {
  return (
    (w.survivalSecond * r.tics) / 35 +
    w.health * Math.max(0, r.health) +
    w.kill * r.kills +
    w.hit * r.hits +
    w.miss * r.misses +
    w.blindDamage * (r.blindDamage ?? 0) +
    w.reactionTic * (r.reactionMean ?? 0) +
    w.exposureDecision * (r.exposureDecisions ?? 0) +
    (w.ammoPerKill ?? 0) * Math.min(RATES.ammoPerKillCap, r.ammoPerKill ?? 0) +
    (w.healthDropPerMinute ?? 0) * Math.min(RATES.healthDropsPerMinuteCap, r.healthDropsPerMinute ?? 0) +
    (w.killPerMinute ?? 0) * Math.min(RATES.killsPerMinuteCap, r.killsPerMinute ?? 0) +
    (w.sightFraction ?? 0) * (r.sightFraction ?? 0)
  );
}
export function promoted(
  search: { eligible?: boolean } | null | undefined,
  validation: { passed?: boolean } | null | undefined,
  lineage?: { passed?: boolean },
): boolean {
  return !!search?.eligible && !!validation?.passed && (lineage === undefined || !!lineage.passed);
}

export interface CurriculumStep {
  minutes: number;
  complete: number;
  capped: number;
  honoured: boolean;
  nextMinutes: number;
}

/** Curriculum step: more than half of the generation's complete episodes survived to the cap, and every game ran on a build that honours the cap. */
export function curriculumStep(
  minutes: number,
  games: Pick<GameResult, 'terminal' | 'health' | 'tics' | 'limit'>[],
): CurriculumStep {
  const complete = games.filter((g) => g.terminal),
    capped = complete.filter((g) => g.health > 0 && g.tics >= minutes * CURRICULUM.minuteTics);
  const honoured = complete.every((g) => (g.limit ?? CURRICULUM.minuteTics) >= minutes * CURRICULUM.minuteTics);
  const next =
    honoured && complete.length && capped.length > CURRICULUM.majority * complete.length
      ? Math.min(CURRICULUM.maxMinutes, minutes + 1)
      : minutes;
  return { minutes, complete: complete.length, capped: capped.length, honoured, nextMinutes: next };
}

export interface LiveESOptions {
  /** Site root holding `model/` and `engine/`. */
  root?: URL;
  emit?: Emit;
  watch?: () => boolean;
  stop?: () => boolean;
  yieldTask?: () => Promise<void>;
  readAsset?: ReadModelAsset;
  /** Prefetched model and engine files by name; lanes receive these instead of downloading again. */
  assets?: Map<string, AssetBytes>;
  lane?: number;
}

export interface LiveES {
  normalized(parent: RecipeSource | null | undefined): Recipe;
  validateCache(row: Float32Array, ops: HeadOp[]): CoreDecision;
  game(
    recipe: Recipe,
    seed: number,
    horizon: number,
    round: number,
    phase: string,
    role: string,
    options?: { hidden?: boolean },
  ): Promise<GameResult>;
  lastHidden(): Float32Array | null;
  localRunner: GameRunner;
  counts: TrainingCounts;
  dispose(): void;
}

interface CacheEntry {
  h: Float32Array;
  core: CoreDecision;
  headKey: number;
}

export async function openLiveES({
  root = siteUrl(''),
  emit = () => {},
  watch = () => false,
  stop = () => false,
  yieldTask = async () => {},
  readAsset,
  assets,
  lane = 0,
}: LiveESOptions = {}): Promise<LiveES> {
  const modelBase = new URL('model/', root),
    engineBase = new URL('engine/', root);
  const head = TRUST.head,
    stock = TRUST.controller;
  const provide = async (name: string): Promise<AssetBytes | null> => {
    const held = assets?.get(name);
    if (held != null) return held;
    return (await readAsset?.(name)) ?? null;
  };
  const bytes = async (base: URL, name: string): Promise<Uint8Array> => {
    const held = await provide(name);
    if (held != null)
      return held instanceof Uint8Array ? held : new Uint8Array(held instanceof Blob ? await held.arrayBuffer() : held);
    const resp = await fetch(new URL(name, base));
    if (!resp.ok) throw new Error('Could not load ' + name);
    return new Uint8Array(await resp.arrayBuffer());
  };
  // A private SIMD instance whose `hidden_ptr` the readout cache reads directly.
  let api: Required<KumoExports> | null = null;
  const runtime = {
    dispose() {
      api = null;
    },
    instantiate: async () => {
      const instance = await WebAssembly.instantiate(
        (await bytes(modelBase, 'policy-simd.wasm')) as Uint8Array<ArrayBuffer>,
        {
          math: { sin: Math.sin, cos: Math.cos, exp: Math.exp, tanh: Math.tanh },
        },
      );
      api = instance.instance.exports as unknown as Required<KumoExports>;
      return api;
    },
  };
  const [policy, arena] = await Promise.all([
    createKumoPolicy({ baseURL: modelBase, runtime, precision: 'w4', readAsset: provide }),
    createArena({ assetBase: engineBase, seed: 0, readAsset: (name) => bytes(engineBase, name) }),
  ]);
  if (arena.ruleset() !== HUGGINGDOOM_RULESET)
    throw new Error('HuggingDOOM engine required; refresh cached game assets before training.');
  const instance = api as Required<KumoExports> | null;
  if (!instance) throw new Error('Policy WASM did not instantiate');
  const bridge = policy.gpuBridge(),
    h = new Float32Array(instance.memory.buffer, instance.hidden_ptr(), 1024),
    cache = new Map<string, CacheEntry>(),
    maxEntries = 8192;
  const counts: TrainingCounts = {
      games: 0,
      decisions: 0,
      cacheHits: 0,
      backboneCalls: 0,
      readoutCalls: 0,
      promotions: 0,
    },
    cacheKey = (f: Float32Array) => String.fromCharCode(...new Uint16Array(f.buffer, f.byteOffset, 28));
  const headIds = new WeakMap<HeadOp[], number>();
  let nextHeadId = 0,
    active = -1,
    sampleHidden: Float32Array | null = null,
    hiddenMean: Float32Array | null = null,
    lastFrame = -Infinity,
    lastProgress = -Infinity;
  function setHead(ops: HeadOp[]): number {
    let id = headIds.get(ops);
    if (id === undefined) {
      id = ++nextHeadId;
      headIds.set(ops, id);
    }
    if (id !== active) {
      policy.setHeadPatch(ops);
      active = id;
    }
    return id;
  }
  /** The backbone output depends only on the features, so it is cached; a head change only reruns the readout. */
  function coreFor(f: Float32Array, headKey: number): CoreDecision {
    const key = cacheKey(f);
    let entry = cache.get(key);
    if (!entry) {
      const core = policy.infer(f, 'custom');
      counts.backboneCalls++;
      entry = { h: h.slice(), core, headKey };
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
      cache.set(key, entry);
    } else {
      counts.cacheHits++;
      cache.delete(key);
      cache.set(key, entry);
      if (entry.headKey !== headKey) {
        entry.core = bridge.decode(entry.h, 'custom');
        entry.headKey = headKey;
        counts.readoutCalls++;
      }
    }
    sampleHidden = entry.h;
    return entry.core;
  }
  const record = (round: number, phase: string, message: string, other: Record<string, unknown> = {}) =>
    emit({ type: 'progress', round, phase, message, lane, ...counts, ...other });
  const minFacingCos = Math.cos((EXPOSURE.facingDeg * Math.PI) / 180);
  function checkStop(): void {
    if (stop()) throw abortError();
  }
  const normalized = (parent: RecipeSource | null | undefined) => normalizeRecipe(parent, head, stock);
  /** One deterministic game. Survival observers: unseen-threat damage and the damage-to-visible-threat reaction clock. */
  async function game(
    recipe: Recipe,
    seed: number,
    horizon: number,
    round: number,
    phase: string,
    role: string,
    { hidden = false }: { hidden?: boolean } = {},
  ): Promise<GameResult> {
    checkStop();
    const headKey = setHead(recipe.ops);
    const controller = buildW4Controller(recipe.tactical, 'custom');
    controller.reset();
    // The engine cap follows the horizon: one minute for search games, the curriculum's minutes for complete episodes.
    arena.setLimit(Math.max(CURRICULUM.minuteTics, 2 * horizon));
    let state = arena.reset(seed),
      n = 0,
      capture = 2166136261,
      melee = 0,
      blindDamage = 0,
      reactions = 0,
      reactionTics = 0,
      pendingSince = -1,
      closeVisibleDecisions = 0,
      exposureDecisions = 0,
      healthDrops = 0,
      visibleDecisions = 0;
    const hiddenSum = hidden ? new Float64Array(1024) : null;
    hiddenMean = null;
    while (n < horizon && !state.done && !state.picnic?.ending) {
      const core = coreFor(state.features, headKey);
      if (hiddenSum && sampleHidden) for (let i = 0; i < 1024; i++) hiddenSum[i] += sampleHidden[i];
      const d = controller.decide(state, core);
      const command = d.action | (+!!d.backward << 2) | (+!!d.forward << 3);
      capture = Math.imul(capture ^ command, 16777619) >>> 0;
      melee += Number(state.weapon === 'fist');
      const sawClose = state.threat.visible && state.threat.distance <= REACTION.closeRange;
      closeVisibleDecisions += Number(sawClose);
      visibleDecisions += Number(!!state.threat.visible);
      if (sawClose && state.actors.some((a) => a.distance <= EXPOSURE.biteRange && a.facingCos >= minFacingCos))
        exposureDecisions++;
      state = arena.step(d.action, !!d.backward, !!d.forward);
      n++;
      counts.decisions++;
      const close = state.threat.visible && state.threat.distance <= REACTION.closeRange;
      if (pendingSince >= 0) {
        if (close) {
          reactionTics += state.tic - pendingSince;
          pendingSince = -1;
        } else if (state.tic - pendingSince >= REACTION.capTics) {
          reactionTics += REACTION.capTics;
          pendingSince = -1;
        }
      }
      const damage = state.events.damage;
      if (damage > 0) {
        healthDrops++;
        if (!sawClose) blindDamage += damage;
        if (!close && pendingSince < 0) {
          reactions++;
          pendingSince = state.tic;
        }
      }
      const now = performance.now();
      if (watch() && now - lastFrame >= 125) {
        const pixels = arena.frame().slice().buffer;
        const frame: TrainingFrame = {
          type: 'frame',
          pixels,
          width: arena.width,
          height: arena.height,
          round,
          phase,
          role,
          seed,
          lane,
          decisions: counts.decisions,
          step: n,
          horizon,
          health: state.health,
          ammo: state.ammo,
          kills: state.kills,
          tic: state.tic,
          weapon: state.weapon,
          picnic: state.picnic,
        };
        emit(frame, [pixels]);
        lastFrame = now;
      }
      if (now - lastProgress >= 500) {
        record(round, phase, 'Playing ' + role + ' on seed ' + seed, {
          role,
          seed,
          step: n,
          horizon,
          kills: state.kills,
          health: state.health,
        });
        lastProgress = now;
      }
      if (n % 8 === 0) {
        await yieldTask();
        checkStop();
      }
    }
    // The emergency-honey finale is presentation, not additional survival or policy experience.
    const activeTics = state.picnic?.activeTics ?? state.tic;
    if (pendingSince >= 0) reactionTics += Math.min(REACTION.capTics, activeTics - pendingSince);
    if (hiddenSum) {
      hiddenMean = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) hiddenMean[i] = hiddenSum[i] / Math.max(1, n);
    }
    const t = state.telemetry;
    counts.games++;
    // Rate observers: the pistol spends one bullet per shot; a health drop is a decision step in which damage landed.
    const minutes = Math.max(1, activeTics) / RATES.ticsPerMinute;
    return {
      role,
      seed,
      horizon,
      decisions: n,
      terminal: state.done || !!state.picnic?.ending,
      tics: activeTics,
      limit: state.limit ?? CURRICULUM.minuteTics,
      kills: state.kills,
      health: state.health,
      hits: t.hits + t.punchHits,
      misses: t.shots - t.hits + t.punchMisses,
      shots: t.shots,
      bulletHits: t.hits,
      punches: t.punches,
      punchHits: t.punchHits,
      meleeDecisions: melee,
      damageTaken: t.damageTaken,
      blindDamage,
      reactions,
      reactionTics,
      reactionMean: reactions ? reactionTics / reactions : 0,
      closeVisibleDecisions,
      exposureDecisions,
      ammoSpent: t.shots,
      ammoPerKill: t.shots / Math.max(1, state.kills),
      healthDrops,
      healthDropsPerMinute: healthDrops / minutes,
      killsPerMinute: state.kills / minutes,
      visibleDecisions,
      sightFraction: visibleDecisions / Math.max(1, n),
      retreatSteps: t.retreatSteps,
      forwardSteps: t.forwardSteps,
      travelDistance: t.travelDistance,
      commandFNV32: capture.toString(16).padStart(8, '0'),
    };
  }
  const lastHidden = () => hiddenMean;
  function validateCache(row: Float32Array, ops: HeadOp[]): CoreDecision {
    const key = setHead(ops),
      a = coreFor(row, key),
      b = policy.infer(row, 'custom');
    if (!a.logits.every((v, i) => Object.is(v, b.logits[i])) || a.action !== b.action)
      throw new Error('Cached readout failed full-inference parity');
    return b;
  }
  const localRunner: GameRunner = {
    get lanes() {
      return 1;
    },
    async play(jobs) {
      const out: PlayedGame[] = [];
      for (const j of jobs) {
        const result = await game(j.recipe, j.seed, j.horizon, j.round, j.phase, j.role, { hidden: !!j.hidden });
        out.push({ result, hidden: j.hidden ? lastHidden() : null });
      }
      return out;
    },
  };
  return {
    normalized,
    validateCache,
    game,
    lastHidden,
    localRunner,
    counts,
    dispose: () => {
      cache.clear();
      policy.dispose();
    },
  };
}
