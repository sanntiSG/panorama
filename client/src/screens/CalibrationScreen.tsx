import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Quat } from '@panorama/shared';
import { HEADING_BUCKETS, useHeadingCoverage } from '../capture/useHeadingCoverage.js';

export interface CalibrationScreenProps {
  /** Callback ref — see useCamera.ts's attachVideo. This screen's own <video> is what the live stream attaches to until CaptureScreen's <video> takes over. */
  videoRef: (el: HTMLVideoElement | null) => void;
  quatRef: RefObject<Quat | null>;
  lastInputAtRef: RefObject<number>;
  simulatorMode: boolean;
  onComplete: () => void;
  /** Sensor genuinely stalled — returns to setup. Not a skip: this never leads to `capturing` without completing the sweep. */
  onAbort: () => void;
}

const DIAL_SIZE = 220;
const DIAL_RADIUS = 72;
const DIAL_SECTOR_WIDTH = 12;
const DIAL_GAP_RAD = 0.03;

function drawDial(ctx: CanvasRenderingContext2D, size: number, visited: readonly boolean[], headingRad: number, nearPole: boolean) {
  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  const bucketAngle = (Math.PI * 2) / HEADING_BUCKETS;
  for (let i = 0; i < HEADING_BUCKETS; i++) {
    // -PI/2 offset: heading 0 (north) should point straight up on the dial,
    // matching a real compass rather than canvas's 0-is-right convention.
    const a0 = i * bucketAngle - Math.PI / 2;
    const a1 = a0 + bucketAngle;
    ctx.beginPath();
    ctx.arc(cx, cy, DIAL_RADIUS, a0 + DIAL_GAP_RAD, a1 - DIAL_GAP_RAD);
    ctx.strokeStyle = visited[i] ? '#30d158' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = DIAL_SECTOR_WIDTH;
    ctx.stroke();
  }

  ctx.font = '600 13px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - DIAL_RADIUS - 16);

  if (!nearPole && !Number.isNaN(headingRad)) {
    const angle = headingRad - Math.PI / 2;
    const len = DIAL_RADIUS - DIAL_SECTOR_WIDTH;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = nearPole ? 'rgba(255,69,58,0.9)' : '#fff';
  ctx.fill();
}

/**
 * Mandatory step between "camera + sensors granted" and real capture: the
 * user has to slowly sweep the camera through most of a full turn before
 * `onComplete` ever fires. Two purposes at once — the sensors (especially
 * the compass, see useOrientation.ts's slow-converging correction) get a
 * deliberate, unhurried motion to settle against, and the user sees, risk
 * free, how the "aim at the moving reticle" interaction behaves before the
 * real capture ring appears.
 */
export function CalibrationScreen({ videoRef, quatRef, lastInputAtRef, simulatorMode, onComplete, onAbort }: CalibrationScreenProps) {
  const coverage = useHeadingCoverage(quatRef, lastInputAtRef);
  const dialCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const completedRef = useRef(false);
  // App re-renders ~10Hz while orientation is live (useOrientation's
  // throttled sample publish), and App passes onComplete/onAbort as fresh
  // inline closures every render — so their identity is not stable. Reading
  // them through refs (updated every render, no effect dependency on the
  // callbacks themselves) means the completion effect below only reacts to
  // coverage.complete actually changing, not to App re-rendering for an
  // unrelated reason.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onAbortRef = useRef(onAbort);
  onAbortRef.current = onAbort;

  useEffect(() => {
    const canvas = dialCanvasRef.current;
    if (!canvas) return;
    const maybeCtx = canvas.getContext('2d');
    if (!maybeCtx) return;
    // Nested function declarations below don't retain the narrowing from
    // the check above, so bind to an explicitly non-null local instead.
    const ctx: CanvasRenderingContext2D = maybeCtx;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = DIAL_SIZE * dpr;
    canvas.height = DIAL_SIZE * dpr;
    canvas.style.width = `${DIAL_SIZE}px`;
    canvas.style.height = `${DIAL_SIZE}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let stopped = false;
    function frame() {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      drawDial(ctx, DIAL_SIZE, coverage.visitedRef.current ?? [], coverage.headingRef.current ?? NaN, coverage.nearPole);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // coverage.{visitedRef,headingRef} are stable ref objects read through
    // .current each frame; coverage.nearPole only gates whether the needle
    // is drawn this frame, read fresh via the closure — none of these need
    // to restart the rAF loop when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!coverage.complete || completedRef.current) return;
    completedRef.current = true;
    // Small pause so the user actually sees the dial close ("¡Listo!")
    // instead of being teleported straight into the capture screen. Reads
    // onCompleteRef.current (not the onComplete prop directly) so this
    // timer isn't at the mercy of App's frequent re-renders — see the ref
    // comment above; without it this effect re-ran (and cancelled the
    // pending timeout via its cleanup) roughly every 100ms, and since
    // completedRef.current was already true it never got rescheduled, so
    // onComplete silently never fired at all.
    const t = setTimeout(() => onCompleteRef.current(), 700);
    return () => clearTimeout(t);
  }, [coverage.complete]);

  const hint = coverage.nearPole
    ? 'Apunta hacia el horizonte, no al suelo ni al techo.'
    : coverage.sinceProgressMs > 8000
      ? 'Sigue girando despacio, en la misma dirección.'
      : coverage.elapsedMs > 30000
        ? 'Si no avanza: aléjate de objetos metálicos y prueba a mover el teléfono despacio en forma de ocho.'
        : simulatorMode
          ? 'Arrastra despacio sobre el vídeo para simular el giro.'
          : 'Gira despacio sobre tu propio eje.';

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-black/55" />

      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 px-8 text-center text-white">
        <h2 className="text-xl font-semibold">Vamos a calibrar</h2>
        <p className="max-w-xs text-sm text-neutral-300">
          Antes de empezar, gira despacio sobre ti mismo con el teléfono en vertical hasta completar la vuelta — así
          afinamos los sensores y ves cómo funciona el guiado.
        </p>

        {/* Always mounted (just hidden, not unmounted) even during the
            sensorSilent error state below: the draw-loop effect only ever
            runs once and binds to whichever canvas element exists at that
            moment — an unmount/remount here (e.g. sensorSilent flipping
            true then recovering false) would strand that loop on a
            detached canvas with nothing drawing into the new one. */}
        <canvas ref={dialCanvasRef} className={coverage.sensorSilent ? 'hidden' : undefined} />

        {coverage.sensorSilent ? (
          <div className="flex flex-col items-center gap-3">
            <p className="max-w-xs text-sm text-red-400">
              No estamos recibiendo datos del sensor de movimiento. Comprueba que los permisos siguen concedidos.
            </p>
            <button onClick={() => onAbortRef.current()} className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black">
              Volver a intentar
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium">
              {Math.min(coverage.visitedCount, coverage.required)}/{coverage.required} sectores
              {coverage.complete ? ' — ¡Listo!' : ''}
            </p>
            <p className="max-w-xs text-xs text-neutral-400">{hint}</p>
          </>
        )}
      </div>
    </div>
  );
}
