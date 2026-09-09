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

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const SHOT_SIZE = 480;
const HFOV_DEG = 55;
const VFOV_DEG = 70;
const OVERLAP = 0.35;
const GYRO_NOISE_DEG = process.env.GYRO_NOISE_DEG ? Number(process.env.GYRO_NOISE_DEG) : 2.5; // per the plan's own estimate of realistic gyro error

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
  const scene = buildScene(rand, 250);

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
  console.log(`Rendering + uploading ${targetsToShoot.length} synthetic shots${skipNadir ? ' (nadir skipped)' : ''}...`);
  for (const target of targetsToShoot) {
    const trueQuat = quatLookingAt(target.yaw, target.pitch, 0);
    const noiseVec = {
      x: ((rand() - 0.5) * 2 * GYRO_NOISE_DEG * Math.PI) / 180,
      y: ((rand() - 0.5) * 2 * GYRO_NOISE_DEG * Math.PI) / 180,
      z: ((rand() - 0.5) * 2 * GYRO_NOISE_DEG * Math.PI) / 180,
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
  console.log('\n=== Result ===');
  console.log(`Output: ${SERVER_URL}${result.outputFile}`);
  console.log(`Size: ${result.width}x${result.height}`);
  console.log(`Mean residual: ${result.meanResidualPx.toFixed(3)} px`);
  const bundleCount = result.poses.filter((p) => p.source === 'bundle').length;
  console.log(`Poses refined by bundle adjustment: ${bundleCount}/${result.poses.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
