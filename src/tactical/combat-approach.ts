/** editable phase-gated neural readout. No accesses to invisible game actors.
 * A memory entry stores a last visible world-space position, never the actor's true hidden position.
 */
import type { Actor, ArenaState, Pose } from '../engine/arena.ts';
import { recordApproach, rankRemembered, type ApproachTrack, type RankedCandidate } from './approach-memory.ts';
import type { CombatWeights, MemoryDiagnostics, PolicyDecision } from './types.ts';

const sat = (x: number) => Math.max(0, Math.min(1, x));
const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => ((a + 540) % 360) - 180;

type MeasuredActor = Actor & { angle: number };

interface MemoryEntry extends ApproachTrack {
  id: number;
  x: number;
  y: number;
  when: number;
}

export interface RememberedActor extends MemoryEntry, RankedCandidate {
  angle: number;
}

export interface Observation {
  list: MeasuredActor[];
  opportunity: RememberedActor | null;
  target: RememberedActor | null;
  damage: number;
  size: number;
  ranking: { firstWithoutApproach: number; candidateCount: number };
}

function angleTo(p: Pose, x: number, y: number): number {
  return wrap(deg(Math.atan2(y - p.y, x - p.x)) - p.yawDeg);
}

function measuredActor(a: Actor, s: ArenaState): MeasuredActor {
  return { ...a, angle: Number.isFinite(a.relativeYawDeg) ? a.relativeYawDeg : angleTo(s.pose, a.worldX, a.worldY) };
}

function eligible(a: MeasuredActor, k: CombatWeights): { center: boolean; reach: boolean; hittable: boolean } {
  const cone = deg(Math.atan2(k.foeHalfWidth, Math.max(1, a.distance)));
  const center = a.aligned || Math.abs(a.angle) <= cone;
  const impactRange = a.distance - Math.min(12, Math.max(0, a.closing || 0)) * 4;
  return { center, reach: impactRange <= k.reach, hittable: center && impactRange <= k.reach };
}

export function createObservationMemory(k: CombatWeights) {
  let entries = new Map<number, MemoryEntry>(),
    priorTic = -1,
    previousKills = 0,
    priorHealth: number | null = null,
    locked = 0,
    until = -1;
  function reset(): void {
    entries = new Map();
    priorTic = -1;
    previousKills = 0;
    priorHealth = null;
    locked = 0;
    until = -1;
  }
  function observe(s: ArenaState): Observation {
    if (s.tic < priorTic) reset();
    const now = s.tic,
      pose = s.pose,
      list = (s.actors || []).map((a) => measuredActor(a, s));
    const visible = new Set(list.map((a) => a.id));
    const damage = Number.isFinite(s.events?.damage)
      ? s.events.damage
      : priorHealth === null
        ? 0
        : Math.max(0, priorHealth - s.health);
    const confirmed = [...(s.events?.shots || []), ...(s.events?.punches || [])].filter((a) => a.hit && a.targetId > 0);
    if (s.kills > previousKills && confirmed.length === 1) entries.delete(confirmed[0].targetId);
    for (const [id, a] of entries) {
      if (now - a.when > k.memoryTTL) entries.delete(id);
    }
    for (const a of list) {
      if (a.id && Number.isFinite(a.worldX) && Number.isFinite(a.worldY))
        entries.set(a.id, {
          id: a.id,
          x: a.worldX,
          y: a.worldY,
          when: now,
          ...recordApproach(entries.get(a.id), a, now),
        });
    }
    const candidates: RememberedActor[] = [];
    for (const a of entries.values()) {
      if (visible.has(a.id)) continue;
      const distance = Math.hypot(a.x - pose.x, a.y - pose.y),
        angle = angleTo(pose, a.x, a.y);
      if (distance <= k.damageMemoryRange && Math.abs(angle) >= k.damageMinBearingDeg)
        candidates.push({ ...a, age: now - a.when, distance, angle });
    }
    const ranking = rankRemembered(candidates, now, k.damageMemoryRange);
    const hitNow = list.some((a) => eligible(a, k).hittable);
    const opportunity = damage > 0 && !hitNow && candidates.length > 0 ? candidates[0] : null;
    if (opportunity) {
      locked = opportunity.id;
      until = now + k.damageTurnTics;
    }
    const target = !hitNow && now < until ? candidates.find((a) => a.id === locked) : null;
    if (!target) {
      locked = 0;
      until = -1;
    }
    priorTic = now;
    priorHealth = s.health;
    previousKills = s.kills;
    return { list, opportunity, target: target || null, damage, size: entries.size, ranking };
  }
  return { reset, observe };
}

export interface CombatController {
  reset(): void;
  decide(state: ArenaState, prior: PolicyDecision): PolicyDecision;
}

