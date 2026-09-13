import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'error';

export interface CameraInfo {
  width: number;
  height: number;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

/**
 * This app is portrait-only end to end — the calibration sweep, the
 * reticle, and cameraCalibration.ts's DEFAULT_FOV_DEG all assume "sensor's
 * short axis becomes horizontal". But `MediaStreamTrack.getSettings()` on
 * iOS Safari reports the stream's landscape/sensor-native resolution (here,
 * confirmed against a real session: {width:4032, height:3024}) regardless
 * of how the phone is actually held — while the frame `captureFrame()`
 * actually saves (via `video.videoWidth`/`videoHeight`, which the browser
 * *does* rotate for display) comes out portrait, 3024x4032, the opposite
 * way round. Every shot in that session's manifest confirmed this exactly:
 * width and height swapped from what the CameraModel believed.
 *
 * That swap silently swaps hFov/vFov everywhere a CameraModel built from it
 * gets used — shared/plan/capturePlan.ts's ring spacing, and
 * viewport.ts's computeCoverTransform (which maps the reticle canvas onto
 * the live video using this same width/height as the source aspect ratio,
 * so a swapped aspect ratio also throws off where the reticle appears
 * relative to what's actually on screen). Enforcing the portrait invariant
 * directly here — rather than trying to pick the "correct" one of
 * getSettings()/videoWidth per-browser — fixes it regardless of *why* a
 * given browser's numbers disagree.
 */
function normalizeToPortrait(width: number, height: number): CameraInfo {
  return width > height ? { width: height, height: width } : { width, height };
}

// The Image Capture API's focus/exposure/white-balance constraints aren't in
// TypeScript's lib.dom.d.ts (a separate spec from core DOM) — minimal local
// extensions of the standard shapes, just for the fields we touch.
interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  exposureTime?: { min: number; max: number; step?: number };
}
interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  focusMode?: string;
  exposureMode?: string;
  whiteBalanceMode?: string;
  exposureTime?: number;
}

/**
 * How far from the fastest (min) end of the camera's supported exposureTime
 * range to bias toward, once we're taking manual control of it anyway —
 * 0 would be the fastest possible shutter (darkest, noisiest), 1 the
 * slowest (brightest, most motion-blur-prone, and what a dim-room auto
 * exposure would tend to pick on its own). A quarter of the way from
 * fastest to slowest is a deliberately conservative bias toward "less
 * motion blur" over "brighter image" — not the extreme, since a badly
 * underexposed shot is its own problem. Not something that can be tuned
 * without a real device to look at actual results on, so treat this as a
 * starting point, not a carefully-measured constant.
 */
const EXPOSURE_TIME_FAST_BIAS = 0.25;

/**
 * Best-effort: locks focus/exposure/white-balance to whatever the camera has
 * auto-settled on, instead of leaving them free to keep hunting/drifting as
 * the phone sweeps across a room mid-session. Sweeping from a bright window
 * to a dark corner (or a ceiling with a different light color temperature)
 * can otherwise re-trigger autofocus or reflow exposure/white-balance
 * between shots — server-side per-image exposure gain (stitch/exposure.ts)
 * can correct a uniform brightness offset after the fact, but it can't fix a
 * frame that came out genuinely soft from a mid-session refocus, or a
 * white-balance shift.
 *
 * Setting focus/white-balance mode to 'manual' *without* also specifying a
 * target value is the standard technique to freeze whatever value auto mode
 * had just settled on — deliberately not trying to compute/guess a number
 * ourselves. Exposure is the one exception: alongside 'manual' it also
 * requests a specific exposureTime biased toward the fast end of the
 * camera's supported range where that capability exists (see
 * EXPOSURE_TIME_FAST_BIAS) — freezing whatever auto had chosen isn't enough
 * there, since in a dim room that could just as well be a slow shutter that
 * bakes hand-tremor blur into every single frame regardless of how steady
 * the orientation reading looks.
 *
 * Support varies a lot by browser (solid on Chrome/Android via the Image
 * Capture API, much more limited on Safari/iOS) — this is a silent no-op,
 * not a failure, anywhere a capability isn't exposed. Call once the camera
 * has had a real moment to settle on the actual scene (e.g. after the
 * calibration sweep), not immediately on stream start.
 */
