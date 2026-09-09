/**
 * Equirectangular image <-> world direction mapping. Row-major, top-to-bottom,
 * left-to-right image: column 0 is yaw = -180°, growing east; row 0 is the
 * zenith (pitch +90°), row (height-1) the nadir (pitch -90°). This is the
 * standard layout expected by the XMP GPano metadata written in stitch/xmp.ts
 * and by photosphere viewers (Google Photos, three.js panorama examples).
 */

import type { Vec3 } from './quat.js';
import { directionFromYawPitch, yawPitchFromDirection } from './spherical.js';

const TWO_PI = Math.PI * 2;
const PI = Math.PI;

export interface EquirectPixel {
  /** Fractional column, [0, width). */
  px: number;
  /** Fractional row, [0, height). */
  py: number;
}

export function dirToEquirectPixel(dir: Vec3, width: number, height: number): EquirectPixel {
  const { yaw, pitch } = yawPitchFromDirection(dir);
  const u = (yaw + PI) / TWO_PI; // yaw -π -> u=0, yaw +π -> u=1
  const v = (PI / 2 - pitch) / PI; // pitch +π/2 -> v=0 (top), pitch -π/2 -> v=1 (bottom)
  return { px: u * width, py: v * height };
}

/** Direction for the *center* of equirectangular pixel (col, row). */
export function equirectPixelToDir(px: number, py: number, width: number, height: number): Vec3 {
  const u = (px + 0.5) / width;
  const v = (py + 0.5) / height;
  const yaw = u * TWO_PI - PI;
  const pitch = PI / 2 - v * PI;
  return directionFromYawPitch(yaw, pitch);
}
