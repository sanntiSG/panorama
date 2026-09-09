import { useCallback, useEffect, useRef, useState } from 'react';
import { headingFromQuat, orientationToQuat, reyawQuat, type Quat } from '@panorama/shared';

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unnecessary';

export interface OrientationSample {
  quat: Quat;
  /** Raw sensor angles, kept for the debug HUD. */
  raw: { alpha: number; beta: number; gamma: number };
  /** True once at least one webkitCompassHeading reading has been folded in. */
  compassLocked: boolean;
}

// How fast the compass correction pulls the gyro-integrated heading toward
// magnetic north, per `deviceorientation` event (fires ~60Hz on iOS). Small
// on purpose: `alpha` drifts only a few degrees per minute, so a slow blend
// removes that drift without making the reticles jitter from short-term
// compass noise (indoors, near metal, near the car etc).
const COMPASS_BLEND_RATE = 0.01;

function wrapAngle(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

export function currentScreenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation) return screen.orientation.angle;
  // Older iOS Safari fallback.
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

export interface UseOrientationOptions {
  /** Fold in webkitCompassHeading to correct alpha's long-term drift. Default true. */
  useCompassCorrection?: boolean;
}

export function useOrientation(options: UseOrientationOptions = {}) {
  const useCompass = options.useCompassCorrection ?? true;
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [sample, setSample] = useState<OrientationSample | null>(null);
  const compassHeadingRef = useRef<number | null>(null);
  const screenAngleRef = useRef(currentScreenAngle());
  const useCompassRef = useRef(useCompass);
  useCompassRef.current = useCompass;
  /** Latest quaternion, updated synchronously on every event — for consumers
   *  (ReticleLayer's rAF loop) that need 60Hz freshness without subscribing
   *  to a React re-render on every single sensor sample. */
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

  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;

      let q = orientationToQuat({
        alpha: e.alpha,
        beta: e.beta,
        gamma: e.gamma,
        screenAngle: screenAngleRef.current,
      });

      // iOS-only, non-standard: true/magnetic compass heading, degrees
      // clockwise from north — exactly our heading convention, no conversion needed.
      const compassDeg = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof compassDeg === 'number' && Number.isFinite(compassDeg)) {
        compassHeadingRef.current = (compassDeg * Math.PI) / 180;
      }

      let compassLocked = false;
      if (useCompassRef.current && compassHeadingRef.current != null) {
        const current = headingFromQuat(q);
        const diff = wrapAngle(compassHeadingRef.current - current);
        const blended = current + diff * COMPASS_BLEND_RATE;
        q = reyawQuat(q, blended);
        compassLocked = true;
      }

      quatRef.current = q;
      setSample({ quat: q, raw: { alpha: e.alpha, beta: e.beta, gamma: e.gamma }, compassLocked });
    }

    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof DOE?.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        setPermission(result === 'granted' ? 'granted' : 'denied');
        return result === 'granted';
      } catch {
        setPermission('denied');
        return false;
      }
    }
    // Android Chrome and older iOS don't gate this behind a permission prompt.
    setPermission('unnecessary');
    return true;
  }, []);

  return { permission, requestPermission, sample, quatRef };
}
