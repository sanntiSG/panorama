import { angularSeparation, cameraFov, qInverse, qRotateVec, type ShotRecord } from '@panorama/shared';

const CAM_FORWARD = { x: 0, y: 0, z: -1 };

export interface CandidatePair {
  a: string;
  b: string;
}

/** How far beyond each camera's own half-FOV (per axis) its neighbor's center may still land and count as "overlapping". Needs to comfortably exceed the plan's ring-to-ring spacing gap (pitchStep - vFov/2, which is `overlap*vFov` short of vFov/2) — see the comment below the rectangular check. */
const AXIS_MARGIN_FRACTION = 0.5;

/**
 * Candidate overlapping pairs from the gyro prior alone: O(n^2) angular
 * comparisons (n ~= 30-40, so under a thousand checks) rather than
 * comparing every image's pixels against every other's.
 *
 * Two-stage test:
 *  1. A cheap circular broad-phase filter (forward-direction angular
 *     distance vs. the diagonal FOV) to avoid the per-pair trig below for
 *     obviously-unrelated shots.
 *  2. A rectangular (per-axis, not diagonal) check of whether either
 *     shot's boresight lands within the other's actual FOV rectangle, with
 *     a margin. This matters specifically near the poles: a ring up there
 *     can have shots on "opposite sides" whose forward directions
 *     converge close together in angular terms (all near the pole) even
 *     though their rectangular frustums barely or don't actually overlap
 *     — a circular distance check alone lets those through as spurious
 *     candidates, while a legitimate ring-to-ring vertical neighbor (whose
 *     center sits *outside* the rectangle on one axis only, by design —
 *     that axis is exactly where the overlap band is) correctly passes.
 *     Found by running tools/synth.ts end-to-end: the circular-only filter
 *     let through near-pole false positives that measurably hurt the
 *     bundle adjustment's residual even with zero injected gyro noise.
 */
export function findCandidatePairs(shots: ShotRecord[], hFov: number, vFov: number): CandidatePair[] {
  // Generous on purpose — this is only a cheap broad-phase reject; the
  // rectangular check below does the real, precise filtering.
  const circularThreshold = 0.85 * Math.max(hFov, vFov);
  const forwards = new Map(shots.map((s) => [s.targetId, qRotateVec(s.quat, CAM_FORWARD)]));
  const halfH = (hFov / 2) * (1 + AXIS_MARGIN_FRACTION);
  const halfV = (vFov / 2) * (1 + AXIS_MARGIN_FRACTION);

  function centerWithinFrame(viewerQuat: ShotRecord['quat'], otherForward: { x: number; y: number; z: number }): boolean {
    const local = qRotateVec(qInverse(viewerQuat), otherForward);
    if (local.z >= -1e-6) return false; // behind the viewer
    const angleX = Math.atan2(local.x, -local.z);
    const angleY = Math.atan2(local.y, -local.z);
    return Math.abs(angleX) < halfH && Math.abs(angleY) < halfV;
  }

  const pairs: CandidatePair[] = [];
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      const a = shots[i];
      const b = shots[j];
      const fa = forwards.get(a.targetId)!;
      const fb = forwards.get(b.targetId)!;
      if (angularSeparation(fa, fb) >= circularThreshold) continue;
      if (centerWithinFrame(a.quat, fb) || centerWithinFrame(b.quat, fa)) {
        pairs.push({ a: a.targetId, b: b.targetId });
      }
    }
  }
  return pairs;
}
