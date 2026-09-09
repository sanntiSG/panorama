/**
 * Maps points from the video's native pixel space (what the pinhole camera
 * model in `targeting.ts` works in) to the on-screen display space, using
 * the same "cover" (crop-to-fill) rule as the CSS `object-fit: cover` the
 * `<video>` element uses — so the canvas overlay lines up with what the
 * user actually sees, however the sensor's aspect ratio compares to the
 * phone screen's.
 */

export interface CoverTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function computeCoverTransform(
  sourceWidth: number,
  sourceHeight: number,
  displayWidth: number,
  displayHeight: number,
): CoverTransform {
  const scale = Math.max(displayWidth / sourceWidth, displayHeight / sourceHeight);
  return {
    scale,
    offsetX: (displayWidth - sourceWidth * scale) / 2,
    offsetY: (displayHeight - sourceHeight * scale) / 2,
  };
}

export function applyCoverTransform(x: number, y: number, t: CoverTransform): { x: number; y: number } {
  return { x: x * t.scale + t.offsetX, y: y * t.scale + t.offsetY };
}
