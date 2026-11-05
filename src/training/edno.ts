/** Evolutionary Direct Neural Optimization.
 *
 * The parameters of the released W4 policy are edited directly, on CPU, by an evolution strategy whose objective (the utility
 * metrics) was designed agentically. The method is generic over parameter tensors:
 * - Parameter blocks: every controller parameter is its own block; native classifier parameters move in blocks that share one
 *   four-bit scale group (64 columns of one output row).
 * - One small mirrored change per game: each direction perturbs a sample of blocks by ±level and is played plus and minus on its
 *   own fresh seed. Every game contributes evidence; no single arm is "picked".
 * - Evidence per block: the antithetic half-difference of each game pair is credited to every block it moved (the mirrored-ES
 *   gradient estimate). A candidate steps only blocks whose accumulated evidence reaches t ≥ propose.t.
 * - Selection `race` (default): whole mirrored directions compete. The better arm of each pair is ranked by its half-difference; the
 *   best finalists play shared screening seeds against the parent and the leaders play more (successive halving). Crossing ("Kreuzen")
 *   fuses the changes of the best finalists into one more candidate: agreeing moves are kept, opposing moves cancel. The race ranks by
 *   the primary metric of the priority (survival time or kills), the metric validation tests, and the final choice uses only the last
 *   screening seeds, which played no part in picking the leaders. Selection `evidence`
 *   instead steps the blocks whose accumulated evidence reaches t ≥ propose.t.
 * - Racing validation on fresh seeds (batches of 16 up to 64), paired t-test on the primary metric, then lineage anchors.
 * - Control goal: the other metric (kills under survival priority, survival time under kills priority) must not fall behind the
 *   parent by guard.t standard errors, in the race and in validation. Without it, survival-first search found a policy that stops
 *   fighting and outlives every game with zero kills.
 * - Selection `adaptive` switches strategy per generation: a discounted Thompson-sampling bandit over arms (selection × mutation)
 *   picks the arm with the best sampled promotion chance per game played; every arm shares the block evidence.
 * - Mutation selection: `auto` weights blocks by coverage (untried first, blocks that never change a game last) and widens the
 *   perturbation when the search stagnates; `uniform` and `broad` are fixed alternatives for comparison.
 * - Selection `race-prune` ("Rennen + Bereinigen"): race selection; after a validated promotion the change is attributed (knock-out
 *   and knock-in of each change group on the validation seeds), and a pruned child with only the groups whose knock-out costs utility
 *   by t ≥ prune.t faces the full validation and anchors on its own fresh seeds. It is promoted instead of the full child only if it
 *   passes; otherwise the full child is promoted. Big broad steps carry many neutral passengers; pruning drops them.
 * - Optional ties: a declared task prior (here: left/right mirror symmetry of the controller) moves tied blocks together.
 * - Kept candidates and the final round: the run keeps the final.keep candidates with the strongest paired evidence over the parent
 *   (race leaders on their last seeds, validated candidates that fell short of the gate). When the user finishes a run, the kept
 *   candidates and the parent play shared fresh seeds; the best one by the primary metric (control goal kept) then faces the same
 *   racing validation and lineage anchors as any generation. Only a candidate that passes is promoted. */
import type { HeadOp } from '../model/kumo.ts';
import type { ReleasedHead } from '../revisions/patch-codec.ts';
import { TRUST } from '../revisions/trust.ts';
import type { Controller } from '../tactical/types.ts';
import {
  SLOTS,
  readSlot,
  writeSlot,
  updateHead,
  utility,
  pairedStats,
  streamSeed,
  rng,
  normalizeRecipe,
  recipeHash,
  PRIORITIES,
  CURRICULUM,
  curriculumStep,
  attributeChange,
  applyGroup,
  type AttributedGroup,
  type Attribution,
  type CurriculumStep,
  type GameJob,
  type GameResult,
  type GameRunner,
  type Metric,
  type PriorityName,
  type Recipe,
  type TrainingCounts,
  type UtilityWeights,
} from './live-es.ts';

/** Mutation modes (`EDNO.modes`). */
export type EdnoMode = 'auto' | 'uniform' | 'broad';
/** Mutation settings of a mode: blocks per direction (`density`, grown by `grow` up to `maxDensity` on stagnation when `adaptive`), the
 * step `level` (raised up to `maxLevel` once the density is at its maximum) and whether block sampling is weighted by coverage. */
export interface EdnoModeConfig {
  readonly density: number;
  readonly maxDensity: number;
  readonly grow: number;
  readonly level: number;
  readonly maxLevel: number;
  readonly coverage: boolean;
  readonly adaptive: boolean;
}

export const EDNO_PROTOCOL = 'agm.dnp.edno/7';
export const EDNO = Object.freeze({
  blockSize: 64,
  directions: 48,
  modes: Object.freeze<Record<EdnoMode, EdnoModeConfig>>({
    auto: Object.freeze({
      density: 0.15,
      maxDensity: 0.6,
      grow: 1.5,
      level: 1,
      maxLevel: 2,
      coverage: true,
      adaptive: true,
    }),
    uniform: Object.freeze({
      density: 0.15,
      maxDensity: 0.15,
      grow: 1,
      level: 1,
      maxLevel: 1,
      coverage: false,
      adaptive: false,
    }),
    broad: Object.freeze({
      density: 0.5,
      maxDensity: 0.5,
      grow: 1,
      level: 2,
      maxLevel: 2,
      coverage: false,
      adaptive: false,
    }),
  }),
  inertPenalty: 4,
  stagnation: 4,
  propose: Object.freeze({ t: 2, minSamples: 8, maxBlocks: 24 }),
  selections: Object.freeze(['race', 'evidence', 'adaptive', 'race-prune'] as const),
  adaptive: Object.freeze({
    arms: Object.freeze([
      Object.freeze({ selection: 'race', mode: 'broad' }),
      Object.freeze({ selection: 'evidence', mode: 'auto' }),
      Object.freeze({ selection: 'race', mode: 'auto' }),
    ]),
    discount: 0.8,
    costPrior: 300,
  }),
  race: Object.freeze({ finalists: 8, seeds: 8, last: 2, lastSeeds: 16, cross: 3 }),
  validation: Object.freeze({ batch: 16, max: 64, early: 3, earlyAfter: 32, reject: -1, t: 2 }),
  guard: Object.freeze({ t: -2 }),
  attributionSeeds: 16,
  final: Object.freeze({ keep: 3, seeds: 16 }),
  // Selection `race-prune`: after a validated promotion, keep only the change groups whose knock-out costs utility by t ≥ prune.t.
  prune: Object.freeze({ t: 2 }),
});
/** Selection strategies (`EDNO.selections`). */
export type EdnoSelection = (typeof EDNO.selections)[number];
/** Whether a free string names a mutation mode (an own key of `EDNO.modes`), so that `EDNO.modes[name]` type-checks. */
export function isEdnoMode(name: string): name is EdnoMode {
  return Object.hasOwn(EDNO.modes, name);
}
/** Whether a free string is one of `EDNO.selections`. */
export function isEdnoSelection(name: string): name is EdnoSelection {
  const names: readonly string[] = EDNO.selections;
  return names.includes(name);
}

/** One controller code, moved alone. */
export interface ControllerBlock {
  id: number;
  kind: 'controller';
  slot: number;
  size: 1;
}
/** `size` native columns of one output row, starting at `first`, that share one four-bit scale group. */
export interface NativeBlock {
  id: number;
  kind: 'native';
  row: number;
  first: number;
  size: number;
}
export type ParameterBlock = ControllerBlock | NativeBlock;
/** A signed move of one parameter block: `[block id, levels]`. */
export type BlockMove = [id: number, delta: number];

