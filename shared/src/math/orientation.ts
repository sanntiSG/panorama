/**
 * Converts W3C `deviceorientation` angles into the world-frame quaternion
 * used everywhere else in the app.
 *
 * Starts from the DeviceOrientation Event Specification's reference rotation
 * matrix, R(alpha, beta, gamma) = Rz(alpha) · Rx(beta) · Ry(gamma) — the
 * intrinsic Z-X'-Y'' composition matching the spec's angle semantics (alpha
 * rotates about the device's own Z, then beta about the resulting X, then
 * gamma about the resulting Y) — mapping a vector in the device's own frame
 * (X right, Y toward top edge, Z out of the screen face) into the Earth
 * frame (X east, Y true north, Z up); the two frames coincide exactly when
 * alpha=beta=gamma=0 (device lying flat, screen up, top edge pointing
 * north). Rz(alpha) is applied with alpha's own sign, unmodified.
 *
 * An earlier version of this file *flipped* alpha's sign here, reasoning
 * that a compass bearing (clockwise-increasing) is the opposite rotational
 * sense from a standard right-hand Rz(+angle) (counter-clockwise-increasing,
 * viewed from above, in an east/north/up frame). That reasoning was
 * internally consistent and passed hand-picked pose checks, but was never
 * tested against a real device — and turned out backwards: on a real
 * iPhone, turning right (clockwise, compass heading increasing) painted the
 * reticles/dial needle turning *left*. Removing the flip fixed it. This
 * also matches the compass-heading-from-alpha relationship iOS Safari web
 * developers have long empirically had to use
 * (`compassHeading ≈ 360 − alpha`, i.e. heading ≈ −alpha): with the flip
 * removed, `headingFromQuat(orientationToQuat({alpha, beta:90, gamma:0,
 * screenAngle:0}))` works out to exactly `−alpha` (see orientation.test.ts)
 * — matching that relationship precisely, not approximately.
 *
 * Physical poses this is checked against (see orientation.test.ts):
 *  - flat, screen up (beta=gamma=0): back camera must point straight down
 *    for every alpha (a flat phone's lens points at the floor no matter
 *    which way the top edge is aimed) — insensitive to alpha's sign, so
 *    this one never distinguished the two versions.
 *  - vertical, screen facing the user (beta=90, gamma=0): back camera must
 *    point due north at alpha=0 (unaffected by the sign either way) and,
 *    with the fix, due *west* at alpha=90 (not east, as the earlier,
 *    unverified version claimed).
 *
 * Camera-local frame (see camera.ts): +X right, +Y up, forward -Z — which
 * is exactly the device's own frame with the sign of Z flipped (the rear
 * lens points opposite the screen's outward normal), so camera-local
 * forward (0,0,-1) equals device-local (0,0,-1) directly: no extra
 * correction quaternion needed for that part.
 */

import type { Mat3, Quat } from './quat.js';
import { mat3ToQuat, qFromAxisAngle, qMul, qNormalize, qRotateVec } from './quat.js';

const CAMERA_LOCAL_FORWARD = { x: 0, y: 0, z: -1 };

const DEG2RAD = Math.PI / 180;

export interface DeviceOrientationSample {
  /** Compass heading of the top of the device, degrees, [0, 360). Earth-referenced (see note below). */
  alpha: number;
  /** Front-back tilt, degrees, [-180, 180]. 0 = flat, screen up. */
  beta: number;
  /** Left-right tilt, degrees, [-90, 90]. 0 = flat. */
  gamma: number;
  /** `screen.orientation.angle` at capture time, degrees. */
  screenAngle: number;
}

/**
 * `alpha`'s zero reference is NOT guaranteed to be true/magnetic north by
 * the base spec — only `event.absolute === true` or (on iOS)
 * `webkitCompassHeading` guarantee that. Callers should feed this function
 * an already Earth-referenced alpha (see useOrientation.ts, which applies
 * the compass correction before calling this), or accept that yaw will be
 * relative to an arbitrary reference if not.
 */
