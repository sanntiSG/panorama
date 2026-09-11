import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { qRotateVec, yawPitchFromDirection, type CapturePlan, type Quat } from '@panorama/shared';

export interface CoverageMapProps {
  plan: CapturePlan;
  capturedIds: ReadonlySet<string>;
  quatRef: RefObject<Quat | null>;
}

const MAP_WIDTH = 120;
const MAP_HEIGHT = 60;
const CAM_FORWARD = { x: 0, y: 0, z: -1 };
const TWO_PI = Math.PI * 2;

/** Plain equirectangular projection (yaw → x, pitch → y) — the same mapping the final panorama itself uses, just tiny. */
function project(yaw: number, pitch: number): { x: number; y: number } {
  const wrapped = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
  return {
    x: (wrapped / TWO_PI) * MAP_WIDTH,
    y: ((Math.PI / 2 - pitch) / Math.PI) * MAP_HEIGHT,
  };
}

/**
 * Small "you are here" overview of the whole sphere: one dot per plan
 * target (dim = pending, green = captured) plus a ring for where the
 * camera is aimed right now. Complements the single-target guidance the
 * rest of the overlay gives (the primary reticle, the edge arrow) with the
 * thing they deliberately don't show — the big picture of what's left and
 * roughly where, so a whole panorama doesn't feel like an unpredictable
 * sequence of single targets with no sense of overall progress.
 */
export function CoverageMap({ plan, capturedIds, quatRef }: CoverageMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const capturedIdsRef = useRef(capturedIds);
  capturedIdsRef.current = capturedIds;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const maybeCtx = canvas.getContext('2d');
    if (!maybeCtx) return;
    // Nested function declarations below don't retain the narrowing from
    // the check above, so bind to an explicitly non-null local instead.
    const ctx: CanvasRenderingContext2D = maybeCtx;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MAP_WIDTH * dpr;
    canvas.height = MAP_HEIGHT * dpr;
    canvas.style.width = `${MAP_WIDTH}px`;
    canvas.style.height = `${MAP_HEIGHT}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let stopped = false;

    function draw() {
      if (stopped) return;
      raf = requestAnimationFrame(draw);

      ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

      const captured = capturedIdsRef.current;
      for (const target of plan.targets) {
        const { x, y } = project(target.yaw, target.pitch);
        const done = captured.has(target.id);
        ctx.beginPath();
        ctx.arc(x, y, done ? 2 : 1.4, 0, Math.PI * 2);
        ctx.fillStyle = done ? '#30d158' : 'rgba(255,255,255,0.35)';
        ctx.fill();
      }

      const quat = quatRef.current;
      if (quat) {
        const forward = qRotateVec(quat, CAM_FORWARD);
        const { yaw, pitch } = yawPitchFromDirection(forward);
        const { x, y } = project(yaw, pitch);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // plan's identity is stable for the whole capture session; capturedIds/
    // quatRef are read fresh each frame via ref/closure, not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  return (
    <div className="pointer-events-none absolute right-2 top-12 z-20 overflow-hidden rounded-md border border-white/10">
      <canvas ref={canvasRef} />
    </div>
  );
}
