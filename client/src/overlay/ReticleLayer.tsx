import { useEffect, useRef } from 'react';
import { headingFromQuat, qRotateVec, suggestNextTarget, type CameraModel, type CapturePlan, type PlanTarget, type Quat } from '@panorama/shared';
import {
  APPROACH_ANGULAR_THRESHOLD_RAD,
  LOCK_ANGULAR_THRESHOLD_RAD,
  LOCK_ROLL_THRESHOLD_RAD,
  computeRoll,
  projectTargets,
  type ProjectedTarget,
} from '../capture/targeting.js';
import { applyCoverTransform, computeCoverTransform } from '../capture/viewport.js';

function wrapPi(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

function forwardOf(quat: Quat) {
  return qRotateVec(quat, { x: 0, y: 0, z: -1 });
}

const HOLD_MS = 250;
const MAX_RETICLE_RADIUS = 46;
const MIN_RETICLE_RADIUS = 20;
const PENDING_DOT_RADIUS = 5;

interface LockProgress {
  targetId: string;
  since: number;
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

export function ReticleLayer({ plan, cam, quatRef, isStableRef, capturedIds, onLockFire, suspended }: ReticleLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const capturedIdsRef = useRef(capturedIds);
  capturedIdsRef.current = capturedIds;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const lockRef = useRef<LockProgress | null>(null);
  const firedCooldownRef = useRef<Set<string>>(new Set());

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

      // --- pending/approaching/captured reticles ---
      let anyUncapturedOnScreen = false;
      for (const p of projected) {
        if (!p.visible) continue;
        const { x, y } = applyCoverTransform(p.screen.x, p.screen.y, transform);
        if (x < -60 || x > w + 60 || y < -60 || y > h + 60) continue;

        if (p.state === 'captured') {
          drawCaptured(ctx, x, y);
        } else if (p.state === 'pending') {
          drawPending(ctx, x, y);
          anyUncapturedOnScreen = true;
        } else if (p.state === 'approaching') {
          const t = 1 - p.angularErrorRad / APPROACH_ANGULAR_THRESHOLD_RAD; // 0..1, 1 = closer
          drawApproaching(ctx, x, y, t);
          anyUncapturedOnScreen = true;
        } else if (p.state === 'locking') {
          anyUncapturedOnScreen = true;
        }
      }

      // --- candidate lock/fire logic ---
      const candidate = pickCandidate(projected);

      // Nothing to aim at on screen at all: point toward the nearest
      // uncaptured target with a simple "turn this way" chevron, so the
      // user keeps sweeping in one consistent direction instead of
      // searching blindly. Left/right is decided purely from the heading
      // difference (ignoring pitch) — good enough since capture is
      // fundamentally a yaw sweep at each ring.
      if (!anyUncapturedOnScreen) {
        const suggestion = suggestNextTarget(plan, capturedIdsRef.current, forwardOf(quat));
        if (suggestion) {
          const currentHeading = headingFromQuat(quat);
          const delta = wrapPi(suggestion.yaw - currentHeading);
          drawTurnHint(ctx, w, h, delta >= 0 ? 'right' : 'left');
        }
      }
      const now = performance.now();
      const stable = isStableRef.current ?? false;

      if (candidate && rollOk && stable && !suspendedRef.current && !firedCooldownRef.current.has(candidate.target.id)) {
        if (lockRef.current?.targetId !== candidate.target.id) {
          lockRef.current = { targetId: candidate.target.id, since: now };
        }
      } else {
        lockRef.current = null;
      }

      const progress = lockRef.current ? Math.min(1, (now - lockRef.current.since) / HOLD_MS) : 0;

      if (candidate) {
        const { x, y } = applyCoverTransform(candidate.screen.x, candidate.screen.y, transform);
        drawLocking(ctx, x, y, progress, rollOk && stable);
      }

      if (progress >= 1 && candidate && lockRef.current) {
        firedCooldownRef.current.add(candidate.target.id);
        lockRef.current = null;
        onLockFire(candidate.target, quat);
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

function drawPending(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, PENDING_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();
}

function drawTurnHint(ctx: CanvasRenderingContext2D, w: number, h: number, direction: 'left' | 'right') {
  const cy = h / 2;
  const cx = direction === 'right' ? w - 50 : 50;
  const sign = direction === 'right' ? 1 : -1;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(-14 * sign, -22);
  ctx.lineTo(14 * sign, 0);
  ctx.lineTo(-14 * sign, 22);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawApproaching(ctx: CanvasRenderingContext2D, x: number, y: number, t: number) {
  const radius = MAX_RETICLE_RADIUS - (MAX_RETICLE_RADIUS - MIN_RETICLE_RADIUS) * Math.max(0, Math.min(1, t));
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#f5a623';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawLocking(ctx: CanvasRenderingContext2D, x: number, y: number, progress: number, ok: boolean) {
  const radius = MIN_RETICLE_RADIUS;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = ok ? 'rgba(48,209,88,0.9)' : 'rgba(48,209,88,0.4)';
  ctx.lineWidth = 3;
  ctx.stroke();

  if (progress > 0) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 6, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = '#30d158';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}

function drawCaptured(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(48,209,88,0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 5, y);
  ctx.lineTo(x - 1, y + 4);
  ctx.lineTo(x + 6, y - 5);
  ctx.strokeStyle = '#04210c';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawRollIndicator(ctx: CanvasRenderingContext2D, w: number, h: number, roll: number, ok: boolean) {
  const cx = w / 2;
  const cy = h - 90;
  const len = 60;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(roll);
  ctx.beginPath();
  ctx.moveTo(-len, 0);
  ctx.lineTo(len, 0);
  ctx.strokeStyle = ok ? 'rgba(255,255,255,0.8)' : 'rgba(255,69,58,0.9)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(cx, cy - 10);
  ctx.lineTo(cx, cy + 10);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
}
