import { describe, expect, it } from 'vitest';
import { generateCapturePlan, suggestNextTarget } from './capturePlan.js';
import { quatLookingAt } from '../math/spherical.js';
import { worldDirToScreen, angularSeparation } from '../math/camera.js';
import type { CameraModel } from '../math/camera.js';

const HFOV = (49 * Math.PI) / 180;
const VFOV = (63 * Math.PI) / 180;
const OVERLAP = 0.35;

/** Deterministic PRNG (mulberry32) so the 100k-sample coverage test is reproducible. */
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

function randomDirection(rand: () => number) {
  // Uniform sampling on the sphere.
  const z = rand() * 2 - 1;
  const theta = rand() * 2 * Math.PI;
  const r = Math.sqrt(1 - z * z);
  return { x: r * Math.cos(theta), y: r * Math.sin(theta), z };
}

describe('generateCapturePlan', () => {
  it('produces a reasonable shot count for typical phone FOV (~sanity, not exact)', () => {
    const plan = generateCapturePlan(HFOV, VFOV, OVERLAP);
    expect(plan.targets.length).toBeGreaterThan(15);
    expect(plan.targets.length).toBeLessThan(60);
    expect(plan.targets.filter((t) => t.kind === 'zenith')).toHaveLength(1);
    expect(plan.targets.filter((t) => t.kind === 'nadir')).toHaveLength(1);
  });

  it('every target id is unique', () => {
    const plan = generateCapturePlan(HFOV, VFOV, OVERLAP);
    const ids = new Set(plan.targets.map((t) => t.id));
    expect(ids.size).toBe(plan.targets.length);
  });

  it('rejects invalid overlap values', () => {
    expect(() => generateCapturePlan(HFOV, VFOV, 0)).toThrow();
    expect(() => generateCapturePlan(HFOV, VFOV, 1)).toThrow();
  });

  it('COVERAGE: every direction on the sphere falls inside at least one target frustum', () => {
    const plan = generateCapturePlan(HFOV, VFOV, OVERLAP);
    const cam: CameraModel = { width: 1000, height: 1000, focalPx: 0 };
    // Re-derive focal from the *plan's* fov so the synthetic frustum matches
    // the geometry the plan was generated for.
    cam.focalPx = 1000 / 2 / Math.tan(HFOV / 2);
    const camV = 1000 / 2 / Math.tan(VFOV / 2);
    // Use non-square pixels conceptually by testing each axis independently
    // isn't possible with a single focal; instead build the camera model at
    // an aspect ratio matching hFov/vFov so both axes use the same focal.
    const width = 1000;
    const height = Math.round(width * (Math.tan(VFOV / 2) / Math.tan(HFOV / 2)));
    const testCam: CameraModel = { width, height, focalPx: cam.focalPx };

    const ringTargets = plan.targets.filter((t) => t.kind === 'ring');
    const ringQuats = ringTargets.map((t) => quatLookingAt(t.yaw, t.pitch, 0));

    // Any direction within this angular radius of a pole is guaranteed
    // covered by that pole's shot regardless of the roll it was captured at
    // (a rectangle inscribes a disk of radius = half the *smaller* FOV axis).
    const poleGuaranteedRadius = Math.min(HFOV, VFOV) / 2;

    const rand = mulberry32(1234);
    const N = 100_000;
    let uncovered = 0;
    let firstFailure: { x: number; y: number; z: number } | null = null;

    for (let i = 0; i < N; i++) {
      const dir = randomDirection(rand);

      if (angularSeparation(dir, { x: 0, y: 0, z: 1 }) < poleGuaranteedRadius) continue;
      if (angularSeparation(dir, { x: 0, y: 0, z: -1 }) < poleGuaranteedRadius) continue;

      let covered = false;
      for (const q of ringQuats) {
        const p = worldDirToScreen(dir, q, testCam);
        if (p.visible && p.x >= 0 && p.x < testCam.width && p.y >= 0 && p.y < testCam.height) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        uncovered++;
        if (!firstFailure) firstFailure = dir;
      }
    }

    if (uncovered > 0) {
      // eslint-disable-next-line no-console
      console.error(`Uncovered: ${uncovered}/${N}, first at`, firstFailure);
    }
    expect(uncovered).toBe(0);
  });
});

describe('pole cap overlap margin', () => {
  // Regression test for a real bug found by running tools/synth.ts
  // end-to-end (not caught by the coverage test above, which checks the
  // *geometry* but not the *margin size*): the last ring before each pole
  // must overlap the zenith/nadir shot by close to the same fraction as any
  // other ring-to-ring transition, or ordinary stitching noise opens a
  // visible gap right at the pole.
  it.each([
    [(49 * Math.PI) / 180, (63 * Math.PI) / 180, 0.35],
    [(55 * Math.PI) / 180, (55 * Math.PI) / 180, 0.35],
    [(70 * Math.PI) / 180, (50 * Math.PI) / 180, 0.3],
    [(40 * Math.PI) / 180, (40 * Math.PI) / 180, 0.45],
  ])('hFov=%d vFov=%d overlap=%d: last ring overlaps the pole cap by close to vFov*overlap', (hFov, vFov, overlap) => {
    const plan = generateCapturePlan(hFov, vFov, overlap);
    const ringPitches = [...new Set(plan.targets.filter((t) => t.kind === 'ring').map((t) => t.pitch))];
    const maxRingPitch = Math.max(...ringPitches);
    const lastRingOuterEdge = maxRingPitch + vFov / 2;
    const zenithLowerEdge = Math.PI / 2 - vFov / 2;
    const marginRad = lastRingOuterEdge - zenithLowerEdge;

    expect(marginRad).toBeGreaterThan(0);
    // Should be in the same ballpark as a normal ring-to-ring overlap
    // (vFov*overlap), not a razor-thin fraction of a degree.
    expect(marginRad).toBeGreaterThan(vFov * overlap * 0.3);
  });
});

describe('suggestNextTarget', () => {
  it('suggests the closest uncaptured target to the current direction', () => {
    const plan = generateCapturePlan(HFOV, VFOV, OVERLAP);
    const captured = new Set<string>();
    const current = { x: 0, y: 1, z: 0 }; // due north, level
    const suggestion = suggestNextTarget(plan, captured, current);
    expect(suggestion).not.toBeNull();
    // The suggestion should be at least as close as any other uncaptured target.
    const bestDist = angularSeparation(current, suggestion!.direction);
    for (const t of plan.targets) {
      expect(angularSeparation(current, t.direction)).toBeGreaterThanOrEqual(bestDist - 1e-9);
    }
  });

  it('returns null once everything is captured', () => {
    const plan = generateCapturePlan(HFOV, VFOV, OVERLAP);
    const captured = new Set(plan.targets.map((t) => t.id));
    expect(suggestNextTarget(plan, captured, { x: 0, y: 1, z: 0 })).toBeNull();
  });
});