/** A game job labelled with the search direction, race entry or kept candidate it plays. */
export interface EdnoJob extends GameJob {
  direction?: number | 'cross';
}
/** The receipt form of one game. */
export interface EdnoGame {
  seed: number;
  tics: number;
  kills: number;
  health: number;
  utility: number;
  fnv: string;
  terminal: boolean;
  horizon: number;
  limit: number;
}
/** Paired statistics of per-seed differences, rounded for the receipt. */
export interface EdnoStats {
  n: number;
  mean: number;
  se: number;
  t: number;
}
export type EdnoValidationStage = 'racing' | 'rejected-early' | 'rejected-control' | 'accepted-early';
/** A lineage anchor played on the validation seeds; the candidate must beat it on the primary metric and on utility. */
export interface EdnoAnchorCheck {
  label: string;
  hash: string;
  primary: number;
  utility: number;
  candidatePrimary: number;
  candidateUtility: number;
  beaten: boolean;
  results: EdnoGame[];
}
/** Racing validation of a candidate against the parent: primary metric, control goal, utility gain and lineage anchors. */
export interface EdnoValidation {
  stage: EdnoValidationStage;
  games: number;
  stats: EdnoStats;
  control: EdnoStats & { metric: Metric };
  utilityGain: number;
  parent: EdnoGame[];
  candidate: EdnoGame[];
  anchors: EdnoAnchorCheck[];
  passed: boolean;
}
/** Both arms of one mirrored direction, the half utility difference per level and whether both arms made identical decisions. */
export interface EdnoDirectionResult {
  plus: EdnoGame;
  minus: EdnoGame;
  half: number;
  same: boolean;
}
export interface EdnoDirectionRecord extends EdnoDirectionResult {
  seed: number;
  moves: BlockMove[];
}
/** Accumulated evidence of one block: `[block id, samples, mean, t]`. */
export type EdnoEvidenceRow = [id: number, n: number, mean: number, t: number];
/** The bandit's choice of a generation (selection `adaptive`): sampled scores and `[a, b, games per generation]` per arm. */
export interface EdnoStrategy {
  arm: number;
  /** The arm's selection (`race` or `evidence`). */
  selection: string;
  mode: EdnoMode;
  draws: number[];
  posterior: [a: number, b: number, games: number][];
  /** Games the generation played; set once the generation ends. */
  games?: number;
}
/** Race statistics of an entry against the parent on a range of seeds: the primary metric (`mean`, `t`, `n`), the mean utility
 * difference and the control goal. */
export interface EdnoRaceStat {
  mean: number;
  t: number;
  n: number;
  utility: number;
  control: number;
  controlT: number;
}
export interface EdnoRaceEntryBase {
  hash: string;
  primary: number[];
  control: number[];
  utilities: number[];
  /** Statistics on the shared screening seeds (finalists). */
  screening?: EdnoRaceStat;
  /** Statistics on the last, fresh seeds (leaders and their cross). */
  final?: EdnoRaceStat;
}
/** The better arm (`sign`) of a mirrored search direction. */
export interface EdnoRaceDirection extends EdnoRaceEntryBase {
  direction: number;
  sign: 1 | -1;
  screen: number;
  parts?: undefined;
}
/** The crossing of the best finalists: `[direction, sign]` per part and the fused moves. */
export interface EdnoRaceCross extends EdnoRaceEntryBase {
  direction: 'cross';
  parts: [direction: number, sign: 1 | -1][];
  moves: BlockMove[];
  sign?: undefined;
}
export type EdnoRaceEntry = EdnoRaceDirection | EdnoRaceCross;
export interface EdnoRace {
  seeds: number[];
  metric: Metric;
  controlMetric: Metric;
  parent: number[];
  parentControl: number[];
  parentUtilities: number[];
  finalists: EdnoRaceDirection[];
  last: EdnoRaceEntry[];
  chosen: number | 'cross' | null;
}
export interface EdnoProposalRace {
  direction: number | 'cross';
  sign: 1 | -1 | null;
  parts: [direction: number, sign: 1 | -1][] | null;
  mean: number;
  t: number;
  seeds: number;
}
/** The candidate of a generation: block evidence (selection `evidence`) or the race winner. */
export interface EdnoProposal {
  moves: BlockMove[];
  hash: string;
  evidence?: EdnoEvidenceRow[];
  race?: EdnoProposalRace;
}
export interface EdnoPruneGroup {
  id: number;
  kind: 'native' | 'controller';
  label: string;
  size: number;
  knockOutT: number;
}
/** Selection `race-prune`: the change groups kept and dropped, and the validation of the pruned child. */
export interface EdnoPrune {
  t: number;
  kept: EdnoPruneGroup[];
  dropped: EdnoPruneGroup[];
  applied: boolean;
  fullHash: string;
  reason?: string;
  prunedHash?: string;
  /** The failed validation of the pruned child. */
  validation?: EdnoValidation;
  validationSeeds?: number[];
  /** The full child's validation, replaced by the pruned child's. */
  full?: { hash: string; validationSeeds: number[]; validation: EdnoValidation | null };
}
/** A candidate kept for the final round, with its latest paired evidence over the parent. */
export interface EdnoKeptCandidate {
  hash: string;
  moves: BlockMove[];
  generation: number;
  source: 'race' | 'validation';
  direction?: number | 'cross';
  mean: number;
  t: number;
  n: number;
  minutes: number;
}
/** A kept candidate as progress records report it. */
export type EdnoKeptSummary = Omit<EdnoKeptCandidate, 'moves'> & { blocks: number };
export type EdnoStatus = 'retained' | 'promoted';
/** The receipt of one generation, passed to `onRound` when the generation ends. A winner event carries a copy taken at promotion,
 * before `nextDensity`, `nextLevel` and `reason` are set. */
export interface EdnoRoundReceipt {
  protocol: typeof EDNO_PROTOCOL;
  /** Generation receipts carry no kind; final-round receipts have kind `final`. */
  kind?: undefined;
  searchSeed: number;
  round: number;
  parentId: string;
  parentHash: string;
  lanes: number;
  priority: PriorityName;
  utility: UtilityWeights;
  primary: Metric;
  mode: string;
  selection: string;
  strategy: EdnoStrategy | null;
  ties: boolean;
  density: number;
  level: number;
  blocks: number;
  minutes: number;
  horizon: number;
  searchSeeds: number[];
  directions: EdnoDirectionRecord[];
  evidenceTop: EdnoEvidenceRow[];
  race: EdnoRace | null;
  proposal: EdnoProposal | null;
  validationSeeds: number[];
  validation: EdnoValidation | null;
  status: EdnoStatus;
  rollbackHash: string;
  curriculum?: CurriculumStep;
  attribution?: Attribution;
  prune?: EdnoPrune;
  winnerHash?: string;
  winnerId?: string;
  nextDensity?: number;
  nextLevel?: number;
  reason?: string;
}
export interface EdnoFinalScore {
  index: number;
  hash: string;
  primary: number;
  mean: number;
  t: number;
  n: number;
  control: number;
  controlT: number;
  results: EdnoGame[];
}
/** The kept candidates and the parent on the shared selection seeds of the final round. */
export interface EdnoFinalSelection {
  seeds: number[];
  parent: EdnoGame[];
  parentPrimary: number;
  scores: EdnoFinalScore[];
  chosen: number | null;
}
export interface EdnoFinalProposal {
  moves: BlockMove[];
  hash: string;
  kept: number;
  source: 'race' | 'validation';
  generation: number;
}
/** The receipt of the final round after a finish request. */
export interface EdnoFinalReceipt {
  protocol: typeof FINAL_PROTOCOL;
  kind: 'final';
  searchSeed: number;
  round: number;
  parentId: string;
  parentHash: string;
  lanes: number;
  priority: PriorityName;
  utility: UtilityWeights;
  primary: Metric;
  minutes: number;
  horizon: number;
  candidates: EdnoKeptCandidate[];
  selection: EdnoFinalSelection | null;
  validationSeeds: number[];
  validation: EdnoValidation | null;
  status: EdnoStatus;
  rollbackHash: string;
  reason?: string;
  proposal?: EdnoFinalProposal;
  curriculum?: CurriculumStep;
  /** Ahead of the parent but below the gate: offered as a revision that does not become the training parent. */
  unconfirmed?: true;
  unconfirmedHash?: string;
  unconfirmedId?: string;
  winnerHash?: string;
  winnerId?: string;
  /** Never set by the final round (attribution is left to the explorer); declared because promotion handles both receipts. */
  attribution?: Attribution;
}
/** Message `winner`: a validated child, now the training parent. */
export type EdnoWinner = {
  type: 'winner';
  parentId: string;
  id: string;
  ops: HeadOp[];
  tactical: Controller;
  receipt: EdnoRoundReceipt | EdnoFinalReceipt;
};
/** Message `final-result`: the final round's receipt and, for an unconfirmed candidate, its recipe. */
export type EdnoFinalResult = {
  type: 'final-result';
  receipt: EdnoFinalReceipt;
  candidate?: { ops: HeadOp[]; tactical: Controller };
};
export type EdnoMessage = EdnoWinner | EdnoFinalResult;
/** What a revision ID is computed from. */
export interface EdnoRevisionRecipe {
  parentId: string;
  precision: 'w4';
  ops: HeadOp[];
  controller: Controller;
}
/** A lineage anchor record: a W4 revision's `ops` and `controller` (or `tactical`), or a ready `recipe`. */
export interface EdnoLineageItem {
  label?: string;
  recipe?: Recipe;
  ops?: HeadOp[];
  tactical?: Controller | null;
  controller?: Controller | null;
}
export interface EdnoOptions {
  runner: GameRunner;
  head?: ReleasedHead;
  /** The training parent: its recipe, recipe hash and revision ID. */
  start: { recipe: Recipe; hash: string; id: string };
  /** Master seed of every search, race, validation and final-round seed; an unsigned 32-bit integer. */
  searchSeed: number;
  /** Maximum number of generations. */
  limit?: number;
  /** Called with each generation's receipt; resolving to `true` ends the run. */
  onRound?: (receipt: EdnoRoundReceipt) => Promise<boolean | void>;
  /** Revision ID of a child; without it the recipe hash serves as ID. */
  revisionId?: (recipe: EdnoRevisionRecipe) => Promise<string>;
  emit?: (message: EdnoMessage) => void;
  /** Throws to abort the run. */
  checkStop?: () => void;
  counts?: Partial<TrainingCounts>;
  yieldTask?: () => Promise<void>;
  record?: (round: number, phase: string, message: string, extra?: Record<string, unknown>) => void;
  /** Lineage anchors, oldest first, as the page sends them: each is read as an `EdnoLineageItem` and its codes are validated by
   * `normalizeRecipe`. Defaults to the shipped composite. */
  lineage?: readonly unknown[];
  priority?: PriorityName;
  /** An `EdnoMode`; anything else falls back to `auto`. */
  mode?: string;
  /** An `EdnoSelection`; anything else falls back to `race`. */
  selection?: string;
  ties?: boolean;
  attribution?: boolean;
  directions?: number;
  /** Polled for a finish request, which ends the run with the final round of the kept candidates. */
  shouldFinish?: () => boolean;
}
export interface EdnoResult extends Recipe {
  startHash: string;
  parentId: string;
  hash: string;
  counts: Partial<TrainingCounts>;
  final: EdnoFinalReceipt | null;
}

