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
    // getSettings() below is the normal source of the camera's resolution;
    // this is only a fallback for the rare case it doesn't report
    // dimensions, so the app doesn't get stuck waiting on info.width > 0.
    if (el.videoWidth > 0) {
      setInfo((prev) => (prev && prev.width > 0 ? prev : { width: el.videoWidth, height: el.videoHeight }));
    } else {
      el.addEventListener(
        'loadedmetadata',
        () => setInfo((prev) => (prev && prev.width > 0 ? prev : { width: el.videoWidth, height: el.videoHeight })),
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
      setInfo({
        width: settings?.width ?? videoRef.current?.videoWidth ?? 0,
        height: settings?.height ?? videoRef.current?.videoHeight ?? 0,
      });
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

  return { videoRef, attachVideo, start, stop, status, error, info };
}
