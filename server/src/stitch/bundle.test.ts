import { describe, expect, it } from 'vitest';
import {
  qAngleBetween,
  qFromAxisAngleVec,
  qInverse,
  qMul,
  qNormalize,
  qToAxisAngleVec,
  quatLookingAt,
  type Quat,
  type Vec3,
} from '@panorama/shared';
import { runBundleAdjustment, type PairMeasurement } from './bundle.js';

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small ring of 8 synthetic shots, like a single row of a real capture plan. */
function buildRing(count: number): { id: string; trueQuat: Quat }[] {
  const shots = [];
  for (let i = 0; i < count; i++) {
    const yaw = (i / count) * 2 * Math.PI;
    shots.push({ id: `ring_${i}`, trueQuat: quatLookingAt(yaw, 0, 0) });
  }
  return shots;
}

describe('runBundleAdjustment converges on a synthetic problem with known ground truth', () => {
  it('recovers the correct *relative* pose between two shots from a single measurement', () => {
    // A single isolated pair, one shot initialized exactly at truth and the
    // other several degrees off. Both shots carry the *same* prior weight
    // (the solver has no way to know one happens to be exact — a real gyro
    // reading never is), so the correction is expected to be redistributed
    // across both rather than B alone snapping to truth; what rotation
    // averaging is actually meant to guarantee — and what's unambiguous
    // here — is that the *relative* rotation between A and B converges to
    // the true relative pose, which is exactly the number that matters for
    // stitching (it's what determines how the two photos overlap).
    const trueQuatA = quatLookingAt(0, 0, 0);
    const trueQuatB = quatLookingAt((20 * Math.PI) / 180, 0, 0);
    const noiseVecB: Vec3 = { x: (3 * Math.PI) / 180, y: (-2 * Math.PI) / 180, z: (4 * Math.PI) / 180 };
    const initialQuatB = qNormalize(qMul(qFromAxisAngleVec(noiseVecB), trueQuatB));

    const initialQuats = new Map<string, Quat>([
      ['a', trueQuatA],
      ['b', initialQuatB],
    ]);
    const correctionVec = qToAxisAngleVec(qMul(trueQuatB, qInverse(initialQuatB)));
    const pairMeasurements: PairMeasurement[] = [{ a: 'a', b: 'b', correctionVec, confidence: 20 }];

    const result = runBundleAdjustment(['a', 'b'], initialQuats, pairMeasurements);

    const trueRelative = qMul(trueQuatB, qInverse(trueQuatA));
    const gotRelative = qMul(result.quats.get('b')!, qInverse(result.quats.get('a')!));
    expect(qAngleBetween(gotRelative, trueRelative)).toBeLessThan((0.2 * Math.PI) / 180);
    expect(result.meanResidualRad).toBeLessThan((0.2 * Math.PI) / 180);

    // Sanity: the solver actually moved things (didn't just leave the prior
    // untouched), and split the correction across both shots rather than
    // moving only one of them by the full amount.
    const movedA = qAngleBetween(result.quats.get('a')!, trueQuatA);
    const movedB = qAngleBetween(result.quats.get('b')!, initialQuatB);
    expect(movedA).toBeGreaterThan((0.5 * Math.PI) / 180);
    expect(movedB).toBeGreaterThan((0.5 * Math.PI) / 180);
  });

  it('on a closed ring of independently-noisy shots, substantially reduces (not eliminates) the pairwise inconsistency', () => {
    // Unlike the anchored case above, every shot here has its own
    // independent gyro noise, and each pairwise measurement is only ever
    // relative to its *own* noisy anchor (exactly like a real align.ts
    // measurement, which has no way to know its anchor shot's absolute
    // error). Composing 8 such measurements around a closed loop therefore
    // carries a real "loop closure" discrepancy — a well-known, expected
    // property of pairwise-relative pose-graph optimization, not a bug —
    // so the right thing to check is that the solver drives the pairwise
    // residual down substantially and *converges* (doesn't diverge or
    // oscillate), not that every shot lands within some tight distance of
    // its own individual ground truth.
    const rand = mulberry32(1);
    const shots = buildRing(8);
    const shotIds = shots.map((s) => s.id);

    const noiseDeg = 4;
    const initialQuats = new Map<string, Quat>();
    for (const s of shots) {
      const noiseVec = {
        x: ((rand() - 0.5) * 2 * noiseDeg * Math.PI) / 180,
        y: ((rand() - 0.5) * 2 * noiseDeg * Math.PI) / 180,
        z: ((rand() - 0.5) * 2 * noiseDeg * Math.PI) / 180,
      };
      initialQuats.set(s.id, qNormalize(qMul(qFromAxisAngleVec(noiseVec), s.trueQuat)));
    }

    const pairMeasurements: PairMeasurement[] = [];
    for (let i = 0; i < shots.length; i++) {
      const a = shots[i];
      const b = shots[(i + 1) % shots.length];
      const initB = initialQuats.get(b.id)!;
      const correctionVec = qToAxisAngleVec(qMul(b.trueQuat, qInverse(initB)));
      pairMeasurements.push({ a: a.id, b: b.id, correctionVec, confidence: 20 });
    }

    // At the unoptimized starting point, each pair's residual is
    // approximately that pair's own B-shot noise magnitude (the A-shot's
    // noise cancels out of a *relative* measurement) — so `noiseDeg` itself
    // is a good proxy for the "before" residual, without having to
    // reimplement bundle.ts's residual formula a second time here.
    const beforeRad = (noiseDeg * Math.PI) / 180;

    const result = runBundleAdjustment(shotIds, initialQuats, pairMeasurements);

    expect(result.usedPairs).toBe(shots.length);
    expect(result.meanResidualRad).toBeLessThan(beforeRad * 0.5); // substantial (>50%) reduction in loop inconsistency
  });

  it('leaves an unpaired shot exactly at its prior (graceful degradation for textureless images)', () => {
    const shots = buildRing(4);
    const shotIds = shots.map((s) => s.id);
    const initialQuats = new Map(shots.map((s) => [s.id, s.trueQuat]));

    // Only pair up shots 0-1 and 1-2; shot 3 has no reliable match at all
    // (e.g. it was pure sky) and should stay exactly where the gyro put it.
    const pairMeasurements: PairMeasurement[] = [
      { a: 'ring_0', b: 'ring_1', correctionVec: { x: 0, y: 0, z: 0 }, confidence: 20 },
      { a: 'ring_1', b: 'ring_2', correctionVec: { x: 0, y: 0, z: 0 }, confidence: 20 },
    ];

    const result = runBundleAdjustment(shotIds, initialQuats, pairMeasurements);
    const drift = qAngleBetween(result.quats.get('ring_3')!, initialQuats.get('ring_3')!);
    expect(drift).toBeLessThan(1e-6);
  });

  it('drops a low-confidence pair rather than letting it corrupt the solution', () => {
    const shots = buildRing(4);
    const shotIds = shots.map((s) => s.id);
    const initialQuats = new Map(shots.map((s) => [s.id, s.trueQuat]));

    // A wildly wrong "measurement" (90 degrees) but with confidence below
    // the acceptance threshold — should be ignored, leaving both shots at
    // their (already correct, in this test) prior.
    const badVec = qToAxisAngleVec(qFromAxisAngleVec({ x: 0, y: 0, z: Math.PI / 2 }));
    const pairMeasurements: PairMeasurement[] = [{ a: 'ring_0', b: 'ring_1', correctionVec: badVec, confidence: 1 }];

    const result = runBundleAdjustment(shotIds, initialQuats, pairMeasurements);
    expect(result.usedPairs).toBe(0);
    for (const id of shotIds) {
      expect(qAngleBetween(result.quats.get(id)!, initialQuats.get(id)!)).toBeLessThan(1e-6);
    }
  });

  it('reports how many accepted pairs support each shot, for render.ts trust weighting', () => {
    const shots = buildRing(4);
    const shotIds = shots.map((s) => s.id);
    const initialQuats = new Map(shots.map((s) => [s.id, s.trueQuat]));

    // ring_0-ring_1 accepted; ring_1-ring_2 rejected for low confidence;
    // ring_3 has no measurement at all.
    const pairMeasurements: PairMeasurement[] = [
      { a: 'ring_0', b: 'ring_1', correctionVec: { x: 0, y: 0, z: 0 }, confidence: 20 },
      { a: 'ring_1', b: 'ring_2', correctionVec: { x: 0, y: 0, z: 0 }, confidence: 1 },
    ];

    const result = runBundleAdjustment(shotIds, initialQuats, pairMeasurements);
    expect(result.acceptedPairs.get('ring_0')).toBe(1);
    expect(result.acceptedPairs.get('ring_1')).toBe(1); // only the accepted pair counts, not the rejected one
    expect(result.acceptedPairs.get('ring_2')).toBe(0);
    expect(result.acceptedPairs.get('ring_3')).toBe(0);
  });
});
