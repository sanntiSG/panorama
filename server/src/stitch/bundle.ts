import {
  qFromAxisAngleVec,
  qInverse,
  qMul,
  qNormalize,
  qToAxisAngleVec,
  qToMat3,
  vecLength,
  type Mat3,
  type Quat,
  type Vec3,
} from '@panorama/shared';
import { IDENTITY_MAT3, addResidualBlock, choleskySolve } from './linalg.js';

export interface PairMeasurement {
  a: string;
  b: string;
  /** From align.ts: world-frame correction such that qMul(correctionVec, initialQuatB) better matches truth, holding `a` fixed. */
  correctionVec: Vec3;
  confidence: number;
}

export interface BundleResult {
  quats: Map<string, Quat>;
  meanResidualRad: number;
  usedPairs: number;
  /** How many accepted (confidence-passing) pairs touch each shot — 0 for a shot with no reliable pairwise measurement at all. Drives render.ts's per-shot trust weighting. */
  acceptedPairs: Map<string, number>;
}

/**
 * Rotation-averaging bundle adjustment: refines each shot's world-frame
 * rotation to be mutually consistent with the pairwise measurements from
 * align.ts, while a weak prior keeps every shot anchored near its gyro
 * reading — that prior is what fixes the overall gauge (there's no
 * absolute reference otherwise) and keeps images with no reliable pair
 * measurement (textureless skies, walls) exactly where the gyro put them,
 * per the plan's degrade-gracefully requirement.
 *
 * Gauss-Newton rather than full Levenberg-Marquardt: the prior term alone
 * guarantees every parameter block is positive-definite, so the normal
 * equations are always solvable without LM's damping/trust-region
 * machinery. Robustness to bad pair measurements instead comes from a
 * Huber-reweighted residual (iteratively reweighted least squares) plus an
 * up-front confidence cutoff.
 */
// Deliberately small relative to a typical (confidence-capped) pair weight
// of up to MAX_PAIR_WEIGHT=30: the prior only needs to (a) fix the overall
// gauge — pairwise residuals alone are invariant to rotating every shot
// together, so *something* has to pin down an absolute reference — and (b)
// anchor shots with no reliable pair at all. It should not meaningfully
// resist a well-supported correction.
const PRIOR_WEIGHT = 1;
// Typical gyro noise is a few degrees (the plan's own estimate: "2-3°"); a
// tighter threshold than that would down-weight *good* measurements during
// the first few iterations, before the solver has had a chance to converge
// toward them — Huber is meant to catch genuinely bad outlier matches
// (tens of degrees off), which the confidence cutoff below mostly already
// filters out.
const HUBER_DELTA_RAD = (8 * Math.PI) / 180;
/** Exported so pipeline.ts's exposure-sampling and per-shot "how was this pose derived" labeling can use the same acceptance bar. */
export const MIN_PAIR_CONFIDENCE = 6;
const MAX_PAIR_WEIGHT = 30;
const ITERATIONS = 15;

interface AcceptedPair extends PairMeasurement {
  relMeasured: Quat;
}

function huberWeight(residualNorm: number): number {
  return residualNorm > HUBER_DELTA_RAD ? HUBER_DELTA_RAD / residualNorm : 1;
}

function computeMeanResidualRad(shotIds: string[], quats: Map<string, Quat>, accepted: AcceptedPair[]): number {
  if (accepted.length === 0) return 0;
  let sumSq = 0;
  for (const pm of accepted) {
    const R0 = qMul(quats.get(pm.b)!, qInverse(quats.get(pm.a)!));
    const residual = qToAxisAngleVec(qMul(R0, qInverse(pm.relMeasured)));
    sumSq += vecLength(residual) ** 2;
  }
  return Math.sqrt(sumSq / accepted.length);
}

