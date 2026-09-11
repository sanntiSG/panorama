/**
 * Synthetic capture bench: generates the set of photos a phone *would*
 * have taken following a real capture plan, complete with known ground
 * truth and injected gyro noise, uploads them to a running server exactly
 * like the real client does, and reports how well the pipeline recovered
 * the true geometry — all without an iPhone in hand. See the plan's
 * Verification section.
 *
 * Usage: npm run synth  (expects `npm run dev:server` running on :3001,
 * or set SERVER_URL)
 */
import sharp from 'sharp';
import {
  angularSeparation,
  cameraFov,
  focalFromFov,
  generateCapturePlan,
  projectCamDir,
  qFromAxisAngleVec,
  qInverse,
  qMul,
  qNormalize,
  qRotateVec,
  quatLookingAt,
  type CameraModel,
  type CapturePlan,
  type Quat,
  type ShotMeta,
  type StitchProgressEvent,
} from '@panorama/shared';
// Reaching into server/'s source directly (not through its package entry —
// it doesn't have one) rather than reimplementing "which shots overlap":
// this is *exactly* the adjacency the real pipeline uses to decide which
// pairs must agree on their relative pose, which is what the relative-error
// metric below needs to mean the same thing "ghosting" does.
import { findCandidatePairs } from '../server/src/stitch/pairs.js';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const SHOT_SIZE = 480;
const HFOV_DEG = 55;
const VFOV_DEG = 70;
const OVERLAP = 0.25; // kept in sync with client/src/App.tsx's OVERLAP
const GYRO_NOISE_DEG = process.env.GYRO_NOISE_DEG ? Number(process.env.GYRO_NOISE_DEG) : 2.5; // per the plan's own estimate of realistic gyro error
// Adds a lattice of identical-looking features (same color/amplitude, 3°
// apart in pitch, near the zenith) on top of the normal random scene —
// mimics a real repetitive surface (parallel ceiling beams) that phase
// correlation can genuinely confuse one repeat-period off. Default off so
// the baseline scene stays a stable point of comparison across runs.
const SYNTH_PERIODIC = process.env.SYNTH_PERIODIC === '1';
// Injects a *large* extra gyro error (SYNTH_OUTLIER_DEG, default 12° — well
// beyond what a ~30° alignment patch can correlate) into SYNTH_OUTLIER_SHOTS
// deterministically-chosen targets, instead of the normal GYRO_NOISE_DEG.
// A direct, reproducible stand-in for a shot fired while the aim was still
// moving: it should fail to get a confident pairwise correction and (once
// the render trust-weighting lands) render faintly instead of ghosting.
const SYNTH_OUTLIER_SHOTS = process.env.SYNTH_OUTLIER_SHOTS ? Number(process.env.SYNTH_OUTLIER_SHOTS) : 0;
const SYNTH_OUTLIER_DEG = process.env.SYNTH_OUTLIER_DEG ? Number(process.env.SYNTH_OUTLIER_DEG) : 12;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScenePoint {
  dir: { x: number; y: number; z: number };
  color: [number, number, number];
}

function buildScene(rand: () => number, count: number): ScenePoint[] {
  const points: ScenePoint[] = [];
  for (let i = 0; i < count; i++) {
    // Uniform-ish on the sphere.
    const z = rand() * 2 - 1;
    const theta = rand() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    points.push({
      dir: { x: r * Math.cos(theta), y: r * Math.sin(theta), z },
      color: [Math.floor(rand() * 200) + 30, Math.floor(rand() * 200) + 30, Math.floor(rand() * 200) + 30],
    });
  }
  return points;
}

/** SYNTH_PERIODIC=1's repetitive "ceiling plank" band: the same feature repeated every 3° of pitch, near the zenith. */
function addPeriodicBand(points: ScenePoint[]): void {
  const STEP_DEG = 3;
  const HALF_SPAN_DEG = 25;
  const PLANK_COLOR: [number, number, number] = [180, 150, 90];
  for (let yawDeg = 0; yawDeg < 360; yawDeg += 20) {
    for (let pitchDeg = 90 - HALF_SPAN_DEG; pitchDeg <= 90; pitchDeg += STEP_DEG) {
      const yaw = (yawDeg * Math.PI) / 180;
      const pitch = (pitchDeg * Math.PI) / 180;
      const cp = Math.cos(pitch);
      points.push({
        dir: { x: cp * Math.sin(yaw), y: cp * Math.cos(yaw), z: Math.sin(pitch) },
        color: PLANK_COLOR,
      });
    }
  }
}

