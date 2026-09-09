import { useCallback, useEffect, useRef, useState } from 'react';
import { quatLookingAt, type Quat } from '@panorama/shared';
import type { OrientationSample } from '../capture/useOrientation.js';

/**
 * Desktop stand-in for useOrientation: drag the pointer to "rotate the
 * phone". Lets the whole guidance/lock/capture/upload/stitch flow be
 * developed and demoed on a laptop with a webcam, without real gyro
 * hardware — see the plan's M0 milestone. Same return shape as
 * useOrientation so screens can use either behind one interface.
 */

const DRAG_SENSITIVITY = 0.005; // radians per pixel
const MAX_PITCH = (89 * Math.PI) / 180;

export function useSimulatedOrientation(targetElement: HTMLElement | null) {
  const [sample, setSample] = useState<OrientationSample | null>(null);
  const quatRef = useRef<Quat | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);

  const publish = useCallback(() => {
    const q = quatLookingAt(yawRef.current, pitchRef.current, 0);
    quatRef.current = q;
    setSample({
      quat: q,
      raw: { alpha: (yawRef.current * 180) / Math.PI, beta: 90, gamma: 0 },
      compassLocked: false,
    });
  }, []);

  useEffect(() => {
    publish(); // establish an initial pose immediately
  }, [publish]);

  useEffect(() => {
    const el = targetElement;
    if (!el) return;

    function onPointerDown(e: PointerEvent) {
      draggingRef.current = { x: e.clientX, y: e.clientY };
      el!.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      const start = draggingRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      draggingRef.current = { x: e.clientX, y: e.clientY };
      yawRef.current += dx * DRAG_SENSITIVITY;
      pitchRef.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitchRef.current + dy * DRAG_SENSITIVITY));
      publish();
    }
    function onPointerUp(e: PointerEvent) {
      draggingRef.current = null;
      try {
        el!.releasePointerCapture(e.pointerId);
      } catch {
        // already released — harmless
      }
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    };
  }, [targetElement, publish]);

  return {
    permission: 'unnecessary' as const,
    requestPermission: async () => true,
    sample,
    quatRef,
  };
}
