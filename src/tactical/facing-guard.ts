/** One tied signed-W4 coordinate adds to BACK and subtracts from FORWARD. The input
 * measures an uninterrupted run of visible, nearby, player-facing actor yaw samples.
 * Policy deliberately does not observe animation/windup, attacker identity, or hidden actors.
 */
import type { ArenaState } from '../engine/arena.ts';
import type { FacingWeights, GuardDiagnostics, PolicyDecision } from './types.ts';

interface FacingTrack {
  start: number;
  lastPulse: number;
}

export interface FacingGuard {
  reset(): void;
  decide(state: ArenaState, prior: PolicyDecision): PolicyDecision;
}

export function createFacingGuard(k: FacingWeights): FacingGuard {
  if (k.format !== 'agm.dnp.facing-guard/1' || !Number.isInteger(k.code) || Math.abs(k.code) > 7 || !(k.scale > 0))
    throw new Error('Invalid facing-guard weight');
  if (!(k.durationTics > 0 && k.triggerRange <= k.trackRange && k.pulseTics > 0 && k.repeatTics >= k.pulseTics))
    throw new Error('Invalid facing-guard transform');
  const minCos = Math.cos((k.facingDeg * Math.PI) / 180);
  let tracks = new Map<number, FacingTrack>(),
    lastTic: number | null = null,
    strikeUntil = -Infinity,
    strikeId = 0;
  function reset(): void {
    tracks.clear();
    lastTic = null;
    strikeUntil = -Infinity;
    strikeId = 0;
  }
  function decide(s: ArenaState, prior: PolicyDecision): PolicyDecision {
    const tic = s.tic;
    if (lastTic !== null && (tic < lastTic || tic - lastTic > k.maxGapTics)) reset();
    lastTic = tic;
    const next = new Map<number, FacingTrack>(),
      choices: { id: number; age: number; distance: number; track: FacingTrack }[] = [];
    if (s.weapon === 'fist' && !s.weaponSwitching) {
      for (const a of s.actors || []) {
        const cos = Number.isFinite(a.facingCos) ? a.facingCos : Math.cos((a.facingErrorDeg * Math.PI) / 180);
        if (!a.id || !Number.isFinite(cos) || cos < minCos || !(a.distance <= k.trackRange)) continue;
        const track = tracks.get(a.id) || { start: tic, lastPulse: -Infinity };
        next.set(a.id, track);
        const age = tic - track.start;
        if (age >= k.durationTics && a.distance <= k.triggerRange)
          choices.push({ id: a.id, age, distance: a.distance, track });
      }
    }
    tracks = next;
    choices.sort((a, b) => a.distance - b.distance || a.id - b.id);
    const danger = choices[0];
    const onset = !!danger && tic - danger.track.lastPulse >= k.repeatTics;
    if (onset) danger.track.lastPulse = tic;
    const pulse = !!danger && tic - danger.track.lastPulse < k.pulseTics;
    const safe = Number.isFinite(s.threat?.backClearance) && s.threat.backClearance >= k.minBackClearance;
    if (s.events?.punches?.length || s.weapon !== 'fist') {
      strikeUntil = -Infinity;
      strikeId = 0;
    }
    if (s.weapon === 'fist' && s.weaponReady && prior.action === 2) {
      strikeUntil = tic + 6;
      strikeId = prior.targetId || 0;
    }
    const strikeProtected = !!k.protectStrike && !!danger && tic < strikeUntil && strikeId === danger.id;
    const feature = Number(pulse && safe && !strikeProtected);
    const delta = feature * k.code * k.scale;
    const guard: GuardDiagnostics = {
      targetId: danger?.id ?? 0,
      ageTics: danger?.age ?? null,
      facing: tracks.size > 0,
      atRisk: !!danger,
      pulse,
      onset,
      rearBlocked: !!danger && !safe,
      changed: false,
      strikeProtected,
      feature,
      delta,
      baselineBackward: prior.backward,
      baselineForward: prior.forward,
    };
    if (delta === 0) return { ...prior, guard };
    const back =
      (prior.backwardLogit !== undefined && Number.isFinite(prior.backwardLogit)
        ? prior.backwardLogit
        : prior.backward
          ? 1
          : -1) + delta;
    const forward =
      (prior.forwardLogit !== undefined && Number.isFinite(prior.forwardLogit)
        ? prior.forwardLogit
        : prior.forward
          ? 1
          : -1) - delta;
    const backward = back > 0 && back >= forward,
      advance = forward > 0 && forward > back;
    guard.changed = backward !== prior.backward || advance !== prior.forward;
    return { ...prior, backward, forward: advance, backwardLogit: back, forwardLogit: forward, guard };
  }
  return { reset, decide };
}