const CAM_FORWARD_LOCAL = { x: 0, y: 0, z: -1 };

/**
 * Gauge-free accuracy metric: bundle adjustment has no absolute reference
 * (a weak prior only, see bundle.ts's PRIOR_WEIGHT), so comparing each
 * shot's final pose to its own ground truth isn't meaningful run to run —
 * but "how much do two *overlapping* shots disagree about their relative
 * pose" is exactly what actually causes ghosting, and is invariant to any
 * whole-scene rotation the solver settled on. `meanResidualPx` (from the
 * stitch result) is *not* a substitute for this: it's computed only over
 * pairs the bundle adjuster accepted, so anything that makes the pipeline
 * more selective (e.g. periodicity-aware confidence) lowers it mechanically
 * even when accuracy genuinely improves — never use it to judge that.
 *
 * Compares *pointing direction* only (where trueRel/gotRel send the camera
 * forward axis), not the full 3-DOF relative rotation — deliberately
 * ignoring the roll component. Two independent bugs would otherwise
 * contaminate this: align.ts itself documents that a single pair's
 * measurement can't resolve roll (near-boresight rotation) at all, so
 * that's not what bundle adjustment is even trying to get right pairwise;
 * and more concretely, `quatLookingAt`'s "roll=0" convention is
 * *discontinuous* exactly at the poles — zenith/nadir fall back to an
 * arbitrary fixed "right" vector (their forward is exactly parallel to
 * world-up, so `cross(forward, worldUp)` is exactly zero) while every
 * nearby ring target uses a smooth, yaw-dependent formula — so a pole
 * target and its ring neighbor have *unrelated* roll references in this
 * synthetic ground truth despite genuinely overlapping and aligning fine
 * (confirmed directly: this alone produced a spurious ~99° "error" against
 * an otherwise-correct reconstruction before this function excluded roll).
 * Forward-direction agreement is also the more honest proxy for ghosting
 * risk anyway — content position mismatch is what visibly doubles objects;
 * a pure roll disagreement alone would read as a milder rotated seam.
 */
function relativeError(
  plan: CapturePlan,
  trueQuats: Map<string, Quat>,
  finalQuats: Map<string, Quat>,
  hFov: number,
  vFov: number,
): { meanDeg: number; maxDeg: number; worstPair: [string, string] | null; pairCount: number } {
  const shotsForPairs = plan.targets
    .filter((t) => trueQuats.has(t.id))
    .map((t) => ({ targetId: t.id, quat: trueQuats.get(t.id)!, screenAngle: 0, capturedAt: 0, cam: { width: 1, height: 1, focalPx: 1 }, fileName: '' }));
  const pairs = findCandidatePairs(shotsForPairs, hFov, vFov);

  let sumSq = 0;
  let maxErr = 0;
  let worstPair: [string, string] | null = null;
  let n = 0;
  for (const { a, b } of pairs) {
    const trueA = trueQuats.get(a);
    const trueB = trueQuats.get(b);
    const gotA = finalQuats.get(a);
    const gotB = finalQuats.get(b);
    if (!trueA || !trueB || !gotA || !gotB) continue; // e.g. a target SKIP_NADIR left out entirely
    const trueRel = qMul(trueB, qInverse(trueA));
    const gotRel = qMul(gotB, qInverse(gotA));
    const trueDir = qRotateVec(trueRel, CAM_FORWARD_LOCAL);
    const gotDir = qRotateVec(gotRel, CAM_FORWARD_LOCAL);
    const err = angularSeparation(trueDir, gotDir);
    sumSq += err * err;
    n++;
    if (err > maxErr) {
      maxErr = err;
      worstPair = [a, b];
    }
  }
  return {
    meanDeg: n > 0 ? (Math.sqrt(sumSq / n) * 180) / Math.PI : 0,
    maxDeg: (maxErr * 180) / Math.PI,
    worstPair,
    pairCount: n,
  };
}