function deviceEulerToMat3(alphaRad: number, betaRad: number, gammaRad: number): Mat3 {
  // alpha used directly, no sign flip — see the file-header comment for why
  // (a real-device chirality bug, not just a style choice): the previous
  // version negated alpha here, which tested fine against hand-picked poses
  // but turned real left/right phone rotation backwards on an actual iPhone.
  const cZ = Math.cos(alphaRad),
    sZ = Math.sin(alphaRad);
  const cX = Math.cos(betaRad),
    sX = Math.sin(betaRad);
  const cY = Math.cos(gammaRad),
    sY = Math.sin(gammaRad);
  return [
    cZ * cY - sZ * sX * sY, -sZ * cX, cZ * sY + sZ * sX * cY,
    sZ * cY + cZ * sX * sY, cZ * cX, sZ * sY - cZ * sX * cY,
    -cX * sY, sX, cX * cY,
  ];
}

/**
 * `screenAngle` rotation is a roll about the camera's own boresight (it
 * changes which way is "up" in the rendered/video frame when the UI flips
 * between portrait and landscape; it does not change which way the lens
 * points). Sign here follows the common convention of correcting by
 * `-screenAngle`; verify against the live HUD (M0) on the real iPhone and
 * flip this constant if the reticles come out rotated 180°/mirrored.
 */
const SCREEN_ANGLE_SIGN = -1;

export function orientationToQuat(sample: DeviceOrientationSample): Quat {
  const R = deviceEulerToMat3(sample.alpha * DEG2RAD, sample.beta * DEG2RAD, sample.gamma * DEG2RAD);
  const qDevice = mat3ToQuat(R);
  const qScreen = qFromAxisAngle({ x: 0, y: 0, z: 1 }, SCREEN_ANGLE_SIGN * sample.screenAngle * DEG2RAD);
  return qNormalize(qMul(qDevice, qScreen));
}

/**
 * World-frame compass heading (radians, clockwise from north) that the
 * camera's forward axis (-Z local) points at, projected onto the horizontal
 * plane. Used to compare against `webkitCompassHeading` for slow yaw
 * correction of alpha's drift.
 */
export function headingFromQuat(q: Quat): number {
  const forward = qRotateVec(q, CAMERA_LOCAL_FORWARD);
  // heading measured clockwise from north (+Y): atan2(east component, north component)
  return Math.atan2(forward.x, forward.y);
}

/**
 * Re-yaws a world-frame quaternion so its heading becomes `targetHeadingRad`,
 * preserving pitch/roll. Used to blend in `webkitCompassHeading` slowly
 * without discarding the (much higher rate) gyro-integrated attitude.
 */
export function reyawQuat(q: Quat, targetHeadingRad: number): Quat {
  const current = headingFromQuat(q);
  const delta = targetHeadingRad - current;
  return applyYawOffset(q, delta);
}

/**
 * Rotates `q` by `offsetRad` of world-frame compass yaw (same clockwise-
 * from-north sense as `headingFromQuat`), preserving pitch and roll — the
 * building block `reyawQuat` is written in terms of, but usable directly
 * when the caller already has the offset to apply (e.g. an accumulated
 * compass-correction offset) instead of a target heading to reach.
 *
 * Numerically stable at *any* pitch, including looking straight up/down,
 * unlike `reyawQuat(q, headingFromQuat(q) + offset)`: `headingFromQuat` is
 * `atan2` of two components that both tend to zero near the poles, so a
 * heading computed there (and then rotated back out again) is noise: this
 * function never evaluates it.
 */
export function applyYawOffset(q: Quat, offsetRad: number): Quat {
  // Unrelated to alpha/deviceEulerToMat3 above — this is purely about the
  // relationship between a world-Z axis-angle rotation and the heading
  // headingFromQuat() extracts (atan2(east, north), clockwise-from-north):
  // applying qFromAxisAngle(Z, +angle) this way (qMul(qDeltaZ, q)) rotates
  // the *content* by +angle in a standard right-hand/counter-clockwise
  // sense, which *decreases* a clockwise-measured heading by `angle` — so
  // this negates `offsetRad` first. Verified directly in
  // orientation.test.ts ("shifts heading by exactly the offset").
  const qDeltaZ = qFromAxisAngle({ x: 0, y: 0, z: 1 }, -offsetRad);
  return qNormalize(qMul(qDeltaZ, q));
}
