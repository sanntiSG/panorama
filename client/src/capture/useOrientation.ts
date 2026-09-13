import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  applyYawOffset,
  createQuatSmoother,
  orientationToQuat,
  qAngleBetween,
  qRotateVec,
  type Quat,
  type QuatSmoother,
} from '@panorama/shared';

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unnecessary' | 'unsupported';

/**
 * Why a permission request failed, distinct enough to show an actionable
 * message instead of a blanket "denied":
 * - `denied`: the user was shown the native prompt and tapped "Don't Allow".
 * - `gesture`: `requestPermission()` threw instead of resolving — on iOS
 *   Safari this means it wasn't called synchronously enough from a user
 *   gesture (typically because something else awaited first and consumed
 *   the activation), not that the user said no.
 * - `unsupported`: this browser has no orientation sensor API at all.
 */
export type PermissionFailureReason = 'denied' | 'gesture' | 'unsupported';

export interface PermissionResult {
  ok: boolean;
  reason?: PermissionFailureReason;
}

export interface OrientationSample {
  /** Smoothed world-frame orientation — the same value `quatRef` carries. */
  quat: Quat;
  /** Raw, unsmoothed sensor angles, kept for the debug HUD. */
  raw: { alpha: number; beta: number; gamma: number };
  /** True once at least one webkitCompassHeading reading has been folded in (sticky for the session). */
  compassLocked: boolean;
  /** Measured angular speed of the *raw* sensor signal, deg/s. 0 in simulator mode. */
  rateDegPerSec: number;
  /** Measured `deviceorientation` event rate, Hz. 0 in simulator mode. */
  hz: number;
}

export interface UseOrientationOptions {
  /** Fold in webkitCompassHeading to correct alpha's long-term drift. Default true. */
  useCompassCorrection?: boolean;
}

/** Common shape of `useOrientation` and `useSimulatedOrientation` — declaring
 *  it explicitly turns any drift between the two into a compile error,
 *  since the simulator is the only way to exercise this code without a
 *  phone. */
export interface OrientationSource {
  permission: PermissionState;
  requestPermission: () => Promise<PermissionResult>;
  sample: OrientationSample | null;
  /** Smoothed world-frame orientation, updated every animation frame — for
   *  consumers (ReticleLayer's rAF loop) that need frame-fresh values
   *  without subscribing to a React re-render on every sample. */
  quatRef: RefObject<Quat | null>;
  /** `performance.now()` of the last real input (a sensor event, or a
   *  pointer-drag sample in simulator mode); 0 before any input has
   *  arrived. Used to detect a stalled sensor (see useHeadingCoverage's
   *  `sensorSilent`). */
  lastInputAtRef: RefObject<number>;
}

// How much of a session's worth of "which way is north" drift the compass
// correction should have visibly fixed after this many milliseconds —
// deliberately slow (a few seconds) so short-term compass noise (indoors,
// near metal, near the car) doesn't make the reticles wander; alpha itself
// only drifts a few degrees per minute, so this doesn't need to be fast.
const COMPASS_TAU_MS = 3000;
// Below this horizontal component of the forward vector (~sin 17.5°), the
// camera is close enough to straight up/down that heading is numerically
// meaningless (atan2 of two near-zero components) — skip the compass
// estimate entirely rather than fold in noise. This matters a lot here:
// the capture plan has real zenith/nadir/high-pitch-ring targets, so the
// user *will* point the camera there mid-session.
const COMPASS_MIN_HORIZONTAL = 0.3;
// Clamp a single rAF frame's dt after e.g. a backgrounded tab, so the
// smoother/compass filter don't try to "catch up" in one giant, visible step.
const MAX_FRAME_DT_MS = 100;
// React state (`sample`) is published at this cadence rather than on every
// sensor event (up to ~60Hz on iOS) — plenty smooth for the HUD, far fewer
// re-renders of whatever reads it.
const SAMPLE_PUBLISH_MS = 100;
// Smoothing factor for the rate/Hz estimates shown in the debug HUD — not
// used for anything behavior-affecting, just needs to not flicker.
const RATE_EMA = 0.25;