async function lockAutoAdjustments(track: MediaStreamTrack | undefined): Promise<void> {
  if (!track) return;
  try {
    const capabilities = track.getCapabilities?.() as ExtendedMediaTrackCapabilities | undefined;
    if (!capabilities) return;
    const advanced: ExtendedMediaTrackConstraintSet[] = [];
    if (capabilities.focusMode?.includes('manual')) advanced.push({ focusMode: 'manual' });
    if (capabilities.exposureMode?.includes('manual')) {
      const range = capabilities.exposureTime;
      if (range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min) {
        // Bias toward a faster shutter instead of just freezing whatever
        // auto picked — see EXPOSURE_TIME_FAST_BIAS's doc comment.
        const target = range.min + (range.max - range.min) * EXPOSURE_TIME_FAST_BIAS;
        advanced.push({ exposureMode: 'manual', exposureTime: target });
      } else {
        advanced.push({ exposureMode: 'manual' });
      }
    }
    if (capabilities.whiteBalanceMode?.includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
    if (advanced.length === 0) return;
    await track.applyConstraints({ advanced });
  } catch {
    // Not fatal — same best-effort posture as acquireWakeLock below; an
    // unsupported or rejected constraint just leaves auto-adjustment on.
  }
}

/**
 * Owns the rear-camera MediaStream and (best-effort) the screen wake lock so
 * the display doesn't sleep mid-capture. `videoRef` must be attached to a
 * `<video playsInline muted>` element — `playsInline` is required or iOS
 * takes the video fullscreen and the reticle overlay breaks.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<CameraInfo | null>(null);

  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
      wakeLockRef.current = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // Not fatal — iOS < 16.4 or a low-power mode can refuse this.
    }
  }, []);

  /**
   * Callback ref for the `<video>` element — deliberately not just a plain
   * object ref assigned via JSX `ref={videoRef}`. `start()` can resolve
   * (and the stream start flowing) well before any `<video>` exists: it's
   * called from the setup screen, which renders no `<video>` at all, and
   * the capture screen mounts its *own* `<video>` only once the capture
   * phase begins. A plain ref object has nothing to hook "a video element
   * just appeared, attach the stream" onto; this callback fires exactly
   * then, so pass it as the `ref` prop wherever the video element lives.
   */
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (!el) return;
    if (streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => {
        // Autoplay can be blocked in rare cases; the element is
        // muted+playsInline so this shouldn't normally happen.
      });
    }
    // getSettings() in start() below is the normal source of the camera's
    // resolution; this is only a fallback for the rare case it doesn't
    // report dimensions, so the app doesn't get stuck waiting on
    // info.width > 0. Always normalized to portrait — see
    // normalizeToPortrait's doc comment.
    if (el.videoWidth > 0) {
      setInfo((prev) => (prev && prev.width > 0 ? prev : normalizeToPortrait(el.videoWidth, el.videoHeight)));
    } else {
      el.addEventListener(
        'loadedmetadata',
        () => setInfo((prev) => (prev && prev.width > 0 ? prev : normalizeToPortrait(el.videoWidth, el.videoHeight))),
        { once: true },
      );
    }
  }, []);

  const start = useCallback(async () => {
    setStatus('requesting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 4032 },
          height: { ideal: 3024 },
          // A low-light auto-negotiated frame rate typically comes paired
          // with a longer per-frame exposure (more light, more risk of hand
          // tremor blurring *within* a single captured frame — a different
          // problem than orientation steadiness, which this constraint
          // alone can't fix; see lockAutoAdjustments' exposureTime bias
          // below for the other half of this). Nudging toward 30fps pushes
          // the browser toward a faster shutter from the start. A plain,
          // widely-supported MediaTrackConstraint (unlike exposureTime),
          // and `ideal` degrades gracefully wherever 30fps isn't achievable.
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      setInfo(
        normalizeToPortrait(
          settings?.width ?? videoRef.current?.videoWidth ?? 0,
          settings?.height ?? videoRef.current?.videoHeight ?? 0,
        ),
      );
      setStatus('ready');
      await acquireWakeLock();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
      // Rethrow so callers (App's handleStart) can react synchronously —
      // e.g. to make sure nothing else proceeds — instead of only reading
      // `error`/`status` from this hook's next render.
      throw err;
    }
  }, [acquireWakeLock]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setStatus('idle');
  }, []);

  /** See lockAutoAdjustments' doc comment — call once the camera has had a real moment to settle on the actual scene (e.g. right as the calibration sweep finishes), not immediately on stream start. */
  const lockAutoAdjustmentsNow = useCallback(async () => {
    await lockAutoAdjustments(streamRef.current?.getVideoTracks()[0]);
  }, []);

  useEffect(() => () => stop(), [stop]);

  // iOS releases the wake lock when the tab is backgrounded; re-acquire on return.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && status === 'ready' && !wakeLockRef.current) {
        void acquireWakeLock();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [status, acquireWakeLock]);

  return { videoRef, attachVideo, start, stop, status, error, info, lockAutoAdjustmentsNow };
}
