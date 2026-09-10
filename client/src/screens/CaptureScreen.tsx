import type { RefObject } from 'react';
import type { CameraModel, CapturePlan, PlanTarget, Quat } from '@panorama/shared';
import { ReticleLayer } from '../overlay/ReticleLayer.js';
import { DebugHud } from '../overlay/DebugHud.js';
import type { OrientationSample } from '../capture/useOrientation.js';

export interface CaptureScreenProps {
  // A callback ref (from useCamera's `attachVideo`), not a plain
  // `RefObject<HTMLVideoElement>`: the camera stream can start flowing
  // before this screen (and its `<video>`) even mounts — see
  // `useCamera.ts`'s `attachVideo` for why a plain ref object can't attach
  // it once the element shows up, only a callback fired on mount can.
  videoRef: (el: HTMLVideoElement | null) => void;
  plan: CapturePlan;
  camModel: CameraModel;
  quatRef: RefObject<Quat | null>;
  isStableRef: RefObject<boolean>;
  capturedIds: ReadonlySet<string>;
  onLockFire: (target: PlanTarget, quatAtCapture: Quat) => void;
  showHud: boolean;
  onToggleHud: () => void;
  debugSample: OrientationSample | null;
  rollDeg: number;
  isStable: boolean;
  jerk: number;
  onFinishEarly: () => void;
  simulatorMode: boolean;
  pendingUploads: number;
}

export function CaptureScreen({
  videoRef,
  plan,
  camModel,
  quatRef,
  isStableRef,
  capturedIds,
  onLockFire,
  showHud,
  onToggleHud,
  debugSample,
  rollDeg,
  isStable,
  jerk,
  onFinishEarly,
  simulatorMode,
  pendingUploads,
}: CaptureScreenProps) {
  const total = plan.targets.length;
  const done = capturedIds.size;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" />

      <ReticleLayer
        plan={plan}
        cam={camModel}
        quatRef={quatRef}
        isStableRef={isStableRef}
        capturedIds={capturedIds}
        onLockFire={onLockFire}
        suspended={false}
      />

      {showHud && (
        <DebugHud
          sample={debugSample}
          rollDeg={rollDeg}
          isStable={isStable}
          jerk={jerk}
          camWidth={camModel.width}
          camHeight={camModel.height}
          focalPx={camModel.focalPx}
        />
      )}

      <div className="pointer-events-none absolute right-2 top-2 z-20 rounded-full bg-black/70 px-4 py-1.5 text-sm font-medium text-white">
        {done}/{total}
        {pendingUploads > 0 && <span className="ml-2 text-xs text-neutral-400">↑{pendingUploads}</span>}
      </div>

      {simulatorMode && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded bg-black/50 px-3 py-1 text-xs text-white">
          Arrastra para rotar
        </div>
      )}

      <div className="absolute bottom-4 left-0 right-0 z-20 flex items-center justify-center gap-3">
        <button
          onClick={onToggleHud}
          className="rounded-full bg-black/60 px-4 py-2 text-xs font-medium text-white"
        >
          {showHud ? 'Ocultar HUD' : 'Mostrar HUD'}
        </button>
        <button
          onClick={onFinishEarly}
          className="rounded-full bg-white px-5 py-2 text-xs font-semibold text-black"
        >
          Terminar
        </button>
      </div>
    </div>
  );
}
