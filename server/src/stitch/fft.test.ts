import { describe, expect, it } from 'vitest';
import { ambiguityDiscount, fft1d, findSecondPeak, phaseCorrelate } from './fft.js';

describe('fft1d', () => {
  it('round-trips forward then inverse', () => {
    const n = 16;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i) + i * 0.1;
    const origRe = re.slice();
    fft1d(re, im, false);
    fft1d(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(origRe[i], 6);
      expect(im[i]).toBeCloseTo(0, 6);
    }
  });

  it('a pure sinusoid at bin k produces energy only at bins k and n-k', () => {
    const n = 32;
    const k = 5;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
    fft1d(re, im, false);
    for (let i = 0; i < n; i++) {
      const mag = Math.hypot(re[i], im[i]);
      if (i === k || i === n - k) {
        expect(mag).toBeGreaterThan(n / 2 - 1);
      } else {
        expect(mag).toBeLessThan(1e-6);
      }
    }
  });
});

/**
 * A handful of bright point features at random *integer* positions (each
 * with a small few-pixel footprint), rather than low-frequency sinusoids.
 * Point features have broadband spectra, so phase correlation localizes
 * them sharply — this is the standard way to test it. An earlier version of
 * this fixture used sinusoids limited to ~3 cycles per patch, which cannot
 * resolve small integer shifts at all (the correlation peak is wider than
 * the shift being measured) — that was a broken test, not an algorithm bug:
 * it failed inconsistently (exact negation for some shifts, zero for
 * others) with no relation to the actual phaseCorrelate convention.
 */
function randomPatch(size: number, seed = 7): Float32Array {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const data = new Float32Array(size * size).fill(50);
  const margin = 10;
  for (let p = 0; p < 25; p++) {
    const cx = margin + Math.floor(rand() * (size - 2 * margin));
    const cy = margin + Math.floor(rand() * (size - 2 * margin));
    const amp = 100 + rand() * 100;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const d2 = ox * ox + oy * oy;
        const v = amp * Math.exp(-d2 / 2);
        const idx = ((cy + oy + size) % size) * size + ((cx + ox + size) % size);
        data[idx] += v;
      }
    }
  }
  return data;
}

/** b(x,y) = a(x - shiftX, y - shiftY), wrapping — i.e. b's content at (x,y) equals a's content shifted right by shiftX, down by shiftY. */
function shiftPatch(a: Float32Array, size: number, shiftX: number, shiftY: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (((x - shiftX) % size) + size) % size;
      const sy = (((y - shiftY) % size) + size) % size;
      out[y * size + x] = a[sy * size + sx];
    }
  }
  return out;
}

describe('phaseCorrelate sign convention (empirical, not just derived)', () => {
  const size = 64;

  it.each([
    [3, 0],
    [-4, 0],
    [0, 5],
    [0, -6],
    [4, -3],
    [-5, 7],
  ])('recovers a known integer shift (%i, %i)', (shiftX, shiftY) => {
    const a = randomPatch(size);
    const b = shiftPatch(a, size, shiftX, shiftY);
    const { dx, dy, confidence } = phaseCorrelate(a, b, size);
    expect(confidence).toBeGreaterThan(3);
    // This assertion's sign is the ground truth for align.ts's geometry
    // conversion — determined by running this test, not assumed.
    // `|| 0` normalizes -0 to 0 (Object.is distinguishes them; a zero shift doesn't care about the sign of zero).
    expect(Math.round(dx) || 0).toBe(shiftX);
    expect(Math.round(dy) || 0).toBe(shiftY);
  });

  it('near-zero confidence-irrelevant case: identical patches shift by zero', () => {
    const a = randomPatch(size, 3);
    const { dx, dy } = phaseCorrelate(a, a, size);
    expect(dx).toBeCloseTo(0, 1);
    expect(dy).toBeCloseTo(0, 1);
  });
});

