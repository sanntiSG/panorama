import { useEffect, useRef } from 'react';
import type { CameraModel, CapturePlan, PlanTarget, Quat } from '@panorama/shared';
import {
  LOCK_MAINTAIN_ANGULAR_THRESHOLD_RAD,
  LOCK_ROLL_THRESHOLD_RAD,
  SECONDARY_MAX_ANGLE_RAD,
  computeRoll,
  describeDirection,
  pickPrimaryTarget,
  projectTargets,
  screenDirectionTo,
  type ProjectedTarget,
} from '../capture/targeting.js';
import { applyCoverTransform, computeCoverTransform } from '../capture/viewport.js';
import {
  drawCapturedDot,
  drawCenterMark,
  drawEdgeArrow,
  drawLeaderLine,
  drawPostCaptureHint,
  drawPrimaryReticle,
  drawRollIndicator,
  drawSecondaryDot,
  drawWorldGrid,
} from './reticleDraw.js';

/**
 * Steady time (ms, only while `steady` — see below) required before a shot
 * fires. Raised from 300ms after directly measuring a reference app's own
 * hold: reading every consecutive frame (no gaps) of two independent hold
 * sequences in its screen-recording, the "HOLD" ring stayed up for 18 and
 * 26 frames respectively before firing, against its own capture flash
 * lasting only 2-3 frames — and we already calibrated our own flash to
 * 140ms (FLASH_MS below) to feel comparably snappy. Applying that same
 * ~8-10x ratio to our flash duration lands the reference's hold at roughly
 * 1-1.3s, not the ~300-550ms we had. (Confirmed separately, frame-by-frame
 * diffing: the video during that hold is genuinely live — small but
 * nonzero frame-to-frame change consistent with natural hand tremor — not
 * a frozen/paused frame, so this is "demand more real elapsed stillness",
 * not "freeze the picture".)
 */
const HOLD_MS = 1200;
/** How long a lock-in-progress survives the gate (roll/stability/etc.) failing for a single frame before resetting — a lone dropped `isStable` sample shouldn't cost the whole hold. Firing itself still requires the gate to hold on the actual frame progress reaches 1 (see the `canLock` check below), so this only smooths out the *hold*, never the fire decision. */
const LOCK_GRACE_MS = 120;
/** Padding outside the visible frame within which a projected point still counts as "on screen" — matches the pinhole projection's own slight overshoot near the edges. */
const OFFSCREEN_MARGIN_PX = 60;
/** Duration (ms) of the full-screen white flash on capture — a deliberately blunt "it fired" confirmation, since previously the only sign a shot was taken was the small counter incrementing, easy to miss. */
const FLASH_MS = 140;
/**
 * How long, after a shot fires, to pause before hunting for the next target
 * resumes — no new hold accumulates and the reticle shows a plain "Listo ✓"
 * confirmation instead. Doesn't affect the sharpness of the shot just taken
 * (that's already fully determined by the HOLD_MS that preceded it, not
 * something a pause afterward can change retroactively) — this is about
 * giving the user a clear beat before the next approach starts, instead of
 * the reticle immediately chasing the next point while their pulse is still
 * settling from the shot that just fired.
 */
const POST_CAPTURE_MS = 1400;

interface LockProgress {
  targetId: string;
  /** Total ms accumulated so far — only ticks up while `steady` (see draw()); wobbling between the maintain and acquire thresholds pauses this instead of resetting it. */
  accumulatedMs: number;
  /** Wall-clock time of the last frame the gate (roll/stability/etc., not aim precision) held — drives LOCK_GRACE_MS. */
  lastGoodAt: number;
  /** Wall-clock time this target's progress was last updated — the basis for how much to add to accumulatedMs next frame. */
  lastTickAt: number;
}

export interface ReticleLayerProps {
  plan: CapturePlan;
  cam: CameraModel;
  quatRef: React.RefObject<Quat | null>;
  isStableRef: React.RefObject<boolean>;
  capturedIds: ReadonlySet<string>;
  onLockFire: (target: PlanTarget, quatAtCapture: Quat) => void;
  /** True while a shot is being processed server-side; suppresses new fires so we don't double-shoot. */
  suspended: boolean;
}

function isOnScreen(x: number, y: number, w: number, h: number): boolean {
  return x >= -OFFSCREEN_MARGIN_PX && x <= w + OFFSCREEN_MARGIN_PX && y >= -OFFSCREEN_MARGIN_PX && y <= h + OFFSCREEN_MARGIN_PX;
}

