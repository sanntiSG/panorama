import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { cameraFov, qNormalize, type CameraModel, type RefinedPose, type SessionManifest, type StitchResult } from '@panorama/shared';
import { outputPath, shotsDir } from '../paths.js';
import { publishProgress } from './progress.js';
import { decodeForAlignment } from './decode.js';
import { findCandidatePairs } from './pairs.js';
import { estimateRotationCorrection, patchOrientationForPair, samplePatch, type AlignImage } from './align.js';
import { runBundleAdjustment, MIN_PAIR_CONFIDENCE, type PairMeasurement } from './bundle.js';
import { computeExposureGains, type ExposurePairSample } from './exposure.js';
import { renderEquirectangular, trustFromAcceptedPairs, type RenderShotInput } from './render.js';
import { injectGPanoXmp } from './xmp.js';

// A safe default that comfortably fits in memory on an ordinary dev
// machine (~100MB for the accumulation buffers). The plan's "up to
// 8192x4096" ceiling works too — the renderer already scales to it — this
// is just the v1 default; wiring it up to a per-session option is a small,
// isolated follow-up. Overridable via PANORAMA_OUTPUT_WIDTH (height follows
// at width/2) for constrained deploy targets — e.g. Render's free tier
// (0.1 CPU / 512MB) needs 2048 to stitch and render without running out of
// memory or timing out.
const OUTPUT_WIDTH = Number(process.env.PANORAMA_OUTPUT_WIDTH) || 4096;
const OUTPUT_HEIGHT = OUTPUT_WIDTH / 2;

/** Small patch for exposure sampling — only needs a mean, not FFT resolution. */
const EXPOSURE_PATCH_SIZE = 64;

