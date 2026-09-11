import {
  angularSeparation,
  qInverse,
  qRotateVec,
  worldDirToScreen,
  type CameraModel,
  type CapturePlan,
  type PlanTarget,
  type Quat,
  type Vec3,
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

/**
 * Center-of-frame angular error under which a target is considered "locked"
 * (before checking roll/stability). 6°, not the tighter 4° this used to be:
 * adjacent ring targets are laid out ~30° apart against a phone's ~49° hFov
 * (see shared/plan/capturePlan.ts), so there's plenty of overlap margin to
 * spend, and 4° plus the 250ms hold plus the stability gate was a lot to
 * demand of a handheld aim.
 */
export const LOCK_ANGULAR_THRESHOLD_RAD = (6 * Math.PI) / 180;
/**
 * Tighter threshold the *hold* must additionally satisfy for its elapsed
 * time to actually accumulate — separate from `LOCK_ANGULAR_THRESHOLD_RAD`
 * above, which only gates the ring turning green and starting to count.
 * Staying merely inside the acquire cone (a handheld aim can wander the
 * full 6° while still technically "locking") isn't good enough for the
 * pose actually recorded at fire time to be trustworthy — real capture
 * sessions showed shots taken mid-wobble landing near that 6° edge,
 * producing ghosting in the stitched panorama. While the error is between
 * this and the acquire threshold, hold progress pauses (doesn't reset,
 * doesn't advance) until the aim genuinely settles — see ReticleLayer's
 * `steady` check.
 */
export const LOCK_MAINTAIN_ANGULAR_THRESHOLD_RAD = (3 * Math.PI) / 180;
/** Roll beyond which we refuse to lock even if pointing is perfect — a rolled shot loses real coverage. */
export const LOCK_ROLL_THRESHOLD_RAD = (12 * Math.PI) / 180;
/** Below this angular error the reticle starts shrinking/turning amber ("getting warmer"). */
export const APPROACH_ANGULAR_THRESHOLD_RAD = (25 * Math.PI) / 180;
/** Beyond this angular error a non-primary target isn't drawn at all — keeps the screen from looking cluttered with faint dots the user isn't being guided toward yet. */
export const SECONDARY_MAX_ANGLE_RAD = (45 * Math.PI) / 180;
/** Hysteresis margin so pickPrimaryTarget doesn't flicker between two near-equidistant targets as the user moves. */
export const PRIMARY_SWITCH_MARGIN_RAD = (3 * Math.PI) / 180;

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

/**
 * The single target the user should be aiming at right now: the nearest
 * not-yet-captured one, with a small hysteresis margin so it doesn't flicker
 * between two near-tied candidates as the phone moves. Pass the previous
 * frame's primary id (or `null`) in; the returned target becomes the next
 * frame's `previousPrimaryId`.
 */
export function pickPrimaryTarget(
  projected: ProjectedTarget[],
  previousPrimaryId: string | null,
): ProjectedTarget | null {
  let nearest: ProjectedTarget | null = null;
  let previous: ProjectedTarget | null = null;
  for (const p of projected) {
    if (p.state === 'captured') continue;
    if (p.target.id === previousPrimaryId) previous = p;
    if (!nearest || p.angularErrorRad < nearest.angularErrorRad) nearest = p;
  }
  if (!nearest) return null;
  if (previous && previous.target.id !== nearest.target.id) {
    if (previous.angularErrorRad - nearest.angularErrorRad < PRIMARY_SWITCH_MARGIN_RAD) {
      return previous;
    }
  }
  return nearest;
}

/**
 * Unit direction, in screen axes (+x right, +y down), from the frame center
 * toward `worldDir` — used to point the off-screen edge arrow even when the
 * target is behind the camera or otherwise has no valid pixel projection
 * (`worldDirToScreen`/`projectCamDir` return `visible: false` there).
 * Returns `null` only when `worldDir` sits (within floating-point epsilon)
 * exactly on the boresight axis, where "which way to turn" is undefined.
 */
export function screenDirectionTo(worldDir: Vec3, quat: Quat): { x: number; y: number } | null {
  const camDir = qRotateVec(qInverse(quat), worldDir);
  const len = Math.hypot(camDir.x, camDir.y);
  if (len < 1e-6) return null;
  return { x: camDir.x / len, y: -camDir.y / len };
}

/**
 * Plain-language version of a `screenDirectionTo` result — "which way do I
 * physically turn the phone" is a much easier question to answer from words
 * than from an arrow + a angle, especially the first few times. `dir` is in
 * the same screen axes as `screenDirectionTo` (+x right, +y down), so this
 * needs no sign translation: the direction the target appears in on screen
 * *is* the direction to turn the phone to bring it to center.
 */
export function describeDirection(dir: { x: number; y: number }): string {
  const absX = Math.abs(dir.x);
  const absY = Math.abs(dir.y);
  const horiz = dir.x > 0 ? 'a la derecha' : 'a la izquierda';
  const vert = dir.y > 0 ? 'hacia abajo' : 'hacia arriba';
  if (absX > absY * 1.8) return `Gira ${horiz}`;
  if (absY > absX * 1.8) return `Apunta ${vert}`;
  return `Gira ${horiz} y ${vert}`;
}

/**
 * The two endpoints (in the video's native pixel space, same as
 * `ProjectedTarget.screen`) of the true horizon line for the current camera
 * pose — the world-locked visual anchor `ReticleLayer` draws first, under
 * everything else. `null` when the camera looks within a few degrees of
 * straight up/down, where the horizon isn't a meaningful line in-frame.
 *
 * Derivation: a camera-local direction `d` (unnormalized, `(px, py, -f)` in
 * the same convention `unprojectToCamDir` uses) is *on* the horizon exactly
 * when its world-frame image has zero "up" component, i.e.
 * `qRotateVec(quat, d) · worldUp == 0`. Rotations preserve dot products, so
 * that's equivalent to `d · n == 0` with `n = qRotateVec(qInverse(quat),
 * worldUp)` — a line in pixel space, solved here for whichever of x/y gives
 * the better-conditioned line (avoids blowing up when the horizon is nearly
 * vertical in-frame, i.e. the camera is rolled close to 90°).
 */
export function horizonLine(
  quat: Quat,
  cam: CameraModel,
): { a: { x: number; y: number }; b: { x: number; y: number } } | null {
  const n = qRotateVec(qInverse(quat), { x: 0, y: 0, z: 1 });
  if (Math.hypot(n.x, n.y) < 1e-4) return null; // looking (almost) straight up/down

  const cx = cam.width / 2;
  const cy = cam.height / 2;
  const f = cam.focalPx;

  if (Math.abs(n.y) >= Math.abs(n.x)) {
    const yAt = (x: number) => cy + (n.x * (x - cx) - n.z * f) / n.y;
    return { a: { x: 0, y: yAt(0) }, b: { x: cam.width, y: yAt(cam.width) } };
  }
  const xAt = (y: number) => cx + (n.y * (y - cy) + n.z * f) / n.x;
  return { a: { x: xAt(0), y: 0 }, b: { x: xAt(cam.height), y: cam.height } };
}
