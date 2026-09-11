import type { Quat, Vec3 } from './math/quat.js';
import type { CameraModel } from './math/camera.js';

export type { CameraModel };

/** One point on the sphere the capture plan wants a photo of. */
export interface PlanTarget {
  id: string;
  kind: 'ring' | 'zenith' | 'nadir';
  /** Index of the horizontal ring, 0 = equator, negative = below, positive = above. Zenith/nadir use ±Infinity. */
  ringIndex: number;
  /** World-frame unit direction this target points at. */
  direction: Vec3;
  /** Convenience yaw (radians, [0, 2π), clockwise from north) matching `direction`. */
  yaw: number;
  /** Convenience pitch (radians, [-π/2, π/2], + is up) matching `direction`. */
  pitch: number;
}

export interface CapturePlan {
  targets: PlanTarget[];
  /** Horizontal FOV (radians) the plan was generated for. */
  hFov: number;
  /** Vertical FOV (radians) the plan was generated for. */
  vFov: number;
  /** Fractional overlap between adjacent shots the plan was generated for, e.g. 0.35. */
  overlap: number;
}

/** Everything captured about one photo at the moment it was taken. */
export interface ShotMeta {
  targetId: string;
  /** Camera's world-frame rotation at capture time (orientationToQuat output, possibly heading-corrected). */
  quat: Quat;
  screenAngle: number;
  capturedAt: number;
  cam: CameraModel;
}

/** A shot as tracked server-side, once its file has landed on disk. */
export interface ShotRecord extends ShotMeta {
  fileName: string;
}

export interface SessionManifest {
  id: string;
  createdAt: number;
  overlap: number;
  /** Focal length (px, at ShotMeta.cam resolution) calibrated by a previous stitch, if any. */
  nominalFocalPx: number | null;
  shots: ShotRecord[];
}

/** Per-shot refined pose, produced by the bundle adjuster. */
export interface RefinedPose {
  targetId: string;
  quat: Quat;
  /** How this pose was determined, for diagnostics/UI. */
  source: 'bundle' | 'phase-fallback' | 'prior-only';
  /** How many accepted pairwise measurements support this pose (bundle.ts's acceptedPairs) — 0 for 'prior-only'. */
  acceptedPairs: number;
  /** The render weight this pose's shot actually got (render.ts's RenderShotInput.trust), for diagnostics/UI. */
  trust: number;
}

export interface StitchResult {
  outputFile: string;
  width: number;
  height: number;
  focalPx: number;
  poses: RefinedPose[];
  /** Mean reprojection residual (px) over inlier correspondences, post bundle-adjustment. */
  meanResidualPx: number;
  /** Fraction of output pixels with no contributing shot at all (before the pole-cap smear fills it in) — a direct signal of genuine geometric coverage gaps, as opposed to a rendering/blending issue. */
  uncoveredFraction: number;
}

/** Server-sent-event payload shape for /api/sessions/:id/stitch progress. */
export type StitchProgressEvent =
  | { stage: 'decode' | 'features' | 'matching' | 'bundle' | 'exposure' | 'render' | 'xmp'; progress: number; message: string }
  | { stage: 'done'; result: StitchResult }
  | { stage: 'error'; message: string };
