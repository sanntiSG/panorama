import {
  cameraFov,
  projectCamDir,
  qInverse,
  qRotateVec,
  yawPitchFromDirection,
  type CameraModel,
  type Quat,
} from '@panorama/shared';
import { equirectPixelToDir } from '@panorama/shared';
import { decodeFullRes } from './decode.js';

export interface RenderShotInput {
  targetId: string;
  filePath: string;
  quat: Quat;
  cam: CameraModel;
  exposureGain: number;
  /**
   * How much to trust this shot's pose, in [MIN_TRUST, 1] — pipeline.ts
   * derives it from how many accepted pairwise measurements support the
   * pose (bundle.ts's acceptedPairs), never 0: a shot with no reliable
   * pairwise measurement at all is exactly the "gyro-only, unverified"
   * case, but it's still the only real image data available where it's the
   * sole contributor (see the `coverage` vs. trust-weighted blend split
   * below), so it must never be discounted to nothing.
   */
  trust: number;
}

/** Floor on `RenderShotInput.trust` — never fully zero, see the field's doc comment. */
export const MIN_TRUST = 0.12;
/** Accepted-pair count at which a shot's trust reaches 1.0 — two independently-agreeing neighbors is already strong corroboration; a lone measurement is nudged only partway there since it hasn't been cross-checked. */
const FULL_TRUST_ACCEPTED_PAIRS = 2;

/** pipeline.ts's mapping from bundle.ts's acceptedPairs count to a render trust weight — a continuous ramp, not all-or-nothing, from MIN_TRUST at 0 pairs to 1.0 at FULL_TRUST_ACCEPTED_PAIRS or more. */
export function trustFromAcceptedPairs(acceptedPairCount: number): number {
  const t = Math.max(0, Math.min(1, acceptedPairCount / FULL_TRUST_ACCEPTED_PAIRS));
  return MIN_TRUST + (1 - MIN_TRUST) * t;
}

const CAM_FORWARD = { x: 0, y: 0, z: -1 };
/** Fraction of each image's half-width/half-height, from center, where the feather blend starts fading to 0 at the edge. */
const FEATHER_START = 0.7;

function featherWeight(nx: number, ny: number): number {
  // Chebyshev (box) distance from center in normalized [-1,1] coords: fades
  // uniformly on both axes rather than favoring a circular center.
  const r = Math.max(Math.abs(nx), Math.abs(ny));
  if (r >= 1) return 0;
  if (r <= FEATHER_START) return 1;
  const t = (r - FEATHER_START) / (1 - FEATHER_START);
  return 1 - t * t * (3 - 2 * t); // smoothstep
}

function bilinearSampleRGB(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  x: number,
  y: number,
): [number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v00 = data[(y0 * width + x0) * channels + k];
    const v10 = data[(y0 * width + x1) * channels + k];
    const v01 = data[(y1 * width + x0) * channels + k];
    const v11 = data[(y1 * width + x1) * channels + k];
    out[k] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  }
  return out;
}

export interface RenderResult {
  /** Raw RGB, row-major, 3 bytes/pixel. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Fraction of output pixels that ended up with no contributing shot at all. */
  uncoveredFraction: number;
}

/**
 * Renders the equirectangular panorama by looping *per source image* (each
 * image only touches the modest region of the output it can actually see)
 * rather than per output pixel querying every image — for a handful of
 * ~4000px-wide sources onto an 8192x4096 output, that's the difference
 * between a few million and tens of millions of samples per image.
 *
 * Blending is a single-band weighted feather (accumulate color*weight and
 * weight, divide at the end) rather than full multi-band/Laplacian
 * blending — a deliberate v1 simplification: it handles the exposure-
 * compensated, geometrically-refined overlaps this pipeline produces
 * reasonably well without the extra complexity, at some cost in seam
 * quality for high-frequency detail crossing a seam.
 *
 * The feather weight is additionally scaled by each shot's `trust` for the
 * actual color blend — a shot fired mid-motion (no reliable pairwise
 * measurement, source='prior-only') gets discounted so a well-supported,
 * overlapping shot dominates instead of ghosting on top of it — but
 * `coverageWeightSum` tracks the *un*-trust-scaled feather weight
 * separately, purely to decide whether a pixel has any real image data at
 * all (uncoveredFraction, the pole-cap fill below). Keeping that decision
 * independent of trust means a low-trust shot that's the *only* coverage
 * for some region still renders there at (nearly) full strength — trust
 * only loses out when a *better-supported* shot overlaps it — rather than
 * that region being wrongly read as a gap. RenderShotInput.trust's MIN_TRUST
 * floor (never 0) is what actually guarantees this mathematically: the
 * weighted-average division below is never by zero wherever there's real
 * coverage.
 */
