import { describe, expect, it } from 'vitest';
import { createQuatSmoother } from './smoothing.js';
import { qAngleBetween, qFromAxisAngle, qNorm, qNormalize, IDENTITY_QUAT, type Quat } from './quat.js';

const DEG2RAD = Math.PI / 180;

describe('createQuatSmoother', () => {
  it('snaps to the target on the first step regardless of dt', () => {
    const smoother = createQuatSmoother();
    const target = qFromAxisAngle({ x: 0, y: 0, z: 1 }, 30 * DEG2RAD);
    const result = smoother.step(target, 16.7, 0);
    expect(qAngleBetween(result, target)).toBeCloseTo(0, 9);
    expect(smoother.value()).not.toBeNull();
  });

  it('approaches ~63% of a step change after one time constant at rest', () => {
    const tauSlowMs = 140;
    const smoother = createQuatSmoother({ tauSlowMs, rateSlowRadPerSec: 8 * DEG2RAD, rateFastRadPerSec: 60 * DEG2RAD });
    const start = IDENTITY_QUAT;
    const target = qFromAxisAngle({ x: 0, y: 0, z: 1 }, 30 * DEG2RAD);
    smoother.step(start, 16.7, 0); // establish the initial value (snaps to identity)

    // Feed the target at a rate well below rateSlow, in small frame steps
    // totaling tauSlowMs, all "at rest" so tauSlowMs applies throughout.
    const frameMs = 16.7;
    let elapsed = 0;
    let result: Quat = start;
    while (elapsed < tauSlowMs) {
      result = smoother.step(target, frameMs, 0);
      elapsed += frameMs;
    }
    const covered = qAngleBetween(start, result);
    const total = qAngleBetween(start, target);
    const fraction = covered / total;
    expect(fraction).toBeGreaterThan(0.55);
    expect(fraction).toBeLessThan(0.7);
  });

  it('snaps instead of easing across a large jump', () => {
    const smoother = createQuatSmoother();
    smoother.step(IDENTITY_QUAT, 16.7, 0);
    const farTarget = qFromAxisAngle({ x: 0, y: 1, z: 0 }, 90 * DEG2RAD);
    const result = smoother.step(farTarget, 16.7, 0);
    expect(qAngleBetween(result, farTarget)).toBeCloseTo(0, 9);
  });

  it('stays a unit quaternion after many steps', () => {
    const smoother = createQuatSmoother();
    let angle = 0;
    for (let i = 0; i < 20000; i++) {
      angle += 0.001;
      const target = qNormalize(qFromAxisAngle({ x: 0, y: 0, z: 1 }, angle));
      smoother.step(target, 16.7, 0.05);
    }
    const v = smoother.value();
    expect(v).not.toBeNull();
    expect(qNorm(v as Quat)).toBeCloseTo(1, 9);
  });

  it('converges faster at high measured input rate than at low rate', () => {
    const target = qFromAxisAngle({ x: 0, y: 0, z: 1 }, 30 * DEG2RAD);

    const slow = createQuatSmoother();
    slow.step(IDENTITY_QUAT, 16.7, 0);
    const slowResult = slow.step(target, 50, 0);

    const fast = createQuatSmoother();
    fast.step(IDENTITY_QUAT, 16.7, 0);
    const fastResult = fast.step(target, 50, 100 * DEG2RAD);

    const slowCovered = qAngleBetween(IDENTITY_QUAT, slowResult);
    const fastCovered = qAngleBetween(IDENTITY_QUAT, fastResult);
    expect(fastCovered).toBeGreaterThan(slowCovered);
  });

  it('reset() makes the next step snap again', () => {
    const smoother = createQuatSmoother();
    smoother.step(IDENTITY_QUAT, 16.7, 0);
    smoother.reset();
    expect(smoother.value()).toBeNull();
    const target = qFromAxisAngle({ x: 1, y: 0, z: 0 }, 10 * DEG2RAD);
    const result = smoother.step(target, 16.7, 0);
    expect(qAngleBetween(result, target)).toBeCloseTo(0, 9);
  });
});
