import {
  focalFromFov,
  projectCamDir,
  qInverse,
  qRotateVec,
  quatLookingAt,
  unprojectToCamDir,
  vecAdd,
  vecNormalize,
  yawPitchFromDirection,
  type CameraModel,
  type Quat,
  type Vec3,
} from '@panorama/shared';
import { phaseCorrelate } from './fft.js';

/** Must be a power of 2 (required by fft2d). 128 is a good balance of angular resolution vs FFT cost for ~30 pairs. */
export const PATCH_SIZE = 128;

export interface AlignImage {
  targetId: string;
  quat: Quat;
  gray: Float32Array;
  width: number;
  height: number;
  focalPx: number;
}

export interface PairAlignment {
  a: string;
  b: string;
  /** World-frame small-rotation correction for `b`, i.e. improvedQuatB = correction ∘ b.quat, holding `a` fixed. */
  correctionVec: Vec3;
  confidence: number;
  /** Diagnostic passthrough from phaseCorrelate: near 1 means a competing peak (e.g. repetitive texture) made the match ambiguous — confidence above already reflects this, this is just for debugging/labeling. */
  ambiguityRatio: number;
}

function bilinearSample(data: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = data[y0 * w + x0];
  const v10 = data[y0 * w + x1];
  const v01 = data[y1 * w + x0];
  const v11 = data[y1 * w + x1];
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

/**
 * Resamples `img` onto a `size`x`size` patch pointed at `patchOrientation`
 * with field of view `patchCam`, using `img.quat` as the current
 * best-estimate of where the photo was actually taken. Pixels outside
 * img's frame are filled with the patch's own mean (a bland fill, so the
 * FFT sees a smooth edge instead of a false hard boundary).
 */
export interface SampledPatch {
  data: Float32Array;
  /** Fraction of patch pixels that came from real image data rather than the mean-fill (see below). */
  validFraction: number;
}

export function samplePatch(img: AlignImage, patchOrientation: Quat, patchCam: CameraModel, size: number): SampledPatch {
  const out = new Float32Array(size * size);
  const invQuat = qInverse(img.quat);
  const srcCam: CameraModel = { width: img.width, height: img.height, focalPx: img.focalPx };
  let sum = 0;
  let count = 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const localDir = unprojectToCamDir(px + 0.5, py + 0.5, patchCam);
      const worldDir = qRotateVec(patchOrientation, localDir);
      const camDir = qRotateVec(invQuat, worldDir);
      const p = projectCamDir(camDir, srcCam);
      const idx = py * size + px;
      if (p.visible && p.x >= 0 && p.x < img.width - 1 && p.y >= 0 && p.y < img.height - 1) {
        const v = bilinearSample(img.gray, img.width, img.height, p.x, p.y);
        out[idx] = v;
        sum += v;
        count++;
      } else {
        out[idx] = Number.NaN;
      }
    }
  }
  const mean = count > 0 ? sum / count : 128;
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = mean;
  return { data: out, validFraction: count / (size * size) };
}

/**
 * Estimates a small world-frame rotation correction for `b` (holding `a`
 * fixed) from the content both photos share in their overlap, by
 * resampling both onto a common tangent-plane patch and running phase
 * correlation. See align.test.ts for the derivation's numerical
 * verification against a fully synthetic scene with known ground truth —
 * this exact class of small-rotation geometry has bitten this codebase
 * with sign errors before (orientation.ts), so it isn't trusted on
 * algebra alone.
 *
 * Known, expected limitation: a rotation about (or near) the patch's own
 * boresight — i.e. close to a pure roll for this particular pair — shifts
 * the patch center by ~0 to first order, so a single pair's measurement
 * can't resolve that component (confirmed in align.test.ts). This isn't a
 * bug: bundle.ts's rotation averaging combines many pairs at different
 * relative geometries plus the gyro prior, and each pair's blind axis is
 * generally a different direction in world space, so the combined system
 * is still well constrained even though any one pair has a blind spot.
 */
/** The tangent-plane orientation both shots of a pair get resampled onto: pointed at the midpoint of their forward directions, level (roll=0). */
export function patchOrientationForPair(a: AlignImage, b: AlignImage): Quat {
  const forwardA = qRotateVec(a.quat, { x: 0, y: 0, z: -1 });
  const forwardB = qRotateVec(b.quat, { x: 0, y: 0, z: -1 });
  const mid = vecNormalize(vecAdd(forwardA, forwardB));
  const { yaw, pitch } = yawPitchFromDirection(mid);
  return quatLookingAt(yaw, pitch, 0);
}

export function estimateRotationCorrection(a: AlignImage, b: AlignImage, patchFov: number): PairAlignment {
  const patchOrientation = patchOrientationForPair(a, b);
  const patchCam: CameraModel = { width: PATCH_SIZE, height: PATCH_SIZE, focalPx: focalFromFov(PATCH_SIZE, patchFov) };

  const patchA = samplePatch(a, patchOrientation, patchCam, PATCH_SIZE);
  const patchB = samplePatch(b, patchOrientation, patchCam, PATCH_SIZE);

  const { dx, dy, confidence: rawConfidence, ambiguityRatio } = phaseCorrelate(patchA.data, patchB.data, PATCH_SIZE);
  // Confirmed convention (fft.test.ts): patchB(x,y) = patchA(x-dx, y-dy).
  // See align.test.ts for the full derivation this implements: the tangent-
  // plane shift (dx,dy) maps to a world-frame small-rotation axis-angle
  // vector via the patch's own local (right,up,forward) basis.
  const dxRad = dx / patchCam.focalPx;
  const dyRad = dy / patchCam.focalPx;
  const localVec: Vec3 = { x: dyRad, y: dxRad, z: 0 };
  const correctionVec = qRotateVec(patchOrientation, localVec);

  // When most of a patch is mean-fill rather than real image data (little
  // actual overlap — e.g. two shots whose *forward directions* happen to
  // be close near a pole even though their rectangular frustums barely
  // overlap), phase correlation can still report a deceptively sharp peak:
  // two mostly-flat fields correlate trivially, and the small amount of
  // real structure that happens to be present dominates the confidence
  // statistic out of proportion to how trustworthy the measurement
  // actually is. Multiplying by both coverage fractions discounts exactly
  // that case. Found the same way as everything else risky in this file:
  // by running tools/synth.ts end-to-end, not by algebra.
  const confidence = rawConfidence * patchA.validFraction * patchB.validFraction;

  return { a: a.targetId, b: b.targetId, correctionVec, confidence, ambiguityRatio };
}
