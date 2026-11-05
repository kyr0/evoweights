/** Signed-W4 controller readouts that sit on top of Kumo's three action logits (formats in `public/tactical/*.json`). */
import type { CoreDecision } from '../model/kumo.ts';

/** v0.3 readout over visible geometry; Kumo's logits form the residual path. */
export interface GraftWeights {
  format: 'agm.dnp.tactical-graft/1';
  inputs: string[];
  outputs: string[];
  scales: number[];
  codes: number[][];
  transform: {
    maxDistance: number;
    closeWidth: number;
    closingScale: number;
    rearStop: number;
    rearMargin: number;
    angleScale: number;
    fineWidth: number;
  };
}

/** phase-gated melee readout with damage memory. */
export interface CombatWeights {
  format: 'agm.dnp.combat/1';
  inputs: string[];
  outputs: string[];
  codes: number[][];
  scales: number[];
  priorLogitGain: number;
  reach: number;
  foeHalfWidth: number;
  turnScaleDeg: number;
  windupTics: number;
  recoverRange: number;
  approachFrom: number;
  approachMaxBearingDeg: number;
  noTrackScanTics: number;
  memoryTTL: number;
  damageMemoryRange: number;
  damageMinBearingDeg: number;
  damageTurnTics: number;
  rearStop: number;
  rearMargin: number;
}

/** v0.5 single tied coordinate: adds to BACK and subtracts from FORWARD while a nearby actor keeps facing the player. */
export interface FacingWeights {
  format: 'agm.dnp.facing-guard/1';
  input: string;
  output: string;
  code: number;
  scale: number;
  facingDeg: number;
  trackRange: number;
  triggerRange: number;
  durationTics: number;
  pulseTics: number;
  repeatTics: number;
  maxGapTics: number;
  minBackClearance: number;
  protectStrike: boolean;
}

/** The complete editable controller of a W4 revision: 119 signed codes across three readouts. */
export interface Controller {
  graft: GraftWeights;
  combat: CombatWeights;
  facing: FacingWeights;
}

export interface MemoryDiagnostics {
  count: number;
  id: number;
  age: number | null;
  distance: number | null;
  angle: number | null;
  closingSpeed: number | null;
  closingAge: number | null;
  closingDistance: number | null;
  approachBonus: number;
}

export interface GuardDiagnostics {
  targetId: number;
  ageTics: number | null;
  facing: boolean;
  atRisk: boolean;
  pulse: boolean;
  onset: boolean;
  rearBlocked: boolean;
  changed: boolean;
  strikeProtected: boolean;
  feature: number;
  delta: number;
  baselineBackward: boolean | undefined;
  baselineForward: boolean | undefined;
}

/** A live decision as it passes Kumo → graft → combat → facing guard; each stage adds its fields. */
export interface PolicyDecision extends CoreDecision {
  backward?: boolean;
  forward?: boolean;
  backwardLogit?: number;
  forwardLogit?: number;
  coreLogits?: number[];
  memory?: MemoryDiagnostics;
  mode?: string;
  targetId?: number;
  guard?: GuardDiagnostics;
}
