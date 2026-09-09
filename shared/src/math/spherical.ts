/**
 * Yaw/pitch <-> unit direction conversions, shared by the capture plan and
 * the equirectangular projection so "yaw" and "pitch" mean the same thing
 * everywhere in the codebase.
 *
 * World frame: +X east, +Y north, +Z up. yaw is compass heading (radians,
 * clockwise from north, atan2(east, north)); pitch is elevation above the
 * horizon (radians, + is up).
 */

import type { Mat3, Quat, Vec3 } from './quat.js';
import { mat3ToQuat, vecCross, vecLength, vecNormalize } from './quat.js';

export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return {
    x: cp * Math.sin(yaw),
    y: cp * Math.cos(yaw),
    z: Math.sin(pitch),
  };
}

export function yawPitchFromDirection(dir: Vec3): { yaw: number; pitch: number } {
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1;
  const x = dir.x / len,
    y = dir.y / len,
    z = dir.z / len;
  return {
    yaw: Math.atan2(x, y),
    pitch: Math.asin(Math.max(-1, Math.min(1, z))),
  };
}

/**
 * Builds the world-rotation quaternion of a camera pointed at (yaw, pitch)
 * with a given roll (radians, default 0 = "level", i.e. camera-local up is
 * world up's projection onto the view plane). Used by the capture-plan
 * coverage test and by tools/synth.ts to synthesize a plausible photo for
 * each planned target. Falls back to an arbitrary right vector when looking
 * straight at a pole, where "level" is undefined.
 */
export function quatLookingAt(yaw: number, pitch: number, roll = 0): Quat {
  const forward = directionFromYawPitch(yaw, pitch);
  const worldUp: Vec3 = { x: 0, y: 0, z: 1 };
  const crossed = vecCross(forward, worldUp);
  let right = vecLength(crossed) < 1e-6 ? { x: 1, y: 0, z: 0 } : vecNormalize(crossed);
  let up = vecCross(right, forward);

  if (roll !== 0) {
    const cr = Math.cos(roll),
      sr = Math.sin(roll);
    const newRight = { x: right.x * cr + up.x * sr, y: right.y * cr + up.y * sr, z: right.z * cr + up.z * sr };
    const newUp = { x: up.x * cr - right.x * sr, y: up.y * cr - right.y * sr, z: up.z * cr - right.z * sr };
    right = newRight;
    up = newUp;
  }

  // Columns [right, up, -forward] map camera-local (X right, Y up, Z=-forward means local -Z is forward) to world.
  const m: Mat3 = [
    right.x, up.x, -forward.x,
    right.y, up.y, -forward.y,
    right.z, up.z, -forward.z,
  ];
  return mat3ToQuat(m);
}
