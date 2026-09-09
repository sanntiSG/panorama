import type { Mat3, Vec3 } from '@panorama/shared';

/** J^T * v for a 3x3 row-major matrix J and a 3-vector v. */
export function mat3TransposeMulVec(J: Mat3, v: Vec3): Vec3 {
  return {
    x: J[0] * v.x + J[3] * v.y + J[6] * v.z,
    y: J[1] * v.x + J[4] * v.y + J[7] * v.z,
    z: J[2] * v.x + J[5] * v.y + J[8] * v.z,
  };
}

/** A^T * B for two row-major 3x3 matrices, returned as a flat row-major 3x3 array. */
export function mat3TransposeMulMat3(A: Mat3, B: Mat3): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += A[k * 3 + r] * B[k * 3 + c]; // A^T[r][k] = A[k][r]
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const NEGATIVE_IDENTITY_MAT3: Mat3 = [-1, 0, 0, 0, -1, 0, 0, 0, -1];

export interface JacobianBlock {
  /** Parameter block index (each block is 3 consecutive rows/cols of H). */
  index: number;
  J: Mat3;
}

/**
 * Accumulates one weighted residual term's contribution to the Gauss-Newton
 * normal equations H*delta=g (H = sum J^T W J, g = -sum J^T W r), for a
 * residual that depends on one or more 3-parameter blocks (a lone prior
 * term touches one block; a pairwise term touches two).
 */
export function addResidualBlock(
  H: Float64Array,
  g: Float64Array,
  totalParams: number,
  blocks: JacobianBlock[],
  residual: Vec3,
  weight: number,
): void {
  for (const bi of blocks) {
    const jtr = mat3TransposeMulVec(bi.J, residual);
    g[bi.index * 3 + 0] -= weight * jtr.x;
    g[bi.index * 3 + 1] -= weight * jtr.y;
    g[bi.index * 3 + 2] -= weight * jtr.z;

    for (const bj of blocks) {
      const block = mat3TransposeMulMat3(bi.J, bj.J);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          H[(bi.index * 3 + r) * totalParams + (bj.index * 3 + c)] += weight * block[r * 3 + c];
        }
      }
    }
  }
}

/** Solves the SPD system A*x=b (A is `n`x`n`, row-major, flat) via Cholesky decomposition. */
export function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        L[i * n + j] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }

  return x;
}
