import { describe, expect, it } from 'vitest';
import { fillUncoveredPoleCap, trustFromAcceptedPairs, MIN_TRUST } from './render.js';

const WIDTH = 32;
const HEIGHT = 20;

function makeCoveredCanvas(uncoveredTopRows: number, uncoveredBottomRows: number) {
  const data = new Uint8Array(WIDTH * HEIGHT * 3);
  const weightSum = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const isUncovered = y < uncoveredTopRows || y >= HEIGHT - uncoveredBottomRows;
    for (let x = 0; x < WIDTH; x++) {
      const idx = y * WIDTH + x;
      if (!isUncovered) {
        weightSum[idx] = 1;
        // A simple horizontal gradient so we can check the blur actually mixes columns.
        data[idx * 3 + 0] = (x * 8) % 256;
        data[idx * 3 + 1] = 100;
        data[idx * 3 + 2] = 200;
      }
    }
  }
  return { data, weightSum };
}

describe('fillUncoveredPoleCap', () => {
  it('fills an uncovered top cap and leaves the covered region untouched', () => {
    const { data, weightSum } = makeCoveredCanvas(4, 0);
    const before = data.slice();

    fillUncoveredPoleCap(data, weightSum, WIDTH, HEIGHT, 'top');

    // Every pixel in the cap should now be non-black (was solid 0,0,0 before).
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const idx = (y * WIDTH + x) * 3;
        const wasBlack = before[idx] === 0 && before[idx + 1] === 0 && before[idx + 2] === 0;
        expect(wasBlack).toBe(true);
        const isStillBlack = data[idx] === 0 && data[idx + 1] === 0 && data[idx + 2] === 0;
        expect(isStillBlack).toBe(false);
      }
    }

    // Covered rows must be untouched.
    for (let y = 4; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const idx = (y * WIDTH + x) * 3;
        expect(data[idx]).toBe(before[idx]);
        expect(data[idx + 1]).toBe(before[idx + 1]);
        expect(data[idx + 2]).toBe(before[idx + 2]);
      }
    }
  });

  it('fills an uncovered bottom cap independently of the top', () => {
    const { data, weightSum } = makeCoveredCanvas(0, 5);
    fillUncoveredPoleCap(data, weightSum, WIDTH, HEIGHT, 'bottom');
    for (let y = HEIGHT - 5; y < HEIGHT; y++) {
      const idx = (y * WIDTH) * 3;
      const isBlack = data[idx] === 0 && data[idx + 1] === 0 && data[idx + 2] === 0;
      expect(isBlack).toBe(false);
    }
  });

  it('is a no-op when the whole hemisphere is uncovered (nothing usable to smear)', () => {
    const data = new Uint8Array(WIDTH * HEIGHT * 3);
    const weightSum = new Float32Array(WIDTH * HEIGHT); // all zero
    fillUncoveredPoleCap(data, weightSum, WIDTH, HEIGHT, 'top');
    expect(data.every((v) => v === 0)).toBe(true);
  });

  it('is a no-op when the pole is already fully covered', () => {
    const { data, weightSum } = makeCoveredCanvas(0, 0);
    const before = data.slice();
    fillUncoveredPoleCap(data, weightSum, WIDTH, HEIGHT, 'top');
    fillUncoveredPoleCap(data, weightSum, WIDTH, HEIGHT, 'bottom');
    expect(data).toEqual(before);
  });
});

describe('trustFromAcceptedPairs', () => {
  it('never goes below MIN_TRUST, even with zero supporting pairs', () => {
    expect(trustFromAcceptedPairs(0)).toBe(MIN_TRUST);
  });

  it('reaches full trust at 2+ accepted pairs', () => {
    expect(trustFromAcceptedPairs(2)).toBe(1);
    expect(trustFromAcceptedPairs(5)).toBe(1);
  });

  it('ramps continuously in between, not all-or-nothing', () => {
    const zero = trustFromAcceptedPairs(0);
    const one = trustFromAcceptedPairs(1);
    const two = trustFromAcceptedPairs(2);
    expect(one).toBeGreaterThan(zero);
    expect(one).toBeLessThan(two);
  });
});
