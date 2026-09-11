import { useEffect, useRef } from 'react';
import type { CameraModel, CapturePlan, PlanTarget, Quat } from '@panorama/shared';
import {
  LOCK_ROLL_THRESHOLD_RAD,
  SECONDARY_MAX_ANGLE_RAD,
  computeRoll,
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
  drawPrimaryReticle,
  drawRollIndicator,
  drawSecondaryDot,
  drawWorldGrid,
} from './reticleDraw.js';

const HOLD_MS = 250;
/** How long a lock-in-progress survives the gate (roll/stability/etc.) failing for a single frame before resetting — a lone dropped `isStable` sample shouldn't cost the whole 250ms hold. Firing itself still requires the gate to hold on the actual frame progress reaches 1 (see the `canLock` check below), so this only smooths out the *hold*, never the fire decision. */
const LOCK_GRACE_MS = 120;
/** Padding outside the visible frame within which a projected point still counts as "on screen" — matches the pinhole projection's own slight overshoot near the edges. */
const OFFSCREEN_MARGIN_PX = 60;

interface LockProgress {
  targetId: string;
  since: number;
  lastGoodAt: number;
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

      drawCenterMark(ctx, w, h);

      // --- lock/fire timing + the primary reticle or edge arrow ---
      if (primary) {
        const gateOk = rollOk && stable;
        const canLock =
          primary.state === 'locking' && gateOk && !suspendedRef.current && !firedCooldownRef.current.has(primary.target.id);

        if (canLock) {
          if (lockRef.current?.targetId !== primary.target.id) {
            lockRef.current = { targetId: primary.target.id, since: now, lastGoodAt: now };
          } else {
            lockRef.current.lastGoodAt = now;
          }
        } else if (lockRef.current?.targetId === primary.target.id) {
          // Same target still, gate just failed this one frame — give it
          // LOCK_GRACE_MS before actually resetting the hold.
          if (now - lockRef.current.lastGoodAt > LOCK_GRACE_MS) {
            lockRef.current = null;
          }
        } else {
          lockRef.current = null;
        }

        const progress =
          lockRef.current?.targetId === primary.target.id ? Math.min(1, (now - lockRef.current.since) / HOLD_MS) : 0;

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
          }
          drawPrimaryReticle(ctx, sx, sy, {
            angularErrorRad: primary.angularErrorRad,
            locking: primary.state === 'locking',
            progress,
            gateHint,
          });
        } else {
          // Falls back to "turn right" only in the vanishingly rare case the
          // target sits exactly on the boresight's opposite point, where a
          // screen direction is genuinely undefined — resolves itself the
          // instant the user starts turning either way.
          const dir = screenDirectionTo(primary.target.direction, quat) ?? { x: 1, y: 0 };
          const pulse = (Math.sin(now / 280) + 1) / 2;
          drawEdgeArrow(ctx, w, h, dir, { distanceDeg: (primary.angularErrorRad * 180) / Math.PI, pulse });
        }

        // Only ever fire on a frame where the gate is genuinely satisfied —
        // the grace period above lets brief gate hiccups keep the hold's
        // progress, but must never let a shot fire *during* one.
        if (canLock && progress >= 1 && lockRef.current) {
          firedCooldownRef.current.add(primary.target.id);
          lockRef.current = null;
          onLockFire(primary.target, quat);
        }
      } else {
        lockRef.current = null;
      }

      // --- roll (artificial horizon) indicator ---
      drawRollIndicator(ctx, w, h, roll, rollOk);
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
