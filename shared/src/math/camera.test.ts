import { describe, expect, it } from 'vitest';
import {
  angularSeparation,
  cameraFov,
  focalFromFov,
  fovFromFocal,
  projectCamDir,
  screenToWorldDir,
  unprojectToCamDir,
  worldDirToScreen,
} from './camera.js';
import { IDENTITY_QUAT, qFromAxisAngle } from './quat.js';
import type { CameraModel } from './camera.js';

const CAM: CameraModel = { width: 1000, height: 800, focalPx: focalFromFov(1000, (60 * Math.PI) / 180) };

describe('focal <-> fov', () => {
  it('round-trips', () => {
    const fov = (72 * Math.PI) / 180;
    const focal = focalFromFov(1200, fov);
    expect(fovFromFocal(1200, focal)).toBeCloseTo(fov, 9);
  });

  it('cameraFov matches per-axis focal/fov relation', () => {
    const { hFov, vFov } = cameraFov(CAM);
    expect(fovFromFocal(CAM.width, CAM.focalPx)).toBeCloseTo(hFov, 9);
    expect(fovFromFocal(CAM.height, CAM.focalPx)).toBeCloseTo(vFov, 9);
  });
});

describe('projectCamDir / unprojectToCamDir round trip', () => {
  it('center of image maps to straight ahead', () => {
    const p = projectCamDir({ x: 0, y: 0, z: -1 }, CAM);
    expect(p.visible).toBe(true);
    expect(p.x).toBeCloseTo(CAM.width / 2, 6);
    expect(p.y).toBeCloseTo(CAM.height / 2, 6);
  });

  it('pixel -> direction -> pixel is stable across the frame', () => {
    const samples: Array<[number, number]> = [
      [0, 0],
      [CAM.width - 1, 0],
      [0, CAM.height - 1],
      [CAM.width - 1, CAM.height - 1],
      [CAM.width / 2, CAM.height / 2],
      [CAM.width * 0.25, CAM.height * 0.75],
    ];
    for (const [sx, sy] of samples) {
      const dir = unprojectToCamDir(sx, sy, CAM);
      const back = projectCamDir(dir, CAM);
      expect(back.visible).toBe(true);
      expect(back.x).toBeCloseTo(sx, 6);
      expect(back.y).toBeCloseTo(sy, 6);
    }
  });

  it('a direction behind the camera is not visible', () => {
    const p = projectCamDir({ x: 0, y: 0, z: 1 }, CAM);
    expect(p.visible).toBe(false);
  });
});

describe('worldDirToScreen / screenToWorldDir with rotation', () => {
  it('round-trips through a non-trivial camera rotation', () => {
    const camQuat = qFromAxisAngle({ x: 0.2, y: 1, z: -0.3 }, 0.9);
    const sx = CAM.width * 0.3;
    const sy = CAM.height * 0.6;
    const worldDir = screenToWorldDir(sx, sy, camQuat, CAM);
    const back = worldDirToScreen(worldDir, camQuat, CAM);
    expect(back.visible).toBe(true);
    expect(back.x).toBeCloseTo(sx, 5);
    expect(back.y).toBeCloseTo(sy, 5);
  });

  it('identity rotation: worldDirToScreen matches projectCamDir', () => {
    const dir = { x: 0.2, y: 0.1, z: -1 };
    const a = worldDirToScreen(dir, IDENTITY_QUAT, CAM);
    const b = projectCamDir(dir, CAM);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.y).toBeCloseTo(b.y, 9);
  });
});

describe('angularSeparation', () => {
  it('is zero for identical directions and pi/2 for orthogonal ones', () => {
    expect(angularSeparation({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(0, 9);
    expect(angularSeparation({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(Math.PI / 2, 9);
  });
});
