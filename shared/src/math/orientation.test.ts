import { describe, expect, it } from 'vitest';
import { headingFromQuat, orientationToQuat, reyawQuat } from './orientation.js';
import { qRotateVec } from './quat.js';

const CAMERA_LOCAL_FORWARD = { x: 0, y: 0, z: -1 };

function forwardFor(alpha: number, beta: number, gamma: number, screenAngle = 0) {
  const q = orientationToQuat({ alpha, beta, gamma, screenAngle });
  return qRotateVec(q, CAMERA_LOCAL_FORWARD);
}

describe('orientationToQuat physical sanity checks', () => {
  it('flat on a table, screen up (beta=gamma=0): lens points straight down for any alpha', () => {
    for (const alpha of [0, 45, 90, 180, 270, 359]) {
      const fwd = forwardFor(alpha, 0, 0);
      expect(fwd.x).toBeCloseTo(0, 6);
      expect(fwd.y).toBeCloseTo(0, 6);
      expect(fwd.z).toBeCloseTo(-1, 6);
    }
  });

  it('vertical, screen facing the user (beta=90, gamma=0): lens heading tracks alpha', () => {
    // At beta=90 the lens points horizontally; alpha=0 should be due north (+Y),
    // alpha=90 should be due east (+X), matching compass semantics.
    const north = forwardFor(0, 90, 0);
    expect(north.z).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(1, 6);
    expect(north.x).toBeCloseTo(0, 6);

    const east = forwardFor(90, 90, 0);
    expect(east.z).toBeCloseTo(0, 6);
    expect(east.x).toBeCloseTo(1, 6);
    expect(east.y).toBeCloseTo(0, 6);
  });

  it('headingFromQuat recovers alpha in the vertical (beta=90, gamma=0) pose', () => {
    for (const alphaDeg of [0, 30, 90, 145, 200, 300]) {
      const q = orientationToQuat({ alpha: alphaDeg, beta: 90, gamma: 0, screenAngle: 0 });
      const headingRad = headingFromQuat(q);
      const headingDeg = ((headingRad * 180) / Math.PI + 360) % 360;
      expect(headingDeg).toBeCloseTo(alphaDeg, 3);
    }
  });
});

describe('reyawQuat', () => {
  it('changes heading to the target while preserving pitch', () => {
    const q = orientationToQuat({ alpha: 10, beta: 90, gamma: 5, screenAngle: 0 });
    const targetHeading = Math.PI / 2; // east
    const reyawed = reyawQuat(q, targetHeading);
    const newHeading = headingFromQuat(reyawed);
    expect(newHeading).toBeCloseTo(targetHeading, 6);

    // Pitch (elevation of forward vector) should be unchanged by a pure yaw fix.
    const fwdBefore = qRotateVec(q, CAMERA_LOCAL_FORWARD);
    const fwdAfter = qRotateVec(reyawed, CAMERA_LOCAL_FORWARD);
    expect(fwdAfter.z).toBeCloseTo(fwdBefore.z, 6);
  });
});