const CAM_FORWARD = { x: 0, y: 0, z: -1 };

function wrapAngle(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

export function currentScreenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation) return screen.orientation.angle;
  // Older iOS Safari fallback.
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

export function useOrientation(options: UseOrientationOptions = {}): OrientationSource {
  const useCompass = options.useCompassCorrection ?? true;
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [sample, setSample] = useState<OrientationSample | null>(null);
  const useCompassRef = useRef(useCompass);
  useCompassRef.current = useCompass;
  const screenAngleRef = useRef(currentScreenAngle());

  // --- Raw sensor state, written by the (cheap, no setState) event handler
  // below and consumed by the rAF loop further down. ---
  const rawQuatRef = useRef<Quat | null>(null);
  const rawAnglesRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const compassHeadingRef = useRef<number | null>(null);
  const prevRawQuatRef = useRef<Quat | null>(null);
  const rateRef = useRef(0); // rad/s, EMA
  const hzRef = useRef(0);
  const lastInputAtRef = useRef(0);

  // --- Derived/output state, written by the rAF loop. ---
  const yawOffsetRef = useRef(0); // accumulated compass yaw correction, radians
  const compassLockedRef = useRef(false);
  const smootherRef = useRef<QuatSmoother | null>(null);
  const lastFrameAtRef = useRef(0);
  const lastPublishAtRef = useRef(0);
  const quatRef = useRef<Quat | null>(null);

  useEffect(() => {
    const update = () => {
      screenAngleRef.current = currentScreenAngle();
    };
    update();
    screen.orientation?.addEventListener('change', update);
    window.addEventListener('orientationchange', update);
    return () => {
      screen.orientation?.removeEventListener('change', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  // Cheap per-event work only: convert to a quat, stash it and the compass
  // heading in refs, and update the rate/Hz estimates. No setState here —
  // this can fire up to ~60 times a second on iOS, and none of the actual
  // filtering (compass correction, smoothing) needs to happen at event
  // granularity rather than frame granularity.
  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;

      const q = orientationToQuat({
        alpha: e.alpha,
        beta: e.beta,
        gamma: e.gamma,
        screenAngle: screenAngleRef.current,
      });
      rawQuatRef.current = q;
      rawAnglesRef.current = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };

      // iOS-only, non-standard: true/magnetic compass heading, degrees
      // clockwise from north — exactly our heading convention, no conversion needed.
      const compassDeg = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof compassDeg === 'number' && Number.isFinite(compassDeg)) {
        compassHeadingRef.current = (compassDeg * Math.PI) / 180;
      }

      const now = performance.now();
      const prev = prevRawQuatRef.current;
      const prevAt = lastInputAtRef.current;
      const dtMs = now - prevAt;
      if (prev && prevAt > 0 && dtMs > 0 && dtMs < 200) {
        const instRateRadPerSec = qAngleBetween(prev, q) / (dtMs / 1000);
        rateRef.current += (instRateRadPerSec - rateRef.current) * RATE_EMA;
        hzRef.current += (1000 / dtMs - hzRef.current) * RATE_EMA;
      }
      prevRawQuatRef.current = q;
      lastInputAtRef.current = now;
    }

    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, []);

  // Per-frame work: accumulate the compass yaw correction, smooth the
  // result, and (at a throttled rate) publish it as React state. This is
  // what actually fixes the reported jitter — see smoothing.ts and the two
  // compass bugs described in useOrientation's plan/commit message.
  useEffect(() => {
    let raf = 0;
    let stopped = false;

    function tick(now: number) {
      if (stopped) return;
      raf = requestAnimationFrame(tick);

      const lastFrameAt = lastFrameAtRef.current;
      const dtMs = lastFrameAt > 0 ? Math.min(now - lastFrameAt, MAX_FRAME_DT_MS) : 16.7;
      lastFrameAtRef.current = now;

      const raw = rawQuatRef.current;
      if (!raw) return;

      // How close the camera is currently pointing to straight up/down —
      // needed below for both the compass gate and the smoother's rate
      // input, so compute it once regardless of whether compass correction
      // is even available this session.
      const forward = qRotateVec(raw, CAM_FORWARD);
      const horiz = Math.hypot(forward.x, forward.y);

      if (useCompassRef.current && compassHeadingRef.current != null) {
        // Skip near the poles (see COMPASS_MIN_HORIZONTAL) — freeze the
        // offset rather than estimate it from numerically meaningless
        // components; it resumes converging the moment the camera comes
        // back down toward the horizon.
        if (horiz > COMPASS_MIN_HORIZONTAL) {
          const rawHeading = Math.atan2(forward.x, forward.y);
          const err = wrapAngle(compassHeadingRef.current - (rawHeading + yawOffsetRef.current));
          const k = 1 - Math.exp(-dtMs / COMPASS_TAU_MS);
          yawOffsetRef.current = wrapAngle(yawOffsetRef.current + err * k);
          compassLockedRef.current = true;
        }
      }
      const target = yawOffsetRef.current !== 0 ? applyYawOffset(raw, yawOffsetRef.current) : raw;

      // Same reasoning as the compass gate right above, applied to the
      // smoother instead: heading/yaw estimation from the raw sensor is
      // numerically unstable near the poles (a physical limitation of the
      // magnetometer+accelerometer fusion, not something our own math can
      // fix), which can read as a large frame-to-frame rotation of the raw
      // quaternion even while the phone is held physically still. The
      // smoother's adaptive damping (smoothing.ts) trusts `rateRef.current`
      // to mean "the phone is actually moving this fast" and *loosens*
      // damping in response — exactly backwards right where the signal is
      // noisiest. Taper the rate it sees down toward 0 as `horiz` shrinks,
      // so heavy damping applies near a pole regardless of what the raw
      // (noise-inflated) rate suggests; away from the pole this is 1 and
      // changes nothing. This doesn't loosen LOCK_MAINTAIN_ANGULAR_THRESHOLD_RAD
      // or any other precision requirement — it only makes the input signal
      // itself steadier, so that existing requirement is easier to satisfy
      // honestly near a pole instead of fighting sensor noise to get there.
      const poleDamping = Math.min(1, horiz / COMPASS_MIN_HORIZONTAL);
      const smoothedRate = rateRef.current * poleDamping;

      if (!smootherRef.current) smootherRef.current = createQuatSmoother();
      quatRef.current = smootherRef.current.step(target, dtMs, smoothedRate);

      if (now - lastPublishAtRef.current >= SAMPLE_PUBLISH_MS) {
        lastPublishAtRef.current = now;
        setSample({
          quat: quatRef.current,
          raw: rawAnglesRef.current ?? { alpha: 0, beta: 0, gamma: 0 },
          compassLocked: compassLockedRef.current,
          rateDegPerSec: (rateRef.current * 180) / Math.PI,
          hz: hzRef.current,
        });
      }
    }

    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  const requestPermission = useCallback(async (): Promise<PermissionResult> => {
    if (typeof window.DeviceOrientationEvent === 'undefined') {
      setPermission('unsupported');
      return { ok: false, reason: 'unsupported' };
    }
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        const ok = result === 'granted';
        setPermission(ok ? 'granted' : 'denied');
        return ok ? { ok: true } : { ok: false, reason: 'denied' };
      } catch {
        // Thrown (rather than resolved 'denied') almost always means this
        // wasn't called from a live user gesture — see PermissionFailureReason.
        setPermission('denied');
        return { ok: false, reason: 'gesture' };
      }
    }
    // Android Chrome and older iOS don't gate this behind a permission prompt.
    setPermission('unnecessary');
    return { ok: true };
  }, []);

  return { permission, requestPermission, sample, quatRef, lastInputAtRef };
}
