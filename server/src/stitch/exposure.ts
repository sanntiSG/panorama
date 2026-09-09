import { choleskySolve } from './linalg.js';

export interface ExposurePairSample {
  a: string;
  b: string;
  meanA: number;
  meanB: number;
  weight: number;
}

/**
 * Per-shot multiplicative gain so overlapping shots agree in brightness
 * (the iPhone re-meters exposure on every shot). Solves for log-gains via
 * weighted least squares: minimize sum w*((logGainB-logGainA)-target)^2 +
 * regularization*sum(logGain_i^2), target = log(meanA)-log(meanB) so that
 * gainA*meanA ≈ gainB*meanB after compensation. The regularization term
 * fixes the otherwise-unconstrained global brightness gauge (pulling the
 * average gain toward 1) the same way bundle.ts's prior fixes rotation's
 * gauge.
 */
export function computeExposureGains(
  shotIds: string[],
  samples: ExposurePairSample[],
  regularization = 0.05,
): Map<string, number> {
  const index = new Map(shotIds.map((id, i) => [id, i]));
  const n = shotIds.length;
  const H = new Float64Array(n * n);
  const g = new Float64Array(n);

  for (const s of samples) {
    if (s.meanA <= 1 || s.meanB <= 1) continue; // near-black overlap — too noisy a brightness estimate to trust
    const ia = index.get(s.a)!;
    const ib = index.get(s.b)!;
    const target = Math.log(s.meanA) - Math.log(s.meanB);
    const w = s.weight;

    // residual(logA,logB) = (logB - logA) - target; J = [-1 (wrt A), +1 (wrt B)]
    H[ia * n + ia] += w;
    H[ib * n + ib] += w;
    H[ia * n + ib] -= w;
    H[ib * n + ia] -= w;
    // g = -J^T w r0, r0 at logGain=0 is -target => g[A] -= w*target, g[B] += w*target.
    g[ia] -= w * target;
    g[ib] += w * target;
  }

  for (let i = 0; i < n; i++) H[i * n + i] += regularization;

  const logGains = choleskySolve(H, g, n);
  const gains = new Map<string, number>();
  for (const id of shotIds) gains.set(id, Math.exp(logGains[index.get(id)!]));
  return gains;
}