describe('findSecondPeak', () => {
  it('ignores a secondary bump within the exclusion radius (same peak, blurred)', () => {
    const size = 32;
    const surface = new Float64Array(size * size).fill(0);
    surface[10 * size + 10] = 100; // main peak
    surface[10 * size + 12] = 90; // 2px away — within a radius-4 exclusion
    surface[20 * size + 20] = 50; // a genuine, farther competing peak
    const second = findSecondPeak(surface, size, 10, 10, 4);
    expect(second).toBe(50);
  });

  it('finds a close-but-outside-radius peak once the radius shrinks', () => {
    const size = 32;
    const surface = new Float64Array(size * size).fill(0);
    surface[10 * size + 10] = 100;
    surface[10 * size + 12] = 90;
    const second = findSecondPeak(surface, size, 10, 10, 1);
    expect(second).toBe(90);
  });

  it('wraps toroidally, matching the FFT domain the surface comes from', () => {
    const size = 16;
    const surface = new Float64Array(size * size).fill(0);
    surface[0] = 100; // (x=0, y=0)
    surface[size - 1] = 80; // (x=15, y=0) — adjacent to (0,0) via wraparound, distance 1
    const second = findSecondPeak(surface, size, 0, 0, 4);
    expect(second).toBeLessThan(80); // the wrapped neighbor must be excluded too
  });
});

describe('ambiguityDiscount', () => {
  it('applies no discount when the second peak is well below the safe ratio', () => {
    expect(ambiguityDiscount(10, 4)).toBe(1); // ratio 0.4 < 0.5
  });

  it('applies the maximum discount once the second peak matches or exceeds the bad ratio', () => {
    expect(ambiguityDiscount(10, 9)).toBeCloseTo(0.15, 6); // ratio 0.9 == AMBIGUITY_RATIO_BAD
    expect(ambiguityDiscount(10, 20)).toBeCloseTo(0.15, 6); // ratio > 1: still floors at the same minimum, never goes negative
  });

  it('interpolates smoothly between the safe and bad ratios', () => {
    const mid = ambiguityDiscount(10, 7); // ratio 0.7, halfway between 0.5 and 0.9
    expect(mid).toBeGreaterThan(0.15);
    expect(mid).toBeLessThan(1);
  });

  it('does not double-penalize an already-worthless main peak', () => {
    expect(ambiguityDiscount(0, 5)).toBe(1);
    expect(ambiguityDiscount(-2, 5)).toBe(1);
  });
});

describe('phaseCorrelate periodicity awareness (end-to-end)', () => {
  const size = 64;

  it('discounts confidence for a periodically-repeating pattern relative to an equally-strong unique one', () => {
    // A single dot repeated every 16px in x: shifting by a few px looks
    // almost as good at the "wrong" period-multiple offsets as at the true
    // one — exactly the repetitive-ceiling-beam scenario this guards
    // against.
    const periodic = new Float32Array(size * size).fill(50);
    for (let cy = 8; cy < size; cy += 16) {
      for (let cx = 8; cx < size; cx += 16) {
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const d2 = ox * ox + oy * oy;
            const idx = ((cy + oy + size) % size) * size + ((cx + ox + size) % size);
            periodic[idx] += 150 * Math.exp(-d2 / 2);
          }
        }
      }
    }
    const periodicShifted = shiftPatch(periodic, size, 3, 0);
    const periodicResult = phaseCorrelate(periodic, periodicShifted, size);

    const unique = randomPatch(size, 11);
    const uniqueShifted = shiftPatch(unique, size, 3, 0);
    const uniqueResult = phaseCorrelate(unique, uniqueShifted, size);

    // Both still recover the true shift (the true peak is still tallest)...
    expect(Math.round(periodicResult.dx)).toBe(3);
    expect(Math.round(uniqueResult.dx)).toBe(3);
    // ...but the periodic one's competing peaks (one period-width away) are
    // much closer in height to the main one, and its post-discount
    // confidence should be markedly lower for the same reason.
    expect(periodicResult.ambiguityRatio).toBeGreaterThan(uniqueResult.ambiguityRatio);
    expect(periodicResult.confidence).toBeLessThan(uniqueResult.confidence);
  });
});
