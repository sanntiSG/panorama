/**
 * Generates the set of sphere directions ("targets") a full 360°×180°
 * capture needs, given the camera's field of view and a desired overlap
 * between adjacent shots. Pure function of (hFov, vFov, overlap) so both the
 * client (aiming reticles) and the synthetic test bench (tools/synth.ts)
 * produce identical plans.
 *
 * Algorithm: horizontal rings stacked in pitch, stepped by `vFov * (1 -
 * overlap)`, each ring holding `ceil(360° / (hFov * (1-overlap) / cos(pitch)))`
 * shots — the `cos(pitch)` term is what shrinks the shot count near the
 * poles, where a fixed angular step covers more physical sky. Once the next
 * ring's edge would reach the pole, ring generation stops and a single
 * zenith/nadir shot closes the cap instead.
 */

import type { PlanTarget, CapturePlan } from '../types.js';
import type { Vec3 } from '../math/quat.js';
import { directionFromYawPitch } from '../math/spherical.js';

export { directionFromYawPitch, yawPitchFromDirection } from '../math/spherical.js';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;
/** Defensive cap on shots-per-ring: guards against a pathological (fov, overlap) combination putting a ring's pitch within a hair of 90°, where 1/cos(pitch) blows up. */
const MAX_SHOTS_PER_RING = 72;

export function generateCapturePlan(hFov: number, vFov: number, overlap = 0.35): CapturePlan {
  if (overlap <= 0 || overlap >= 1) {
    throw new Error(`overlap must be in (0, 1), got ${overlap}`);
  }

  const pitchStep = vFov * (1 - overlap);
  const ringPitches: number[] = [0];
  let k = 1;
  // Keep adding rings while the *center* of the next one is still short of
  // the pole. This is the same spacing rule used between any two rings
  // (pitchStep = vFov*(1-overlap)), so the last ring ends up overlapping
  // the zenith/nadir cap by the same `vFov*overlap` margin as any other
  // ring-to-ring transition — not a knife's-edge epsilon. (An earlier
  // version stopped as soon as a ring's *outer edge* was merely short of
  // the pole by a tiny fixed epsilon, which could leave only a fraction of
  // a degree of real overlap with the pole cap — thin enough that ordinary
  // measurement noise in the stitcher opened real gaps there; caught by
  // running tools/synth.ts end-to-end, not by the unit-level coverage test
  // below, which checks the *plan* geometrically but not its margin size.)
  while (k * pitchStep < HALF_PI) {
    ringPitches.push(k * pitchStep, -k * pitchStep);
    k++;
  }

  const targets: PlanTarget[] = [];
  let ringSeq = 0;
  for (const pitch of ringPitches) {
    const cosP = Math.cos(pitch);
    const hStep = (hFov * (1 - overlap)) / cosP;
    const count = Math.min(MAX_SHOTS_PER_RING, Math.max(1, Math.ceil(TWO_PI / hStep)));
    // Stagger alternate rings by half a step ("brick" pattern), giving each
    // shot's four neighbours a diagonal offset instead of meeting at a single
    // point — a small but standard improvement for feature-match coverage.
    const stagger = ringSeq % 2 === 1 ? (TWO_PI / count) / 2 : 0;
    const ringIndex = Math.round(pitch / pitchStep);
    for (let i = 0; i < count; i++) {
      const yaw = ((i * TWO_PI) / count + stagger) % TWO_PI;
      targets.push({
        id: `ring${ringIndex}_${i}`,
        kind: 'ring',
        ringIndex,
        direction: directionFromYawPitch(yaw, pitch),
        yaw,
        pitch,
      });
    }
    ringSeq++;
  }

  targets.push({
    id: 'zenith',
    kind: 'zenith',
    ringIndex: Number.POSITIVE_INFINITY,
    direction: { x: 0, y: 0, z: 1 },
    yaw: 0,
    pitch: HALF_PI,
  });
  targets.push({
    id: 'nadir',
    kind: 'nadir',
    ringIndex: Number.NEGATIVE_INFINITY,
    direction: { x: 0, y: 0, z: -1 },
    yaw: 0,
    pitch: -HALF_PI,
  });

  return { targets, hFov, vFov, overlap };
}

/**
 * Of the not-yet-captured targets, the one whose great-circle distance from
 * `currentDirection` is smallest — used to suggest which way to keep
 * rotating so the user sweeps in one consistent direction instead of
 * bouncing around the sphere.
 */
export function suggestNextTarget(
  plan: CapturePlan,
  capturedTargetIds: ReadonlySet<string>,
  currentDirection: Vec3,
): PlanTarget | null {
  let best: PlanTarget | null = null;
  let bestDot = -Infinity;
  for (const t of plan.targets) {
    if (capturedTargetIds.has(t.id)) continue;
    const dot =
      t.direction.x * currentDirection.x + t.direction.y * currentDirection.y + t.direction.z * currentDirection.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = t;
    }
  }
  return best;
}
