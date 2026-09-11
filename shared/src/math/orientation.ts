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
 * north). One correction on top of that: alpha is a *compass bearing*
 * (increases clockwise from north), which is the opposite rotational sense
 * from a standard right-hand Rz(+angle) in an east/north/up frame (that
 * rotates east *toward* north, i.e. counter-clockwise viewed from above) —
 * so alpha's sign is flipped before building Rz.
 *
 * Re-derived from the spec (rather than ported from a UI library) and
 * checked against physical poses before trusting it:
 *  - flat, screen up (beta=gamma=0): back camera must point straight down
 *    for every alpha (a flat phone's lens points at the floor no matter
 *    which way the top edge is aimed).
 *  - vertical, screen facing the user (beta=90, gamma=0): back camera must
 *    point due north at alpha=0 and due east at alpha=90 (the pose used to
 *    shoot a panorama, where alpha *is* the compass heading).
 * All hold with this formula (the alpha=90 case is exactly what caught the
 * chirality bug above — see orientation.test.ts); they did not hold with
 * the more commonly quoted "-90° about X" quaternion-correction shortcut,
 * so this file does not use that shortcut.
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
  // Compass bearing increases *clockwise* from north (N=0, E=90), but a
  // standard right-hand Rz(+angle) rotates East->North, i.e.
  // *counter*-clockwise when viewed from above in our X=east/Y=north/Z=up
  // frame. The two rotational senses are opposite, so alpha's sign must be
  // flipped here to get true compass semantics — caught by
  // orientation.test.ts (beta=90,gamma=0,alpha=90 must point due east; it
  // pointed due west without this negation).
  const cZ = Math.cos(-alphaRad),
    sZ = Math.sin(-alphaRad);
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
  // Same compass-vs-math-rotation chirality flip as deviceEulerToMat3: a
  // standard Rz(+angle) *decreases* compass heading, so negate here.
  const qDeltaZ = qFromAxisAngle({ x: 0, y: 0, z: 1 }, -offsetRad);
  return qNormalize(qMul(qDeltaZ, q));
}
