/**
 * Pure canvas drawing helpers for `ReticleLayer` — no React, no state, just
 * `(ctx, ...) => void`. Kept separate so the rAF loop in ReticleLayer.tsx
 * stays readable as "for each thing, call the function that draws it"
 * rather than a few hundred lines of inline canvas calls.
 */
import { directionFromYawPitch, headingFromQuat, worldDirToScreen, type CameraModel, type Quat, type Vec3 } from '@panorama/shared';
import { APPROACH_ANGULAR_THRESHOLD_RAD, LOCK_ANGULAR_THRESHOLD_RAD, SECONDARY_MAX_ANGLE_RAD, horizonLine } from '../capture/targeting.js';
import { applyCoverTransform, type CoverTransform } from '../capture/viewport.js';

interface LabelOptions {
  align?: CanvasTextAlign;
  size?: number;
  color?: string;
}

/** Text with a dark halo stroke — over arbitrary live video, plain fillText is often unreadable. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: LabelOptions = {}) {
  const { align = 'center', size = 13, color = '#fff' } = opts;
  ctx.font = `600 ${size}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Strokes a sequence of world directions as a polyline in screen space, breaking into separate subpaths wherever the projection goes invisible (behind the camera / off the pinhole's valid range) instead of drawing a stray line across the gap. */
function strokeWorldPolyline(
  ctx: CanvasRenderingContext2D,
  dirs: Vec3[],
  quat: Quat,
  cam: CameraModel,
  transform: CoverTransform,
) {
  ctx.beginPath();
  let started = false;
  for (const dir of dirs) {
    const p = worldDirToScreen(dir, quat, cam);
    if (!p.visible) {
      started = false;
      continue;
    }
    const { x, y } = applyCoverTransform(p.x, p.y, transform);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

const LADDER_PITCHES_DEG = [30, 60];
const GRID_SAMPLE_STEP_DEG = 6;
const GRID_HALF_SPAN_DEG = 60;
const MERIDIAN_STEP_DEG = 30;
const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
const DEG2RAD = Math.PI / 180;

/**
 * The world-locked visual anchor the capture screen is missing entirely
 * today: a horizon line, a pitch "ladder" every 30°, and heading meridians
 * (with cardinal labels) near the current view. None of it moves with the
 * screen — it's fixed to the world exactly like the plan's targets are, so
 * seeing it slide opposite the phone's motion and settle when the phone
 * holds still is the visual proof the targets really are anchored too.
 * Draw this first — everything else layers on top.
 */
export function drawWorldGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  quat: Quat,
  cam: CameraModel,
  transform: CoverTransform,
) {
  const currentHeading = headingFromQuat(quat);

  const horizon = horizonLine(quat, cam);
  if (horizon) {
    const a = applyCoverTransform(horizon.a.x, horizon.a.y, transform);
    const b = applyCoverTransform(horizon.b.x, horizon.b.y, transform);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1.5;

  for (const pitchDeg of LADDER_PITCHES_DEG) {
    for (const sign of [1, -1]) {
      const pitchRad = sign * pitchDeg * DEG2RAD;
      const dirs: Vec3[] = [];
      for (let dh = -GRID_HALF_SPAN_DEG; dh <= GRID_HALF_SPAN_DEG; dh += GRID_SAMPLE_STEP_DEG) {
        dirs.push(directionFromYawPitch(currentHeading + dh * DEG2RAD, pitchRad));
      }
      strokeWorldPolyline(ctx, dirs, quat, cam, transform);

      const endDir = directionFromYawPitch(currentHeading + GRID_HALF_SPAN_DEG * DEG2RAD, pitchRad);
      const endP = worldDirToScreen(endDir, quat, cam);
      if (endP.visible) {
        const { x, y } = applyCoverTransform(endP.x, endP.y, transform);
        if (x > 20 && x < w - 20 && y > 20 && y < h - 20) {
          label(ctx, `${sign * pitchDeg}°`, x, y, { size: 11, color: 'rgba(255,255,255,0.5)' });
        }
      }
    }
  }

  for (let m = 0; m < 360; m += MERIDIAN_STEP_DEG) {
    const meridianRad = m * DEG2RAD;
    const diff = Math.atan2(Math.sin(meridianRad - currentHeading), Math.cos(meridianRad - currentHeading));
    if (Math.abs(diff) > GRID_HALF_SPAN_DEG * DEG2RAD) continue;

    const dirs: Vec3[] = [];
    for (let p = -GRID_HALF_SPAN_DEG; p <= GRID_HALF_SPAN_DEG; p += GRID_SAMPLE_STEP_DEG) {
      dirs.push(directionFromYawPitch(meridianRad, p * DEG2RAD));
    }
    strokeWorldPolyline(ctx, dirs, quat, cam, transform);

    const cardinal = CARDINALS[m];
    if (cardinal) {
      const horizonDir = directionFromYawPitch(meridianRad, 0);
      const hp = worldDirToScreen(horizonDir, quat, cam);
      if (hp.visible) {
        const { x, y } = applyCoverTransform(hp.x, hp.y, transform);
        if (x > 10 && x < w - 10 && y > 10 && y < h - 10) {
          label(ctx, cardinal, x, y - 14, { size: 13, color: 'rgba(255,255,255,0.65)' });
        }
      }
    }
  }
}

/** Fixed crosshair at the exact center of the screen — the "where am I pointing right now" reference that was missing entirely before this. */
export function drawCenterMark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const r = 9;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - r - 6, cy);
  ctx.lineTo(cx - r - 1, cy);
  ctx.moveTo(cx + r + 1, cy);
  ctx.lineTo(cx + r + 6, cy);
  ctx.moveTo(cx, cy - r - 6);
  ctx.lineTo(cx, cy - r - 1);
  ctx.moveTo(cx, cy + r + 1);
  ctx.lineTo(cx, cy + r + 6);
  ctx.stroke();
}