export function createCombatController(
  k: CombatWeights,
  { memory = true, melee = true }: { memory?: boolean; melee?: boolean } = {},
): CombatController {
  if (
    k.format !== 'agm.dnp.combat/1' ||
    k.codes.length !== 6 ||
    k.codes.some((r) => r.length !== k.inputs.length || r.some((w) => !Number.isInteger(w) || w < -7 || w > 7))
  )
    throw new Error('Invalid v4 readout codes');
  const history = createObservationMemory(k);
  let lastStrike = -Infinity,
    lastTic = -1,
    scanUntil = -1,
    scanSign = 1,
    lastTurn = 0;
  function reset(): void {
    history.reset();
    lastStrike = -Infinity;
    lastTic = -1;
    scanUntil = -1;
    scanSign = 1;
    lastTurn = 0;
  }
  function decide(s: ArenaState, prior: PolicyDecision): PolicyDecision {
    if (s.tic < lastTic) reset();
    const o = history.observe(s),
      remembered = memory ? o.target : null;
    const diag: MemoryDiagnostics = {
      count: o.size,
      id: remembered?.id || 0,
      age: remembered?.age ?? null,
      distance: remembered?.distance ?? null,
      angle: remembered?.angle ?? null,
      closingSpeed: remembered?.closingSpeed ?? null,
      closingAge: remembered?.closingTic == null ? null : s.tic - remembered.closingTic,
      closingDistance: remembered?.closingDistance ?? null,
      approachBonus: remembered?.approachBonus ?? 0,
    };
    lastTic = s.tic;
    let seen: MeasuredActor | null = null;
    if (melee && s.weapon === 'fist' && !s.weaponSwitching && o.list.length) {
      // Choose the closest punchable visible actor first, then the closest visible actor for approach/turning.
      const actors = [...o.list].sort((a, b) => a.distance - b.distance || a.id - b.id);
      seen = actors.find((a) => eligible(a, k).hittable) || actors[0];
    }
    const distant = o.list.length > 0 && o.list.every((a) => a.distance > k.damageMemoryRange);
    if (memory && k.noTrackScanTics > 0 && distant && !remembered && o.damage > 0) {
      scanUntil = s.tic + k.noTrackScanTics;
      scanSign = lastTurn || -scanSign;
    }
    if (remembered || o.list.some((a) => a.distance <= k.damageMemoryRange)) scanUntil = -1;
    const scan = memory && !remembered && s.tic < scanUntil;
    if (!seen && !remembered && !scan) {
      if (prior.action < 2) lastTurn = prior.action === 0 ? 1 : -1;
      return { ...prior, forward: false, memory: diag, mode: 'prior' };
    }
    if (s.events?.punches?.length) lastStrike = -Infinity;
    // Past the early return, at least one of remembered, scan and seen holds.
    const target = (remembered || (scan ? { id: 0, angle: scanSign * k.turnScaleDeg } : seen)) as {
        id: number;
        angle: number;
      },
      angle = target.angle;
    const fwd = seen ? eligible(seen, k) : { center: false, reach: false, hittable: false };
    const isMemory = !!remembered || scan;
    // Without memory or scan, `seen` is set.
    const seenDistance = seen ? seen.distance : NaN;
    const winding = !isMemory && s.tic - lastStrike < k.windupTics;
    const ready = !isMemory && s.weaponReady;
    const recover = !isMemory && !ready && !winding && seenDistance < k.recoverRange;
    const approach =
      !isMemory && (ready || winding) && seenDistance > k.approachFrom && Math.abs(angle) < k.approachMaxBearingDeg;
    const strike = ready && fwd.hittable;
    const left = sat(angle / k.turnScaleDeg),
      right = sat(-angle / k.turnScaleDeg);
    const blocked = sat((k.rearStop + k.rearMargin - s.threat.backClearance) / k.rearMargin);
    const f = [
      1,
      isMemory ? 0 : left,
      isMemory ? 0 : right,
      Number(!isMemory && fwd.center),
      Number(strike),
      Number(winding),
      Number(recover),
      Number(approach),
      blocked,
      isMemory ? left : 0,
      isMemory ? right : 0,
    ];
    const z = k.codes.map(
      (row, r) =>
        row.reduce((a, w, i) => a + w * f[i], 0) * k.scales[r] + (r < 3 ? k.priorLogitGain * prior.logits[r] : 0),
    );
    const logits = z.slice(0, 4),
      action = logits.indexOf(Math.max(...logits));
    if (action === 2 && ready && s.tic > lastStrike + k.windupTics) lastStrike = s.tic;
    if (action < 2) lastTurn = action === 0 ? 1 : -1;
    return {
      ...prior,
      action,
      logits,
      backward: z[4] > 0 && z[4] >= z[5],
      forward: z[5] > 0 && z[5] > z[4],
      backwardLogit: z[4],
      forwardLogit: z[5],
      memory: diag,
      mode: scan ? 'damage-scan' : isMemory ? 'damage-memory' : 'melee',
      targetId: target.id,
    };
  }
  return { reset, decide };
}
