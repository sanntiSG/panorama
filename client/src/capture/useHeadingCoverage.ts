import { useEffect, useReducer, useRef } from 'react';
import type { RefObject } from 'react';
import { qRotateVec, type Quat } from '@panorama/shared';

/** Number of 30° compass sectors a full turn is divided into. */
export const HEADING_BUCKETS = 12;
/**
 * Sectors that must be visited before calibration is considered complete —
 * 10 of 12 (300° of the full 360°), not literally all of them: requiring an
 * exact full closure is fragile to one sector narrowly missed by a few
 * degrees at the seam, without meaningfully changing what this is actually
 * for (settling the sensors and teaching the interaction).
 */
export const REQUIRED_BUCKETS = 10;
/** A sector only counts as "visited" after this many ms of continuous dwell — forces a slow, deliberate pan instead of a quick flick, which is also roughly the scale of motion iOS's own magnetometer calibration benefits from. */
const BUCKET_DWELL_MS = 300;
/** Below this horizontal component of the forward vector (~sin 15°), heading is numerically meaningless (see useOrientation.ts's identical guard) — freeze bucket tracking rather than let noise near the poles complete the sweep for free. */
const MIN_HORIZONTAL = 0.26;
/** No orientation input at all for this long -> something's actually wrong (permission revoked mid-session, hardware fault), not just "hasn't turned yet". */
const SENSOR_TIMEOUT_MS = 3500;
/** How often elapsed/near-pole/sensor-silent state (all otherwise derived at render time from refs) gets a chance to actually reach a render. */
const SLOW_TICK_MS = 500;

const CAM_FORWARD = { x: 0, y: 0, z: -1 };
const TWO_PI = Math.PI * 2;

export interface HeadingCoverage {
  /** Which of the HEADING_BUCKETS sectors have been visited — a ref (not state) so a canvas-drawn dial can read it every frame without forcing a React re-render per sector. */
  visitedRef: RefObject<boolean[]>;
  /** Current heading, radians clockwise from north; NaN while too close to a pole for heading to mean anything. */
  headingRef: RefObject<number>;
  visitedCount: number;
  required: number;
  complete: boolean;
  elapsedMs: number;
  sinceProgressMs: number;
  nearPole: boolean;
  sensorSilent: boolean;
}

/**
 * Tracks how much of a full turn the user has physically swept the camera
 * through, for the mandatory pre-capture calibration screen. Works
 * identically for a real phone or the desktop drag simulator: both feed a
 * `quatRef` whose heading this hook reads the same way — dragging the mouse
 * through several slow strokes covers sectors exactly like turning the
 * phone does.
 */
export function useHeadingCoverage(quatRef: RefObject<Quat | null>, lastInputAtRef: RefObject<number>): HeadingCoverage {
  const visitedRef = useRef<boolean[]>(new Array(HEADING_BUCKETS).fill(false));
  const headingRef = useRef(NaN);
  const countRef = useRef(0);
  const dwellBucketRef = useRef(-1);
  const dwellSinceRef = useRef(0);
  const lastProgressAtRef = useRef(performance.now());
  const startedAtRef = useRef(performance.now());
  const [visitedCount, bumpVisitedCount] = useReducer((c: number) => c + 1, 0);
  const [, forceTick] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    let raf = 0;
    let stopped = false;

    function frame() {
      if (stopped) return;
      raf = requestAnimationFrame(frame);

      const q = quatRef.current;
      if (!q) {
        headingRef.current = NaN;
        return;
      }
      const forward = qRotateVec(q, CAM_FORWARD);
      const horiz = Math.hypot(forward.x, forward.y);
      if (horiz < MIN_HORIZONTAL) {
        headingRef.current = NaN;
        dwellBucketRef.current = -1; // require a fresh dwell once heading becomes meaningful again
        return;
      }

      const heading = Math.atan2(forward.x, forward.y);
      headingRef.current = heading;
      const wrapped = ((heading % TWO_PI) + TWO_PI) % TWO_PI;
      const bucket = Math.min(HEADING_BUCKETS - 1, Math.floor((wrapped / TWO_PI) * HEADING_BUCKETS));

      const now = performance.now();
      if (bucket !== dwellBucketRef.current) {
        dwellBucketRef.current = bucket;
        dwellSinceRef.current = now;
      } else if (now - dwellSinceRef.current >= BUCKET_DWELL_MS && !visitedRef.current[bucket]) {
        visitedRef.current[bucket] = true;
        countRef.current++;
        lastProgressAtRef.current = now;
        bumpVisitedCount();
      }
    }

    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // quatRef is a stable ref object (read through .current each frame, not
    // a reactive value) — matches the pattern in useOrientation.ts's own rAF loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(forceTick, SLOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const now = performance.now();
  const lastInput = lastInputAtRef.current ?? 0;
  const sensorSilent = (lastInput === 0 ? now - startedAtRef.current : now - lastInput) > SENSOR_TIMEOUT_MS;

  return {
    visitedRef,
    headingRef,
    visitedCount,
    required: REQUIRED_BUCKETS,
    complete: visitedCount >= REQUIRED_BUCKETS,
    elapsedMs: now - startedAtRef.current,
    sinceProgressMs: now - lastProgressAtRef.current,
    nearPole: Number.isNaN(headingRef.current),
    sensorSilent,
  };
}