/** A not-yet-captured target that isn't the primary one — small and dim, and not drawn at all beyond SECONDARY_MAX_ANGLE_RAD, so the screen doesn't fill up with clutter the user isn't being guided toward yet. */
export function drawSecondaryDot(ctx: CanvasRenderingContext2D, x: number, y: number, angularErrorRad: number) {
  const t = Math.max(0, Math.min(1, 1 - angularErrorRad / SECONDARY_MAX_ANGLE_RAD));
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${(0.1 + 0.3 * t).toFixed(3)})`;
  ctx.fill();
}

export function drawCapturedDot(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(48,209,88,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 3.2, y);
  ctx.lineTo(x - 0.6, y + 2.6);
  ctx.lineTo(x + 3.8, y - 3.2);
  ctx.strokeStyle = 'rgba(4,33,12,0.9)';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

export interface PrimaryReticleOptions {
  angularErrorRad: number;
  locking: boolean;
  /** 0..1 fill-up of the lock-hold ring; 0 draws no ring at all. */
  progress: number;
  /** Shown instead of the degrees-remaining label when locking but gated (e.g. "Nivela el teléfono", "Mantén quieto"). */
  gateHint: string | null;
  /** World-frame yaw/pitch of the target itself (not just its already-projected screen point) — needed to project the card's own corners independently. See drawWorldCard. */
  targetYaw: number;
  targetPitch: number;
  quat: Quat;
  cam: CameraModel;
  transform: CoverTransform;
  /** False for zenith/nadir — the reference's own concentric-ring style for pole targets, not the rectangular card, since a card's "which way is up" cue stops meaning anything pointed straight up/down. */
  showCard: boolean;
}

const PRIMARY_MIN_RADIUS = 26;
const PRIMARY_MAX_RADIUS = 50;

/** Angular half-extents of the world-anchored card — a portrait rectangle (taller than wide), matching a reference app's own target shape (confirmed by direct frame-by-frame review: it visibly skews/rotates in perspective as you approach off-axis, straightening to upright right at lock — a flat card anchored at the target's own orientation, not a flat screen-space shape). Not derivable to pixel precision from screenshots alone — a reasonable starting size, easy to retune after seeing it live in the simulator. */
const CARD_HALF_WIDTH_RAD = (8 * Math.PI) / 180;
const CARD_HALF_HEIGHT_RAD = (11 * Math.PI) / 180;

/**
 * The card's 4 corners as world directions, in yaw/pitch offsets around the
 * target — the same small-angle-box simplification drawWorldGrid already
 * uses for its own world-anchored lines above (pure yaw/pitch steps, no
 * tangent-plane correction), not a new approximation.
 */
function cardCornerDirs(targetYaw: number, targetPitch: number): Vec3[] {
  return [
    directionFromYawPitch(targetYaw - CARD_HALF_WIDTH_RAD, targetPitch + CARD_HALF_HEIGHT_RAD),
    directionFromYawPitch(targetYaw + CARD_HALF_WIDTH_RAD, targetPitch + CARD_HALF_HEIGHT_RAD),
    directionFromYawPitch(targetYaw + CARD_HALF_WIDTH_RAD, targetPitch - CARD_HALF_HEIGHT_RAD),
    directionFromYawPitch(targetYaw - CARD_HALF_WIDTH_RAD, targetPitch - CARD_HALF_HEIGHT_RAD),
  ];
}

/**
 * Fills a flat card anchored in world space at the target's own orientation
 * (not a flat screen-space shape) — its on-screen corners naturally show
 * perspective skew/rotation the further off-axis the camera is, which is
 * exactly the "how do I need to tilt the phone" cue a reference app's own
 * target card gives (confirmed by direct comparison: its card visibly
 * straightens from a skewed parallelogram to an upright rectangle as you
 * approach correct alignment). Returns false (drawing nothing) if any
 * corner falls outside the pinhole projection's valid range — e.g. a target
 * near the edge of the frame — so the caller can fall back to a plainer
 * shape rather than draw a corrupted quad.
 */
function fillWorldCard(
  ctx: CanvasRenderingContext2D,
  targetYaw: number,
  targetPitch: number,
  quat: Quat,
  cam: CameraModel,
  transform: CoverTransform,
  fillStyle: string,
): boolean {
  const projected = cardCornerDirs(targetYaw, targetPitch).map((dir) => worldDirToScreen(dir, quat, cam));
  if (projected.some((p) => !p.visible)) return false;
  const points = projected.map((p) => applyCoverTransform(p.x, p.y, transform));

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  return true;
}

/**
 * The single target the user should be aiming at, rendered large and with
 * an explicit label — previously every uncaptured target on screen drew as
 * an identical faint ring with no explanation for why it wasn't firing.
 */
export function drawPrimaryReticle(ctx: CanvasRenderingContext2D, x: number, y: number, opts: PrimaryReticleOptions) {
  const { angularErrorRad, locking, progress, gateHint, targetYaw, targetPitch, quat, cam, transform, showCard } = opts;
  const span = APPROACH_ANGULAR_THRESHOLD_RAD - LOCK_ANGULAR_THRESHOLD_RAD;
  const t = span > 0 ? Math.max(0, Math.min(1, (angularErrorRad - LOCK_ANGULAR_THRESHOLD_RAD) / span)) : 0;
  const radius = PRIMARY_MIN_RADIUS + (PRIMARY_MAX_RADIUS - PRIMARY_MIN_RADIUS) * t;
  const color = locking ? '#30d158' : angularErrorRad < APPROACH_ANGULAR_THRESHOLD_RAD ? '#f5a623' : '#ffffff';

  const cardDrawn = showCard && fillWorldCard(ctx, targetYaw, targetPitch, quat, cam, transform, color);
  if (cardDrawn) {
    // Punch a transparent hole where the ring/hole sits so the live video
    // shows through it exactly like the reference's own card — this canvas
    // is an overlay directly on top of the <video>, so erasing back to
    // transparent here reveals the live feed underneath, not a color.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  if (progress > 0) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 8, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = '#30d158';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  const labelY = y + radius + 24;
  if (gateHint) {
    // Gate problems (roll/stability/steadiness) are more urgent than the
    // plain "you're holding" state below — always take priority.
    label(ctx, gateHint, x, labelY, { size: 12, color: '#ffd60a' });
  } else if (progress > 0) {
    // Matches the reference app directly: the instant the hold ring starts
    // filling (no gate blocking it), it shows the word "HOLD" the whole
    // time it fills, not a degrees countdown — confirmed frame-by-frame,
    // this is its default/only state during an active hold, not occasional.
    label(ctx, 'HOLD', x, labelY, { size: 13, color: '#30d158' });
  } else {
    const deg = Math.round((angularErrorRad * 180) / Math.PI);
    label(ctx, `${deg}°`, x, labelY, { size: 12, color: 'rgba(255,255,255,0.85)' });
  }
}

/**
 * Shown for a short window right after a shot fires, in place of the normal
 * hunt-for-the-next-target UI — a deliberate pause so the user gets a clear
 * "it fired, you can relax now" before the reticle immediately starts
 * chasing the next point while their pulse is still settling from the last
 * one. Doesn't retroactively change the sharpness of the shot just taken
 * (that's already decided by the hold that preceded it) — this is about the
 * transition to the *next* one starting from a calmer baseline.
 */
export function drawPostCaptureHint(ctx: CanvasRenderingContext2D, w: number, h: number, remainingFrac: number) {
  const cx = w / 2;
  const cy = h / 2 + 90; // just below the center mark, out of its way
  const alpha = Math.min(1, remainingFrac * 4); // quick fade in, lingers, no fade-out needed since it's cleared outright when the window ends
  label(ctx, 'Listo ✓', cx, cy, { size: 15, color: `rgba(48,209,88,${alpha.toFixed(3)})` });
}

export interface EdgeArrowOptions {
  distanceDeg: number;
  /** 0..1, caller-driven pulse phase (e.g. from `(sin(now/280)+1)/2`) — a static arrow is easy to miss in a busy scene. */
  pulse: number;
  /** Plain-language version of the same direction (see targeting.ts's describeDirection) — "Gira a la derecha" reads far faster than an arrow + a angle, especially the first few times. */
  label: string;
}

const EDGE_MARGIN_PX = 46;

/** Points from the padded edge of the frame toward the primary target when it's off-screen — in any direction, not just left/right, since a target can be off the top/bottom too (there are zenith/nadir/high-pitch-ring targets). */
export function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dir: { x: number; y: number },
  opts: EdgeArrowOptions,
) {
  const { distanceDeg, pulse, label: directionLabel } = opts;
  const cx = w / 2;
  const cy = h / 2;
  const halfW = Math.max(1, w / 2 - EDGE_MARGIN_PX);
  const halfH = Math.max(1, h / 2 - EDGE_MARGIN_PX);
  const tx = dir.x !== 0 ? halfW / Math.abs(dir.x) : Infinity;
  const ty = dir.y !== 0 ? halfH / Math.abs(dir.y) : Infinity;
  const t = Math.min(tx, ty);
  const px = cx + dir.x * t;
  const py = cy + dir.y * t;
  const angle = Math.atan2(dir.y, dir.x);

  const scale = 0.85 + 0.15 * pulse;
  const alpha = 0.55 + 0.35 * pulse;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, -11);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-10, 11);
  ctx.closePath();
  ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
  ctx.fill();
  ctx.restore();

  // Plain-language direction as the primary line (bigger, easier to read at
  // a glance) with the precise degrees as a smaller secondary line — the
  // words matter more for "which way do I turn", the number for "how far".
  const labelOffset = 34;
  const lx = px - dir.x * labelOffset;
  const ly = py - dir.y * labelOffset;
  label(ctx, directionLabel, lx, ly - 8, { size: 13, color: 'rgba(255,255,255,0.95)' });
  label(ctx, `${Math.round(distanceDeg)}°`, lx, ly + 10, { size: 11, color: 'rgba(255,255,255,0.7)' });
}

const LEADER_MIN_DIST_PX = 90;
const LEADER_START_OFFSET_PX = 26;
const LEADER_END_GAP_PX = 10;

/** Dashed line from just outside the center mark toward the primary reticle when it's on-screen but far from center — helps the eye find it fast in a busy scene. */
export function drawLeaderLine(ctx: CanvasRenderingContext2D, w: number, h: number, x: number, y: number) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < LEADER_MIN_DIST_PX) return;
  const ux = dx / dist;
  const uy = dy / dist;

  ctx.save();
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + ux * LEADER_START_OFFSET_PX, cy + uy * LEADER_START_OFFSET_PX);
  ctx.lineTo(x - ux * LEADER_END_GAP_PX, y - uy * LEADER_END_GAP_PX);
  ctx.stroke();
  ctx.restore();
}

export function drawRollIndicator(ctx: CanvasRenderingContext2D, w: number, h: number, roll: number, ok: boolean) {
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
