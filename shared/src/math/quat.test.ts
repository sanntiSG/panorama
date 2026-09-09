import { describe, expect, it } from 'vitest';
import {
  IDENTITY_QUAT,
  mat3ToQuat,
  qAngleBetween,
  qFromAxisAngle,
  qFromAxisAngleVec,
  qMul,
  qNormalize,
  qRotateVec,
  qToAxisAngleVec,
  qToMat3,
  vecLength,
} from './quat.js';

function expectVecClose(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, eps = 1e-9) {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
}

describe('quaternion rotation basics', () => {
  it('90° about Z maps +X to +Y', () => {
    const q = qFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
    const rotated = qRotateVec(q, { x: 1, y: 0, z: 0 });
    expectVecClose(rotated, { x: 0, y: 1, z: 0 });
  });

  it('90° about X maps +Y to +Z', () => {
    const q = qFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    const rotated = qRotateVec(q, { x: 0, y: 1, z: 0 });
    expectVecClose(rotated, { x: 0, y: 0, z: 1 });
  });

  it('identity leaves vectors unchanged', () => {
    const rotated = qRotateVec(IDENTITY_QUAT, { x: 0.3, y: -0.7, z: 1.2 });
    expectVecClose(rotated, { x: 0.3, y: -0.7, z: 1.2 });
  });

  it('qMul(a,b) applies b first, then a', () => {
    const qa = qFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2); // 90 about Z
    const qb = qFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2); // 90 about X
    const combined = qMul(qa, qb);
    const direct = qRotateVec(qa, qRotateVec(qb, { x: 0, y: 1, z: 0 }));
    const viaCombined = qRotateVec(combined, { x: 0, y: 1, z: 0 });
    expectVecClose(direct, viaCombined);
  });

  it('qAngleBetween measures the right angle for a known rotation', () => {
    const q = qFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 3); // 60deg
    const angle = qAngleBetween(IDENTITY_QUAT, q);
    expect(angle).toBeCloseTo(Math.PI / 3, 9);
  });
});

describe('axis-angle vector <-> quaternion round trip', () => {
  it('round-trips small and large rotation vectors', () => {
    const cases = [
      { x: 0, y: 0, z: 0 },
      { x: 0.01, y: 0, z: 0 },
      { x: 0.1, y: -0.2, z: 0.05 },
      { x: 1.5, y: 0.3, z: -0.4 },
    ];
    for (const v of cases) {
      const q = qFromAxisAngleVec(v);
      const back = qToAxisAngleVec(q);
      expectVecClose(back, v, 6);
    }
  });
});

describe('mat3 <-> quat round trip', () => {
  it('recovers the original quaternion (up to sign) for many random rotations', () => {
    let seed = 42;
    const rand = () => {
      // simple deterministic PRNG (mulberry32) for reproducible test cases
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 200; i++) {
      const axis = { x: rand() - 0.5, y: rand() - 0.5, z: rand() - 0.5 };
      const angle = (rand() - 0.5) * 2 * Math.PI;
      const q = qNormalize(qFromAxisAngle(axis, angle));
      const m = qToMat3(q);
      const back = qNormalize(mat3ToQuat(m));
      // quaternions q and -q represent the same rotation
      const sameSign = Math.abs(q.w - back.w) < 1e-6;
      const a = sameSign ? q : { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
      expect(back.x).toBeCloseTo(a.x, 5);
      expect(back.y).toBeCloseTo(a.y, 5);
      expect(back.z).toBeCloseTo(a.z, 5);
      expect(back.w).toBeCloseTo(a.w, 5);
    }
  });

  it('always returns a unit quaternion', () => {
    const q = qFromAxisAngle({ x: 1, y: 2, z: 3 }, 2.1);
    const m = qToMat3(q);
    const back = mat3ToQuat(m);
    expect(vecLength({ x: back.x, y: back.y, z: back.z }) ** 2 + back.w ** 2).toBeCloseTo(1, 9);
  });
});
