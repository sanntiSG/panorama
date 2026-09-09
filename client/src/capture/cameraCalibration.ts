import { focalFromFov, type CameraModel } from '@panorama/shared';

/**
 * Default field-of-view guess for an iPhone main camera in *portrait*
 * holding orientation (sensor's short axis becomes horizontal). Derived
 * from a ~26mm full-frame-equivalent focal length. Only used until a real
 * session has been stitched and calibrated the actual focal length — see
 * `saveCalibratedFocal`.
 */
export const DEFAULT_FOV_DEG = { horizontal: 49, vertical: 65 };

const STORAGE_KEY = 'panorama:calibratedFocal';

interface StoredCalibration {
  focalPx: number;
  atWidth: number;
}

/** Focal length (px) from a previous session's bundle-adjusted result, rescaled to this session's resolution. */
export function loadCalibratedFocalPx(videoWidth: number): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredCalibration;
    if (!data.focalPx || !data.atWidth) return null;
    // Focal length in pixels scales linearly with resolution at a fixed
    // sensor/FOV, so rescale if this capture's resolution differs from the
    // one the calibration was measured at.
    return data.focalPx * (videoWidth / data.atWidth);
  } catch {
    return null;
  }
}

export function saveCalibratedFocal(focalPx: number, atWidth: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ focalPx, atWidth } satisfies StoredCalibration));
  } catch {
    // localStorage unavailable (private mode, etc) — non-fatal, just skip persistence.
  }
}

export function buildCameraModel(videoWidth: number, videoHeight: number): CameraModel {
  const calibrated = loadCalibratedFocalPx(videoWidth);
  const focalPx = calibrated ?? focalFromFov(videoWidth, (DEFAULT_FOV_DEG.horizontal * Math.PI) / 180);
  return { width: videoWidth, height: videoHeight, focalPx };
}
