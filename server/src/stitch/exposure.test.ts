import { describe, expect, it } from 'vitest';
import { computeExposureGains } from './exposure.js';

describe('computeExposureGains', () => {
  it('recovers known relative gains from a simple 3-shot chain', () => {
    // Ground truth: shot B was captured twice as bright as A, C twice as bright as B.
    const trueGain = { a: 1, b: 2, c: 4 };
    const baseMean = 60;

    const samples = [
      // meanA/meanB are what the (uncompensated) images actually show for the *same* overlap scene.
      { a: 'a', b: 'b', meanA: baseMean * trueGain.a, meanB: baseMean * trueGain.b, weight: 10 },
      { a: 'b', b: 'c', meanA: baseMean * trueGain.b, meanB: baseMean * trueGain.c, weight: 10 },
    ];

    const gains = computeExposureGains(['a', 'b', 'c'], samples, 1e-4);

    // Only relative gains are determined (regularization pulls the overall
    // scale toward 1, an arbitrary but harmless gauge choice), so check ratios.
    const ratioBA = gains.get('b')! / gains.get('a')!;
    const ratioCB = gains.get('c')! / gains.get('b')!;
    // Each ratio compensates for that *step's* brightness change (b/a, then
    // c/b) — not for trueGain.c's absolute value, which is relative to the
    // baseline two steps back.
    expect(ratioBA).toBeCloseTo(trueGain.a / trueGain.b, 1);
    expect(ratioCB).toBeCloseTo(trueGain.b / trueGain.c, 1);

    // After applying gains, the overlap means should match.
    for (const s of samples) {
      const compensatedA = s.meanA * gains.get(s.a)!;
      const compensatedB = s.meanB * gains.get(s.b)!;
      expect(compensatedA / compensatedB).toBeCloseTo(1, 1);
    }
  });

  it('ignores near-black samples rather than dividing by ~0', () => {
    const gains = computeExposureGains(['a', 'b'], [{ a: 'a', b: 'b', meanA: 0.1, meanB: 0.2, weight: 10 }]);
    expect(gains.get('a')).toBeCloseTo(1, 3);
    expect(gains.get('b')).toBeCloseTo(1, 3);
  });
});
