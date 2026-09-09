import { describe, expect, it } from 'vitest';
import { dirToEquirectPixel, equirectPixelToDir } from './equirect.js';
import { angularSeparation } from './camera.js';
import { directionFromYawPitch } from './spherical.js';

const WIDTH = 4096;
const HEIGHT = 2048;

describe('equirectangular pixel <-> direction', () => {
  it('round-trips pixel centers within half a pixel of angular error', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [WIDTH - 1, 0],
      [0, HEIGHT - 1],
      [WIDTH - 1, HEIGHT - 1],
      [WIDTH / 2, HEIGHT / 2],
      [WIDTH * 0.1, HEIGHT * 0.9],
    ];
    for (const [px, py] of cases) {
      const dir = equirectPixelToDir(px, py, WIDTH, HEIGHT);
      const back = dirToEquirectPixel(dir, WIDTH, HEIGHT);
      // wrap-aware comparison on px (0 and WIDTH are the same column)
      const dx = Math.min(Math.abs(back.px - (px + 0.5)), WIDTH - Math.abs(back.px - (px + 0.5)));
      expect(dx).toBeLessThan(1e-6);
      expect(back.py).toBeCloseTo(py + 0.5, 6);
    }
  });

  it('north pole direction maps to the top row center column region', () => {
    const { py } = dirToEquirectPixel({ x: 0, y: 0, z: 1 }, WIDTH, HEIGHT);
    expect(py).toBeCloseTo(0, 6);
  });

  it('south pole direction maps to the bottom row', () => {
    const { py } = dirToEquirectPixel({ x: 0, y: 0, z: -1 }, WIDTH, HEIGHT);
    expect(py).toBeCloseTo(HEIGHT, 6);
  });

  it('agrees with directionFromYawPitch for an arbitrary yaw/pitch', () => {
    const yaw = 1.234;
    const pitch = 0.4;
    const dirA = directionFromYawPitch(yaw, pitch);
    const { px, py } = dirToEquirectPixel(dirA, WIDTH, HEIGHT);
    const dirB = equirectPixelToDir(Math.floor(px), Math.floor(py), WIDTH, HEIGHT);
    expect(angularSeparation(dirA, dirB)).toBeLessThan(0.01); // within ~1 pixel's worth of angle
  });
});
