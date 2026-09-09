import { useCallback, useEffect, useRef, useState } from 'react';
import type { PermissionState } from './useOrientation.js';

/**
 * Detects whether the phone is currently being held still, using
 * `devicemotion`'s rotation rate (and, as a secondary signal, linear
 * acceleration). Feeds the capture lock logic's "stable for 250ms" gate so
 * shots don't fire mid-motion-blur.
 *
 * The exact thresholds below are reasonable starting points, not
 * device-calibrated: real hand jitter/sensor noise floors should be tuned
 * against the actual iPhone during the M0 HUD milestone (the debug HUD
 * exposes the raw smoothed "jerk" value for this purpose).
 */

const JERK_SMOOTHING = 0.2;
/** deg/s equivalent combined-motion threshold below which we consider the device "still". */
const STILL_THRESHOLD = 6;
const STABLE_HOLD_MS = 250;

export function useStability() {
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [isStable, setIsStable] = useState(false);
  const [jerk, setJerk] = useState(0);
  const stableSinceRef = useRef<number | null>(null);
  const jerkRef = useRef(0);
  /** Mirrors `isStable` synchronously for the ReticleLayer's rAF loop (see useOrientation's quatRef). */
  const isStableRef = useRef(false);

  useEffect(() => {
    function handleMotion(e: DeviceMotionEvent) {
      const rr = e.rotationRate;
      const accel = e.acceleration;
      const rotMag = rr ? Math.sqrt((rr.alpha ?? 0) ** 2 + (rr.beta ?? 0) ** 2 + (rr.gamma ?? 0) ** 2) : 0;
      const accelMag = accel ? Math.sqrt((accel.x ?? 0) ** 2 + (accel.y ?? 0) ** 2 + (accel.z ?? 0) ** 2) : 0;
      // Accel is in m/s^2 (small numbers for hand jitter) vs rotationRate in
      // deg/s; the *10 weighting brings them to comparable scale so either
      // signal alone can flag "moving".
      const combined = rotMag + accelMag * 10;
      jerkRef.current = jerkRef.current * (1 - JERK_SMOOTHING) + combined * JERK_SMOOTHING;
      setJerk(jerkRef.current);

      const now = performance.now();
      if (jerkRef.current < STILL_THRESHOLD) {
        if (stableSinceRef.current == null) stableSinceRef.current = now;
      } else {
        stableSinceRef.current = null;
      }
      const heldFor = stableSinceRef.current != null ? now - stableSinceRef.current : 0;
      const stable = heldFor >= STABLE_HOLD_MS;
      isStableRef.current = stable;
      setIsStable(stable);
    }

    window.addEventListener('devicemotion', handleMotion);
    return () => window.removeEventListener('devicemotion', handleMotion);
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const DME = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof DME?.requestPermission === 'function') {
      try {
        const result = await DME.requestPermission();
        setPermission(result === 'granted' ? 'granted' : 'denied');
        return result === 'granted';
      } catch {
        setPermission('denied');
        return false;
      }
    }
    setPermission('unnecessary');
    return true;
  }, []);

  return { permission, requestPermission, isStable, isStableRef, jerk };
}
