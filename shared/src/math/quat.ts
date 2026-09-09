/**
 * Minimal quaternion math library, hand-rolled so both the browser client and
 * the Node server depend on the exact same rotation code (no drift between
 * how the client aims the reticles and how the server reprojects pixels).
 *
 * Convention: Hamilton quaternions, (x, y, z, w) with w the scalar part,
 * representing an *active* rotation of column vectors: v' = q * v * q^-1.
 * "World frame" follows the W3C DeviceOrientation convention: X east, Y
 * north, Z up, when the device lies flat with the screen facing the sky.
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const IDENTITY_QUAT: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w };
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function qNorm(q: Quat): number {
  return Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
}

export function qNormalize(q: Quat): Quat {
  const n = qNorm(q);
  if (n < 1e-12) return { ...IDENTITY_QUAT };
  const inv = 1 / n;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

/** Hamilton product: apply `a` after `b` (a ∘ b), i.e. result rotates by b then a. */
export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function qConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Inverse; for unit quaternions this equals the conjugate. */
export function qInverse(q: Quat): Quat {
  const n2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (n2 < 1e-12) return { ...IDENTITY_QUAT };
  const inv = 1 / n2;
  return { x: -q.x * inv, y: -q.y * inv, z: -q.z * inv, w: q.w * inv };
}

export function qFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const len = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
  if (len < 1e-12) return { ...IDENTITY_QUAT };
  const half = angleRad / 2;
  const s = Math.sin(half) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/**
 * Small-angle axis-angle vector (3 numbers) -> quaternion. Used by the bundle
 * adjuster, which parameterizes each camera's rotation increment as a
 * tangent-space 3-vector (the standard SO(3) local parameterization).
 */
export function qFromAxisAngleVec(v: Vec3): Quat {
  const angle = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (angle < 1e-9) {
    // First-order approximation avoids a 0/0 normalize for tiny updates.
    return qNormalize({ x: v.x / 2, y: v.y / 2, z: v.z / 2, w: 1 });
  }
  return qFromAxisAngle({ x: v.x / angle, y: v.y / angle, z: v.z / angle }, angle);
}

/** Inverse of qFromAxisAngleVec: quaternion -> tangent-space 3-vector. */
export function qToAxisAngleVec(q: Quat): Vec3 {
  const qn = qNormalize(q);
  const w = Math.max(-1, Math.min(1, qn.w));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-9) return { x: 0, y: 0, z: 0 };
  const scale = angle / s;
  return { x: qn.x * scale, y: qn.y * scale, z: qn.z * scale };
}

export function qRotateVec(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q^-1, expanded without allocating intermediate quaternions.
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const uvx = qy * v.z - qz * v.y;
  const uvy = qz * v.x - qx * v.z;
  const uvz = qx * v.y - qy * v.x;
  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;
  return {
    x: v.x + 2 * (qw * uvx + uuvx),
    y: v.y + 2 * (qw * uvy + uuvy),
    z: v.z + 2 * (qw * uvz + uuvz),
  };
}

/** Angle in radians between two rotations (shortest arc). */
export function qAngleBetween(a: Quat, b: Quat): number {
  const rel = qMul(qInverse(a), b);
  const w = Math.max(-1, Math.min(1, Math.abs(rel.w)));
  return 2 * Math.acos(w);
}

export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x,
    by = b.y,
    bz = b.z,
    bw = b.w;
  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cosHalfTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }
  if (cosHalfTheta > 0.9995) {
    return qNormalize({
      x: a.x + t * (bx - a.x),
      y: a.y + t * (by - a.y),
      z: a.z + t * (bz - a.z),
      w: a.w + t * (bw - a.w),
    });
  }
  const halfTheta = Math.acos(cosHalfTheta);
  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  };
}

/** Row-major 3x3 rotation matrix as a flat 9-element array. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export function qToMat3(q: Quat): Mat3 {
  const { x, y, z, w } = q;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/** Transpose of a 3x3 rotation matrix == its inverse. */
export function mat3Transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/**
 * Standard robust matrix->quaternion conversion (Shepperd's method): picks
 * whichever of w/x/y/z has the largest magnitude to divide by, avoiding the
 * precision loss / division-by-zero that a naive `w = sqrt(trace+1)/2`
 * formula has near 180° rotations.
 */
export function mat3ToQuat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return qNormalize({ w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s });
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return qNormalize({ w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s });
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return qNormalize({ w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s });
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return qNormalize({ w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s });
  }
}

export function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function vecLength(v: Vec3): number {
  return Math.sqrt(vecDot(v, v));
}

export function vecNormalize(v: Vec3): Vec3 {
  const len = vecLength(v);
  if (len < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