export async function renderEquirectangular(
  shots: RenderShotInput[],
  outWidth: number,
  outHeight: number,
  onProgress?: (fraction: number) => void,
): Promise<RenderResult> {
  const accum = new Float32Array(outWidth * outHeight * 3);
  const trustWeightSum = new Float32Array(outWidth * outHeight);
  const coverageWeightSum = new Float32Array(outWidth * outHeight);

  for (let s = 0; s < shots.length; s++) {
    const shot = shots[s];
    const full = await decodeFullRes(shot.filePath);
    const invQuat = qInverse(shot.quat);
    const { hFov, vFov } = cameraFov(shot.cam);

    const forward = qRotateVec(shot.quat, CAM_FORWARD);
    const { yaw: centerYaw, pitch: centerPitch } = yawPitchFromDirection(forward);
    const halfDiag = 0.5 * Math.sqrt(hFov * hFov + vFov * vFov) * 1.08; // small safety margin

    const pitchMin = Math.max(-Math.PI / 2, centerPitch - halfDiag);
    const pitchMax = Math.min(Math.PI / 2, centerPitch + halfDiag);
    const rowStart = Math.max(0, Math.floor(((Math.PI / 2 - pitchMax) / Math.PI) * outHeight));
    const rowEnd = Math.min(outHeight - 1, Math.ceil(((Math.PI / 2 - pitchMin) / Math.PI) * outHeight));

    // Near a pole, a modest angular radius covers most/all of the yaw
    // circle (a fixed FOV image's projection in yaw blows up as
    // 1/cos(pitch)) — simplest correct handling is to just scan every
    // column for those rows rather than compute a precise yaw bound.
    const nearPole = Math.cos(Math.max(Math.abs(pitchMin), Math.abs(pitchMax))) < 0.2;
    let colStart = 0;
    let colCount = outWidth;
    if (!nearPole) {
      const yawHalfRange = halfDiag / Math.max(0.2, Math.cos(centerPitch));
      const yawMin = centerYaw - yawHalfRange;
      const yawMax = centerYaw + yawHalfRange;
      const cStart = Math.floor(((yawMin + Math.PI) / (2 * Math.PI)) * outWidth);
      const cEnd = Math.ceil(((yawMax + Math.PI) / (2 * Math.PI)) * outWidth);
      colStart = cStart;
      colCount = Math.min(outWidth, cEnd - cStart);
    }

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let c = 0; c < colCount; c++) {
        const col = (((colStart + c) % outWidth) + outWidth) % outWidth;
        const worldDir = equirectPixelToDir(col, row, outWidth, outHeight);
        const camDir = qRotateVec(invQuat, worldDir);
        const p = projectCamDir(camDir, shot.cam);
        if (!p.visible || p.x < 0 || p.x >= shot.cam.width - 1 || p.y < 0 || p.y >= shot.cam.height - 1) continue;

        const nx = (p.x - shot.cam.width / 2) / (shot.cam.width / 2);
        const ny = (p.y - shot.cam.height / 2) / (shot.cam.height / 2);
        const weight = featherWeight(nx, ny);
        if (weight <= 0) continue;
        const trust = Math.max(MIN_TRUST, Math.min(1, shot.trust));

        const [r, g, b] = bilinearSampleRGB(full.data, full.width, full.height, full.channels, p.x, p.y);
        const outIdx = row * outWidth + col;
        const trustedWeight = weight * trust;
        accum[outIdx * 3 + 0] += r * shot.exposureGain * trustedWeight;
        accum[outIdx * 3 + 1] += g * shot.exposureGain * trustedWeight;
        accum[outIdx * 3 + 2] += b * shot.exposureGain * trustedWeight;
        trustWeightSum[outIdx] += trustedWeight;
        coverageWeightSum[outIdx] += weight;
      }
    }

    onProgress?.((s + 1) / shots.length);
  }

  const data = new Uint8Array(outWidth * outHeight * 3);
  let uncovered = 0;
  for (let i = 0; i < outWidth * outHeight; i++) {
    if (coverageWeightSum[i] <= 1e-6) {
      uncovered++;
      continue;
    }
    // trustWeightSum is guaranteed > 0 here too: MIN_TRUST > 0 and
    // coverageWeightSum > 0 means at least one shot contributed a positive
    // (weight * trust) term above.
    const w = trustWeightSum[i];
    for (let k = 0; k < 3; k++) {
      data[i * 3 + k] = Math.max(0, Math.min(255, Math.round(accum[i * 3 + k] / w)));
    }
  }

  fillUncoveredPoleCap(data, coverageWeightSum, outWidth, outHeight, 'top');
  fillUncoveredPoleCap(data, coverageWeightSum, outWidth, outHeight, 'bottom');

  return { data, width: outWidth, height: outHeight, uncoveredFraction: uncovered / (outWidth * outHeight) };
}