export function ReticleLayer({ plan, cam, quatRef, isStableRef, capturedIds, onLockFire, suspended }: ReticleLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const capturedIdsRef = useRef(capturedIds);
  capturedIdsRef.current = capturedIds;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const lockRef = useRef<LockProgress | null>(null);
  const firedCooldownRef = useRef<Set<string>>(new Set());
  const primaryIdRef = useRef<string | null>(null);
  const flashStartRef = useRef<number | null>(null);
  const postCaptureUntilRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const maybeCtx = canvas.getContext('2d');
    if (!maybeCtx) return;
    // Nested function declarations below don't retain the narrowing from the
    // check above, so bind to an explicitly non-null local instead.
    const ctx: CanvasRenderingContext2D = maybeCtx;

    let raf = 0;
    let stopped = false;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    /** The nearest *lockable* (state === 'locking', uncaptured) target, if any — distinct from `pickPrimaryTarget`'s hysteresis-smoothed pick because a real lock candidate must never be visually displaced by that hysteresis. */
    function pickCandidate(projected: ProjectedTarget[]): ProjectedTarget | null {
      let best: ProjectedTarget | null = null;
      for (const p of projected) {
        if (p.state !== 'locking') continue;
        if (capturedIdsRef.current.has(p.target.id)) continue;
        if (!best || p.angularErrorRad < best.angularErrorRad) best = p;
      }
      return best;
    }

    function draw() {
      if (stopped) return;
      raf = requestAnimationFrame(draw);

      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      const quat = quatRef.current;
      if (!quat) return;

      const transform = computeCoverTransform(cam.width, cam.height, w, h);
      const projected = projectTargets(plan, capturedIdsRef.current, quat, cam);
      const roll = computeRoll(quat);
      const rollOk = Math.abs(roll) < LOCK_ROLL_THRESHOLD_RAD;
      const now = performance.now();
      const stable = isStableRef.current ?? false;

      // --- world-fixed reference (bottom layer) ---
      drawWorldGrid(ctx, w, h, quat, cam, transform);

      // --- pick the one target to actively guide toward ---
      const candidate = pickCandidate(projected);
      const primary = candidate ?? pickPrimaryTarget(projected, primaryIdRef.current);
      primaryIdRef.current = primary?.target.id ?? null;

      // --- captured + secondary (non-primary) pending targets ---
      for (const p of projected) {
        if (p.state === 'captured') {
          if (!p.visible) continue;
          const { x, y } = applyCoverTransform(p.screen.x, p.screen.y, transform);
          if (!isOnScreen(x, y, w, h)) continue;
          drawCapturedDot(ctx, x, y);
          continue;
        }
        if (primary && p.target.id === primary.target.id) continue;
        if (!p.visible || p.angularErrorRad > SECONDARY_MAX_ANGLE_RAD) continue;
        const { x, y } = applyCoverTransform(p.screen.x, p.screen.y, transform);
        if (!isOnScreen(x, y, w, h)) continue;
        drawSecondaryDot(ctx, x, y, p.angularErrorRad);
      }

      const inPostCapture = postCaptureUntilRef.current !== null && now < postCaptureUntilRef.current;
      if (inPostCapture) {
        // No hold accumulates and nothing fires during this window — just
        // the confirmation hint, in place of the normal hunt-for-the-next-
        // target UI. See POST_CAPTURE_MS's doc comment. Falls through to
        // the roll indicator and (fading) capture flash below unchanged.
        lockRef.current = null;
        drawPostCaptureHint(ctx, w, h, (postCaptureUntilRef.current! - now) / POST_CAPTURE_MS);
      } else {
        postCaptureUntilRef.current = null;
        drawPrimaryOrEdge();
      }

      // Drawn *after* the primary reticle, not before: the card's fill (and
      // especially its destination-out hole punch, which erases whatever
      // was already on the canvas in that circle) would otherwise cover or
      // outright erase the crosshair exactly when it overlaps it — i.e.
      // exactly when you're nearly aligned and most need to see it, which a
      // real session confirmed was happening.
      drawCenterMark(ctx, w, h);

      // --- roll (artificial horizon) indicator ---
      drawRollIndicator(ctx, w, h, roll, rollOk);

      // --- capture flash (drawn last, over everything) ---
      if (flashStartRef.current !== null) {
        const elapsed = now - flashStartRef.current;
        if (elapsed >= FLASH_MS) {
          flashStartRef.current = null;
        } else {
          const alpha = 1 - elapsed / FLASH_MS;
          ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
          ctx.fillRect(0, 0, w, h);
        }
      }

      /** The lock/fire timing + primary reticle or edge-arrow drawing, pulled into its own nested function only so the post-capture-freeze branch above can skip it cleanly without duplicating the roll-indicator/flash tail that follows either way — declared inside draw() (recreated each frame, like the several other per-frame closures/objects already here) specifically so it closes over draw()'s own locals (w, h, primary, quat, etc.) directly instead of threading eight parameters through. */
      function drawPrimaryOrEdge() {
        // TS doesn't carry the non-null narrowing of `quat`/`primary` from
        // draw()'s own scope into this nested function's closure — redundant
        // at runtime (draw() already returned early if quat was null, and
        // this whole function is a no-op without a primary target), but
        // needed so the calls below can rely on their non-null types.
        if (!quat || !primary) {
          lockRef.current = null;
          return;
        }
        const gateOk = rollOk && stable;
        const canLock =
          primary.state === 'locking' && gateOk && !suspendedRef.current && !firedCooldownRef.current.has(primary.target.id);
        // Tighter than "locking" (LOCK_ANGULAR_THRESHOLD_RAD, 6°) — the hold
        // only actually accumulates time while the aim is this precise, so
        // the pose recorded when it fires is trustworthy, not just "was
        // somewhere in the 6° cone at some point during the hold".
        const steady = primary.angularErrorRad <= LOCK_MAINTAIN_ANGULAR_THRESHOLD_RAD;
  
        if (canLock) {
          if (lockRef.current?.targetId !== primary.target.id) {
            lockRef.current = { targetId: primary.target.id, accumulatedMs: 0, lastGoodAt: now, lastTickAt: now };
          } else {
            const lp = lockRef.current;
            lp.lastGoodAt = now;
            // Only add elapsed time while genuinely steady — wobbling
            // between the maintain and acquire thresholds pauses the hold
            // (lastTickAt still advances, so that gap isn't retroactively
            // counted once it steadies again) instead of resetting it.
            if (steady) lp.accumulatedMs += now - lp.lastTickAt;
            lp.lastTickAt = now;
          }
        } else if (lockRef.current?.targetId === primary.target.id) {
          // Same target still, gate just failed this one frame — give it
          // LOCK_GRACE_MS before actually resetting the hold.
          if (now - lockRef.current.lastGoodAt > LOCK_GRACE_MS) {
            lockRef.current = null;
          } else {
            lockRef.current.lastTickAt = now;
          }
        } else {
          lockRef.current = null;
        }
  
        const progress =
          lockRef.current?.targetId === primary.target.id ? Math.min(1, lockRef.current.accumulatedMs / HOLD_MS) : 0;
  
        let onScreen = false;
        let sx = 0;
        let sy = 0;
        if (primary.visible) {
          const pt = applyCoverTransform(primary.screen.x, primary.screen.y, transform);
          if (isOnScreen(pt.x, pt.y, w, h)) {
            onScreen = true;
            sx = pt.x;
            sy = pt.y;
          }
        }
  
        if (onScreen) {
          drawLeaderLine(ctx, w, h, sx, sy);
          let gateHint: string | null = null;
          if (primary.state === 'locking') {
            if (!rollOk) gateHint = 'Nivela el teléfono';
            else if (!stable) gateHint = 'Mantén quieto';
            else if (!steady) gateHint = 'Sigue quieto…';
          } else if (primary.state === 'approaching' && primary.target.kind === 'zenith') {
            // Stepping back genuinely clears your body from a straight-up
            // shot — the ceiling point you're capturing is no longer
            // directly above where you're standing. Said early (while still
            // approaching, not only once already trying to hold the lock)
            // so there's time to act on it before the hold actually starts.
            gateHint = 'Estirá el brazo y date un paso atrás';
          } else if (primary.state === 'approaching' && primary.target.kind === 'nadir') {
            // Stepping back does NOT work here, unlike zenith: this system
            // has no position tracking, only orientation — "straight down"
            // always means straight down from wherever the phone physically
            // is *right now*, which after a step back is still essentially
            // where your feet are standing. The only thing that actually
            // moves the camera away from your own feet is holding it out to
            // the side while still pointing it straight down.
            gateHint = 'Extendé el brazo lejos de tus pies';
          }
          drawPrimaryReticle(ctx, sx, sy, {
            angularErrorRad: primary.angularErrorRad,
            locking: primary.state === 'locking',
            progress,
            gateHint,
            targetYaw: primary.target.yaw,
            targetPitch: primary.target.pitch,
            quat,
            cam,
            transform,
            showCard: primary.target.kind !== 'zenith' && primary.target.kind !== 'nadir',
          });
        } else {
          // Falls back to "turn right" only in the vanishingly rare case the
          // target sits exactly on the boresight's opposite point, where a
          // screen direction is genuinely undefined — resolves itself the
          // instant the user starts turning either way.
          const dir = screenDirectionTo(primary.target.direction, quat) ?? { x: 1, y: 0 };
          const pulse = (Math.sin(now / 280) + 1) / 2;
          drawEdgeArrow(ctx, w, h, dir, {
            distanceDeg: (primary.angularErrorRad * 180) / Math.PI,
            pulse,
            label: describeDirection(dir),
          });
        }
  
        // Only ever fire on a frame where the gate is genuinely satisfied
        // *and* the aim is currently steady — the grace period above lets
        // brief gate hiccups keep the hold's progress, but must never let a
        // shot fire while the aim itself is off, even briefly.
        if (canLock && steady && progress >= 1 && lockRef.current) {
          firedCooldownRef.current.add(primary.target.id);
          lockRef.current = null;
          flashStartRef.current = now;
          postCaptureUntilRef.current = now + POST_CAPTURE_MS;
          onLockFire(primary.target, quat);
        }
      }
    }

    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
    // Re-run the whole rAF loop if the plan/camera model identity changes (new session).
    // quatRef/isStableRef/capturedIdsRef/onLockFire are read through refs/closures each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, cam]);

  // Once a captured id is confirmed by the parent, it's safe to allow re-locking that spot
  // again in a future session — but never within this one, so we don't clear the cooldown set.

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10" />;
}
