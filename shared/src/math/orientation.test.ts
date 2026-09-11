import { describe, expect, it } from 'vitest';
import { applyYawOffset, headingFromQuat, orientationToQuat, reyawQuat } from './orientation.js';
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

describe('applyYawOffset', () => {
  it('shifts heading by exactly the offset while preserving pitch and roll, at a non-degenerate pitch', () => {
    // beta=60 (not 90) so both pitch and roll are away from any of the
    // formula's special cases, and gamma!=0 so there's real roll to preserve.
    const q = orientationToQuat({ alpha: 20, beta: 60, gamma: 15, screenAngle: 0 });
    const offsetDeg = 37;
    const shifted = applyYawOffset(q, (offsetDeg * Math.PI) / 180);

    const headingBefore = headingFromQuat(q);
    const headingAfter = headingFromQuat(shifted);
    const headingDelta = (((headingAfter - headingBefore + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    expect((headingDelta * 180) / Math.PI).toBeCloseTo(offsetDeg, 4);

    const CAM_UP = { x: 0, y: 1, z: 0 };
    const fwdBefore = qRotateVec(q, CAMERA_LOCAL_FORWARD);
    const fwdAfter = qRotateVec(shifted, CAMERA_LOCAL_FORWARD);
    expect(fwdAfter.z).toBeCloseTo(fwdBefore.z, 6); // pitch (elevation) unchanged

    // Roll: angle between camera-local up and the world-up projected onto
    // the view plane should be identical before and after — same check
    // computeRoll (client/src/capture/targeting.ts) performs.
    function rollOf(qq: typeof q) {
      const fwd = qRotateVec(qq, CAMERA_LOCAL_FORWARD);
      const up = qRotateVec(qq, CAM_UP);
      const worldUp = { x: 0, y: 0, z: 1 };
      const dot = worldUp.x * fwd.x + worldUp.y * fwd.y + worldUp.z * fwd.z;
      const levelUp = { x: worldUp.x - dot * fwd.x, y: worldUp.y - dot * fwd.y, z: worldUp.z - dot * fwd.z };
      const len = Math.hypot(levelUp.x, levelUp.y, levelUp.z);
      const n = { x: levelUp.x / len, y: levelUp.y / len, z: levelUp.z / len };
      const cross = { x: up.y * n.z - up.z * n.y, y: up.z * n.x - up.x * n.z, z: up.x * n.y - up.y * n.x };
      const sinA = cross.x * fwd.x + cross.y * fwd.y + cross.z * fwd.z;
      const cosA = up.x * n.x + up.y * n.y + up.z * n.z;
      return Math.atan2(sinA, cosA);
    }
    expect(rollOf(shifted)).toBeCloseTo(rollOf(q), 6);
  });

  it('matches reyawQuat away from the poles, where headingFromQuat is well-conditioned', () => {
    const q = orientationToQuat({ alpha: 200, beta: 45, gamma: -10, screenAngle: 0 });
    const targetHeading = Math.PI / 4;
    const viaReyaw = reyawQuat(q, targetHeading);
    const offset = targetHeading - headingFromQuat(q);
    const viaOffset = applyYawOffset(q, offset);
    expect(headingFromQuat(viaOffset)).toBeCloseTo(headingFromQuat(viaReyaw), 6);
  });
});
