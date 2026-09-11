import { headingFromQuat } from '@panorama/shared';
import type { OrientationSample } from '../capture/useOrientation.js';

export interface DebugHudProps {
  sample: OrientationSample | null;
  rollDeg: number;
  isStable: boolean;
  jerk: number;
  camWidth: number;
  camHeight: number;
  focalPx: number;
}

/**
 * Live yaw/pitch/roll readout for the M0 milestone: the whole point is to
 * verify (on the real iPhone) that heading tracks the compass, pitch
 * matches the physical tilt, and roll goes to zero when level, *before*
 * building the reticle guidance on top. Toggle with the HUD button in the
 * capture screen.
 */
export function DebugHud({ sample, rollDeg, isStable, jerk, camWidth, camHeight, focalPx }: DebugHudProps) {
  const headingDeg = sample ? ((headingFromQuat(sample.quat) * 180) / Math.PI + 360) % 360 : null;

  return (
    <div className="pointer-events-none absolute left-2 top-2 z-20 rounded-lg bg-black/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-lime-300">
      <div>raw α {sample?.raw.alpha.toFixed(1) ?? '—'}° β {sample?.raw.beta.toFixed(1) ?? '—'}° γ {sample?.raw.gamma.toFixed(1) ?? '—'}°</div>
      <div>heading {headingDeg?.toFixed(1) ?? '—'}°</div>
      <div>
        sensor {sample ? sample.hz.toFixed(0) : '—'}Hz ω {sample ? sample.rateDegPerSec.toFixed(0) : '—'}°/s
      </div>
      <div>roll {rollDeg.toFixed(1)}° {Math.abs(rollDeg) < 12 ? '' : '⚠ nivela el teléfono'}</div>
      <div>compass {sample?.compassLocked ? 'ok' : 'sin señal'}</div>
      <div>
        estable {isStable ? 'sí' : 'no'} (jerk {jerk.toFixed(1)})
      </div>
      <div>
        cam {camWidth}×{camHeight} focal {focalPx.toFixed(0)}px
      </div>
    </div>
  );
}
