import { describe, expect, it } from 'vitest';
import {
  projectCamDir,
  qFromAxisAngleVec,
  qInverse,
  qMul,
  qRotateVec,
  quatLookingAt,
  vecLength,
  vecSub,
  type CameraModel,
  type Quat,
  type Vec3,
} from '@panorama/shared';
import { estimateRotationCorrection, type AlignImage } from './align.js';

const CAM_SIZE = 480;
const CAM_FOV = (50 * Math.PI) / 180;
const PATCH_FOV = (32 * Math.PI) / 180;

function testCam(): CameraModel {
  return { width: CAM_SIZE, height: CAM_SIZE, focalPx: CAM_SIZE / 2 / Math.tan(CAM_FOV / 2) };
}

interface WorldPoint {
  dir: Vec3;
  amp: number;
}

/** Deterministic PRNG so the synthetic scene is reproducible across runs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeScene(centerYaw: number, angularRadius: number, count: number, seed: number): WorldPoint[] {
  const rand = mulberry32(seed);
  const points: WorldPoint[] = [];
  for (let i = 0; i < count; i++) {
    const yaw = centerYaw + (rand() - 0.5) * 2 * angularRadius;
    const pitch = (rand() - 0.5) * 2 * angularRadius;
    const cp = Math.cos(pitch);
    points.push({
      dir: { x: cp * Math.sin(yaw), y: cp * Math.cos(yaw), z: Math.sin(pitch) },
      amp: 100 + rand() * 100,
    });
  }
  return points;
}

/** Renders a synthetic photo (grayscale) of `points` as seen by a camera at `quat`. */
function renderShot(points: WorldPoint[], quat: Quat, cam: CameraModel): Float32Array {
  const gray = new Float32Array(cam.width * cam.height).fill(50);
  const invQuat = qInverse(quat);
  for (const pt of points) {
    const camDir = qRotateVec(invQuat, pt.dir);
    const p = projectCamDir(camDir, cam);
    if (!p.visible) continue;
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || x >= cam.width || y < 0 || y >= cam.height) continue;
        const d2 = ox * ox + oy * oy;
        gray[y * cam.width + x] += pt.amp * Math.exp(-d2 / 3);
      }
    }
  }
  return gray;
}

function vecClose(a: Vec3, b: Vec3, tolRad: number): boolean {
  return vecLength(vecSub(a, b)) < tolRad;
}

/**
 * End-to-end numerical check of align.ts's geometry conversion against a
 * fully synthetic scene with a KNOWN injected rotation error — this class
 * of small-rotation sign math has produced real bugs elsewhere in this
 * codebase (see orientation.ts's history), so it's verified by measurement
 * here rather than trusted from the derivation alone.
 */
describe('estimateRotationCorrection recovers a known synthetic rotation error', () => {
  const YAW_STEP = (20 * Math.PI) / 180;
  const scene = makeScene(YAW_STEP / 2, (35 * Math.PI) / 180, 40, 99);

  // Note: no case rotates purely about world-Y here. camA looks along
  // world-Y (yaw=0) and camB is only 20° away in yaw, so world-Y is nearly
  // parallel to both cameras' boresight for this geometry — i.e. nearly a
  // pure roll, which a single patch's translation measurement fundamentally
  // cannot resolve (see align.ts's doc comment). That's a correct property
  // of the method, not a bug: confirmed by checking that case separately
  // produces a small, noisy correction alongside a *much* lower confidence
  // score (~49 vs ~90-120 for the resolvable axes below) — the bundle
  // adjuster relies on pairs at other relative geometries (and the gyro
  // prior) to constrain what any single pair can't.
  const cases: Array<{ label: string; errorAxis: Vec3; errorDeg: number }> = [
    { label: 'pure world-Z (yaw) error', errorAxis: { x: 0, y: 0, z: 1 }, errorDeg: 2 },
    { label: 'pure world-X error', errorAxis: { x: 1, y: 0, z: 0 }, errorDeg: 2 },
    { label: 'mixed X/Z error (away from boresight)', errorAxis: { x: 0.6, y: 0, z: 0.8 }, errorDeg: 2 },
    { label: 'negative world-Z error', errorAxis: { x: 0, y: 0, z: 1 }, errorDeg: -2 },
  ];

  for (const { label, errorAxis, errorDeg } of cases) {
    it(`recovers ${label}`, () => {
      const cam = testCam();
      const trueQuatA = quatLookingAt(0, 0, 0);
      const trueQuatB = quatLookingAt(YAW_STEP, 0, 0);

      const errorVec: Vec3 = {
        x: errorAxis.x * (errorDeg * Math.PI) / 180,
        y: errorAxis.y * (errorDeg * Math.PI) / 180,
        z: errorAxis.z * (errorDeg * Math.PI) / 180,
      };
      const E = qFromAxisAngleVec(errorVec);
      // trueQuatB = E ∘ guessQuatB  =>  guessQuatB = E^-1 ∘ trueQuatB
      const guessQuatB = qMul(qInverse(E), trueQuatB);

      const a: AlignImage = {
        targetId: 'a',
        quat: trueQuatA,
        gray: renderShot(scene, trueQuatA, cam),
        width: cam.width,
        height: cam.height,
        focalPx: cam.focalPx,
      };
      const b: AlignImage = {
        targetId: 'b',
        quat: guessQuatB, // deliberately wrong — this is what samplePatch will use
        gray: renderShot(scene, trueQuatB, cam), // real photo, taken at the TRUE pose
        width: cam.width,
        height: cam.height,
        focalPx: cam.focalPx,
      };

      const result = estimateRotationCorrection(a, b, PATCH_FOV);
      expect(result.confidence).toBeGreaterThan(3);

      // The recovered correction should approximate `errorVec` (within
      // ~30% — this is a coarse, patch-based estimate, not exact).
      const tol = Math.max(0.3 * vecLength(errorVec), (0.3 * Math.PI) / 180);
      expect(vecClose(result.correctionVec, errorVec, tol)).toBe(true);
    });
  }
});