export function runBundleAdjustment(
  shotIds: string[],
  initialQuats: Map<string, Quat>,
  pairMeasurements: PairMeasurement[],
): BundleResult {
  const index = new Map(shotIds.map((id, i) => [id, i]));
  const n = shotIds.length;
  const totalParams = 3 * n;
  const current = new Map(initialQuats);

  const accepted: AcceptedPair[] = pairMeasurements
    .filter((m) => m.confidence >= MIN_PAIR_CONFIDENCE && index.has(m.a) && index.has(m.b))
    .map((m) => {
      const initA = initialQuats.get(m.a)!;
      const initB = initialQuats.get(m.b)!;
      const correctedB = qMul(qFromAxisAngleVec(m.correctionVec), initB);
      const relMeasured = qMul(correctedB, qInverse(initA));
      return { ...m, relMeasured };
    });

  const acceptedPairs = new Map<string, number>(shotIds.map((id) => [id, 0]));
  for (const pm of accepted) {
    acceptedPairs.set(pm.a, (acceptedPairs.get(pm.a) ?? 0) + 1);
    acceptedPairs.set(pm.b, (acceptedPairs.get(pm.b) ?? 0) + 1);
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const H = new Float64Array(totalParams * totalParams);
    const g = new Float64Array(totalParams);

    for (const pm of accepted) {
      const ia = index.get(pm.a)!;
      const ib = index.get(pm.b)!;
      const quatA = current.get(pm.a)!;
      const quatB = current.get(pm.b)!;
      const R0 = qMul(quatB, qInverse(quatA));
      const residual = qToAxisAngleVec(qMul(R0, qInverse(pm.relMeasured)));
      const weight = Math.min(pm.confidence, MAX_PAIR_WEIGHT) * huberWeight(vecLength(residual));

      // Residual r = log(R0 * M^-1) with R0 = quatB * quatA^-1, under this
      // loop's left-multiplicative tangent-space perturbations (quat' =
      // exp(eta) * quat, see the update step below). To first order:
      //   dr/d(eta_b) = I
      //   dr/d(eta_a) = -R0   (R0 acting as its 3x3 rotation matrix)
      // This was previously swapped (Identity-ish for A, qToMat3(R0^-1) for
      // B), which happens to be a fair approximation when R0 itself is
      // small (most adjacent-shot pairs: qToMat3(R0^-1) ~= I there too) but
      // is badly wrong for pairs whose relative pose is far from identity —
      // structurally the case for near-pole ring pairs, where it caused the
      // solver to diverge (confirmed via finite-difference comparison and
      // by the exponential residual blowup this produced, worst at exactly
      // 180 deg where qToMat3(R0^-1) flips sign relative to the true I).
      const R0Mat = qToMat3(R0);
      const Ja: Mat3 = [
        -R0Mat[0], -R0Mat[1], -R0Mat[2],
        -R0Mat[3], -R0Mat[4], -R0Mat[5],
        -R0Mat[6], -R0Mat[7], -R0Mat[8],
      ];
      addResidualBlock(
        H,
        g,
        totalParams,
        [
          { index: ia, J: Ja },
          { index: ib, J: IDENTITY_MAT3 },
        ],
        residual,
        weight,
      );
    }

    for (const id of shotIds) {
      const i = index.get(id)!;
      const priorResidual = qToAxisAngleVec(qMul(current.get(id)!, qInverse(initialQuats.get(id)!)));
      addResidualBlock(H, g, totalParams, [{ index: i, J: IDENTITY_MAT3 }], priorResidual, PRIOR_WEIGHT);
    }

    const delta = choleskySolve(H, g, totalParams);

    for (const id of shotIds) {
      const i = index.get(id)!;
      const dvec: Vec3 = { x: delta[i * 3], y: delta[i * 3 + 1], z: delta[i * 3 + 2] };
      current.set(id, qNormalize(qMul(qFromAxisAngleVec(dvec), current.get(id)!)));
    }
  }

  return {
    quats: current,
    meanResidualRad: computeMeanResidualRad(shotIds, current, accepted),
    usedPairs: accepted.length,
    acceptedPairs,
  };
}
