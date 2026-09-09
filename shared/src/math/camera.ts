/**
 * Pinhole camera model shared between the capture guidance (client) and the
 * stitcher (server). Camera-local frame: +X right, +Y up, forward is -Z —
 * this matches the frame produced by orientation.ts, so a quaternion from
 * that module can be plugged straight in here.
 *
 * No lens distortion model: iPhone main/ultra-wide lenses are corrected in
 * hardware/software before the frame reaches getUserMedia, so a plain
 * pinhole is a good enough approximation for guidance and for the bundle
 * adjuster's residuals.
 */

import type { Quat, Vec3 } from './quat.js';
import { qInverse, qRotateVec, vecNormalize } from './quat.js';

export interface CameraModel {
  /** Video/image width in pixels. */
  width: number;
  /** Video/image height in pixels. */
  height: number;
  /** Focal length in pixel units (same units as width/height). */
  focalPx: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** False when the direction is behind the camera (would need a negative-depth divide). */
  visible: boolean;
}

/** Focal length (px) that gives a field of view `fovRad` across `sizePx` pixels. */
export function focalFromFov(sizePx: number, fovRad: number): number {
  return sizePx / 2 / Math.tan(fovRad / 2);
}

/** Field of view (radians) across `sizePx` pixels at the given focal length (px). */
export function fovFromFocal(sizePx: number, focalPx: number): number {
  return 2 * Math.atan(sizePx / 2 / focalPx);
}

/** Horizontal and vertical FOV (radians) implied by a camera model. */
export function cameraFov(cam: CameraModel): { hFov: number; vFov: number } {
  return {
    hFov: fovFromFocal(cam.width, cam.focalPx),
    vFov: fovFromFocal(cam.height, cam.focalPx),
  };
}

/**
 * Project a direction already expressed in camera-local space (forward -Z)
 * to a pixel coordinate, origin top-left, +Y down (canvas convention).
 */
export function projectCamDir(dir: Vec3, cam: CameraModel): ScreenPoint {
  if (dir.z >= -1e-9) {
    // On or behind the image plane: no finite projection.
    return { x: NaN, y: NaN, visible: false };
  }
  const t = -cam.focalPx / dir.z;
  const px = dir.x * t;
  const py = dir.y * t;
  return {
    x: cam.width / 2 + px,
    y: cam.height / 2 - py,
    visible: true,
  };
}

/** Inverse of projectCamDir: pixel -> normalized camera-local direction (forward -Z). */
export function unprojectToCamDir(sx: number, sy: number, cam: CameraModel): Vec3 {
  const px = sx - cam.width / 2;
  const py = cam.height / 2 - sy;
  return vecNormalize({ x: px, y: py, z: -cam.focalPx });
}

/** World direction -> pixel coordinate, given the camera's world-rotation quaternion. */
export function worldDirToScreen(worldDir: Vec3, cameraQuat: Quat, cam: CameraModel): ScreenPoint {
  const camDir = qRotateVec(qInverse(cameraQuat), worldDir);
  return projectCamDir(camDir, cam);
}

/** Pixel coordinate -> world direction (unit vector), given the camera's world-rotation quaternion. */
export function screenToWorldDir(sx: number, sy: number, cameraQuat: Quat, cam: CameraModel): Vec3 {
  const camDir = unprojectToCamDir(sx, sy, cam);
  return qRotateVec(cameraQuat, camDir);
}

/** Angular separation (radians) between two (not necessarily normalized) directions. */
export function angularSeparation(a: Vec3, b: Vec3): number {
  const an = vecNormalize(a);
  const bn = vecNormalize(b);
  const dot = Math.max(-1, Math.min(1, an.x * bn.x + an.y * bn.y + an.z * bn.z));
  return Math.acos(dot);
}