type PairedStats = ReturnType<typeof pairedStats>;
interface Anchor {
  label: string;
  recipe: Recipe;
  hash: string;
}
interface Direction {
  seed: number;
  moves: BlockMove[];
  plus: Recipe;
  minus: Recipe;
  result?: EdnoDirectionResult;
}
interface RaceDirectionEntry extends EdnoRaceDirection {
  recipe: Recipe;
}
interface RaceCrossEntry extends EdnoRaceCross {
  recipe: Recipe;
}
type RaceEntry = RaceDirectionEntry | RaceCrossEntry;
interface Proposal extends EdnoProposal {
  recipe: Recipe;
}
interface KeptCandidate extends EdnoKeptCandidate {
  recipe: Recipe;
}
/** One arm of the adaptive bandit: a Beta posterior of the promotion chance and the running cost in games per generation. */
interface BanditArm {
  selection: EdnoSelection;
  mode: EdnoMode;
  a: number;
  b: number;
  games: number;
  gens: number;
  used: number;
  promoted: number;
}
interface ValidationOutcome {
  used: number[];
  parentRs: GameResult[];
  candRs: GameResult[];
  stats: PairedStats;
  controlStats: PairedStats;
  passed: boolean;
  validation: EdnoValidation;
}

/** Validation seeds of a pruned child (stream index 0xE000000 + (generation − 1) · validation.max + k). */
export function pruneSeed(master: number, generation: number, k: number): number {
  return streamSeed(master, 0xe000000 + (generation - 1) * EDNO.validation.max + k, true);
}
export const FINAL_PROTOCOL = 'agm.dnp.edno-final/7';
/** Final-round seeds (stream index 0xD000000 + k): the first final.seeds select among the kept candidates, the rest validate the choice. */
export function finalSeed(master: number, k: number): number {
  return streamSeed(master, 0xd000000 + k, true);
}
const byOps = (a: HeadOp, b: HeadOp) => a[0] - b[0] || a[1] - b[1];
/** Parameter blocks of the released policy: 119 controller parameters and 3 × 16 native blocks of 64 columns. */
export function parameterBlocks(head: ReleasedHead = TRUST.head, blockSize: number = EDNO.blockSize): ParameterBlock[] {
  const blocks = SLOTS.map((_path, s): ParameterBlock => ({ id: s, kind: 'controller', slot: s, size: 1 }));
  for (let r = 0; r < head.actions.length; r++)
    for (let first = 0; first < 1024; first += blockSize)
      blocks.push({ id: blocks.length, kind: 'native', row: r, first, size: blockSize });
  return blocks;
}
/** Optional task prior: left/right mirror symmetry of the readout controller (LEFT ← xLeft is tied to RIGHT ← xRight). */
export function mirrorTies(
  blocks: readonly ParameterBlock[],
  controller: Controller = TRUST.controller,
): Map<number, number> {
  const swapOut = (o: string) => (o === 'LEFT' ? 'RIGHT' : o === 'RIGHT' ? 'LEFT' : o),
    swapIn = (i: string) =>
      /Left$/.test(i) ? i.replace(/Left$/, 'Right') : /Right$/.test(i) ? i.replace(/Right$/, 'Left') : i;
  const key = (m: string, o: string, i: string) => m + '|' + o + '|' + i,
    index = new Map<string, number>(),
    ties = new Map<number, number>();
  for (const b of blocks)
    if (b.kind === 'controller') {
      const p = SLOTS[b.slot];
      if (p.length === 3) {
        const m = controller[p[0]];
        index.set(key(p[0], m.outputs[p[1]], m.inputs[p[2]]), b.id);
      }
    }
  for (const b of blocks)
    if (b.kind === 'controller') {
      const p = SLOTS[b.slot];
      if (p.length !== 3) continue;
      const m = controller[p[0]];
      const j = index.get(key(p[0], swapOut(m.outputs[p[1]]), swapIn(m.inputs[p[2]])));
      if (j !== undefined && j !== b.id) ties.set(b.id, j);
    }
  return ties;
}
/** Move blocks by signed levels; values stay within the signed four-bit range. */
export function applyMoves(
  recipe: Recipe,
  moves: readonly BlockMove[],
  blocks: readonly ParameterBlock[],
  head: ReleasedHead = TRUST.head,
): { recipe: Recipe; changed: number } {
  const ops = new Map(recipe.ops.map((op) => [op[0] * 1024 + op[1], op])),
    tactical = structuredClone(recipe.tactical);
  let changed = 0;
  for (const [id, delta] of moves) {
    const b = blocks[id];
    if (b.kind === 'controller') {
      const path = SLOTS[b.slot],
        x = readSlot(tactical, path),
        y = Math.max(-7, Math.min(7, x + delta));
      if (y !== x) {
        writeSlot(tactical, path, y);
        changed++;
      }
    } else
      for (let c = b.first; c < b.first + b.size; c++) {
        const i = b.row * 1024 + c,
          x = ops.get(i)?.[3] ?? head.codes[i],
          y = Math.max(-7, Math.min(7, x + delta));
        if (y !== x) {
          updateHead(ops, head, i, y);
          changed++;
        }
      }
  }
  return { recipe: { ops: [...ops.values()].sort(byOps), tactical }, changed };
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** The control goal of a priority: kills when survival is primary, survival time when kills are primary. */
export const controlOf = (primary: Metric): Metric => (primary === 'kills' ? 'tics' : 'kills');
const compact = (r: GameResult, w: UtilityWeights): EdnoGame => ({
  seed: r.seed,
  tics: r.tics,
  kills: r.kills,
  health: r.health,
  utility: r6(utility(r, w)),
  fnv: r.commandFNV32,
  terminal: r.terminal,
  horizon: r.horizon,
  limit: r.limit,
});
/** Gamma(k, 1) and Beta(a, b) draws from a uniform stream (Marsaglia–Tsang with a Box–Muller normal); deterministic for a given stream. */
function gammaDraw(k: number, random: () => number): number {
  if (k < 1) return gammaDraw(k + 1, random) * Math.pow(random() || 1e-12, 1 / k);
  const d = k - 1 / 3,
    c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random()),
      v = (1 + c * z) ** 3;
    if (v <= 0) continue;
    const u = random() || 1e-12;
    if (Math.log(u) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function betaDraw(a: number, b: number, random: () => number): number {
  const x = gammaDraw(a, random),
    y = gammaDraw(b, random);
  return x / (x + y);
}
/** Weighted sampling without replacement (Efraimidis–Spirakis keys), deterministic for a given random stream. */
function sample(weights: number[], m: number, random: () => number): number[] {
  return weights
    .map((w, i) => ({ i, key: w > 0 ? Math.log(random()) / w : -Infinity }))
    .sort((a, b) => b.key - a.key || a.i - b.i)
    .slice(0, m)
    .filter((x) => x.key > -Infinity)
    .map((x) => x.i);
}
/** Crossing ("Kreuzen"): fuse signed move lists. Per block the steps add up; the sum is capped at ±cap and blocks whose moves cancel are dropped. */
export function crossMoves(lists: readonly (readonly BlockMove[])[], cap: number = Infinity): BlockMove[] {
  const sum = new Map<number, number>();
  for (const list of lists) for (const [id, d] of list) sum.set(id, (sum.get(id) ?? 0) + d);
  return [...sum.entries()]
    .filter(([, d]) => d !== 0)
    .map(([id, d]): BlockMove => [id, Math.sign(d) * Math.min(Math.abs(d), cap)])
    .sort((a, b) => a[0] - b[0]);
}
/** Shared screening seeds of the race selection (stream index 0x7000000 + 32·(generation − 1) + k), disjoint from search and validation seeds. */
export function raceSeed(master: number, generation: number, k: number): number {
  return streamSeed(master, 0x7000000 + (generation - 1) * 32 + k, false);
}
export function ednoSeed(master: number, generation: number, k: number, validation: boolean): number {
  return streamSeed(
    master,
    (validation ? 0x6000000 : 0x1000000) + (generation - 1) * (validation ? EDNO.validation.max : EDNO.directions) + k,
    validation,
  );
}
/** The search outcome of a direction. Step 2 of each generation records it for every direction before anything reads it. */
function searched(d: Direction): EdnoDirectionResult {
  if (!d.result) throw new Error('Direction read before its search games were scored');
  return d.result;
}
/** The generation loop. `runner.play(jobs)` returns `{result}` per job in order; lanes change wall-clock time only. */
export async function runEDNO({
  runner,
  head = TRUST.head,
  start,
  searchSeed,
  limit = Infinity,
  onRound = async () => {},
  revisionId,
  emit = () => {},
  checkStop = () => {},
  counts = { promotions: 0 },
  yieldTask = async () => {},
  record = () => {},
  lineage,
  priority = 'survival',
  mode = 'auto',
  selection = 'race',
  ties: useTies = false,
  attribution: explain = false,
  directions = EDNO.directions,
  shouldFinish = () => false,
}: EdnoOptions): Promise<EdnoResult> {
  const master = searchSeed >>> 0;
  if (master !== searchSeed) throw new RangeError('searchSeed out of bounds');
  const chosen = PRIORITIES[priority] ?? PRIORITIES.survival,
    w = chosen.utility,
    primary = chosen.primary,
    control = controlOf(primary);
  priority = PRIORITIES[priority] ? priority : 'survival';
  // String-keyed views of the frozen tables: `mode` and `selection` arrive as free strings.
  const modes: Readonly<Partial<Record<string, EdnoModeConfig>>> = EDNO.modes,
    selections: readonly string[] = EDNO.selections;
  const cfg = modes[mode] ?? EDNO.modes.auto;
  mode = modes[mode] ? mode : 'auto';
  selection = selections.includes(selection) ? selection : 'race';
  // Adaptive strategy: one Beta posterior of the promotion chance and a running cost (games per generation) per arm.
  const arms: BanditArm[] | null =
    selection === 'adaptive'
      ? EDNO.adaptive.arms.map((x) => ({
          ...x,
          a: 1,
          b: 1,
          games: EDNO.adaptive.costPrior,
          gens: 1,
          used: 0,
          promoted: 0,
        }))
      : null;
  if (!(directions >= 1 && directions <= EDNO.directions))
    throw new RangeError('directions must be 1–' + EDNO.directions);
  const blocks = parameterBlocks(head),
    B = blocks.length,
    ties = useTies ? mirrorTies(blocks) : new Map<number, number>();
  const roots: Anchor[] = [];
  // Lineage records arrive from the page as stored; normalizeRecipe validates their codes.
  for (const item of (lineage ?? [
    { label: 'shipped', recipe: normalizeRecipe(undefined, head) },
  ]) as readonly EdnoLineageItem[]) {
    const recipe = item.recipe ?? normalizeRecipe({ ops: item.ops, tactical: item.tactical ?? item.controller }, head);
    roots.push({ label: item.label || 'lineage-root', recipe, hash: await recipeHash(recipe) });
  }
  let current = start.recipe,
    parentHash = start.hash,
    parentId = start.id,
    density = cfg.density,
    level = cfg.level,
    stagnant = 0,
    minutes: number = CURRICULUM.startMinutes;
  const startHash = parentHash,
    ancestors: Anchor[] = [],
    trials = new Float64Array(B),
    inert = new Float64Array(B),
    rejected = new Set<string>();
  let acc = Array.from({ length: B }, () => ({ n: 0, s: 0, q: 0 }));
  const anchorsFor = () => {
    const list: Anchor[] = [];
    const add = (a: Anchor) => {
      if (a.hash !== parentHash && !list.some((x) => x.hash === a.hash)) list.push(a);
    };
    roots.forEach(add);
    add({ label: 'root', recipe: start.recipe, hash: startHash });
    ancestors.forEach(add);
    return list;
  };
  let genGames = 0,
    finalMode = false,
    finishedAt: number | null = null;
  // A finish request ends the generation after the running batch once a candidate is kept; before that the generation plays on
  // until its race keeps one, or ends. The final round then plays without interruption.
  const finishSignal = () => Object.assign(new Error('Finish requested'), { name: 'FinishSignal' });
  const finishing = () => {
    if (!finalMode && shouldFinish() && kept.length) throw finishSignal();
  };
  async function play(jobs: EdnoJob[], generation: number, phase: string, message: string): Promise<GameResult[]> {
    if (!jobs.length) return [];
    checkStop();
    finishing();
    genGames += jobs.length;
    record(generation, phase, message, { jobs: jobs.length, kept: keptSummary() });
    const out = await runner.play(jobs);
    checkStop();
    finishing();
    if (out.length !== jobs.length) throw new Error('Runner returned an incomplete generation');
    return out.map((o) => o.result);
  }
  const parentMemo = new Map<string, GameResult>();
  // The strongest candidates of the current parent, by the t statistic of their latest paired evidence.
  const kept: KeptCandidate[] = [];
  function remember(c: KeptCandidate): void {
    if (c.hash === parentHash) return;
    const i = kept.findIndex((x) => x.hash === c.hash);
    if (i >= 0) kept.splice(i, 1);
    kept.push(c);
    kept.sort((a, b) => b.t - a.t || a.generation - b.generation);
    if (kept.length > EDNO.final.keep) kept.length = EDNO.final.keep;
  }
  const forget = (hash: string) => {
    const i = kept.findIndex((x) => x.hash === hash);
    if (i >= 0) kept.splice(i, 1);
  };
  const keptSummary = (): EdnoKeptSummary[] =>
    kept.map(({ recipe: _recipe, moves, ...c }) => ({ ...c, blocks: moves.length }));
  /** Racing validation against the parent on fresh seeds (batches up to seeds.length), then every lineage anchor on the seeds played. */
  async function validate(
    recipe: Recipe,
    seeds: number[],
    horizon: number,
    generation: number,
    phase: string,
    label: string,
  ): Promise<ValidationOutcome> {
    const V = EDNO.validation,
      parentRs: GameResult[] = [],
      candRs: GameResult[] = [];
    let stage: EdnoValidationStage = 'racing',
      stats: PairedStats | null = null,
      controlStats: PairedStats | null = null;
    for (let n = 0; n < seeds.length; n += V.batch) {
      const batch = seeds.slice(n, n + V.batch),
        need = batch.filter((s) => !parentMemo.has(parentHash + '|' + s + '|' + horizon));
      const vjobs = [
        ...need.map((seed) => ({ recipe: current, seed, horizon, round: generation, phase, role: 'parent' })),
        ...batch.map((seed) => ({ recipe, seed, horizon, round: generation, phase, role: 'candidate' })),
      ];
      const got = await play(
        vjobs,
        generation,
        phase,
        label + ' · seeds ' + (n + 1) + '–' + (n + batch.length) + ' of up to ' + seeds.length,
      );
      need.forEach((s, i) => parentMemo.set(parentHash + '|' + s + '|' + horizon, got[i]));
      batch.forEach((s, i) => {
        // Every seed of the batch is memoized: `need` was just played and the others were found in the memo.
        const parentResult = parentMemo.get(parentHash + '|' + s + '|' + horizon);
        if (!parentResult) throw new Error('Parent result missing for seed ' + s);
        parentRs.push(parentResult);
        candRs.push(got[need.length + i]);
      });
      stats = pairedStats(candRs.map((c, i) => c[primary] - parentRs[i][primary]));
      controlStats = pairedStats(candRs.map((c, i) => c[control] - parentRs[i][control]));
      if (stats.t <= V.reject) {
        stage = 'rejected-early';
        break;
      }
      if (controlStats.t <= EDNO.guard.t) {
        stage = 'rejected-control';
        break;
      }
      if (candRs.length >= V.earlyAfter && stats.t >= V.early) {
        stage = 'accepted-early';
        break;
      }
    }
    // The loop ran at least once: every caller passes validation.max seeds.
    if (!stats || !controlStats) throw new Error('Validation needs at least one seed');
    const used = seeds.slice(0, candRs.length),
      gain = candRs.reduce((a, r) => a + utility(r, w), 0) - parentRs.reduce((a, r) => a + utility(r, w), 0);
    const parentPass =
      stage !== 'rejected-early' &&
      stage !== 'rejected-control' &&
      stats.t >= V.t &&
      gain > 0 &&
      controlStats.t > EDNO.guard.t;
    const anchors: EdnoAnchorCheck[] = [];
    if (parentPass)
      for (const a of anchorsFor()) {
        const ar = await play(
          used.map((seed) => ({ recipe: a.recipe, seed, horizon, round: generation, phase, role: 'anchor' })),
          generation,
          phase,
          'Lineage anchor ' + a.label,
        );
        const sumP = (x: GameResult[]) => x.reduce((s, r) => s + r[primary], 0),
          sumU = (x: GameResult[]) => x.reduce((s, r) => s + utility(r, w), 0);
        anchors.push({
          label: a.label,
          hash: a.hash,
          primary: sumP(ar),
          utility: r6(sumU(ar)),
          candidatePrimary: sumP(candRs),
          candidateUtility: r6(sumU(candRs)),
          beaten: sumP(candRs) >= sumP(ar) && sumU(candRs) >= sumU(ar),
          results: ar.map((r) => compact(r, w)),
        });
      }
    const passed = parentPass && anchors.every((a) => a.beaten);
    return {
      used,
      parentRs,
      candRs,
      stats,
      controlStats,
      passed,
      validation: {
        stage,
        games: candRs.length,
        stats: { n: stats.n, mean: r6(stats.mean), se: r6(stats.se), t: r6(stats.t) },
        control: {
          metric: control,
          n: controlStats.n,
          mean: r6(controlStats.mean),
          se: r6(controlStats.se),
          t: r6(controlStats.t),
        },
        utilityGain: r6(gain),
        parent: parentRs.map((r) => compact(r, w)),
        candidate: candRs.map((r) => compact(r, w)),
        anchors,
        passed,
      },
    };
  }
  /** Rennen + Bereinigen: attribute the validated child, build the child with only its carrying groups and validate it on fresh seeds.
   * Returns the child to promote (pruned when it passes, else full); the receipt then holds the promoted child's validation and the
   * other one under `prune`. */
  async function pruneStep(
    receipt: EdnoRoundReceipt,
    proposal: Proposal,
    v: ValidationOutcome,
    horizon: number,
    generation: number,
  ): Promise<{ recipe: Recipe; hash: string; v: ValidationOutcome }> {
    checkStop();
    const S = Math.min(EDNO.attributionSeeds, v.used.length);
    const att = await attributeChange({
      play: (j) => runner.play(j),
      parent: current,
      child: proposal.recipe,
      seeds: v.used.slice(0, S),
      horizon,
      head,
      w,
      parentResults: v.parentRs.slice(0, S),
      childResults: v.candRs.slice(0, S),
      round: generation,
    });
    receipt.attribution = att;
    const keep = att.groups.filter((g) => g.knockOut.t >= EDNO.prune.t),
      drop = att.groups.filter((g) => g.knockOut.t < EDNO.prune.t);
    const label = (g: AttributedGroup) =>
      g.kind === 'native' ? 'native row ' + g.row : 'controller ' + (g.matrix ?? SLOTS[g.slots[0][0]][0]);
    const summary = (gs: AttributedGroup[]): EdnoPruneGroup[] =>
      gs.map((g) => ({ id: g.id, kind: g.kind, label: label(g), size: g.size, knockOutT: g.knockOut.t }));
    receipt.prune = {
      t: EDNO.prune.t,
      kept: summary(keep),
      dropped: summary(drop),
      applied: false,
      fullHash: proposal.hash,
    };
    if (!keep.length || !drop.length) {
      receipt.prune.reason = !keep.length
        ? 'No change group carries the gain by itself; the full child is promoted'
        : 'Every change group carries the gain';
      return { recipe: proposal.recipe, hash: proposal.hash, v };
    }
    let pruned = current;
    for (const g of keep) pruned = applyGroup(pruned, g, 'after', head);
    const hash = await recipeHash(pruned);
    const pv = await validate(
      pruned,
      Array.from({ length: EDNO.validation.max }, (_, k) => pruneSeed(master, generation, k)),
      horizon,
      generation,
      'validation',
      'Validating the pruned child (' + keep.length + ' of ' + att.groups.length + ' change groups)',
    );
    receipt.prune.prunedHash = hash;
    if (!pv.passed) {
      receipt.prune.reason = 'The pruned child did not pass validation; the full child is promoted';
      receipt.prune.validation = pv.validation;
      receipt.prune.validationSeeds = pv.used;
      return { recipe: proposal.recipe, hash: proposal.hash, v };
    }
    receipt.prune.applied = true;
    receipt.prune.reason = 'The pruned child passed validation and replaces the full child';
    receipt.prune.full = {
      hash: proposal.hash,
      validationSeeds: receipt.validationSeeds,
      validation: receipt.validation,
    };
    receipt.validationSeeds = pv.used;
    receipt.validation = pv.validation;
    return { recipe: pruned, hash, v: pv };
  }
  /** Promote a validated candidate: optional attribution, the child's ID, the winner event, and the child becomes the parent. */
  async function promote(
    receipt: EdnoRoundReceipt | EdnoFinalReceipt,
    recipe: Recipe,
    hash: string,
    v: ValidationOutcome,
    horizon: number,
    generation: number,
    attribute: boolean,
  ): Promise<void> {
    checkStop();
    if (attribute) {
      const S = Math.min(EDNO.attributionSeeds, v.used.length);
      receipt.attribution = await attributeChange({
        play: (j) => runner.play(j),
        parent: current,
        child: recipe,
        seeds: v.used.slice(0, S),
        horizon,
        head,
        w,
        parentResults: v.parentRs.slice(0, S),
        childResults: v.candRs.slice(0, S),
        round: generation,
      });
    }
    const nextId = revisionId
      ? await revisionId({ parentId, precision: 'w4', ops: recipe.ops, controller: recipe.tactical })
      : hash;
    checkStop();
    receipt.status = 'promoted';
    receipt.winnerHash = hash;
    receipt.winnerId = nextId;
    // `counts.promotions++` (the counter is optional in TrainingCounts; Number(undefined) + 1 is NaN, as ++ gives).
    counts.promotions = Number(counts.promotions) + 1;
    emit({
      type: 'winner',
      parentId,
      id: nextId,
      ops: recipe.ops,
      tactical: recipe.tactical,
      receipt: structuredClone(receipt),
    });
    ancestors.push({ label: 'ancestor-' + generation, recipe: current, hash: parentHash });
    current = recipe;
    parentHash = hash;
    parentId = nextId;
    parentMemo.clear();
    rejected.clear();
    kept.length = 0;
    acc = Array.from({ length: B }, () => ({ n: 0, s: 0, q: 0 }));
    density = cfg.density;
    level = cfg.level;
    stagnant = 0;
  }
  for (let generation = 1; generation <= limit; generation++) {
    checkStop();
    try {
      if (shouldFinish()) throw finishSignal();
      const horizon = minutes * CURRICULUM.minuteDecisions;
      genGames = 0;
      // The generation's strategy: the declared one, or the bandit's choice when adaptive.
      let sel = selection === 'race-prune' ? 'race' : selection,
        gcfg = cfg,
        strategy: EdnoStrategy | null = null;
      if (arms) {
        const random = rng((master ^ Math.imul(generation, 0x27d4eb2d) ^ 0x5bd1e995) >>> 0),
          draws = arms.map((x) => betaDraw(x.a, x.b, random) / (x.games / x.gens / 1000));
        const pick = draws.indexOf(Math.max(...draws)),
          arm = arms[pick];
        sel = arm.selection;
        gcfg = EDNO.modes[arm.mode];
        density = gcfg.density;
        level = gcfg.level;
        strategy = {
          arm: pick,
          selection: sel,
          mode: arm.mode,
          draws: draws.map(r6),
          posterior: arms.map((x) => [r6(x.a), r6(x.b), r6(x.games / x.gens)]),
        };
      }
      // 1. Directions: coverage-weighted block samples (auto) or uniform; mirrored signs; ties move together.
      const weights = blocks.map((_b, i) =>
        gcfg.coverage
          ? 1 / Math.sqrt(1 + trials[i]) / (1 + EDNO.inertPenalty * (trials[i] ? inert[i] / trials[i] : 0))
          : 1,
      );
      const m = Math.max(1, Math.round(density * B)),
        dirs: Direction[] = [];
      for (let k = 0; k < directions; k++) {
        const random = rng((master ^ Math.imul(generation, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0);
        const picked = sample(weights, m, random),
          moves = new Map<number, number>();
        for (const id of picked) {
          const sign = random() < 0.5 ? -1 : 1;
          moves.set(id, sign * level);
          const t = ties.get(id);
          if (t !== undefined && !moves.has(t)) moves.set(t, sign * level);
        }
        const list = [...moves.entries()].sort((a, b) => a[0] - b[0]);
        const plus = applyMoves(current, list, blocks, head),
          minus = applyMoves(
            current,
            list.map(([id, d]) => [id, -d]),
            blocks,
            head,
          );
        dirs.push({
          seed: ednoSeed(master, generation, k, false),
          moves: list,
          plus: plus.recipe,
          minus: minus.recipe,
        });
      }
      const jobs: EdnoJob[] = [];
      for (const [k, d] of dirs.entries())
        for (const role of ['plus', 'minus'] as const)
          jobs.push({ recipe: d[role], seed: d.seed, horizon, round: generation, phase: 'search', role, direction: k });
      const results = await play(
        jobs,
        generation,
        'search',
        'Generation ' +
          generation +
          ' · ' +
          directions +
          ' mirrored directions, one fresh seed each · ' +
          m +
          ' of ' +
          B +
          ' blocks ±' +
          level,
      );
      // 2. Evidence: each pair's half utility difference per level, credited to every block it moved.
      dirs.forEach((d, k) => {
        const p = results[2 * k],
          q = results[2 * k + 1],
          half = (utility(p, w) - utility(q, w)) / 2 / level,
          same = p.commandFNV32 === q.commandFNV32;
        d.result = { plus: compact(p, w), minus: compact(q, w), half: r6(half), same };
        for (const [id, delta] of d.moves) {
          const x = half * Math.sign(delta),
            a = acc[id];
          a.n++;
          a.s += x;
          a.q += x * x;
          trials[id]++;
          if (same) inert[id]++;
        }
      });
      // 3. Candidate: blocks whose evidence reaches t ≥ propose.t, stepped one level in the indicated direction.
      const evidence = acc
        .map((a, id) => {
          if (a.n < EDNO.propose.minSamples) return null;
          const mean = a.s / a.n,
            v = (a.q - a.n * mean * mean) / Math.max(1, a.n - 1),
            se = Math.sqrt(Math.max(0, v) / a.n);
          return { id, n: a.n, mean, t: se > 0 ? mean / se : 0 };
        })
        .filter((e) => e !== null);
      let proposal: Proposal | null = null,
        race: EdnoRace | null = null,
        raceParent: GameResult[] = [];
      if (sel === 'evidence') {
        const strong = evidence
          .filter((e) => Math.abs(e.t) >= EDNO.propose.t)
          .sort((a, b) => Math.abs(b.t) - Math.abs(a.t) || a.id - b.id)
          .slice(0, EDNO.propose.maxBlocks);
        const stepMoves = new Map<number, number>();
        for (const e of strong) {
          const d = Math.sign(e.mean);
          stepMoves.set(e.id, d);
          const t = ties.get(e.id);
          if (t !== undefined && !stepMoves.has(t)) stepMoves.set(t, d);
        }
        if (stepMoves.size) {
          const moves = [...stepMoves.entries()].sort((a, b) => a[0] - b[0]),
            applied = applyMoves(current, moves, blocks, head);
          if (applied.changed) {
            const hash = await recipeHash(applied.recipe);
            if (!rejected.has(hash))
              proposal = {
                moves,
                recipe: applied.recipe,
                hash,
                evidence: strong.map((e) => [e.id, e.n, r6(e.mean), r6(e.t)]),
              };
          }
        }
      } else {
        // Race: the better arm of each direction, ranked by its half-difference; finalists against the parent on shared seeds, then the leaders on more.
        const R = EDNO.race,
          ranked = dirs
            .map((d, k): { k: number; sign: 1 | -1; screen: number; same: boolean } => {
              const h = (results[2 * k][primary] - results[2 * k + 1][primary]) / 2;
              return { k, sign: h >= 0 ? 1 : -1, screen: Math.abs(h), same: searched(d).same };
            })
            .filter((x) => !x.same && x.screen > 0)
            .sort((a, b) => b.screen - a.screen || a.k - b.k);
        const finalists: RaceDirectionEntry[] = [];
        for (const x of ranked) {
          if (finalists.length >= R.finalists) break;
          const recipe = x.sign > 0 ? dirs[x.k].plus : dirs[x.k].minus,
            hash = await recipeHash(recipe);
          if (rejected.has(hash) || hash === parentHash || finalists.some((c) => c.hash === hash)) continue;
          finalists.push({
            direction: x.k,
            sign: x.sign,
            screen: r6(x.screen),
            recipe,
            hash,
            primary: [],
            control: [],
            utilities: [],
          });
        }
        if (finalists.length) {
          const seeds = Array.from({ length: R.seeds + R.lastSeeds }, (_, k) => raceSeed(master, generation, k)),
            parentUtilities: number[] = [],
            parentPrimary: number[] = [],
            parentControl: number[] = [];
          raceParent = [];
          const stage = async (list: RaceEntry[], ss: number[], label: string) => {
            const got = await play(
              [
                ...ss.map((seed) => ({
                  recipe: current,
                  seed,
                  horizon,
                  round: generation,
                  phase: 'race',
                  role: 'parent',
                })),
                ...list.flatMap((c) =>
                  ss.map((seed) => ({
                    recipe: c.recipe,
                    seed,
                    horizon,
                    round: generation,
                    phase: 'race',
                    role: 'candidate',
                    direction: c.direction,
                  })),
                ),
              ],
              generation,
              'race',
              label,
            );
            const mineP = got.slice(0, ss.length);
            raceParent.push(...mineP);
            parentUtilities.push(...mineP.map((r) => r6(utility(r, w))));
            parentPrimary.push(...mineP.map((r) => r[primary]));
            parentControl.push(...mineP.map((r) => r[control]));
            list.forEach((c, j) => {
              const mine = got.slice(ss.length * (j + 1), ss.length * (j + 2));
              c.utilities.push(...mine.map((r) => r6(utility(r, w))));
              c.primary.push(...mine.map((r) => r[primary]));
              c.control.push(...mine.map((r) => r[control]));
            });
          };
          // Race statistics on the primary metric; the utility difference is recorded alongside.
          const stat = (
            c: Pick<EdnoRaceEntryBase, 'primary' | 'control' | 'utilities'>,
            from: number,
          ): EdnoRaceStat => {
            const st = pairedStats(c.primary.map((x, i) => x - parentPrimary[from + i])),
              ct = pairedStats(c.control.map((x, i) => x - parentControl[from + i]));
            const u = c.utilities.reduce((a, x, i) => a + x - parentUtilities[from + i], 0) / c.utilities.length;
            return {
              mean: r6(st.mean),
              t: r6(st.t),
              n: st.n,
              utility: r6(u),
              control: r6(ct.mean),
              controlT: r6(ct.t),
            };
          };
          const score = (c: RaceEntry, from: number, to: number, key: 'screening' | 'final') => {
            c[key] = stat(
              {
                primary: c.primary.slice(from, to),
                control: c.control.slice(from, to),
                utilities: c.utilities.slice(from, to),
              },
              from,
            );
            return c;
          };
          const guarded = (x: EdnoRaceStat) => x.controlT > EDNO.guard.t;
          await stage(
            finalists,
            seeds.slice(0, R.seeds),
            'Race · ' + finalists.length + ' directions against the parent on ' + R.seeds + ' shared seeds',
          );
          finalists.forEach((c) => score(c, 0, R.seeds, 'screening'));
          // Every finalist was just scored, so the `screening` check only informs the type.
          const ahead = finalists
            .filter(
              (c): c is RaceDirectionEntry & { screening: EdnoRaceStat } =>
                c.screening !== undefined && c.screening.mean > 0 && guarded(c.screening),
            )
            .sort((a, b) => b.screening.mean - a.screening.mean || a.direction - b.direction);
          const leaders = ahead
            .slice(0, R.last)
            .map((c): RaceDirectionEntry => ({ ...c, primary: [], control: [], utilities: [] }));
          // Crossing: the changes of the best finalists fused into one candidate.
          let crossed: RaceCrossEntry | null = null;
          if (R.cross > 1 && ahead.length >= 2) {
            const parts = ahead.slice(0, R.cross),
              moves = crossMoves(
                parts.map((c) => dirs[c.direction].moves.map(([id, v]) => [id, v * c.sign])),
                level,
              ),
              applied = applyMoves(current, moves, blocks, head);
            if (applied.changed) {
              const hash = await recipeHash(applied.recipe);
              if (!rejected.has(hash) && hash !== parentHash && !leaders.some((c) => c.hash === hash))
                crossed = {
                  direction: 'cross',
                  parts: parts.map((c) => [c.direction, c.sign]),
                  moves,
                  recipe: applied.recipe,
                  hash,
                  primary: [],
                  control: [],
                  utilities: [],
                };
            }
          }
          const last: RaceEntry[] = crossed ? [...leaders, crossed] : leaders,
            lastSeeds = seeds.slice(R.seeds),
            lastParent = parentUtilities.length;
          if (last.length) {
            await stage(
              last,
              lastSeeds,
              'Race · ' +
                leaders.length +
                ' leaders' +
                (crossed ? ' and their cross' : '') +
                ' on ' +
                R.lastSeeds +
                ' fresh seeds',
            );
            last.forEach((c) => {
              c.final = stat(c, lastParent);
            });
            // Every entry of `last` was just scored, so the `final` checks below only inform the type.
            for (const c of last)
              if (c.final && c.final.mean > 0 && guarded(c.final))
                remember({
                  recipe: c.recipe,
                  hash: c.hash,
                  moves: c.direction === 'cross' ? c.moves : dirs[c.direction].moves.map(([id, v]) => [id, v * c.sign]),
                  generation,
                  source: 'race',
                  direction: c.direction,
                  mean: c.final.mean,
                  t: c.final.t,
                  n: c.final.n,
                  minutes,
                });
          }
          const best = last
            .filter((c): c is RaceEntry & { final: EdnoRaceStat } => c.final !== undefined && guarded(c.final))
            .sort((a, b) => b.final.mean - a.final.mean || String(a.direction).localeCompare(String(b.direction)))[0];
          // Each entry without its recipe (destructured per list so finalists keep their direction type).
          race = {
            seeds: seeds.slice(0, last.length ? seeds.length : R.seeds),
            metric: primary,
            controlMetric: control,
            parent: parentPrimary,
            parentControl,
            parentUtilities,
            finalists: finalists.map(({ recipe: _recipe, ...c }) => c),
            last: last.map(({ recipe: _recipe, ...c }) => c),
            chosen: best && best.final.mean > 0 ? best.direction : null,
          };
          if (best && best.final.mean > 0) {
            const moves: BlockMove[] =
              best.direction === 'cross'
                ? best.moves
                : dirs[best.direction].moves.map(([id, v]) => [id, v * best.sign]);
            proposal = {
              moves,
              recipe: best.recipe,
              hash: best.hash,
              race: {
                direction: best.direction,
                sign: best.sign ?? null,
                parts: best.parts ?? null,
                mean: best.final.mean,
                t: best.final.t,
                seeds: best.final.n,
              },
            };
          }
        }
      }
      const receipt: EdnoRoundReceipt = {
        protocol: EDNO_PROTOCOL,
        searchSeed: master,
        round: generation,
        parentId,
        parentHash,
        lanes: runner.lanes ?? 1,
        priority,
        utility: w,
        primary,
        mode,
        selection,
        strategy,
        ties: useTies,
        density: r6(density),
        level,
        blocks: B,
        minutes,
        horizon,
        searchSeeds: dirs.map((d) => d.seed),
        directions: dirs.map((d) => ({ seed: d.seed, moves: d.moves, ...searched(d) })),
        evidenceTop: evidence
          .sort((a, b) => Math.abs(b.t) - Math.abs(a.t) || a.id - b.id)
          .slice(0, 12)
          .map((e) => [e.id, e.n, r6(e.mean), r6(e.t)]),
        race,
        proposal: proposal && {
          moves: proposal.moves,
          hash: proposal.hash,
          evidence: proposal.evidence,
          race: proposal.race,
        },
        validationSeeds: [],
        validation: null,
        status: 'retained',
        rollbackHash: parentHash,
      };
      // 4. Racing validation on fresh seeds against the parent, then every lineage anchor on the seeds that were played.
      if (proposal) {
        const v = await validate(
          proposal.recipe,
          Array.from({ length: EDNO.validation.max }, (_, k) => ednoSeed(master, generation, k, true)),
          horizon,
          generation,
          'validation',
          'Validating ' + proposal.moves.length + ' stepped blocks',
        );
        receipt.validationSeeds = v.used;
        receipt.validation = v.validation;
        receipt.curriculum = curriculumStep(minutes, [...v.parentRs, ...v.candRs]);
        if (v.passed && selection === 'race-prune') {
          const chosen = await pruneStep(receipt, proposal, v, horizon, generation);
          await promote(receipt, chosen.recipe, chosen.hash, chosen.v, horizon, generation, false);
        } else if (v.passed) await promote(receipt, proposal.recipe, proposal.hash, v, horizon, generation, explain);
        else {
          rejected.add(proposal.hash);
          // A candidate that stayed ahead without reaching the gate is kept with its validation evidence; one that fell behind is dropped.
          if (v.stats.mean > 0 && v.controlStats.t > EDNO.guard.t)
            remember({
              recipe: proposal.recipe,
              hash: proposal.hash,
              moves: proposal.moves,
              generation,
              source: 'validation',
              mean: r6(v.stats.mean),
              t: r6(v.stats.t),
              n: v.stats.n,
              minutes,
            });
          else forget(proposal.hash);
        }
        minutes = receipt.curriculum.nextMinutes;
      }
      // Without a validation the parent's race games (or else the search games) decide the episode length, so a parent that survives
      // the whole horizon never blocks the search at a survival ceiling.
      if (!receipt.curriculum) {
        receipt.curriculum = curriculumStep(minutes, raceParent.length ? raceParent : results);
        minutes = receipt.curriculum.nextMinutes;
      }
      // 5. Stagnation widens the perturbation (auto): more blocks per direction, then larger steps.
      // (`strategy` is set exactly when `arms` is, and it is the object the receipt holds.)
      if (arms && strategy) {
        const D = EDNO.adaptive.discount;
        for (const x of arms) {
          x.a = 1 + (x.a - 1) * D;
          x.b = 1 + (x.b - 1) * D;
        }
        const arm = arms[strategy.arm];
        arm.used++;
        arm.games += genGames;
        arm.gens++;
        if (receipt.status === 'promoted') {
          arm.a++;
          arm.promoted++;
        } else arm.b++;
        strategy.games = genGames;
      }
      if (receipt.status !== 'promoted') {
        stagnant++;
        if (!arms && cfg.adaptive && stagnant % EDNO.stagnation === 0) {
          if (density < cfg.maxDensity) density = Math.min(cfg.maxDensity, density * cfg.grow);
          else if (level < cfg.maxLevel) level++;
        }
      }
      receipt.nextDensity = r6(density);
      receipt.nextLevel = level;
      // (A proposal always has a validation.)
      receipt.reason =
        receipt.status === 'promoted'
          ? 'Validated on fresh seeds and ahead of every lineage anchor'
          : !proposal || !receipt.validation
            ? sel === 'race'
              ? 'No direction was ahead of the parent on the screening seeds'
              : 'No block has enough evidence yet'
            : receipt.validation.stage === 'rejected-early'
              ? 'Candidate fell behind the parent early in validation'
              : receipt.validation.control.t <= EDNO.guard.t
                ? 'Candidate is significantly worse in the control goal (' + control + ')'
                : receipt.validation.stats.t < EDNO.validation.t
                  ? 'Candidate not significantly better than the parent'
                  : receipt.validation.utilityGain <= 0
                    ? 'Candidate did not raise utility'
                    : 'A lineage anchor is ahead on the same seeds';
      const finish = await onRound(receipt);
      record(
        generation,
        'round-end',
        receipt.status === 'promoted' ? 'Validated revision promoted' : 'Parent retained',
        { last: receipt, kept: keptSummary() },
      );
      if (finish === true) break;
      await yieldTask();
    } catch (e) {
      // Anything may be thrown; only its `name` is read.
      if ((e as { name?: unknown } | null | undefined)?.name === 'FinishSignal') {
        finishedAt = generation;
        break;
      }
      throw e;
    }
  }
  let final: EdnoFinalReceipt | null = null,
    // Set by finalRound; declared wide so the read below is not narrowed to the initial null.
    unconfirmed = null as Recipe | null;
  if (finishedAt !== null) {
    final = await finalRound(finishedAt);
    emit({
      type: 'final-result',
      receipt: structuredClone(final),
      ...(unconfirmed ? { candidate: { ops: unconfirmed.ops, tactical: unconfirmed.tactical } } : {}),
    });
  }
  return { startHash, parentId, hash: parentHash, ...current, counts: { ...counts }, final };
  /** Final round after a finish request: select among the kept candidates on shared fresh seeds, validate the choice, promote if it passes. */
  async function finalRound(generation: number): Promise<EdnoFinalReceipt> {
    finalMode = true;
    const F = EDNO.final,
      V = EDNO.validation,
      horizon = minutes * CURRICULUM.minuteDecisions,
      list = kept.slice(),
      seeds = Array.from({ length: F.seeds + V.max }, (_, k) => finalSeed(master, k));
    const receipt: EdnoFinalReceipt = {
      protocol: FINAL_PROTOCOL,
      kind: 'final',
      searchSeed: master,
      round: generation,
      parentId,
      parentHash,
      lanes: runner.lanes ?? 1,
      priority,
      utility: w,
      primary,
      minutes,
      horizon,
      candidates: list.map(({ recipe: _recipe, ...c }) => c),
      selection: null,
      validationSeeds: [],
      validation: null,
      status: 'retained',
      rollbackHash: parentHash,
    };
    if (!list.length) {
      receipt.reason = 'No candidate was ahead of the parent yet';
      return receipt;
    }
    const ss = seeds.slice(0, F.seeds);
    const got = await play(
      [
        ...ss.map((seed) => ({ recipe: current, seed, horizon, round: generation, phase: 'final', role: 'parent' })),
        ...list.flatMap((c, j) =>
          ss.map((seed) => ({
            recipe: c.recipe,
            seed,
            horizon,
            round: generation,
            phase: 'final',
            role: 'candidate',
            direction: j,
          })),
        ),
      ],
      generation,
      'final',
      'Final round · ' +
        list.length +
        ' kept candidate' +
        (list.length > 1 ? 's' : '') +
        ' and the parent on ' +
        F.seeds +
        ' shared fresh seeds',
    );
    const P = got.slice(0, ss.length);
    const scores = list.map((c, j): EdnoFinalScore => {
      const mine = got.slice(ss.length * (j + 1), ss.length * (j + 2)),
        st = pairedStats(mine.map((r, i) => r[primary] - P[i][primary])),
        ct = pairedStats(mine.map((r, i) => r[control] - P[i][control]));
      return {
        index: j,
        hash: c.hash,
        primary: mine.reduce((a, r) => a + r[primary], 0),
        mean: r6(st.mean),
        t: r6(st.t),
        n: st.n,
        control: r6(ct.mean),
        controlT: r6(ct.t),
        results: mine.map((r) => compact(r, w)),
      };
    });
    const pick = scores
      .filter((x) => x.mean > 0 && x.controlT > EDNO.guard.t)
      .sort((a, b) => b.primary - a.primary || a.index - b.index)[0];
    receipt.selection = {
      seeds: ss,
      parent: P.map((r) => compact(r, w)),
      parentPrimary: P.reduce((a, r) => a + r[primary], 0),
      scores,
      chosen: pick ? pick.index : null,
    };
    if (!pick) {
      receipt.reason = 'No kept candidate was ahead of the parent on the selection seeds';
      return receipt;
    }
    const c = list[pick.index],
      v = await validate(
        c.recipe,
        seeds.slice(F.seeds),
        horizon,
        generation,
        'final',
        'Final validation of kept candidate ' + (pick.index + 1),
      );
    receipt.proposal = { moves: c.moves, hash: c.hash, kept: pick.index, source: c.source, generation: c.generation };
    receipt.validationSeeds = v.used;
    receipt.validation = v.validation;
    receipt.curriculum = curriculumStep(minutes, [...v.parentRs, ...v.candRs]);
    // Attribution is left to the explorer ("Measure causes") so the stopped run ends promptly.
    if (v.passed) await promote(receipt, c.recipe, c.hash, v, horizon, generation, false);
    // Ahead of the parent but below the gate (0 < t < validation.t), control goal kept: offered as an unconfirmed revision that does
    // not become the training parent. Lineage anchors were not played for it.
    else if (v.stats.mean > 0 && v.controlStats.t > EDNO.guard.t && v.validation.stage !== 'rejected-control') {
      unconfirmed = c.recipe;
      receipt.unconfirmed = true;
      receipt.unconfirmedHash = c.hash;
      receipt.unconfirmedId = revisionId
        ? await revisionId({ parentId, precision: 'w4', ops: c.recipe.ops, controller: c.recipe.tactical })
        : c.hash;
    }
    const val = receipt.validation;
    receipt.reason =
      receipt.status === 'promoted'
        ? 'Validated on fresh seeds and ahead of every lineage anchor'
        : val.stage === 'rejected-early'
          ? 'Candidate fell behind the parent early in validation'
          : val.control.t <= EDNO.guard.t
            ? 'Candidate is significantly worse in the control goal (' + control + ')'
            : val.stats.t < V.t
              ? 'Candidate not significantly better than the parent'
              : val.utilityGain <= 0
                ? 'Candidate did not raise utility'
                : 'A lineage anchor is ahead on the same seeds';
    return receipt;
  }
}