const POLE_CAP_COVERAGE_THRESHOLD = 0.7;
const POLE_CAP_BLUR_RADIUS = 15;

/**
 * If the zenith/nadir shot was skipped (or otherwise didn't cover its
 * pole), the render loop above leaves that cap solid black. This smears
 * the nearest fully-covered row across the gap and softens it with a
 * horizontal blur — a cheap stand-in for "a blurred patch" that at least
 * avoids a jarring black disc at the top/bottom of the sphere. Purely
 * additive: only ever touches pixels the main loop left uncovered.
 */
export function fillUncoveredPoleCap(
  data: Uint8Array,
  coverageWeightSum: Float32Array,
  width: number,
  height: number,
  which: 'top' | 'bottom',
): void {
  const rowSequence: number[] = [];
  if (which === 'top') {
    for (let r = 0; r < height; r++) rowSequence.push(r);
  } else {
    for (let r = height - 1; r >= 0; r--) rowSequence.push(r);
  }

  let boundaryRow = -1;
  for (const row of rowSequence) {
    let covered = 0;
    const base = row * width;
    for (let x = 0; x < width; x++) if (coverageWeightSum[base + x] > 1e-6) covered++;
    if (covered / width >= POLE_CAP_COVERAGE_THRESHOLD) {
      boundaryRow = row;
      break;
    }
  }
  if (boundaryRow === -1) return; // nothing usable in this hemisphere at all — leave it black rather than guess

  const capStart = which === 'top' ? 0 : boundaryRow + 1;
  const capEnd = which === 'top' ? boundaryRow : height;
  if (capStart >= capEnd) return; // no gap to fill

  // Smear the boundary row's own per-column colors across every uncovered
  // row of the cap (rows that already have real coverage — e.g. a partial
  // ring reaching partway into the cap — are left untouched).
  for (let row = capStart; row < capEnd; row++) {
    for (let x = 0; x < width; x++) {
      const idx = row * width + x;
      if (coverageWeightSum[idx] > 1e-6) continue;
      const srcIdx = boundaryRow * width + x;
      data[idx * 3 + 0] = data[srcIdx * 3 + 0];
      data[idx * 3 + 1] = data[srcIdx * 3 + 1];
      data[idx * 3 + 2] = data[srcIdx * 3 + 2];
    }
  }

  boxBlurHorizontal(data, width, capStart, capEnd, POLE_CAP_BLUR_RADIUS);
}

/**
 * In-place horizontal box blur over rows [rowStart, rowEnd), wrapping at
 * the yaw seam (column 0 meets column width-1). Simple O(rows*width*radius)
 * scan rather than a running-sum sliding window — correctness over
 * micro-optimization, since this only ever runs over a small polar cap.
 */
function boxBlurHorizontal(data: Uint8Array, width: number, rowStart: number, rowEnd: number, radius: number): void {
  const rows = rowEnd - rowStart;
  const src = new Uint8Array(rows * width * 3);
  src.set(data.subarray(rowStart * width * 3, rowEnd * width * 3));
  const windowSize = radius * 2 + 1;

  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = ((x + dx) % width + width) % width;
          sum += src[(r * width + sx) * 3 + k];
        }
        data[((rowStart + r) * width + x) * 3 + k] = Math.round(sum / windowSize);
      }
    }
  }
}