export async function runStitch(session: SessionManifest): Promise<void> {
  const { id, shots } = session;

  publishProgress(id, { stage: 'decode', progress: 0, message: 'Leyendo fotos' });
  const alignImages = new Map<string, AlignImage>();
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const decoded = await decodeForAlignment(path.join(shotsDir(id), shot.fileName));
    alignImages.set(shot.targetId, {
      targetId: shot.targetId,
      quat: shot.quat,
      gray: decoded.gray,
      width: decoded.width,
      height: decoded.height,
      focalPx: shot.cam.focalPx * decoded.scale,
    });
    publishProgress(id, {
      stage: 'decode',
      progress: (i + 1) / shots.length,
      message: `Leyendo fotos (${i + 1}/${shots.length})`,
    });
  }

  // All shots in a session come from the same continuous getUserMedia
  // stream, so their camera intrinsics are consistent — safe to read once.
  const referenceCam = shots[0].cam;
  const { hFov, vFov } = cameraFov(referenceCam);

  const candidatePairs = findCandidatePairs(shots, hFov, vFov);
  publishProgress(id, {
    stage: 'features',
    progress: 1,
    message: `${candidatePairs.length} pares candidatos por solape`,
  });

  const patchFov = 0.55 * Math.min(hFov, vFov);
  const pairMeasurements: PairMeasurement[] = [];
  for (let i = 0; i < candidatePairs.length; i++) {
    const { a, b } = candidatePairs[i];
    const imgA = alignImages.get(a);
    const imgB = alignImages.get(b);
    if (!imgA || !imgB) continue;
    pairMeasurements.push(estimateRotationCorrection(imgA, imgB, patchFov));
    publishProgress(id, {
      stage: 'matching',
      progress: (i + 1) / Math.max(1, candidatePairs.length),
      message: `Emparejando fotos (${i + 1}/${candidatePairs.length})`,
    });
  }

  const shotIds = shots.map((s) => s.targetId);
  const initialQuats = new Map(shots.map((s) => [s.targetId, qNormalize(s.quat)]));
  const bundleResult = runBundleAdjustment(shotIds, initialQuats, pairMeasurements);
  const residualDeg = (bundleResult.meanResidualRad * 180) / Math.PI;
  publishProgress(id, {
    stage: 'bundle',
    progress: 1,
    message: `Ajuste geométrico: ${bundleResult.usedPairs} pares usados, residual ${residualDeg.toFixed(2)}°`,
  });

  // Exposure: resample a small overlap patch per accepted pair using the
  // *final* (bundle-adjusted) poses, so the brightness comparison lines up
  // with where the content actually overlaps post-refinement.
  const exposureSamples: ExposurePairSample[] = [];
  const exposurePatchCam: CameraModel = {
    width: EXPOSURE_PATCH_SIZE,
    height: EXPOSURE_PATCH_SIZE,
    focalPx: EXPOSURE_PATCH_SIZE / 2 / Math.tan(patchFov / 2),
  };
  for (const pm of pairMeasurements) {
    if (pm.confidence < MIN_PAIR_CONFIDENCE) continue;
    const imgA = alignImages.get(pm.a);
    const imgB = alignImages.get(pm.b);
    if (!imgA || !imgB) continue;
    const finalA: AlignImage = { ...imgA, quat: bundleResult.quats.get(pm.a)! };
    const finalB: AlignImage = { ...imgB, quat: bundleResult.quats.get(pm.b)! };
    const orientation = patchOrientationForPair(finalA, finalB);
    const patchA = samplePatch(finalA, orientation, exposurePatchCam, EXPOSURE_PATCH_SIZE);
    const patchB = samplePatch(finalB, orientation, exposurePatchCam, EXPOSURE_PATCH_SIZE);
    exposureSamples.push({
      a: pm.a,
      b: pm.b,
      meanA: mean(patchA.data),
      meanB: mean(patchB.data),
      weight: Math.min(pm.confidence, 30),
    });
  }
  const exposureGains = computeExposureGains(shotIds, exposureSamples);
  publishProgress(id, { stage: 'exposure', progress: 1, message: 'Exposición compensada entre fotos' });

  const renderInputs: RenderShotInput[] = shots.map((s) => ({
    targetId: s.targetId,
    filePath: path.join(shotsDir(id), s.fileName),
    quat: bundleResult.quats.get(s.targetId) ?? s.quat,
    cam: s.cam,
    exposureGain: exposureGains.get(s.targetId) ?? 1,
    trust: trustFromAcceptedPairs(bundleResult.acceptedPairs.get(s.targetId) ?? 0),
  }));

  const rendered = await renderEquirectangular(renderInputs, OUTPUT_WIDTH, OUTPUT_HEIGHT, (fraction) => {
    publishProgress(id, { stage: 'render', progress: fraction, message: `Generando la esfera (${Math.round(fraction * 100)}%)` });
  });

  publishProgress(id, { stage: 'xmp', progress: 0.5, message: 'Guardando metadatos de fotoesfera' });
  const jpeg = await sharp(Buffer.from(rendered.data), {
    raw: { width: rendered.width, height: rendered.height, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
  const withXmp = injectGPanoXmp(jpeg, rendered.width, rendered.height);

  const outFile = outputPath(id);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, withXmp);

  const poses: RefinedPose[] = shotIds.map((targetId) => {
    const acceptedPairs = bundleResult.acceptedPairs.get(targetId) ?? 0;
    return {
      targetId,
      quat: bundleResult.quats.get(targetId) ?? initialQuats.get(targetId)!,
      source: acceptedPairs > 0 ? 'bundle' : 'prior-only',
      acceptedPairs,
      trust: trustFromAcceptedPairs(acceptedPairs),
    };
  });

  const result: StitchResult = {
    outputFile: `/api/output/${id}.jpg`,
    width: rendered.width,
    height: rendered.height,
    // Focal length is NOT self-calibrated in this implementation (see
    // README/plan deviation notes) — reported as the value the client
    // supplied, which is either a prior calibration or the FOV default.
    focalPx: referenceCam.focalPx,
    poses,
    meanResidualPx: bundleResult.meanResidualRad * referenceCam.focalPx,
    uncoveredFraction: rendered.uncoveredFraction,
  };

  publishProgress(id, { stage: 'done', result });
}

function mean(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  return data.length > 0 ? sum / data.length : 0;
}
