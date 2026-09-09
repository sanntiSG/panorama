/**
 * Minimal iterative radix-2 Cooley-Tukey FFT (in place, parallel real/imag
 * arrays, length must be a power of 2) plus a 2D wrapper and a phase
 * correlator built on top. No external dependency — patch sizes here are
 * small (128-256) so an unoptimized-but-correct implementation is plenty
 * fast, and it keeps the whole stitcher dependency-free.
 */

/** Forward: X_k = sum_n x_n * exp(-2*pi*i*k*n/N). Inverse includes the 1/N normalization. */
export function fft1d(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (invert ? 1 : -1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** In-place 2D FFT on a size*size row-major flattened array. `size` must be a power of 2. */
export function fft2d(re: Float64Array, im: Float64Array, size: number, invert: boolean): void {
  const rowRe = new Float64Array(size);
  const rowIm = new Float64Array(size);
  for (let y = 0; y < size; y++) {
    const base = y * size;
    for (let x = 0; x < size; x++) {
      rowRe[x] = re[base + x];
      rowIm[x] = im[base + x];
    }
    fft1d(rowRe, rowIm, invert);
    for (let x = 0; x < size; x++) {
      re[base + x] = rowRe[x];
      im[base + x] = rowIm[x];
    }
  }
  const colRe = new Float64Array(size);
  const colIm = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      colRe[y] = re[y * size + x];
      colIm[y] = im[y * size + x];
    }
    fft1d(colRe, colIm, invert);
    for (let y = 0; y < size; y++) {
      re[y * size + x] = colRe[y];
      im[y * size + x] = colIm[y];
    }
  }
}

export interface PhaseCorrelationResult {
  dx: number;
  dy: number;
  /** Peak-to-sidelobe-ratio-like confidence: (peak - mean) / stddev of the correlation surface. Higher is better. */
  confidence: number;
}

function hann(i: number, n: number): number {
  return n <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
}

/**
 * Phase correlation between two size*size grayscale patches. See
 * fft.test.ts for the empirically-verified sign convention (derived by
 * measurement, not just algebra, after this exact class of bug bit
 * orientation.ts twice) — in short, `dx`/`dy` come out such that shifting
 * `a`'s sampling coordinate by (dx, dy) reproduces `b`.
 */
export function phaseCorrelate(a: Float32Array, b: Float32Array, size: number): PhaseCorrelationResult {
  const n = size * size;
  const reA = new Float64Array(n);
  const imA = new Float64Array(n);
  const reB = new Float64Array(n);
  const imB = new Float64Array(n);

  for (let y = 0; y < size; y++) {
    const wy = hann(y, size);
    for (let x = 0; x < size; x++) {
      const w = hann(x, size) * wy;
      const idx = y * size + x;
      reA[idx] = a[idx] * w;
      reB[idx] = b[idx] * w;
    }
  }

  fft2d(reA, imA, size, false);
  fft2d(reB, imB, size, false);

  const crossRe = new Float64Array(n);
  const crossIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // A * conj(B)
    const cr = reA[i] * reB[i] + imA[i] * imB[i];
    const ci = imA[i] * reB[i] - reA[i] * imB[i];
    const mag = Math.sqrt(cr * cr + ci * ci) + 1e-9;
    crossRe[i] = cr / mag;
    crossIm[i] = ci / mag;
  }

  fft2d(crossRe, crossIm, size, true);

  let bestIdx = 0;
  let bestVal = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = crossRe[i];
    sum += v;
    sumSq += v * v;
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  const mean = sum / n;
  const variance = Math.max(1e-12, sumSq / n - mean * mean);
  const confidence = (bestVal - mean) / Math.sqrt(variance);

  const py = Math.floor(bestIdx / size);
  const px = bestIdx % size;

  const left = crossRe[py * size + ((px - 1 + size) % size)];
  const right = crossRe[py * size + ((px + 1) % size)];
  const up = crossRe[((py - 1 + size) % size) * size + px];
  const down = crossRe[((py + 1) % size) * size + px];
  const denomX = 2 * bestVal - left - right;
  const subX = Math.abs(denomX) > 1e-9 ? (0.5 * (left - right)) / denomX : 0;
  const denomY = 2 * bestVal - up - down;
  const subY = Math.abs(denomY) > 1e-9 ? (0.5 * (up - down)) / denomY : 0;

  let rawDx = px + subX;
  if (rawDx > size / 2) rawDx -= size;
  let rawDy = py + subY;
  if (rawDy > size / 2) rawDy -= size;

  // Cross-power spectrum A*conj(B) peaks at -d when b(x)=a(x-d) (shift
  // theorem: negate here so the returned (dx,dy) directly matches the
  // documented convention b(x,y)=a(x-dx,y-dy) — confirmed empirically in
  // fft.test.ts against known synthetic shifts, not just by this derivation.
  return { dx: -rawDx, dy: -rawDy, confidence };
}
