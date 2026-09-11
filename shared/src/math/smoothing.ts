/**
 * Temporal low-pass filter for a stream of noisy orientation quaternions —
 * used by `useOrientation.ts` to turn raw, jittery `deviceorientation`
 * samples into the steady signal the capture reticles are drawn from. Pure
 * and DOM/time-source free (the caller supplies `dtMs`), so it's the same
 * code and the same tests on both the browser client and (hypothetically)
 * the server.
 *
 * First-order lag (`a = 1 - exp(-dt/tau)`, slerped toward the target each
 * step) rather than a fixed per-frame blend factor: a fixed factor's actual
 * time constant depends on the caller's frame rate, which on a phone is not
 * constant (screen can throttle, tab can background). The time constant
 * itself adapts to how fast the *input* is currently rotating: slow/steady
 * (holding still, aiming) gets heavy damping to kill sensor noise; fast
 * (actively panning) gets light damping so the reticle doesn't feel like
 * it's dragging behind the phone.
 */

import { qAngleBetween, qNormalize, qSlerp, type Quat } from './quat.js';

export interface QuatSmootherOptions {
  /** Time constant (ms) applied when the input is essentially still — heavy damping, kills jitter. Default 140. */
  tauSlowMs?: number;
  /** Time constant (ms) applied at/above `rateFastRadPerSec` — light damping, low lag while actively panning. Default 40. */
  tauFastMs?: number;
  /** Input angular speed (rad/s) below which `tauSlowMs` applies fully. Default 8°/s. */
  rateSlowRadPerSec?: number;
  /** Input angular speed (rad/s) at/above which `tauFastMs` applies fully. Default 60°/s. */
  rateFastRadPerSec?: number;
  /** Angular jump (rad) beyond which the filter snaps straight to the target instead of easing — a real discontinuity (screen rotation, tab resume), not sensor noise. Default 50°. */
  snapAngleRad?: number;
}

export interface QuatSmoother {
  /**
   * Advances the filter toward `target` by `dtMs` milliseconds.
   * `rateRadPerSec` is the caller's own measurement of how fast the *raw*
   * input is currently rotating (used only to pick the time constant, not
   * fed back into the filter's own state). Returns the new smoothed value
   * (also available from `value()`).
   */
  step(target: Quat, dtMs: number, rateRadPerSec: number): Quat;
  /** Current smoothed value, or `null` before the first `step()` call. */
  value(): Quat | null;
  /** Forgets the current value — the next `step()` snaps to its target as if it were the first sample. */
  reset(): void;
}

const DEG2RAD = Math.PI / 180;

export function createQuatSmoother(opts: QuatSmootherOptions = {}): QuatSmoother {
  const tauSlowMs = opts.tauSlowMs ?? 140;
  const tauFastMs = opts.tauFastMs ?? 40;
  const rateSlow = opts.rateSlowRadPerSec ?? 8 * DEG2RAD;
  const rateFast = opts.rateFastRadPerSec ?? 60 * DEG2RAD;
  const snapAngleRad = opts.snapAngleRad ?? 50 * DEG2RAD;

  let current: Quat | null = null;

  return {
    step(target: Quat, dtMs: number, rateRadPerSec: number): Quat {
      const t = qNormalize(target);
      if (current === null || qAngleBetween(current, t) > snapAngleRad) {
        current = t;
        return current;
      }
      const f = Math.max(0, Math.min(1, (rateRadPerSec - rateSlow) / (rateFast - rateSlow)));
      const tau = tauSlowMs + (tauFastMs - tauSlowMs) * f;
      const a = 1 - Math.exp(-dtMs / tau);
      current = qNormalize(qSlerp(current, t, a));
      return current;
    },
    value() {
      return current;
    },
    reset() {
      current = null;
    },
  };
}
