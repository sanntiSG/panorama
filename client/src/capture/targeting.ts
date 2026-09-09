import {
  angularSeparation,
  qRotateVec,
  worldDirToScreen,
  type CameraModel,
  type CapturePlan,
  type PlanTarget,
  type Quat,
} from '@panorama/shared';

export type ReticleState = 'pending' | 'approaching' | 'locking' | 'captured';

export interface ProjectedTarget {
  target: PlanTarget;
  /** Screen-space pixel position, even when off the visible frame (used to draw an edge arrow). */
  screen: { x: number; y: number };
  /** False when the target is behind the camera or so far off-axis the pinhole projection is meaningless. */
  visible: boolean;
  angularErrorRad: number;
  state: ReticleState;
}

/** Center-of-frame angular error under which a target is considered "locked" (before checking roll/stability). */
export const LOCK_ANGULAR_THRESHOLD_RAD = (4 * Math.PI) / 180;
/** Roll beyond which we refuse to lock even if pointing is perfect — a rolled shot loses real coverage. */
export const LOCK_ROLL_THRESHOLD_RAD = (12 * Math.PI) / 180;
/** Below this angular error the reticle starts shrinking/turning amber ("getting warmer"). */
export const APPROACH_ANGULAR_THRESHOLD_RAD = (25 * Math.PI) / 180;

const WORLD_UP = { x: 0, y: 0, z: 1 };
const CAM_FORWARD = { x: 0, y: 0, z: -1 };
const CAM_UP = { x: 0, y: 1, z: 0 };

/**
 * Roll (radians) of the camera about its own boresight, relative to
 * "level" (camera-local up aligned with world up's projection onto the view
 * plane). Zero when looking at the horizon with the phone held upright;
 * undefined (returns 0) when looking straight up/down, where roll has no
 * meaning.
 */
export function computeRoll(quat: Quat): number {
  const forward = qRotateVec(quat, CAM_FORWARD);
  const up = qRotateVec(quat, CAM_UP);

  const dot = WORLD_UP.x * forward.x + WORLD_UP.y * forward.y + WORLD_UP.z * forward.z;
  const levelUp = {
    x: WORLD_UP.x - dot * forward.x,
    y: WORLD_UP.y - dot * forward.y,
    z: WORLD_UP.z - dot * forward.z,
  };
  const levelLen = Math.hypot(levelUp.x, levelUp.y, levelUp.z);
  if (levelLen < 1e-6) return 0; // looking (almost) straight up/down

  const levelUpN = { x: levelUp.x / levelLen, y: levelUp.y / levelLen, z: levelUp.z / levelLen };
  const cross = {
    x: up.y * levelUpN.z - up.z * levelUpN.y,
    y: up.z * levelUpN.x - up.x * levelUpN.z,
    z: up.x * levelUpN.y - up.y * levelUpN.x,
  };
  const sinAngle = cross.x * forward.x + cross.y * forward.y + cross.z * forward.z;
  const cosAngle = up.x * levelUpN.x + up.y * levelUpN.y + up.z * levelUpN.z;
  return Math.atan2(sinAngle, cosAngle);
}

export function projectTargets(
  plan: CapturePlan,
  capturedIds: ReadonlySet<string>,
  quat: Quat,
  cam: CameraModel,
): ProjectedTarget[] {
  const forward = qRotateVec(quat, CAM_FORWARD);
  return plan.targets.map((target) => {
    const angularErrorRad = angularSeparation(forward, target.direction);
    const point = worldDirToScreen(target.direction, quat, cam);

    let state: ReticleState;
    if (capturedIds.has(target.id)) {
      state = 'captured';
    } else if (angularErrorRad < LOCK_ANGULAR_THRESHOLD_RAD) {
      state = 'locking';
    } else if (angularErrorRad < APPROACH_ANGULAR_THRESHOLD_RAD) {
      state = 'approaching';
    } else {
      state = 'pending';
    }

    return { target, screen: { x: point.x, y: point.y }, visible: point.visible, angularErrorRad, state };
  });
}