function renderShotJpeg(scene: ScenePoint[], quat: Quat, cam: CameraModel): Promise<Buffer> {
  const data = new Uint8Array(cam.width * cam.height * 3).fill(40);
  const invQuat = qInverse(quat);
  for (const pt of scene) {
    const camDir = qRotateVec(invQuat, pt.dir);
    const p = projectCamDir(camDir, cam);
    if (!p.visible) continue;
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    for (let oy = -4; oy <= 4; oy++) {
      for (let ox = -4; ox <= 4; ox++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || x >= cam.width || y < 0 || y >= cam.height) continue;
        const d2 = ox * ox + oy * oy;
        const falloff = Math.exp(-d2 / 6);
        const idx = (y * cam.width + x) * 3;
        for (let k = 0; k < 3; k++) {
          data[idx + k] = Math.min(255, data[idx + k] + pt.color[k] * falloff);
        }
      }
    }
  }
  return sharp(Buffer.from(data), { raw: { width: cam.width, height: cam.height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function createSession(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlap: OVERLAP }),
  });
  if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function uploadShot(sessionId: string, meta: ShotMeta, jpeg: Buffer): Promise<void> {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), `${meta.targetId}.jpg`);
  const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/shots`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`uploadShot(${meta.targetId}) failed: ${res.status} ${await res.text()}`);
}

async function triggerStitch(sessionId: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/stitch`, { method: 'POST' });
  if (!res.ok) throw new Error(`triggerStitch failed: ${res.status} ${await res.text()}`);
}

async function waitForStitchResult(sessionId: string): Promise<StitchProgressEvent> {
  const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/stitch/events`);
  if (!res.ok || !res.body) throw new Error(`SSE connection failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream ended before a terminal event');
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice('data: '.length)) as StitchProgressEvent;
      if (event.stage === 'done' || event.stage === 'error') {
        await reader.cancel();
        return event;
      }
      console.log(`  [${event.stage}] ${event.message} (${Math.round(event.progress * 100)}%)`);
    }
  }
}

async function main() {
  const rand = mulberry32(42);
  // 250 was too sparse: at patchFov≈30° a 128px alignment patch only sees
  // ~5 of 250 points scattered across the whole sphere on average — too few
  // for phase correlation to reliably find the true peak, confirmed by a
  // direct diagnostic (estimateRotationCorrection given two zero-noise,
  // genuinely-overlapping patches from the 250-point scene returned a
  // confidently WRONG ~13° correction for several real candidate pairs;
  // raising the count to 2000 made every one of them correctly resolve to
  // <0.05°, with nothing else changed). This isn't a pipeline bug — real
  // photos have far denser, continuous texture than isolated dots — but it
  // means 250 was silently making this bench's own baseline meaningless.
  const scene = buildScene(rand, 2000);
  if (SYNTH_PERIODIC) {
    addPeriodicBand(scene);
    console.log('SYNTH_PERIODIC=1: added a repetitive "ceiling plank" band near the zenith.');
  }

  const hFov = (HFOV_DEG * Math.PI) / 180;
  const vFov = (VFOV_DEG * Math.PI) / 180;
  const focalPx = focalFromFov(SHOT_SIZE, hFov);
  const cam: CameraModel = { width: SHOT_SIZE, height: SHOT_SIZE, focalPx };
  // Camera is square here but hFov/vFov used for cameraFov(cam) inside the
  // pipeline are derived from `cam` itself — recompute what the pipeline
  // will see so the capture plan and the pipeline agree on FOV.
  const { hFov: effHFov, vFov: effVFov } = cameraFov(cam);

  const plan: CapturePlan = generateCapturePlan(effHFov, effVFov, OVERLAP);
  console.log(`Plan: ${plan.targets.length} targets (hFov=${HFOV_DEG}°, vFov=${((effVFov * 180) / Math.PI).toFixed(1)}°)`);

  console.log('Creating session...');
  const sessionId = await createSession();
  console.log(`Session ${sessionId}`);

  const skipNadir = process.env.SKIP_NADIR === '1';
  const targetsToShoot = skipNadir ? plan.targets.filter((t) => t.id !== 'nadir') : plan.targets;

  // Deterministically pick which shots get the large SYNTH_OUTLIER_DEG error
  // instead of the normal GYRO_NOISE_DEG — spread evenly across the session
  // rather than clustered, so they land in different real overlap regions.
  const outlierIds = new Set<string>();
  if (SYNTH_OUTLIER_SHOTS > 0) {
    const stride = Math.max(1, Math.floor(targetsToShoot.length / SYNTH_OUTLIER_SHOTS));
    for (let i = 0, picked = 0; i < targetsToShoot.length && picked < SYNTH_OUTLIER_SHOTS; i += stride, picked++) {
      outlierIds.add(targetsToShoot[i].id);
    }
    console.log(`SYNTH_OUTLIER_SHOTS=${SYNTH_OUTLIER_SHOTS}: injecting ${SYNTH_OUTLIER_DEG}° error into [${[...outlierIds].join(', ')}].`);
  }

  console.log(`Rendering + uploading ${targetsToShoot.length} synthetic shots${skipNadir ? ' (nadir skipped)' : ''}...`);
  const trueQuats = new Map<string, Quat>();
  for (const target of targetsToShoot) {
    const trueQuat = quatLookingAt(target.yaw, target.pitch, 0);
    trueQuats.set(target.id, trueQuat);
    const noiseDeg = outlierIds.has(target.id) ? SYNTH_OUTLIER_DEG : GYRO_NOISE_DEG;
    const noiseVec = {
      x: ((rand() - 0.5) * 2 * noiseDeg * Math.PI) / 180,
      y: ((rand() - 0.5) * 2 * noiseDeg * Math.PI) / 180,
      z: ((rand() - 0.5) * 2 * noiseDeg * Math.PI) / 180,
    };
    const noisyQuat = qNormalize(qMul(qFromAxisAngleVec(noiseVec), trueQuat));

    const jpeg = await renderShotJpeg(scene, trueQuat, cam);
    const meta: ShotMeta = { targetId: target.id, quat: noisyQuat, screenAngle: 0, capturedAt: Date.now(), cam };
    await uploadShot(sessionId, meta, jpeg);
  }

  console.log('Triggering stitch...');
  await triggerStitch(sessionId);
  const finalEvent = await waitForStitchResult(sessionId);

  if (finalEvent.stage === 'error') {
    console.error('STITCH FAILED:', finalEvent.message);
    process.exit(1);
  }

  const result = finalEvent.result;
  const finalQuats = new Map(result.poses.map((p) => [p.targetId, p.quat]));
  const rel = relativeError(plan, trueQuats, finalQuats, effHFov, effVFov);

  console.log('\n=== Result ===');
  console.log(`Output: ${SERVER_URL}${result.outputFile}`);
  console.log(`Size: ${result.width}x${result.height}`);
  // NOT a valid before/after metric for anything that makes the pipeline
  // more *selective* about which pairs to trust (e.g. periodicity-aware
  // confidence) — it's averaged only over accepted pairs, so rejecting more
  // of them lowers this number mechanically even when accuracy improves.
  // Use meanRelativeErrorDeg below for that instead.
  console.log(`Mean residual (accepted pairs only — NOT a general accuracy metric, see comment): ${result.meanResidualPx.toFixed(3)} px`);
  const bundleCount = result.poses.filter((p) => p.source === 'bundle').length;
  console.log(`Poses refined by bundle adjustment: ${bundleCount}/${result.poses.length}`);
  console.log(
    `Relative pose error over ${rel.pairCount} overlapping pairs: mean ${rel.meanDeg.toFixed(3)}°, max ${rel.maxDeg.toFixed(3)}°` +
      (rel.worstPair ? ` (worst: ${rel.worstPair[0]} <-> ${rel.worstPair[1]})` : ''),
  );
  console.log('  ^ this is the metric that actually predicts ghosting — two overlapping shots disagreeing about their relative pose.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
